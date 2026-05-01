"""Shared parser for display-device chips in rule_sentences.

Chip token formats produced by the dashboard's device picker for any
device with `device_type='display'` (currently Pixoo + Awtrix):

    @<DeviceName> on              → power_on
    @<DeviceName> off             → power_off
    @<DeviceName> push <preset>   → push_preset (Pixoo preset OR Awtrix saved app)

Legacy format (still in use): `@Pixoo <PresetName>` — same as
`@Pixoo push <PresetName>`. Recognized as a fallback.

`parse_display_chip(token, devices_by_name)` returns a command-dict ready
for rule_engine._dispatch_command, or None if the token isn't a display
chip.
"""

def parse_display_chip(token, devices_by_name):
    """Return a command dict for a display chip, or None.

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
    if dev.get("device_type") != "display" and dev.get("protocol") not in ("pixoo", "awtrix"):
        return None

    device_id = dev.get("id")
    protocol = dev.get("protocol")

    rest_lower = rest.lower()
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
