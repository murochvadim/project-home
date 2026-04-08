"""Computes home activity level from all presence sensors."""

RULE = {
    "name": "Home Activity",
    "description": "Track activity level across all rooms based on presence sensor state",
    "triggers": ["*"],  # fires on any device event
    "controls": [],     # read-only — no commands
    "category": "info",
}


def evaluate(event, state):
    # Only process presence sensor events
    device = state.devices.get(event.get("device_id", ""), {})
    if device.get("device_type") != "presence":
        return []

    # Count rooms with active presence
    active_rooms = []
    for dev_id, dev in state.devices.items():
        if dev.get("device_type") != "presence":
            continue
        if not dev.get("online", False):
            continue
        dps = dev.get("dps", {})
        # DPS key "1" = presence state for Tuya presence sensors (True = detected)
        if dps.get("1") == True or dps.get("1") == "true":
            room = dev.get("room", "")
            if room and room not in active_rooms:
                active_rooms.append(room)

    # Determine activity level
    count = len(active_rooms)
    if count == 0:
        level = "idle"
    elif count <= 2:
        level = "low"
    else:
        level = "active"

    # Track last motion room
    if device.get("device_type") == "presence":
        dps = event.get("dps", {})
        if dps.get("1") == True or dps.get("1") == "true":
            state.shared["last_motion_room"] = device.get("room", "unknown")
            state.set_timer("last_motion")

    # Update shared state
    state.shared["activity_level"] = level
    state.shared["active_rooms"] = active_rooms
    state.shared["active_room_count"] = count

    return []  # read-only, no commands
