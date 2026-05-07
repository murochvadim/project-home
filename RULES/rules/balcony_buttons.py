"""Balcony Buttons — dispatch device commands on HASP panel button presses.

Reads bindings from `hasp_buttons.bindings` (JSONB array of device/action
combos, same shape as Living Room wallmote bindings — each element:
{device_id, channel, name, label, action}). Multi-device per button:
one panel press dispatches N commands.

Triggered by synthetic events the rule engine generates from
`hasp/balcony/state/p<page>b<id>` MQTT messages — see
`rule_engine.on_mqtt_event()` (the "Button widgets" branch). The synthetic
event has `device_id = 'hasp:balcony:p<page>b<id>'` and dps =
`{event: 'short'|'long'|'down'|'up'|'double', ...}`.

Non-device binding variants supported (less common):
  {type:'hasp_command', target:'page 2'}     — panel command
  {type:'pixoo_preset', target:'name', vars} — push a Pixoo preset
"""

import logging
import os
import re
import sys
import time

_RULES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)
from _display_chips import build_alexa_cmd as _build_alexa_cmd  # noqa: E402

log = logging.getLogger("rule.balcony_buttons")

RULE = {
    "name": "Balcony Buttons",
    "description": "Dispatch actions on HASP balcony panel button presses",
    "triggers": ["*"],
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

_COOLDOWN_SEC = 1.0
_last_fired = {}

_bindings_cache = {"data": None, "ts": 0.0}
_CACHE_TTL_SEC = 30

_BTN_RE = re.compile(r"^hasp:balcony:p(\d+)b(\d+)$")


def _get_bindings(state):
    """Return dict (page, button_id, event) → bindings_array. 30 s TTL cache."""
    now = time.time()
    if _bindings_cache["data"] is not None and (now - _bindings_cache["ts"]) < _CACHE_TTL_SEC:
        return _bindings_cache["data"]

    rows = state.db_query(
        """
        SELECT b.page, b.button_id, b.event, b.bindings
        FROM hasp_buttons b
        JOIN hasp_panels p ON p.id = b.panel_id
        WHERE p.name = 'balcony'
          AND b.bindings IS NOT NULL
          AND jsonb_array_length(b.bindings) > 0
        """
    )
    data = {}
    for row in rows or []:
        page, bid, evt, bindings = row
        data[(page, bid, evt)] = bindings or []

    _bindings_cache["data"] = data
    _bindings_cache["ts"] = now
    return data


def _resolve_toggle(state, device_id, channel):
    """Read current device state and return 'turn_on' or 'turn_off' to flip it."""
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


def _build_command(b, state):
    """Translate one binding element into a command dict (or None to skip)."""
    btype = b.get("type")  # None implies device

    if btype is None or btype == "device":
        device_id = b.get("device_id")
        if not device_id:
            return None
        channel = b.get("channel")
        action = b.get("action", "toggle")
        # Alexa speak / play / transport — see _display_chips.build_alexa_cmd
        alexa_cmd = _build_alexa_cmd(b, action, device_id, "Balcony Buttons")
        if alexa_cmd:
            return alexa_cmd
        if action == "toggle":
            action = _resolve_toggle(state, device_id, channel)
        cmd = {
            "device_id": device_id,
            "action": action,
            "rule": "Balcony Buttons",
            "_skip_loop_guard": True,
        }
        if channel:
            cmd["channel"] = channel
        if "page_num" in b:
            cmd["page_num"] = b["page_num"]
        return cmd

    if btype == "hasp_command":
        target = b.get("target") or ""
        parts = target.strip().split(" ", 1)
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

    if btype == "pixoo_preset":
        cmd = {
            "device_id": "pixoo",
            "protocol": "pixoo",
            "action": "push_preset",
            "preset_name": b.get("target"),
            "rule": "Balcony Buttons",
            "_skip_loop_guard": True,
        }
        if b.get("vars"):
            cmd["vars"] = b["vars"]
        return cmd

    log.warning("Balcony Buttons: unsupported binding type '%s'", btype)
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

    cooldown_key = f"p{page}b{bid}:{evt}"
    now = time.time()
    last = _last_fired.get(cooldown_key, 0.0)
    if now - last < _COOLDOWN_SEC:
        return []
    _last_fired[cooldown_key] = now

    bindings_map = _get_bindings(state)
    bindings = bindings_map.get((page, bid, evt))
    if not bindings:
        log.info("Balcony Buttons: no binding for p%db%d:%s", page, bid, evt)
        return []

    commands = []
    for b in bindings:
        cmd = _build_command(b, state)
        if cmd:
            commands.append(cmd)

    if commands:
        log.info("Balcony Buttons: p%db%d:%s → %d command(s)",
                 page, bid, evt, len(commands))
    return commands
