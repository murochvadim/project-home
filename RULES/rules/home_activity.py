"""Determines which rooms are active.

Simple approach — only two evidence types:
1. Presence sensor: DPS "1" = presence/true → someone detected
2. Switch (name contains room name): recent DPS change → someone operated it

Everything else ignored for now. Easy to expand later.
"""

HOLD_OFF_SEC = 10       # presence sensor clear hold-off
INTERACT_WINDOW = 120   # seconds after switch operation to count room as active

# Switch-like types that count if their name contains the room name
SWITCH_TYPES = {'switch', 'circuit_breaker', 'light'}

RULE = {
    "name": "Home Activity",
    "description": "Track active rooms from presence sensors + named switches",
    "triggers": ["*"],
    "controls": [],
    "category": "info",
}


def _name_matches_room(device_name, room):
    """Check if device name contains the room name (case-insensitive)."""
    if not device_name or not room:
        return False
    return room.lower() in device_name.lower()


def evaluate(event, state):
    dev_id = event.get("device_id", "")
    device = state.devices.get(dev_id, {})
    dtype = device.get("device_type", "")
    room = device.get("room", "")
    name = device.get("name", "")

    # ── Track events ──

    if dtype == "presence" and room:
        event_val = event.get("dps", {}).get("1")
        if event_val in (True, "true", "presence"):
            state.set_timer(f"room_active:{room}")
            state.shared["last_motion_room"] = room
            state.set_timer("last_motion")
        else:
            # Clear event — set timer for hold-off
            state.set_timer(f"room_active:{room}")

    elif dtype in SWITCH_TYPES and room and event.get("source") != "startup":
        # Only count if device name contains room name
        if _name_matches_room(name, room):
            state.set_timer(f"room_interact:{room}")
            state.set_timer(f"room_active:{room}")
            state.shared["last_motion_room"] = room
            state.set_timer("last_motion")

    # ── Scan devices to build active rooms ──

    active_rooms = []

    for did, dev in state.devices.items():
        dt = dev.get("device_type", "")
        if not dev.get("online", False):
            continue
        r = dev.get("room", "")
        if not r or r in active_rooms:
            continue

        # Presence sensor
        if dt == "presence":
            val = dev.get("dps", {}).get("1")
            if val in (True, "true", "presence"):
                active_rooms.append(r)
                continue
            if state.get_timer(f"room_active:{r}") < HOLD_OFF_SEC:
                active_rooms.append(r)
                continue

        # Named switch — recent operation
        if dt in SWITCH_TYPES and _name_matches_room(dev.get("name", ""), r):
            if state.get_timer(f"room_interact:{r}") < INTERACT_WINDOW:
                active_rooms.append(r)
                continue

    # ── Activity level ──

    count = len(active_rooms)
    if count == 0:
        level = "idle"
    elif count <= 2:
        level = "low"
    else:
        level = "active"

    state.shared["activity_level"] = level
    state.shared["active_rooms"] = sorted(active_rooms)
    state.shared["active_room_count"] = count

    return []
