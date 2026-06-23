"""My BathRoom Lights Panel Buttons — dispatch device commands on hasp button
presses for the **mybathroom-panel** plate (the Lights Panel tab's Button Bindings).

Clone of `my_bathroom_buttons.py` scoped to panel `mybathroom-panel`. Reads bindings
from `hasp_buttons WHERE p.name='mybathroom-panel'` (set via the dashboard Button
Bindings card) and dispatches each: device toggle/on/off (+ alexa/vacuum via
`_display_chips`), `hasp_command`, `pixoo_preset`. Multi-device per button supported.

Triggered by the synthetic events the engine makes from
`hasp/mybathroom-panel/state/p<page>b<id>` (device_id `hasp:mybathroom-panel:p<page>b<id>`,
dps `{event: short|long|down|up|double, …}`).

⚠ `_RESERVED` guard: the plate's existing buttons (page-1 relays, page-2 colour,
page-3 Alexa) are driven by DEDICATED rules (laundry_light / mybathroom /
mybathroom_panel_color / mybathroom_panel_alexa) that trigger on the SAME object ids.
This generic handler SKIPS those reserved ids so binding one in the dashboard card
can't double-fire. Only SPARE / future buttons act on bindings.
"""

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

log = logging.getLogger("rule.mybathroom_panel_buttons")

_PANEL = "mybathroom-panel"
_RULE_NAME = "My BathRoom Lights Panel Buttons"

RULE = {
    "name": _RULE_NAME,
    "description": "Dispatch actions on hasp mybathroom-panel button presses (Button Bindings card)",
    "triggers": ["*"],   # wildcard with prefix early-return — see evaluate()
    "controls": [],
    "category": "control",
    "group": "my-bathroom",
    "priority": 10,
    "depends_on": [],
}

# Buttons already driven by dedicated rules (relays / colour / Alexa). The generic
# binding handler skips them so binding one in the card can't double-fire alongside
# its dedicated rule. Add a button here if a future dedicated rule claims it.
_RESERVED = {
    "p1b10", "p1b20",                                        # page-1 relays
    "p2b10", "p2b20", "p2b30", "p2b40", "p2b41",             # page-2 colour
    "p3b10", "p3b11", "p3b12", "p3b13", "p3b14", "p3b15",    # page-3 Alexa media
    "p3b20", "p3b21", "p3b22", "p3b30",                       # page-3 transport + volume
}

_COOLDOWN_SEC = 1.0
_last_fired = {}

_bindings_cache = {"data": None, "ts": 0.0}
_CACHE_TTL_SEC = 30

_BTN_RE = re.compile(r"^hasp:mybathroom-panel:p(\d+)b(\d+)$")


def _get_bindings(state):
    """(page, button_id, event) → bindings_array. 30 s TTL cache."""
    now = time.time()
    if _bindings_cache["data"] is not None and (now - _bindings_cache["ts"]) < _CACHE_TTL_SEC:
        return _bindings_cache["data"]
    rows = state.db_query(
        """
        SELECT b.page, b.button_id, b.event, b.bindings
        FROM hasp_buttons b
        JOIN hasp_panels p ON p.id = b.panel_id
        WHERE p.name = 'mybathroom-panel'
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
        dev = state.devices.get(device_id, {}) or {}
        special_cmd = (_build_alexa_cmd(b, action, device_id, _RULE_NAME, dev)
                       or _build_vacuum_cmd(b, action, device_id, _RULE_NAME, dev))
        if special_cmd:
            return special_cmd
        if action == "toggle":
            action = _resolve_toggle(state, device_id, channel)
        cmd = {"device_id": device_id, "action": action, "rule": _RULE_NAME, "_skip_loop_guard": True}
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
            "device_id": f"hasp:{_PANEL}", "protocol": "hasp",
            "path": path, "value": value,
            "rule": _RULE_NAME, "_skip_loop_guard": True,
        }

    if btype == "pixoo_preset":
        cmd = {
            "device_id": "pixoo", "protocol": "pixoo", "action": "push_preset",
            "preset_name": b.get("target"), "rule": _RULE_NAME, "_skip_loop_guard": True,
        }
        if b.get("vars"):
            cmd["vars"] = b["vars"]
        return cmd

    log.warning("%s: unsupported binding type '%s'", _RULE_NAME, btype)
    return None


def evaluate(event, state):
    dev_id = event.get("device_id", "")
    m = _BTN_RE.match(dev_id)
    if not m:
        return []

    page = int(m.group(1))
    bid = int(m.group(2))
    if f"p{page}b{bid}" in _RESERVED:
        return []   # driven by a dedicated rule — never act on bindings here

    dps = event.get("dps", {}) or {}
    evt = dps.get("event") or "short"
    if evt not in {"short", "long", "down", "up", "double"}:
        return []

    cooldown_key = f"p{page}b{bid}:{evt}"
    now = time.time()
    if now - _last_fired.get(cooldown_key, 0.0) < _COOLDOWN_SEC:
        return []
    _last_fired[cooldown_key] = now

    bindings = _get_bindings(state).get((page, bid, evt))
    if not bindings:
        return []

    commands = []
    for b in bindings:
        cmd = _build_command(b, state)
        if cmd:
            commands.append(cmd)
    if commands:
        log.info("%s: p%db%d:%s → %d command(s)", _RULE_NAME, page, bid, evt, len(commands))
    return commands
