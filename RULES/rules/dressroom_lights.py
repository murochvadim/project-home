"""Dressroom Lights — presence/door motion lighting for the DressRoom, sentence-driven.

Same pattern as My Bathroom Lights, trimmed to a single light (the DressRoom has
only one — the Ambient light Switch), so NO day/night split and NO mirror.

Behaviour
---------
1. **Motion light** — when the DressRoom presence sensor detects someone OR the
   DressRoom door changes, turn ON the configured light(s). Only switches ON
   targets currently off (no spam) + a 3 s burst debounce for the mmWave's entry
   flurry. Fires at any time (no time window — a dressroom is used day & night).
2. **Auto-off** — on each heartbeat, if the room has been continuously clear
   (presence reads `none`) AND no presence/door activity for `timeout` (s_drl2),
   turn OFF every configured light that's on. Countdown starts when the room
   goes empty and RESETS on every presence/door trigger; the presence-clear gate
   means the light never switches off while someone is still detected.

Everything configurable lives in the dashboard container "Dressroom Lights"
(`r_dressroom_lights_init` in apartment.rule_sentences) — the rule parses it
itself (30 s TTL cache), so edits + Reload take effect without an engine restart:

  s_drl1: Dressroom Lights: lights are @<Light>, @<Light> <Channel>, ...
  s_drl2: Dressroom Lights: turn off after 5 minutes
  s_drl3: Dressroom Lights: only fires when home_mode is home   (gate — turn-on
          only; AND-combined; auto-off ignores it so lights still clear when away)

Trigger device IDs (presence / door) are fixed in RULE['triggers'] (triggers bind
at module load and can't be sentence-driven); they are the room's permanent
sensors. heartbeat is a trigger so the auto-off timer ticks during quiet periods.

Manual "Run" button (dashboard red Run → engine Force path): simulates a presence
trigger NOW and turns the light(s) on, bumping the Runs counter like a real fire.
"""

import json
import logging
import os
import re
import sys
import time

_RULES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)

log = logging.getLogger("rule.dressroom_lights")

# Fixed room sensors (triggers — bound at module load).
_PRESENCE_ID = "bf13844ff697409de91u3d"               # DressRoom Presence sensor (dps "1")
_DOOR_ID     = "d3d26b00-b4c2-4c8d-924e-df5b6290cf54"  # Dressroom Door (dps "door")

# Sentence regex anchors (case-insensitive).
_LIGHTS_RE  = re.compile(r"dressroom\s+lights:\s*lights\s+are", re.IGNORECASE)
_TIMEOUT_RE = re.compile(
    r"dressroom\s+lights:\s*turn\s+off\s+after\s+(\d+)\s*(hour|hr|minute|min|second|sec)",
    re.IGNORECASE,
)
# Gate sentence (s_drl3) — "Dressroom Lights: only fires when <state.shared key> is <value>".
# Each match = one (key, expected_value) gate; multiple are AND-combined. Gates the
# TURN-ON paths only (presence / door / Run) — auto-off always runs so lights still
# clear when empty regardless of mode. First gate: home_mode is home.
_GATE_RE = re.compile(
    r"dressroom\s+lights:\s*only\s+fires\s+when\s+(\w+)\s+is\s+([\w-]+)",
    re.IGNORECASE,
)

_DEF_TIMEOUT = 300        # 5 min — used only if s_drl2 is missing/unparsable

# A turn_on command takes >1 s to round-trip back into state.devices, so the
# mmWave's flurry of presence/amplitude events on entry would each re-emit
# turn_on. Suppress repeat on-bursts within this window; retries after it if the
# light still reads off (e.g. the first command was lost).
_ON_DEBOUNCE_SEC = 3.0

_CLEAR_STR = {"none", "no", "clear", "off", "false", "0", ""}
_ON_VALS   = (True, 1, "on", "ON", "true", "True", "1")

_cfg_cache = {"data": None, "ts": 0.0}
_CFG_TTL_SEC = 30


RULE = {
    "name":        "Dressroom Lights",
    "description": "Presence/door motion lighting for the DressRoom: turn the light on, auto-off when empty (resets on activity). Sentence-driven, single light.",
    "triggers":    [_PRESENCE_ID, _DOOR_ID, "heartbeat"],
    "controls":    [],
    "category":    "control",
    "group":       "dressroom",   # dedicated single-rule group → never skipped by same-group competition
    "priority":    10,
    "depends_on":  [],
    # Red "Run" button (dashboard Force path) → simulates a presence trigger.
    "test_event":  {"device_id": "heartbeat", "source": "force_run"},
    "count_force_fires": True,
}


