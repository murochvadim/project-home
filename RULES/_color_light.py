"""Shared actuator helpers for the "My Bathroom Color" RGBCW light.

ONE place that knows how to translate a desired power / dim / colour / white
into the command the rule engine dispatches. A FUTURE timeline / "show" rule
reuses these directly — it only adds its own time-sequencing on top.

CONTROL IS HA-MEDIATED, not local Tuya. This light's local TCP write listener
is unreliable — it sleeps and drops off, and `set_dps` writes silently don't
land (validated 2026-06-23: local DP20/DP1 writes never turned it on; HA
`light.my_bath_color` did). So every helper emits an `ha_light` command that
`rule_engine._dispatch_ha_light` POSTs to HA's `light.*` services (same urllib
pattern as `_dispatch_curtain`). The device row stays `protocol='local'` (the
device-agent still ingests its ha_api state for the on/off mirror).

HA entity `light.my_bath_color` supports `hs_color` + `color_temp` only (no
scene/effect). The OpenHASP cpicker emits H 0-360 / S 0-100 = HA's `hs_color`
exactly, and V → brightness.
"""

COLOR_LIGHT_ID = "80578725d8bfc003b2a0"   # devices-row id (used for the mirror trigger)
HA_ENTITY      = "light.my_bath_color"     # the working control entity (HA)
WHITE_KELVIN   = 4000                       # neutral white for the White mode button
MODES          = ("white", "colour")        # 'scene' dropped — HA entity has no effect support


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _ha(service, data, rule):
    """Build an `ha_light` command. service = 'turn_on' | 'turn_off';
    data = optional light.turn_on attributes (brightness_pct / hs_color / …)."""
    cmd = {
        "device_id": COLOR_LIGHT_ID,
        "protocol":  "ha_light",
        "entity_id": HA_ENTITY,
        "service":   service,
        "rule":      rule,
        "_skip_loop_guard": True,
    }
    if data:
        cmd["data"] = data
    return cmd


def set_power(on, rule):
    return _ha("turn_on" if on else "turn_off", None, rule)


def set_dim(pct, rule):
    """0-100 slider → HA brightness_pct (1-100)."""
    try:
        pct = float(pct)
    except (TypeError, ValueError):
        return None
    return _ha("turn_on", {"brightness_pct": int(_clamp(round(pct), 1, 100))}, rule)


def set_color(h, s, v, rule):
    """cpicker H/S → HA hs_color. Brightness is left to the dim slider (the
    cpicker's V is ignored so picking a colour doesn't blow brightness to 100)."""
    try:
        h, s = float(h), float(s)
    except (TypeError, ValueError):
        return None
    return _ha("turn_on", {"hs_color": [int(_clamp(round(h), 0, 360)),
                                        int(_clamp(round(s), 0, 100))]}, rule)


def set_mode(mode, rule):
    """White → color_temp (white mode). Colour → flip to colour mode (the
    cpicker is the real colour tool; this just leaves white mode)."""
    if mode not in MODES:
        return None
    if mode == "white":
        return _ha("turn_on", {"color_temp_kelvin": WHITE_KELVIN}, rule)
    if mode == "colour":
        return _ha("turn_on", {"hs_color": [30, 100]}, rule)
    return None
