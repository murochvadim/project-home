"""My BathRoom Smart Switch Handler — dispatch device commands on button presses.

Reads bindings from `dashboard_settings` (key=`my-bathroom.smart_switch_bindings`),
saved by the My BathRoom Agent dashboard page. The TS0044 publishes a single
`action` field of shape "<N>_<event>" (e.g. "1_single", "3_double"). The
rule accepts single / double / hold but the dashboard UI only exposes
**single** (decided 2026-05-03 after live testing):

- `_hold` never fires on this MOES TS0044 firmware variant.
- `_double` works but creates a visible on→off flicker when bound alongside
  single (device emits both events on a real double-click). A 500 ms
  single-debounce was prototyped to suppress the flicker but introduced
  sluggish latency on every single press; user reverted.
- Cleanest UX: one row per button (single only). Per-binding action picks
  `toggle` vs `turn_on` vs `turn_off`. Multi-device per slot supported.

Pattern mirrors `wallmote_handler.py` — fire immediately on every event,
no deferred dispatch.

Bindings shape:
    {"btn1:single": [{device_id, channel, action, name, label}, ...],
     "btn2:single": [...], ...}

Bindings cached 30 s.
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
from _display_chips import (  # noqa: E402
    build_alexa_cmd  as _build_alexa_cmd,
    build_vacuum_cmd as _build_vacuum_cmd,
)

log = logging.getLogger("rule.my_bathroom_smart_switch_handler")

# Tuya TS0044 device id (Z2M friendly name "My BathRoom Smart Switch").
# TODO: set to the My BathRoom TS0044 IEEE address when paired (Z2M friendly name `My BathRoom Smart Switch`).
#       Until paired, the placeholder ensures the rule never matches a real event.
SMART_SWITCH_ID = "0xMYBATHROOM_TS0044_NOT_PAIRED_YET"

RULE = {
    "name":        "My BathRoom Smart Switch Handler",
    "description": "When you press the My BathRoom wireless wall remote, this runs whatever each button is set to do. (Only a single press works on this remote.)",
    "triggers":    [SMART_SWITCH_ID],   # specific id — fires only on real presses
    "controls":    [],                  # dynamic — resolved per binding
    "category":    "control",
    "group":       "my-bathroom",
    "priority":    10,
    "depends_on":  [],
    "test_event":  {
        "device_id": SMART_SWITCH_ID,
        "source":    "zigbee",
        "dps":       {"action": "1_single", "linkquality": 140},
    },
}

_ACTION_RE       = re.compile(r"^(\d+)_(single|double|hold)$")
_BINDINGS_CACHE  = {"data": None, "ts": 0.0}
_CACHE_TTL_SEC   = 30

# Per-slot cooldown to suppress duplicate `action` emissions from Z2M.
# The MOES TS0044 firmware publishes the same action value twice in
# rapid succession (press + release both carry it), so without this we
# fire each binding twice per physical press — confuses devices like
# Awtrix that don't tolerate two power-toggles 50 ms apart. 1 s window
# matches the my_bathroom_buttons rule's HASP cooldown for consistency.
_COOLDOWN_SEC    = 1.0
_last_fired      = {}


def _get_bindings(state):
    """Load bindings from dashboard_settings with TTL cache."""
    now = time.time()
    if _BINDINGS_CACHE["data"] is not None and (now - _BINDINGS_CACHE["ts"]) < _CACHE_TTL_SEC:
        return _BINDINGS_CACHE["data"]
    rows = state.db_query(
        "SELECT value FROM dashboard_settings WHERE key = 'my-bathroom.smart_switch_bindings'"
    )
    data = {}
    if rows:
        v = rows[0][0]
        if isinstance(v, str):
            try:    v = json.loads(v)
            except: v = {}
        if isinstance(v, dict):
            data = v
    _BINDINGS_CACHE["data"] = data
    _BINDINGS_CACHE["ts"]   = now
    return data


def _resolve_target(action_str, dev_state, channel):
    """Resolve 'toggle' against current device state. Returns 'turn_on'/'turn_off'/None."""
    if action_str in ("turn_on", "turn_off"):
        return action_str
    if action_str != "toggle":
        return None
    cur_dps = (dev_state or {}).get("dps", {}) or {}
    if channel:
        cur_val = cur_dps.get(channel)
    elif "1" in cur_dps:
        cur_val = cur_dps["1"]
    elif "state" in cur_dps:
        cur_val = cur_dps["state"]
    elif "power" in cur_dps:
        cur_val = cur_dps["power"]
    elif len(cur_dps) == 1:
        cur_val = next(iter(cur_dps.values()))
    else:
        cur_val = None
    return "turn_off" if cur_val in (True, 1, "on", "ON", "true", "True") else "turn_on"


def _build_commands(slot, state, slot_key):
    """Resolve bindings into command dicts (same shape rule engine expects)."""
    commands = []
    for b in slot:
        device_id = b.get("device_id")
        if not device_id:
            continue
        channel = b.get("channel")
        action  = b.get("action", "turn_on")
        # Alexa / Vacuum bindings — see _display_chips. Pass dev so the
        # helpers can disambiguate the shared 'stop' action by protocol.
        dev = state.devices.get(device_id, {}) or {}
        special_cmd = (_build_alexa_cmd(b, action, device_id, "My BathRoom Smart Switch Handler", dev)
                       or _build_vacuum_cmd(b, action, device_id, "My BathRoom Smart Switch Handler", dev))
        if special_cmd:
            commands.append(special_cmd)
            continue
        target  = _resolve_target(action, state.devices.get(device_id, {}), channel)
        if not target:
            log.warning("Unknown action '%s' in binding for %s — skipping", action, slot_key)
            continue
        cmd = {
            "device_id":        device_id,
            "action":           target,
            "rule":             "My BathRoom Smart Switch Handler",
            "_skip_loop_guard": True,
        }
        if channel:
            cmd["channel"] = channel
        # Pass through page_num for HASP `page` channel bindings (the
        # picker stores the chosen page 1-12 on the binding; rule engine
        # HASP branch reads it to publish the page-switch command).
        if "page_num" in b:
            cmd["page_num"] = b["page_num"]
        commands.append(cmd)
    return commands


def evaluate(event, state):
    if event.get("device_id") != SMART_SWITCH_ID:
        return []
    dps = event.get("dps", {}) or {}
    action_raw = dps.get("action")
    if not isinstance(action_raw, str):
        return []
    m = _ACTION_RE.match(action_raw)
    if not m:
        return []

    button_n, event_type = m.group(1), m.group(2)
    slot_key             = f"btn{button_n}:{event_type}"

    # Z2M emits the same `action` field twice in quick succession on
    # this TS0044 firmware. Drop dupes within the cooldown window.
    now  = time.time()
    last = _last_fired.get(slot_key, 0.0)
    if now - last < _COOLDOWN_SEC:
        return []
    _last_fired[slot_key] = now

    bindings             = _get_bindings(state)
    slot                 = bindings.get(slot_key, [])
    if not slot:
        # No binding for this slot — common case if user only configured single.
        return []

    commands = _build_commands(slot, state, slot_key)
    log.info("My BathRoom Smart Switch %s → %d commands: %s",
             slot_key, len(commands),
             [(c["device_id"], c.get("channel"), c["action"]) for c in commands])
    return commands
