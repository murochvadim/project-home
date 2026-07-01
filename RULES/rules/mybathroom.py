"""MyBathroom — presence/door motion lighting for My BathRoom, fully sentence-driven.

The main light is the new **mybathroom-panel** plate's on-board relay (p1b20 =
GPIO output2); the old "My Bathroom Switch" died and was removed 2026-06-22. The
plate relay is driven via the documented `command/output<pin> {"state":...}`
(see `_relay_cmd`); the under-cabinet light is a normal Z-Wave switch.

Behaviour
---------
1. **Motion light** — when the My Bathroom presence sensor detects someone OR
   the My Bathroom door changes:
     - inside the day window  → turn ON the *day lights*   (s_mbr1 chips)
     - outside the day window → turn ON the *night lights* (s_mbr2 chips)
   The plate relay is re-asserted ON every trigger (idempotent output command,
   no harm); a 3 s burst debounce caps the mmWave's entry flurry. The
   under-cabinet (real state feedback) is only switched ON when currently off.

2. **Auto-off** — on each heartbeat tick, if the room has been continuously
   empty (presence sensor reads clear) AND no presence/door activity for
   `timeout` (s_mbr4), turn OFF the lights ONCE this empty period (guarded by
   `_mybathroom_autooff_done`, cleared on any presence/door activity). The plate
   relays fire OFF UNCONDITIONALLY (no state feedback to skip on, so a manual
   tap-on we never saw still gets cleared); the under-cabinet uses its real
   state. The countdown starts when the room goes empty and resets on activity.

3. **Manual override + Laundry off-cascade** — tapping the main light's plate
   button (p1b20) OFF blocks motion from re-lighting the MAIN while you're still
   in the room (the under-cabinet keeps its normal behaviour), AND turns the
   Laundry light (p1b10) OFF — restoring the old "bathroom off → laundry off"
   cascade, now driven by the plate button's `up`+`val` event instead of the dead
   switch. The block clears on a real departure (room clear ≥ `_LEFT_CLEAR_SEC`,
   so a brief mmWave dropout doesn't count); tapping the button ON clears it
   immediately. If someone is IN the Laundry, its own motion re-lights it.

Everything configurable lives in the dashboard container "My Bathroom Lights"
(`r_mybathroom_init` in apartment.rule_sentences) — the rule parses it itself
(30 s TTL cache), so edits + Reload take effect without an engine restart:

  s_mbr1: My Bathroom Lights: day lights are @<Light> <Channel>, @<Light>, ...
  s_mbr2: My Bathroom Lights: night lights are @<Light>, ...
  s_mbr3: My Bathroom Lights: day window is between 06:00 and 23:00
  s_mbr4: My Bathroom Lights: turn off after 10 minutes
  s_mbr7: My Bathroom Lights: only fires when home_mode is home   (gate — turn-on
          only; AND-combined; auto-off ignores it)

(The old s_mbr5 *mirror* and s_mbr6 *off-cascade* were removed 2026-06-22 along
with the dead switch — they reacted to the old switch's pushed state. The
off-cascade to the Laundry was RESTORED 2026-06-27 via the plate button p1b20 —
see behaviour 3 — driven in code, not a sentence. The mirror stays gone:
presence turns main + under-cabinet on together.)

Trigger device IDs (presence / door) are fixed in RULE['triggers'] (bound at
module load, can't be sentence-driven); they are the room's permanent sensors.
heartbeat is a trigger so the auto-off timer ticks during quiet periods.

Manual "Run" button (dashboard red Run → engine Force path): simulates a
presence trigger NOW and turns on the time-appropriate light set, bumping the
Runs counter like a real fire. See the force_run block in evaluate().
"""

import json
import logging
import re
import time
from datetime import datetime
from zoneinfo import ZoneInfo

log = logging.getLogger("rule.mybathroom")

_TZ = ZoneInfo("Asia/Jerusalem")

