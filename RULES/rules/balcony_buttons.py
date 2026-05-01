"""Balcony Buttons — dispatch device commands on HASP panel button presses.

Reads bindings from `hasp_buttons` table (rows for the balcony panel).
Each (page, button_id, event) row maps to an action_type + action_target
that the rule resolves to a command.

Triggered by synthetic events the rule engine generates from
`hasp/balcony/state/p<page>b<id>` MQTT messages — see
`rule_engine.on_mqtt_event()` (the "Button widgets" branch). The synthetic
event has `device_id = 'hasp:balcony:p<page>b<id>'` and dps =
`{event: 'short'|'long'|'down'|'up'|'double', ...}`.

Action types supported in v1:
  - 'device'        → turn_on / turn_off / toggle a real device
  - 'hasp_command'  → run a HASP command on the same panel (e.g. 'page 2')
  - 'pixoo_preset'  → push a named Pixoo preset
"""

import logging
import re
import time

log = logging.getLogger("rule.balcony_buttons")

RULE = {
    "name": "Balcony Buttons",
    "description": "Dispatch actions on HASP balcony panel button presses",
    "triggers": ["*"],  # wildcard with prefix early-return — see evaluate()
    "controls": [],
    "category": "control",
    "group": "balcony",
    "priority": 10,
    "depends_on": [],
    "test_event": {
        "device_id": "hasp:balcony:p1b110",
        "source": "hasp_button",
        "dps": {"event": "short"},
    },
}

# Same panel-button can fire down+up+short in rapid succession on a single tap;
# we want one dispatch per press. Cooldown is per (page, button_id, event).
_COOLDOWN_SEC = 1.0
_last_fired = {}  # key = "p<page>b<id>:<event>" → unix ts

# Bindings cache — avoid hitting the DB on every event.
_bindings_cache = {"data": None, "ts": 0.0}
_CACHE_TTL_SEC = 30

_BTN_RE = re.compile(r"^hasp:balcony:p(\d+)b(\d+)$")


def _get_bindings(state):
    """Load all hasp_buttons rows for the balcony panel into a dict keyed
    on (page, button_id, event). Cached for 30s."""
    now = time.time()
    if _bindings_cache["data"] is not None and (now - _bindings_cache["ts"]) < _CACHE_TTL_SEC:
        return _bindings_cache["data"]

    rows = state.db_query(
        """
        SELECT b.page, b.button_id, b.event, b.action_type, b.action_target, b.action_payload
        FROM hasp_buttons b
        JOIN hasp_panels p ON p.id = b.panel_id
        WHERE p.name = 'balcony'
        """
    )
    data = {}
    for row in rows or []:
        page, bid, evt, atype, atarget, apayload = row
        data[(page, bid, evt)] = {
            "action_type": atype,
            "action_target": atarget,
            "action_payload": apayload or {},
        }

    _bindings_cache["data"] = data
    _bindings_cache["ts"] = now
    return data


def _resolve_toggle(state, device_id, channel):
    """Read current device state and return 'turn_on' or 'turn_off' to flip it.

    Mirrors the wallmote_handler resolution — channel keys vary per protocol
    (Tuya '1'/'2'/'3', Zigbee 'state_l1'…, single-channel: 'state'/'power'/'1').
    """
    dev_state = state.devices.get(device_id, {}) or {}
    cur_dps = dev_state.get("dps", {}) or {}
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
    if cur_val in (True, 1, "on", "ON", "true", "True"):
        return "turn_off"
    return "turn_on"


def _build_command(binding, page, bid, evt, state):
    """Translate a hasp_buttons row into a command dict (or None to skip)."""
    atype = binding.get("action_type")
    atarget = binding.get("action_target") or ""
    apayload = binding.get("action_payload") or {}

    if not atype or not atarget:
        return None

    # Human button presses are intentional input, not automation feedback —
    # exempt from the rule engine's same-action-4x-in-10s loop guard so
    # rapid tapping during testing doesn't auto-disable the rule.
    if atype == "device":
        action = apayload.get("action", "toggle")
        channel = apayload.get("channel")
        # Resolve toggle client-side — device_agent only handles turn_on/turn_off
        if action == "toggle":
            action = _resolve_toggle(state, atarget, channel)
        cmd = {
            "device_id": atarget,
            "action": action,
            "rule": "Balcony Buttons",
            "_skip_loop_guard": True,
        }
        if channel:
            cmd["channel"] = channel
        return cmd

    if atype == "hasp_command":
        # action_target is the full HASP command line, e.g. "page 2", "clearpage 1",
        # "p1b110.val 1". Split on first space → path / value.
        parts = atarget.strip().split(" ", 1)
        path = parts[0]
        value = parts[1] if len(parts) > 1 else ""
        return {
            "device_id": "hasp:balcony",
            "protocol": "hasp",
            "path": path,
            "value": value,
            "rule": "Balcony Buttons",
            "_skip_loop_guard": True,
        }

    if atype == "pixoo_preset":
        cmd = {
            "device_id": "pixoo",
            "protocol": "pixoo",
            "action": "push_preset",
            "preset_name": atarget,
            "rule": "Balcony Buttons",
            "_skip_loop_guard": True,
        }
        if apayload.get("vars"):
            cmd["vars"] = apayload["vars"]
        return cmd

    log.warning("Balcony Buttons: unsupported action_type '%s' for p%db%d:%s",
                atype, page, bid, evt)
    return None


def evaluate(event, state):
    dev_id = event.get("device_id", "")
    m = _BTN_RE.match(dev_id)
    if not m:
        return []

    page = int(m.group(1))
    bid = int(m.group(2))
    dps = event.get("dps", {}) or {}
    evt = dps.get("event") or "short"
    if evt not in {"short", "long", "down", "up", "double"}:
        return []

    # Cooldown: collapse down+up+short for one tap into a single dispatch.
    cooldown_key = f"p{page}b{bid}:{evt}"
    now = time.time()
    last = _last_fired.get(cooldown_key, 0.0)
    if now - last < _COOLDOWN_SEC:
        return []
    _last_fired[cooldown_key] = now

    bindings = _get_bindings(state)
    binding = bindings.get((page, bid, evt))
    if not binding:
        log.info("Balcony Buttons: no binding for p%db%d:%s", page, bid, evt)
        return []

    cmd = _build_command(binding, page, bid, evt, state)
    if not cmd:
        return []

    log.info("Balcony Buttons: p%db%d:%s → %s %s",
             page, bid, evt, binding.get("action_type"), binding.get("action_target"))
    return [cmd]