# ─────────────────────────── Parsing helpers ───────────────────────────

def _sentence_text(s):
    segs = s.get("segments")
    if isinstance(segs, list) and segs:
        return "".join((seg or {}).get("v", "") for seg in segs)
    return s.get("text") or ""


def _iter_dev_chips(sentence):
    segs = sentence.get("segments")
    if not isinstance(segs, list):
        return []
    out = []
    for seg in segs:
        if isinstance(seg, dict) and (seg.get("t") or "").lower() == "dev":
            v = seg.get("v") or ""
            if v.startswith("@"):
                out.append(v)
    return out


def _build_devices_by_name_desc(state_devices):
    by_name = {}
    for dev_id, dev in state_devices.items():
        name = (dev.get("name") or "").strip()
        if not name:
            continue
        merged = dict(dev)
        merged["id"] = dev_id
        by_name[name] = merged
    return sorted(by_name.items(), key=lambda kv: len(kv[0]), reverse=True)


def _parse_dev_chip(chip_value, devices_by_name_desc):
    """'@<DeviceName> <ChannelLabel>' → (device_id, dps_key|None) via
    longest-prefix name match + dps_labels channel lookup."""
    if not chip_value or not chip_value.startswith("@"):
        return None
    text = chip_value[1:].strip()
    if not text:
        return None
    for name, dev in devices_by_name_desc:
        if text == name:
            return (dev["id"], None)
        if text.startswith(name + " "):
            label = text[len(name) + 1:].strip()
            for dps_key, dps_label in (dev.get("dps_labels") or {}).items():
                if dps_label == label:
                    return (dev["id"], dps_key)
            return (dev["id"], None)
    return None


def _read_container(state):
    rows = state.db_query(
        "SELECT value FROM dashboard_settings WHERE key = %s",
        ("apartment.rule_sentences",),
    )
    if not rows:
        return None
    raw = rows[0][0]
    if isinstance(raw, str):
        try:
            rules = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
    elif isinstance(raw, list):
        rules = raw
    else:
        return None
    for r in rules or []:
        if r.get("active") and (r.get("name") or "").strip().lower() == "dressroom lights":
            return r
    return None


def _parse_config(state):
    """Parse the Dressroom Lights container → config dict (30 s TTL cache)."""
    now = time.time()
    if _cfg_cache["data"] is not None and (now - _cfg_cache["ts"]) < _CFG_TTL_SEC:
        return _cfg_cache["data"]

    container = _read_container(state)
    cfg = {"lights": [], "timeout": _DEF_TIMEOUT, "gates": [], "authored": container is not None}
    if container:
        devs = _build_devices_by_name_desc(state.devices)
        for s in (container.get("sentences") or []):
            if not s.get("active"):
                continue
            text = _sentence_text(s)
            if _LIGHTS_RE.search(text):
                cfg["lights"] = [p for p in (_parse_dev_chip(c, devs) for c in _iter_dev_chips(s)) if p]
            elif _GATE_RE.search(text):
                m = _GATE_RE.search(text)
                cfg["gates"].append((m.group(1).lower(), m.group(2).lower()))
            elif _TIMEOUT_RE.search(text):
                m = _TIMEOUT_RE.search(text)
                n, unit = int(m.group(1)), m.group(2).lower()
                mult = 3600 if unit in ("hour", "hr") else 1 if unit in ("second", "sec") else 60
                cfg["timeout"] = n * mult

    _cfg_cache["data"] = cfg
    _cfg_cache["ts"] = now
    return cfg


# ─────────────────────────── State helpers ───────────────────────────

def _present_val(v):
    if v is None:
        return False
    if isinstance(v, str):
        return v.strip().lower() not in _CLEAR_STR
    return bool(v)


def _dps_of(state, dev_id):
    return (state.devices.get(dev_id, {}) or {}).get("dps", {}) or {}


def _is_on(state, dev_id, ch):
    dps = _dps_of(state, dev_id)
    if ch is not None:
        v = dps.get(ch)
    else:
        v = dps.get("light", dps.get("1", dps.get("state")))
    return v in _ON_VALS