# Fixed room sensors (triggers — bound at module load).
_PRESENCE_ID = "bf23d6781f5f872648dd4n"               # My Bathroom Presence sens (dps "1")
_DOOR_ID     = "66ac7365-7a9b-4706-bbd4-315a2793ecff"  # My Bathroom Door (dps "door")
# NOTE: the old "My Bathroom Switch" (57317771…) was REMOVED 2026-06-22 — it died,
# was physically replaced by the mybathroom-panel plate, and the user deleted its
# devices row. With it went the mirror + OFF-cascade: the plate gives no pushed
# state to mirror, and presence already turns the main light + under-cabinet on
# together (so the mirror was redundant for the automation path anyway).

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
# Gate sentence (s_mbr7) — "My Bathroom Lights: only fires when <key> is <value>".
# AND-combined; gates the TURN-ON paths only (presence / door / Run). The mirror,
# OFF-cascade, and auto-off all ignore it (they're manual-switch responses /
# cleanup that should work regardless of mode). First gate: home_mode is home.
_GATE_RE = re.compile(
    r"my\s+bathroom\s+lights:\s*only\s+fires\s+when\s+(\w+)\s+is\s+([\w-]+)",
    re.IGNORECASE,
)

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

# After a MANUAL off of the main light (plate button), motion won't re-light the
# main while you're still in the room. The block clears only on a real departure:
# the room must be clear for this long before a returning presence counts as a
# fresh entry (above the mmWave's brief dropouts so a flicker doesn't count).
_LEFT_CLEAR_SEC = 10

_CLEAR_STR = {"none", "no", "clear", "off", "false", "0", ""}
_ON_VALS   = (True, 1, "on", "ON", "true", "True", "1")

_cfg_cache = {"data": None, "ts": 0.0}
_CFG_TTL_SEC = 30

# ── New plate (mybathroom-panel) on-board relays ────────────────────────────
# The failed "My Bathroom Switch" was replaced by an OpenHASP plate whose page-1
# buttons drive on-board relays: p1b20 = My Bathroom Light, p1b10 = Laundry.
# Control = publish `hasp/mybathroom-panel/command/output<pin> {"state":"on"|"off"}`
# (see _RELAY_OUTPUT / _relay_cmd below) — confirmed working 2026-06-22 (both
# lights drive correctly). The rule does NOT track or read plate relay state: it
# re-asserts the commanded output (idempotent) on each turn-on, and the heartbeat
# auto-off fires UNCONDITIONALLY for plate relays when the room is empty — so a
# manual tap that we never saw still gets cleared and the light can't be left on.
# Dispatch goes through the engine's generic hasp
# command path (action 'set' + path/value) since the device row is protocol='hasp'.
_PLATE_PREFIX = "hasp:mybathroom-panel:"

# Button object → GPIO output pin (plate gpio config: pin1/group1 = Laundry,
# pin2/group2 = My Bathroom). Relay control is the documented OpenHASP
# `command/output<pin>` with a JSON `{"state":"on"|"off"}` payload — STATE-based
# (idempotent) and, because each pin shares a groupid with its page button, it
# ALSO syncs the button's displayed state. Verified 2026-06-22 via state/output2
# feedback (`command/output2 {"state":"on"}` → state/output2 {"state":"on"}).
# NOT `.val` (only sets the button display, drives the relay flakily on a change)
# and NOT a bare `1` payload (must be the JSON state object).
_RELAY_OUTPUT = {"p1b10": "output1", "p1b20": "output2"}

# Manual-off block + off-cascade (2026-06-27). The user turns the MAIN light OFF
# via the plate's page-1 button p1b20; its toggle "up" event carries the new state
# in `val` (val=0 off / val=1 on — same shape the Laundry p1b10 probe confirmed).
# On a manual OFF the rule (1) blocks motion from re-lighting the MAIN while you're
# still in the room, and (2) cascades OFF to the Laundry light (p1b10) — restoring
# the old "bathroom off → laundry off" behaviour lost when the dead switch was
# replaced by the plate. The under-cabinet (Z-Wave) is unaffected — the user only
# controls the main by hand — so it keeps its normal motion behaviour.
_PLATE_MAIN_BTN_ID = "hasp:mybathroom-panel:p1b20"   # My Bathroom main light button
_LAUNDRY_RELAY_ID  = "hasp:mybathroom-panel:p1b10"   # Laundry relay (cascade-off target)


def _is_plate_relay(dev_id):
    return isinstance(dev_id, str) and dev_id.startswith(_PLATE_PREFIX)


def _plate_obj(dev_id):
    return dev_id.split(":")[-1]   # 'hasp:mybathroom-panel:p1b20' -> 'p1b20'


