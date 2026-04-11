"""Label drop events as human / thermal / unknown based on presence.

Reacts to consumption events published by the boiler agent to
`mur/home/device/boiler/event`. For each new drop, checks presence
timers in the water-using rooms (and in any room overall) and writes
`cause` and (when human) `likely_rooms` back to boiler_consumptions.
"""

WATER_ROOMS = ("Bathroom", "Kitchen", "My BathRoom")  # exact casing from rooms table
PRESENCE_WINDOW_SEC = 900  # 15 min — matches default consumption_time_delta

RULE = {
    "name": "Boiler Consumption Classify",
    "description": "Label drop events as human / thermal / unknown based on presence",
    "triggers": ["boiler"],
    "controls": [],
    "category": "info",
    "group": "boiler",
    "priority": 10,
    "depends_on": ["Home Activity"],
}


def evaluate(event, state):
    if event.get("source") != "event":
        return []

    dps = event.get("dps", {})
    if dps.get("event_type") != "consumption":
        return []

    start_ts = dps.get("start_ts")
    drop_c = dps.get("drop_c")
    if not start_ts or drop_c is None:
        return []

    water_rooms_hit = [
        r for r in WATER_ROOMS
        if state.get_timer(f"room_active:{r}") <= PRESENCE_WINDOW_SEC
    ]

    any_room_hit = False
    rooms_iter = getattr(state, "rooms", None) or {}
    for r in rooms_iter:
        if state.get_timer(f"room_active:{r}") <= PRESENCE_WINDOW_SEC:
            any_room_hit = True
            break

    if water_rooms_hit:
        cause = "human"
        likely = water_rooms_hit
    elif any_room_hit:
        cause = "unknown"
        likely = []
    else:
        cause = "thermal"
        likely = []

    state.shared["last_consumption_cause"] = cause
    state.shared["last_consumption_rooms"] = likely
    state.shared["last_consumption_drop_c"] = drop_c
    state.shared["last_consumption_ts"] = start_ts
    state.set_timer("last_consumption")

    state.db_execute(
        "UPDATE boiler_consumptions SET cause = %s, likely_rooms = %s WHERE start_ts = %s",
        (cause, likely if likely else None, start_ts),
    )

    return []
