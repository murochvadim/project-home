"""Shared parser for chip-driven action tokens in rule_sentences.

Display chips (device_type='display' or protocol in {pixoo, awtrix}):

    @<DeviceName> on              → power_on
    @<DeviceName> off             → power_off
    @<DeviceName> push <preset>   → push_preset (Pixoo preset OR Awtrix saved app)

Legacy (still in use): `@Pixoo <PresetName>` ≡ `@Pixoo push <PresetName>`.

Panel chips (device_type='panel' or protocol='hasp', added 2026-05-05):

    @<PanelName> on               → backlight on
    @<PanelName> off              → backlight off
    @<PanelName> Page <N>         → goto_page N

The function still named `parse_display_chip` for back-compat with the
single existing caller (Evening Lights). Returns a command-dict ready
for rule_engine._dispatch_command, or None if the token isn't a chip
this parser knows about.
"""

import re

# `@<Panel> Page <N>` — case-insensitive; allow "page" / "Page" / "PAGE".
_PAGE_RE = re.compile(r"^page\s+(\d+)$")

def parse_display_chip(token, devices_by_name):
    """Return a command dict for a display / panel chip, or None.

    devices_by_name: map of {device_name: device_dict} where device_dict has
    at least 'id' and 'protocol' (typically built from state.devices).
    """
    if not token or not isinstance(token, str) or not token.startswith("@"):
        return None
    body = token[1:].strip()
    if not body:
        return None

    # Longest-prefix match: try the full body as device name, then shorten
    # by one trailing word until a known name matches. Handles both
    # single-word ('@Pixoo on') and multi-word ('@Multi Word Display on').
    parts = body.split()
    dev = None
    rest = ""
    for split_at in range(len(parts), 0, -1):
        candidate = " ".join(parts[:split_at])
        if candidate in devices_by_name:
            dev = devices_by_name[candidate]
            rest = " ".join(parts[split_at:]).strip()
            break

    if not dev:
        return None

    protocol  = dev.get("protocol")
    dtype     = dev.get("device_type")
    is_display = dtype == "display" or protocol in ("pixoo", "awtrix")
    is_panel   = dtype == "panel"   or protocol == "hasp"
    if not (is_display or is_panel):
        return None

    device_id  = dev.get("id")
    rest_lower = rest.lower()

    # ── Panel: HASP-specific actions (page nav + backlight on/off) ────
    if is_panel:
        m = _PAGE_RE.match(rest_lower)
        if m:
            # `@<Panel> Page <N>` → rule engine HASP branch resolves
            # via dps_config.page.action_on='goto_page' and reads
            # cmd['page_num'] as the publish payload for command/page.
            return {
                "device_id": device_id,
                "protocol":  protocol,
                "action":    "turn_on",
                "channel":   "page",
                "page_num":  int(m.group(1)),
            }
        if rest_lower in ("on", "off"):
            # Backlight toggle — engine maps via dps_config.backlight
            # alias to publish `command/backlight on|off`.
            return {
                "device_id": device_id,
                "protocol":  protocol,
                "action":    "turn_on" if rest_lower == "on" else "turn_off",
                "channel":   "backlight",
            }
        return None

    # ── Display: power + push preset ──────────────────────────────────
    if rest_lower == "on":
        return {"device_id": device_id, "protocol": protocol, "action": "power_on"}
    if rest_lower == "off":
        return {"device_id": device_id, "protocol": protocol, "action": "power_off"}

    # `push <preset>` or legacy `<preset>` (Pixoo only)
    preset_name = None
    if rest_lower.startswith("push "):
        preset_name = rest[5:].strip()
    elif protocol == "pixoo" and rest:
        # Legacy format: @Pixoo <PresetName> (no 'push' prefix) — Start Away has used this.
        preset_name = rest

    if preset_name:
        cmd = {
            "device_id": device_id,
            "protocol": protocol,
            "action": "push_preset",
            "preset_name": preset_name,
            "vars": {},
        }
        return cmd

    # Bare @DisplayName with no action — caller decides whether to skip or default.
    return None


def build_devices_by_name(state_devices):
    """Build a name → device dict suitable for parse_display_chip.

    Includes both the device's `name` and lower-cased variant for tolerance.
    """
    out = {}
    for dev_id, dev in (state_devices or {}).items():
        n = (dev.get("name") or "").strip()
        if not n:
            continue
        merged = dict(dev)
        merged["id"] = dev_id
        out[n] = merged
    return out
