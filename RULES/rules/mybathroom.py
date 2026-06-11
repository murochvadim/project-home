"""MyBathroom — presence/door motion lighting for My BathRoom, fully sentence-driven.

Behaviour
---------
1. **Motion light** — when the My Bathroom presence sensor detects someone OR
   the My Bathroom door changes:
     - inside the day window  → turn ON the *day lights*   (s_mbr1 chips)
     - outside the day window → turn ON the *night lights* (s_mbr2 chips)
   Lights are only switched ON if currently off (no command spam on repeated
   presence/amplitude events — the state-diff guard is the rule's debounce).

2. **Auto-off** — on each heartbeat tick, if the room has been continuously
   empty (presence sensor reads clear) AND no presence/door activity for
   `timeout` (s_mbr4), turn OFF every light that's currently on. The countdown
   starts the moment the room goes empty and is RESET by any presence/door
   trigger (s_mbr4 grace timer). The "presence currently clear" gate means the
   lights never switch off while someone is still detected, regardless of how
   long they've been motionless.

3. **Mirror** (one-way, s_mbr5) — operating the master light (My Bathroom
   Light) drives the slave (Under-Cabinet): master ON → slave ON, master OFF →
   slave OFF. Lets the main wall switch also control the under-cabinet strip.

4. **OFF-cascade** (one-way, OFF-only, s_mbr6) — on a real FALLING EDGE of the
   main light (was on, now off — manual or auto-off), also turn off the listed
   lights (the Laundry Light, My Bathroom Switch ch 1), immediately. No occupancy
   gate (the laundry-empty check was dropped 2026-06-12 — the adjacent laundry
   sensor still read "presence" at the off-instant so it blocked nearly every
   time). Edge-gated via `_mybathroom_master_was_on` so steady-state local-poll
   snapshots showing ch2=false don't keep re-killing the laundry light (which
   would fight the separate Laundry Light rule). Nothing happens on ON.

Everything configurable lives in the dashboard container "My Bathroom Lights"
(`r_mybathroom_init` in apartment.rule_sentences) — the rule parses it itself
(30 s TTL cache), so edits + Reload take effect without an engine restart:

  s_mbr1: My Bathroom Lights: day lights are @<Light> <Channel>, @<Light>, ...
  s_mbr2: My Bathroom Lights: night lights are @<Light>, ...
  s_mbr3: My Bathroom Lights: day window is between 06:00 and 23:00
  s_mbr4: My Bathroom Lights: turn off after 10 minutes
  s_mbr5: My Bathroom Lights: mirror @<Master> <Channel> to @<Slave>
  s_mbr6: My Bathroom Lights: when main light off also turn off @<Light> <Channel>

Trigger device IDs (presence / door / switch) are fixed in RULE['triggers']
(triggers are bound at module load and can't be sentence-driven); they are the
room's permanent sensors. heartbeat is a trigger so the auto-off timer ticks
during quiet periods.

Manual "Run" button (dashboard red Run → engine Force path): simulates a
presence trigger NOW and turns on the time-appropriate light set, bumping the
Runs counter like a real fire. See the force_run block in evaluate().
"""

import json
import logging
import os
import re
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

_RULES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)

log = logging.getLogger("rule.mybathroom")

_TZ = ZoneInfo("Asia/Jerusalem")

# Fixed room sensors / switch (triggers — bound at module load).
_PRESENCE_ID = "bf23d6781f5f872648dd4n"               # My Bathroom Presence sens (dps "1")
_DOOR_ID     = "66ac7365-7a9b-4706-bbd4-315a2793ecff"  # My Bathroom Door (dps "door")
_SWITCH_ID   = "57317771ecfabcbd3d24"                  # My Bathroom Switch (mirror master, ch "2")

