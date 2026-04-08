"""Computes home activity level from all presence sensors.

Presence detected → immediate update.
Clear detected → 10s hold-off before removing room (avoids flicker).
"""

HOLD_OFF_SEC = 10  # seconds to keep room active after sensor clears

RULE = {
    "name": "Home Activity",
    "description": "Track activity level across all rooms based on presence sensor state",
    "triggers": ["*"],
    "controls": [],
    "category": "info",
}


def evaluate(event, state):
    device = state.devices.get(event.get("device_id", ""), {})
    if device.get("device_type") != "presence":
        return []

    room = device.get("room", "")

    # Any event from a presence sensor = someone caused it
    if room:
        state.set_timer(f"room_active:{room}")

    # Presence detected → update last motion immediately
    event_val = event.get("dps", {}).get("1")
    if event_val in (True, "true", "presence") and room:
        state.shared["last_motion_room"] = room
        state.set_timer("last_motion")

    # Scan all presence sensors — room is active if:
    # 1. DPS "1" = presence, OR
    # 2. room_active timer < HOLD_OFF_SEC (recent event, sensor may have briefly cleared)
    active_rooms = []
    for dev_id, dev in state.devices.items():
        if dev.get("device_type") != "presence":
            continue
        if not dev.get("online", False):
            continue
        r = dev.get("room", "")
        if not r or r in active_rooms:
            continue

        val = dev.get("dps", {}).get("1")
        if val in (True, "true", "presence"):
            active_rooms.append(r)
        elif state.get_timer(f"room_active:{r}") < HOLD_OFF_SEC:
            active_rooms.append(r)

    count = len(active_rooms)
    if count == 0:
        level = "idle"
    elif count <= 2:
        level = "low"
    else:
        level = "active"

    state.shared["activity_level"] = level
    state.shared["active_rooms"] = active_rooms
    state.shared["active_room_count"] = count

    return []
