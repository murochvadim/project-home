"""My Bathroom Color Panel — drive the "My Bathroom Color" RGBCW light from the
mybathroom-panel plate's page 2, and mirror the light's power back to the panel.

Two directions in one rule:
  panel event  → HA light.* service       (p2b* objects → _color_light helpers)
  light power  → panel p2b10.val          (on/off toggle reflects real power)

CONTROL IS HA-MEDIATED (light.my_bath_color), NOT local Tuya — this light's local
TCP write listener is unreliable (it sleeps / drops writes; validated 2026-06-23).
See _color_light.py for the actuator commands ({protocol:'ha_light', ...}).

Page-2 objects (MY_BATHROOM_PANEL/pages.jsonl):
  p2b10  on/off toggle    → turn_on / turn_off
  p2b20  dim slider 1-100 → brightness_pct
  p2b30  cpicker          → hs_color
  p2b40 White / p2b41 Colour → color_temp / hs_color

Per request: only the on/off button shows live state; dim/mode/colour are
write-only settings pushed to the device. The colour/dim/mode WRITE logic lives
in the shared `_color_light` helper so a FUTURE timeline/show rule reuses it (it
only has to add its own time-sequencing on top).

The engine turns `hasp/mybathroom-panel/state/p2b<id>` into a synthetic event
`device_id='hasp:mybathroom-panel:p2b<id>'`, dps = the OpenHASP payload
({event,val} for slider/toggle, {event,h,s,v,...} for cpicker). We act on the
'up' (commit) event so a slider/cpicker drag fires exactly once.
"""

import logging
import os
import sys
import time

_RULES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)
import _color_light as cl  # noqa: E402

log = logging.getLogger("rule.mybathroom_panel_color")

_PANEL = "mybathroom-panel"
_LIGHT = cl.COLOR_LIGHT_ID

# page-2 object ids
_ONOFF = "p2b10"
_DIM   = "p2b20"
_CPICK = "p2b30"
_MODE  = {"p2b40": "white", "p2b41": "colour"}   # 'scene' removed — HA entity has no effect support

_RULE_NAME = "My Bathroom Color Panel"

RULE = {
    "name": _RULE_NAME,
    "description": "Controls the My Bathroom Color light from page 2 of the My BathRoom Lights Panel — on/off, dim, white or colour, and pick a colour — and keeps the on/off button matching the light.",
    "triggers": [f"hasp:{_PANEL}:{o}" for o in (_ONOFF, _DIM, _CPICK, *_MODE)] + [_LIGHT],
    "controls": [],
    "category": "control",
    "group": "my-bathroom",
    "priority": 12,
    "depends_on": [],
}

# Commit event we act on (slider/cpicker/btn release). Other events
# (down / changed) are ignored so a drag fires exactly once.
_COMMIT_EVENTS = {"up"}
_ON_VALS = (True, 1, "1", "on", "ON", "true", "True")

# Per-object debounce — OpenHASP can emit a duplicate 'up'.
_DEBOUNCE_SEC = 0.4
_last_fired = {}


def _set_btn_val(on):
    """Push p2b10.val to make the on/off toggle SHOW `on`. Setting .val on a
    HASP toggle writes the visual without emitting an event (no feedback loop)."""
    return {
        "device_id": f"hasp:{_PANEL}",
        "action": "set",
        "path": f"{_ONOFF}.val",
        "value": "1" if on else "0",
        "rule": _RULE_NAME,
        "_skip_loop_guard": True,
    }


def _known_power(state):
    """Best estimate of the light's current power. The shadow (`_mbcolor_power`,
    updated on every press + every ha_api DP1 event) is the source of truth; on
    cold start fall back to DP1 / DP20 from last_state."""
    sh = state.shared.get("_mbcolor_power")
    if sh is not None:
        return bool(sh)
    d = (state.devices.get(_LIGHT, {}) or {}).get("dps", {}) or {}
    return d.get("1", d.get("20")) in _ON_VALS


def evaluate(event, state):
    dev_id = event.get("device_id", "")
    dps = event.get("dps", {}) or {}

    # ── Direction B: light power event → sync the on/off toggle ──
    # Power is reported on DP1 via ha_api (local_poll only reports 21/22/24).
    # Act only when this event actually carries a power DP, so mode/dim/colour
    # echoes don't churn the button.
    if dev_id == _LIGHT:
        if "1" in dps:
            on = dps["1"] in _ON_VALS
        elif "20" in dps:
            on = dps["20"] in _ON_VALS
        else:
            return []
        if state.shared.get("_mbcolor_power") == on:
            return []
        state.shared["_mbcolor_power"] = on
        return [_set_btn_val(on)]

    # ── Direction A: panel event → HA light.* service on the light ──
    if not dev_id.startswith(f"hasp:{_PANEL}:"):
        return []
    obj = dev_id.rsplit(":", 1)[-1]
    evt = dps.get("event")
    if evt is not None and evt not in _COMMIT_EVENTS:
        return []   # ignore down / changed — act on the 'up' commit only

    now = time.time()
    if now - _last_fired.get(obj, 0.0) < _DEBOUNCE_SEC:
        return []
    _last_fired[obj] = now

    if obj == _ONOFF:
        # The OpenHASP toggle free-runs (its val isn't tied to the light), so
        # don't trust dps['val'] — toggle from the last-known real power so every
        # tap definitively flips the light, then re-assert the button visual to
        # match (self-corrects any drift). External changes resync via DP1 above.
        cur = _known_power(state)
        new = not cur
        state.shared["_mbcolor_power"] = new
        log.info("%s: p2b10 toggle %s → %s", _RULE_NAME, cur, new)
        return [cl.set_power(new, _RULE_NAME), _set_btn_val(new)]

    cmd = None
    if obj == _DIM:
        cmd = cl.set_dim(dps.get("val"), _RULE_NAME)
    elif obj == _CPICK:
        cmd = cl.set_color(dps.get("h"), dps.get("s"), dps.get("v"), _RULE_NAME)
    elif obj in _MODE:
        cmd = cl.set_mode(_MODE[obj], _RULE_NAME)

    if not cmd:
        return []
    log.info("%s: %s %s → light.%s %s", _RULE_NAME, obj, evt,
             cmd.get("service"), cmd.get("data", ""))
    return [cmd]