# Sentence regex anchors (case-insensitive).
_DAY_RE     = re.compile(r"my\s+bathroom\s+lights:\s*day\s+lights\s+are", re.IGNORECASE)
_NIGHT_RE   = re.compile(r"my\s+bathroom\s+lights:\s*night\s+lights\s+are", re.IGNORECASE)
_WINDOW_RE  = re.compile(
    r"my\s+bathroom\s+lights:\s*day\s+window\s+is\s+between\s+(\d{1,2}:\d{2})\s+and\s+(\d{1,2}:\d{2})",
    re.IGNORECASE,
)
_TIMEOUT_RE = re.compile(
    r"my\s+bathroom\s+lights:\s*turn\s+off\s+after\s+(\d+)\s*(hour|hr|minute|min|second|sec)",
    re.IGNORECASE,
)
_MIRROR_RE  = re.compile(r"my\s+bathroom\s+lights:\s*mirror\b", re.IGNORECASE)
# s_mbr6 — OFF-only cascade: on a real falling edge of the main light (was on,
# now off), also turn off these lights immediately. No occupancy gate (the
# laundry-empty check was dropped 2026-06-12). Edge-gated in evaluate() via
# _mybathroom_master_was_on so steady-state local-poll snapshots don't re-fire.
_OFF_CASCADE_RE = re.compile(r"my\s+bathroom\s+lights:\s*when\s+main\s+light\s+off", re.IGNORECASE)

# Defaults used only if a sentence is missing/unparsable (container is seeded
# with all five on deploy, so these are belt-and-braces).
_DEF_WIN_START = 6 * 60     # 06:00
_DEF_WIN_END   = 23 * 60    # 23:00
_DEF_TIMEOUT   = 600        # 10 min

# A turn_on command takes >1 s to round-trip back into state.devices, so the
# mmWave's flurry of presence/amplitude events on entry would each re-emit
# turn_on (the _is_on state-diff guard can't catch it — state still reads off).
# Suppress repeat on-bursts within this window; retries after it if the lights
# still read off (e.g. the first command was lost).
_ON_DEBOUNCE_SEC = 3.0

_CLEAR_STR = {"none", "no", "clear", "off", "false", "0", ""}
_ON_VALS   = (True, 1, "on", "ON", "true", "True", "1")

_cfg_cache = {"data": None, "ts": 0.0}
_CFG_TTL_SEC = 30