def _relay_cmd(dev_id, on):
    """Direct GPIO relay command → publishes
    `hasp/mybathroom-panel/command/output<pin>  {"state":"on"|"off"}`
    (idempotent; group-syncs the button display). None if the relay isn't mapped."""
    path = _RELAY_OUTPUT.get(_plate_obj(dev_id))
    if not path:
        return None
    return {
        "device_id": dev_id, "action": "set",
        "path": path, "value": '{"state":"on"}' if on else '{"state":"off"}',
        "rule": "My Bathroom Lights", "_skip_loop_guard": True,
    }


RULE = {
    "name":        "My Bathroom Lights",
    "description": "Turns the My BathRoom lights on when it senses you there, picks the right lights for day or night, turns them off after the room is empty, and keeps the under-cabinet light following the main light.",
    "triggers":    [_PRESENCE_ID, _DOOR_ID, "heartbeat", _PLATE_MAIN_BTN_ID],
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
        "gates": [],
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
            elif _GATE_RE.search(text):
                m = _GATE_RE.search(text)
                cfg["gates"].append((m.group(1).lower(), m.group(2).lower()))
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


def _turn_on_set(state, targets, now_ts, skip_plate=False):
    """turn_on each target that's currently OFF, with a two-layer debounce:
    (1) state-diff — skip targets already on; (2) burst debounce — suppress
    repeat on-bursts within _ON_DEBOUNCE_SEC of the last on-emit (see the
    constant's note). Retries after the window if the lights still read off.
    skip_plate=True omits plate-relay targets (used while the user has the MAIN
    light blocked by a manual off — don't re-assert it, but the non-plate
    under-cabinet still turns on)."""
    cmds = []
    for dev_id, ch in targets:
        if _is_plate_relay(dev_id):
            if skip_plate:
                continue   # main blocked by a manual off — don't re-assert it
            # Idempotent GPIO output — always (re)assert ON. The plate gives no
            # state feedback and a manual dashboard/tap change is invisible to
            # us, so we can't safely "skip if already on"; re-asserting an
            # already-on output is a harmless no-op. The 3 s burst debounce below
            # caps repeats during the mmWave's entry flurry.
            c = _relay_cmd(dev_id, True)
            if c:
                cmds.append(c)
        elif not _is_on(state, dev_id, ch):
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


def _gates_pass(state, cfg):
    """All s_mbr7 gates AND-combined (e.g. home_mode is home). No gates → True.
    Gates the TURN-ON paths only (presence / door / Run); the mirror, OFF-cascade
    and auto-off ignore it."""
    return all(state.shared.get(k) == v for k, v in cfg["gates"])


# ─────────────────────────── Rule ───────────────────────────

def _activity_turn_on(state, cfg, active_set, now_ts, src, in_day):
    """Shared turn-on for presence + door. Honors the MAIN-light manual-off block:
    while the user has tapped the main off, motion won't re-light the main (the
    under-cabinet still turns on) UNTIL they leave (room clear ≥ _LEFT_CLEAR_SEC);
    a real re-entry then clears the block and lights normally. Returns commands."""
    prev_active = float(state.shared.get("_mybathroom_last_active_ts", 0) or 0)
    clear_gap = (now_ts - prev_active) if prev_active else 1e9
    state.shared["_mybathroom_last_active_ts"] = now_ts
    state.shared["_mybathroom_autooff_done"] = False   # activity → re-arm auto-off
    blocked = bool(state.shared.get("_mybathroom_user_off"))
    if blocked and clear_gap >= _LEFT_CLEAR_SEC:
        state.shared["_mybathroom_user_off"] = False
        blocked = False
        log.info("mybathroom: re-entry after %.0fs away → main manual-off block cleared", clear_gap)
    if not _gates_pass(state, cfg):
        return []
    cmds = _turn_on_set(state, active_set, now_ts, skip_plate=blocked)
    if cmds:
        log.info("mybathroom: %s → %d on-commands (in_day=%s, main_blocked=%s)",
                 src, len(cmds), in_day, blocked)
    return cmds


def evaluate(event, state):
    dev_id = event.get("device_id", "")
    cfg = _parse_config(state)
    if not cfg["authored"]:
        return []

    now = datetime.now(_TZ)
    now_min = now.hour * 60 + now.minute
    now_ts = time.time()
    in_day = _in_day(cfg, now_min)
    day_set = cfg["day"] if in_day else cfg["night"]

    # ── Main-light panel button (p1b20): detect a MANUAL flip ──
    # The toggle button's "up" event carries the resulting state in `val`
    # (val=0 off / val=1 on). On a manual OFF: block motion re-light of the MAIN
    # until you leave, AND cascade OFF to the Laundry light (p1b10). On a manual
    # ON: clear the block. Act only on "up" (the settled result).
    if dev_id == _PLATE_MAIN_BTN_ID:
        dps = event.get("dps", {}) or {}
        if dps.get("event") == "up":
            val = dps.get("val")
            if val in (0, "0", False):
                state.shared["_mybathroom_user_off"] = True
                # Cascade OFF to the Laundry AND set the Laundry rule's manual-off
                # block + reset its activity clock, so the Laundry presence sensor
                # doesn't immediately re-light it (without this the cascade turned the
                # relay off but the Laundry rule re-lit it ~1 s later — its block was
                # only ever set by a DIRECT p1b10 tap). The block clears the same way a
                # direct Laundry-off would: when the Laundry room is genuinely empty
                # for _LEFT_CLEAR_SEC, so walking into the Laundry later lights it fine.
                state.shared["_laundry_user_off"] = True
                state.shared["_laundry_light_last_active_ts"] = now_ts
                log.info("mybathroom: manual OFF on panel (main) → block main + cascade Laundry off + block Laundry re-light")
                c = _relay_cmd(_LAUNDRY_RELAY_ID, False)   # one-shot Laundry off
                return [c] if c else []
            if val in (1, "1", True):
                state.shared["_mybathroom_user_off"] = False
                state.shared["_mybathroom_last_active_ts"] = now_ts
                state.shared["_mybathroom_autooff_done"] = False
                log.info("mybathroom: manual ON on panel (main) → block cleared")
        return []

    # ── Manual Run (Force path) — simulate a presence trigger NOW ──
    if event.get("source") == "force_run":
        state.shared["_mybathroom_last_active_ts"] = now_ts
        state.shared["_mybathroom_prev_present"] = True
        state.shared["_mybathroom_user_off"] = False   # Run is an explicit override → clear any manual-off block
        if not _gates_pass(state, cfg):
            log.info("mybathroom: Run gated off (gates=%s)", cfg["gates"])
            return []
        cmds = _turn_on_set(state, day_set, now_ts)
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
            return _activity_turn_on(state, cfg, day_set, now_ts, "presence", in_day)
        # present → clear transition starts the empty-room grace countdown
        if prev_present:
            state.shared["_mybathroom_last_active_ts"] = now_ts
        return []

    # ── Door sensor (open or close = activity) ──
    if dev_id == _DOOR_ID:
        dps = event.get("dps", {}) or {}
        if "door" in dps:
            return _activity_turn_on(state, cfg, day_set, now_ts, "door", in_day)
        return []

    # ── Heartbeat: auto-off when empty + idle ──
    if dev_id == "heartbeat":
        clear = not _present_val(_dps_of(state, _PRESENCE_ID).get("1"))
        if not clear:
            state.shared["_mybathroom_autooff_done"] = False   # occupied → re-arm
            return []
        last_active = float(state.shared.get("_mybathroom_last_active_ts", 0) or 0)
        if (now_ts - last_active) < cfg["timeout"]:
            return []
        if state.shared.get("_mybathroom_autooff_done"):
            return []   # lights already cleared once this empty period
        # Empty + idle past the timeout → turn everything off ONCE this period.
        # Plate relays fire UNCONDITIONALLY: we can't read their state and a
        # manual tap-on is invisible to us, so always send OFF to be certain the
        # light can't be left on. Non-plate targets (under-cabinet, which DOES
        # report) honor _is_on to avoid redundant commands.
        all_targets = []
        for t in list(cfg["day"]) + list(cfg["night"]):
            if t not in all_targets:
                all_targets.append(t)
        cmds = []
        for dev2, ch2 in all_targets:
            if _is_plate_relay(dev2):
                c = _relay_cmd(dev2, False)   # idempotent GPIO output OFF
                if c:
                    cmds.append(c)
            elif _is_on(state, dev2, ch2):
                c = {"device_id": dev2, "action": "turn_off", "rule": "My Bathroom Lights",
                     "_skip_loop_guard": True}
                if ch2 is not None:
                    c["channel"] = ch2
                cmds.append(c)
        state.shared["_mybathroom_autooff_done"] = True
        if cmds:
            log.info("mybathroom: auto-off → %d off-commands (idle %.0fs >= %ds, room clear)",
                     len(cmds), now_ts - last_active, cfg["timeout"])
        return cmds

    return []