def _turn_on_set(state, targets, now_ts):
    """turn_on each target currently OFF, with a two-layer debounce: state-diff
    (skip already-on) + burst debounce (suppress repeats within _ON_DEBOUNCE_SEC
    of the last on-emit; retries after the window if it still reads off)."""
    cmds = []
    for dev_id, ch in targets:
        if _is_on(state, dev_id, ch):
            continue
        cmd = {"device_id": dev_id, "action": "turn_on", "rule": "Dressroom Lights",
               "_skip_loop_guard": True}
        if ch is not None:
            cmd["channel"] = ch
        cmds.append(cmd)
    if not cmds:
        return []
    last_emit = float(state.shared.get("_dressroom_last_on_emit_ts", 0) or 0)
    if (now_ts - last_emit) < _ON_DEBOUNCE_SEC:
        return []
    state.shared["_dressroom_last_on_emit_ts"] = now_ts
    return cmds


def _turn_off_set(state, targets):
    cmds = []
    seen = set()
    for dev_id, ch in targets:
        key = (dev_id, ch)
        if key in seen:
            continue
        seen.add(key)
        if not _is_on(state, dev_id, ch):
            continue
        cmd = {"device_id": dev_id, "action": "turn_off", "rule": "Dressroom Lights",
               "_skip_loop_guard": True}
        if ch is not None:
            cmd["channel"] = ch
        cmds.append(cmd)
    return cmds


def _gates_pass(state, cfg):
    """All s_drl3 gates AND-combined (e.g. home_mode is home). No gates → True.
    Gates the TURN-ON paths only; auto-off ignores them."""
    return all(state.shared.get(k) == v for k, v in cfg["gates"])


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    dev_id = event.get("device_id", "")
    cfg = _parse_config(state)
    if not cfg["authored"]:
        return []
    now_ts = time.time()
    targets = cfg["lights"]

    # ── Manual Run (Force path) — simulate a presence trigger NOW ──
    if event.get("source") == "force_run":
        state.shared["_dressroom_last_active_ts"] = now_ts
        state.shared["_dressroom_prev_present"] = True
        if not _gates_pass(state, cfg):
            log.info("dressroom_lights: Run gated off (gates=%s)", cfg["gates"])
            return []
        cmds = _turn_on_set(state, targets, now_ts)
        log.info("dressroom_lights: Run → %d on-commands", len(cmds))
        return cmds

    # ── Presence sensor ──
    if dev_id == _PRESENCE_ID:
        dps = event.get("dps", {}) or {}
        pv = dps.get("1") if "1" in dps else _dps_of(state, _PRESENCE_ID).get("1")
        cur_present = _present_val(pv)
        prev_present = bool(state.shared.get("_dressroom_prev_present", False))
        state.shared["_dressroom_prev_present"] = cur_present
        if cur_present:
            state.shared["_dressroom_last_active_ts"] = now_ts
            if not _gates_pass(state, cfg):
                return []   # e.g. home_mode != home → track activity but don't turn on
            cmds = _turn_on_set(state, targets, now_ts)
            if cmds:
                log.info("dressroom_lights: presence → %d on-commands", len(cmds))
            return cmds
        # present → clear transition starts the empty-room grace countdown
        if prev_present:
            state.shared["_dressroom_last_active_ts"] = now_ts
        return []

    # ── Door sensor (open or close = activity) ──
    if dev_id == _DOOR_ID:
        dps = event.get("dps", {}) or {}
        if "door" in dps:
            state.shared["_dressroom_last_active_ts"] = now_ts
            if not _gates_pass(state, cfg):
                return []
            cmds = _turn_on_set(state, targets, now_ts)
            if cmds:
                log.info("dressroom_lights: door → %d on-commands", len(cmds))
            return cmds
        return []

    # ── Heartbeat: auto-off when empty + idle ──
    if dev_id == "heartbeat":
        clear = not _present_val(_dps_of(state, _PRESENCE_ID).get("1"))
        if not clear:
            return []
        last_active = float(state.shared.get("_dressroom_last_active_ts", 0) or 0)
        if (now_ts - last_active) < cfg["timeout"]:
            return []
        cmds = _turn_off_set(state, targets)
        if cmds:
            log.info("dressroom_lights: auto-off → %d off-commands (idle %.0fs >= %ds, room clear)",
                     len(cmds), now_ts - last_active, cfg["timeout"])
        return cmds

    return []