RULE = {
    "name":        "My Bathroom Lights",
    "description": "Presence/door motion lighting for My BathRoom: day/night light sets, auto-off when empty, and a one-way main→under-cabinet mirror. Fully sentence-driven.",
    "triggers":    [_PRESENCE_ID, _DOOR_ID, _SWITCH_ID, "heartbeat"],
    "controls":    [],
    "category":    "control",
    "group":       "my-bathroom",   # room group (renders as "My BathRoom"). priority 10 keeps it
    "priority":    10,              # ABOVE My BathRoom Displays (50) so the heartbeat auto-off check
                                    # is evaluated first and never skipped by same-group competition.
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


def _hhmm_to_min(s):
    try:
        h, m = s.split(":")
        return (int(h) * 60 + int(m)) % 1440
    except (ValueError, AttributeError):
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
        if r.get("active") and (r.get("name") or "").strip().lower() == "my bathroom lights":
            return r
    return None


def _parse_config(state):
    """Parse the MyBathroom container → config dict (30 s TTL cache)."""
    now = time.time()
    if _cfg_cache["data"] is not None and (now - _cfg_cache["ts"]) < _CFG_TTL_SEC:
        return _cfg_cache["data"]

    container = _read_container(state)
    cfg = {
        "day": [], "night": [],
        "win_start": _DEF_WIN_START, "win_end": _DEF_WIN_END,
        "timeout": _DEF_TIMEOUT,
        "mirror_master": None, "mirror_slave": None,
        "off_cascade": [],
        "authored": container is not None,
    }
    if container:
        devs = _build_devices_by_name_desc(state.devices)
        for s in (container.get("sentences") or []):
            if not s.get("active"):
                continue
            text = _sentence_text(s)
            if _DAY_RE.search(text):
                cfg["day"] = [p for p in (_parse_dev_chip(c, devs) for c in _iter_dev_chips(s)) if p]
            elif _NIGHT_RE.search(text):
                cfg["night"] = [p for p in (_parse_dev_chip(c, devs) for c in _iter_dev_chips(s)) if p]
            elif _WINDOW_RE.search(text):
                m = _WINDOW_RE.search(text)
                a, b = _hhmm_to_min(m.group(1)), _hhmm_to_min(m.group(2))
                if a is not None and b is not None:
                    cfg["win_start"], cfg["win_end"] = a, b
            elif _TIMEOUT_RE.search(text):
                m = _TIMEOUT_RE.search(text)
                n, unit = int(m.group(1)), m.group(2).lower()
                mult = 3600 if unit in ("hour", "hr") else 1 if unit in ("second", "sec") else 60
                cfg["timeout"] = n * mult
            elif _OFF_CASCADE_RE.search(text):
                cfg["off_cascade"] = [p for p in (_parse_dev_chip(c, devs) for c in _iter_dev_chips(s)) if p]
            elif _MIRROR_RE.search(text):
                chips = _iter_dev_chips(s)
                if len(chips) >= 2:
                    cfg["mirror_master"] = _parse_dev_chip(chips[0], devs)
                    cfg["mirror_slave"]  = _parse_dev_chip(chips[1], devs)

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


def _in_day(cfg, now_min):
    a, b = cfg["win_start"], cfg["win_end"]
    if a == b:
        return True
    if a < b:
        return a <= now_min < b
    return now_min >= a or now_min < b   # wrap past midnight


def _turn_on_set(state, targets, now_ts):
    """turn_on each target that's currently OFF, with a two-layer debounce:
    (1) state-diff — skip targets already on; (2) burst debounce — suppress
    repeat on-bursts within _ON_DEBOUNCE_SEC of the last on-emit (see the
    constant's note). Retries after the window if the lights still read off."""
    cmds = []
    for dev_id, ch in targets:
        if _is_on(state, dev_id, ch):
            continue
        cmd = {"device_id": dev_id, "action": "turn_on", "rule": "My Bathroom Lights",
               "_skip_loop_guard": True}
        if ch is not None:
            cmd["channel"] = ch
        cmds.append(cmd)
    if not cmds:
        return []
    last_emit = float(state.shared.get("_mybathroom_last_on_emit_ts", 0) or 0)
    if (now_ts - last_emit) < _ON_DEBOUNCE_SEC:
        return []   # burst repeat within the command round-trip window — suppress
    state.shared["_mybathroom_last_on_emit_ts"] = now_ts
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
        cmd = {"device_id": dev_id, "action": "turn_off", "rule": "My Bathroom Lights",
               "_skip_loop_guard": True}
        if ch is not None:
            cmd["channel"] = ch
        cmds.append(cmd)
    return cmds


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    dev_id = event.get("device_id", "")
    cfg = _parse_config(state)
    if not cfg["authored"]:
        return []

    now = datetime.now(_TZ)
    now_min = now.hour * 60 + now.minute
    now_ts = time.time()
    day_set = cfg["day"] if _in_day(cfg, now_min) else cfg["night"]

    # ── Manual Run (Force path) — simulate a presence trigger NOW ──
    if event.get("source") == "force_run":
        cmds = _turn_on_set(state, day_set, now_ts)
        state.shared["_mybathroom_last_active_ts"] = now_ts
        state.shared["_mybathroom_prev_present"] = True
        log.info("mybathroom: Run → %d on-commands (in_day=%s)", len(cmds), _in_day(cfg, now_min))
        return cmds

    # ── Presence sensor ──
    if dev_id == _PRESENCE_ID:
        dps = event.get("dps", {}) or {}
        pv = dps.get("1") if "1" in dps else _dps_of(state, _PRESENCE_ID).get("1")
        cur_present = _present_val(pv)
        prev_present = bool(state.shared.get("_mybathroom_prev_present", False))
        state.shared["_mybathroom_prev_present"] = cur_present
        if cur_present:
            state.shared["_mybathroom_last_active_ts"] = now_ts
            cmds = _turn_on_set(state, day_set, now_ts)
            if cmds:
                log.info("mybathroom: presence → %d on-commands (in_day=%s)",
                         len(cmds), _in_day(cfg, now_min))
            return cmds
        # present → clear transition starts the empty-room grace countdown
        if prev_present:
            state.shared["_mybathroom_last_active_ts"] = now_ts
        return []

    # ── Door sensor (open or close = activity) ──
    if dev_id == _DOOR_ID:
        dps = event.get("dps", {}) or {}
        if "door" in dps:
            state.shared["_mybathroom_last_active_ts"] = now_ts
            cmds = _turn_on_set(state, day_set, now_ts)
            if cmds:
                log.info("mybathroom: door → %d on-commands (in_day=%s)",
                         len(cmds), _in_day(cfg, now_min))
            return cmds
        return []

    # ── Mirror: master light change → slave follows; on OFF also kill off-cascade ──
    if dev_id == _SWITCH_ID and cfg["mirror_master"]:
        master_id, master_ch = cfg["mirror_master"]
        if master_id != dev_id:
            return []
        dps = event.get("dps", {}) or {}
        key = master_ch if master_ch is not None else "1"
        if key not in dps:
            return []   # this event didn't change the master channel
        want_on = dps.get(key) in _ON_VALS
        prev_master = state.shared.get("_mybathroom_master_was_on")
        state.shared["_mybathroom_master_was_on"] = want_on
        cmds = []
        # Primary slave — bidirectional (on→on, off→off). Idempotent via the
        # _is_on guard, so steady-state local-poll snapshots are no-ops.
        if cfg["mirror_slave"]:
            slave_id, slave_ch = cfg["mirror_slave"]
            if _is_on(state, slave_id, slave_ch) != want_on:
                c = {"device_id": slave_id,
                     "action": "turn_on" if want_on else "turn_off",
                     "rule": "My Bathroom Lights", "_skip_loop_guard": True}
                if slave_ch is not None:
                    c["channel"] = slave_ch
                cmds.append(c)
        # OFF-cascade (s_mbr6) — on a real FALLING EDGE of the main light (was on,
        # now off), also turn off the listed lights. Fires immediately, NO
        # occupancy gate (the laundry-empty check was dropped 2026-06-12 — the
        # adjacent laundry sensor still read "presence" at the off-instant, so the
        # gate blocked nearly every time). Edge-gated (not "ch2==false in this
        # event") via _mybathroom_master_was_on so steady-state local-poll
        # snapshots showing ch2=false don't keep turning the laundry light off and
        # fight the Laundry Light rule (which turns it on for the laundry room).
        if prev_master is True and not want_on and cfg["off_cascade"]:
            for dev2, ch2 in cfg["off_cascade"]:
                if not _is_on(state, dev2, ch2):
                    continue
                c = {"device_id": dev2, "action": "turn_off",
                     "rule": "My Bathroom Lights", "_skip_loop_guard": True}
                if ch2 is not None:
                    c["channel"] = ch2
                cmds.append(c)
        if cmds:
            log.info("mybathroom: mirror master=%s → %d cmd(s)",
                     "on" if want_on else "off", len(cmds))
        return cmds

    # ── Heartbeat: auto-off when empty + idle ──
    if dev_id == "heartbeat":
        clear = not _present_val(_dps_of(state, _PRESENCE_ID).get("1"))
        if not clear:
            return []
        last_active = float(state.shared.get("_mybathroom_last_active_ts", 0) or 0)
        if (now_ts - last_active) < cfg["timeout"]:
            return []
        all_targets = list(cfg["day"]) + list(cfg["night"])
        cmds = _turn_off_set(state, all_targets)
        if cmds:
            log.info("mybathroom: auto-off → %d off-commands (idle %.0fs >= %ds, room clear)",
                     len(cmds), now_ts - last_active, cfg["timeout"])
        return cmds

    return []
