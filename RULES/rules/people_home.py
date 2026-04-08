"""Estimates number of people home and which rooms are occupied."""

RULE = {
    "name": "People Home",
    "description": "Estimate how many people are home based on presence in different rooms",
    "triggers": ["*"],  # fires on any device event
    "controls": [],     # read-only — no commands
    "category": "info",
}


def evaluate(event, state):
    # Only process presence sensor events
    device = state.devices.get(event.get("device_id", ""), {})
    if device.get("device_type") != "presence":
        return []

    # Find all rooms with active presence
    occupied = {}  # room → list of sensor names
    for dev_id, dev in state.devices.items():
        if dev.get("device_type") != "presence":
            continue
        if not dev.get("online", False):
            continue
        dps = dev.get("dps", {})
        # DPS "1": True, "true", "presence" all mean someone is there
        val = dps.get("1")
        if val in (True, "true", "presence"):
            room = dev.get("room", "unknown")
            occupied.setdefault(room, []).append(dev.get("name", dev_id))

    occupied_rooms = list(occupied.keys())

    # Rough people estimate:
    # - Each occupied room that is far from others suggests a different person
    # - Simple heuristic: number of occupied rooms = rough people count
    # - Minimum 1 if any room occupied, 0 if all clear
    people_count = len(occupied_rooms) if occupied_rooms else 0

    # Determine home occupancy status
    if people_count == 0:
        home_mode = state.shared.get("home_mode", "away")
        # Only set to "away" if no motion for 30+ minutes
        if state.get_timer("last_motion") > 1800:
            home_mode = "away"
        else:
            home_mode = "idle"  # recently active but no current presence
    else:
        home_mode = "active"

    # Update shared state
    state.shared["people_home"] = people_count
    state.shared["occupied_rooms"] = occupied_rooms
    state.shared["home_mode"] = home_mode

    return []  # read-only, no commands
