"""Estimates number of people home and which rooms are occupied.

Uses same 10s hold-off as home_activity — room stays occupied
after sensor clears to avoid flicker.
"""

HOLD_OFF_SEC = 10

RULE = {
    "name": "People Home",
    "description": "Estimate how many people are home based on presence in different rooms",
    "triggers": ["*"],
    "controls": [],
    "category": "info",
}


def evaluate(event, state):
    device = state.devices.get(event.get("device_id", ""), {})
    if device.get("device_type") != "presence":
        return []

    # Scan all presence sensors — room occupied if DPS "1" = presence OR hold-off active
    occupied = {}
    for dev_id, dev in state.devices.items():
        if dev.get("device_type") != "presence":
            continue
        if not dev.get("online", False):
            continue
        r = dev.get("room", "unknown")
        if r in occupied:
            continue

        val = dev.get("dps", {}).get("1")
        if val in (True, "true", "presence"):
            occupied[r] = True
        elif state.get_timer(f"room_active:{r}") < HOLD_OFF_SEC:
            occupied[r] = True

    occupied_rooms = list(occupied.keys())
    people_count = len(occupied_rooms)

    if people_count == 0:
        if state.get_timer("last_motion") > 1800:
            home_mode = "away"
        else:
            home_mode = "idle"
    else:
        home_mode = "active"

    state.shared["people_home"] = people_count
    state.shared["occupied_rooms"] = occupied_rooms
    state.shared["home_mode"] = home_mode

    return []
