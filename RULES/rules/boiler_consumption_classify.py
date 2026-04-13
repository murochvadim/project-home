"""Classify hot-water drop events into 5 categories based on presence + valve state.

Reacts to consumption events published by the boiler agent to
`mur/home/device/boiler/event`. For each new drop:
1. human  — presence in water room (always wins)
2. panel  — valve was ON ≥ PANEL_VALID_ON min, no human
3. thermal — nobody home
4. boiler — valve OFF ≥ PANEL_VALID_OFF min, someone home, no human
5. unknown — fallback
"""

WATER_ROOMS = ("Bathroom", "Kitchen", "My BathRoom")  # exact casing from rooms table
PRESENCE_WINDOW_SEC = 900   # 15 min — matches default consumption_time_delta
PANEL_VALID_ON  = 4         # min valve must be ON for panel classification
PANEL_VALID_OFF = 10        # min valve must be OFF for boiler classification

RULE = {
    "name": "Boiler Consumption Classify",
    "description": "Label drop events as human / panel / thermal / boiler / unknown",
    "triggers": ["boiler"],
    "controls": [],
    "category": "info",
    "group": "boiler",
    "priority": 10,
    "depends_on": ["Home Activity"],
    "test_event": {
        "device_id": "boiler",
        "source": "event",
        "dps": {
            "event_type":   "consumption",
            "drop_c":       5.0,
            "duration_min": 6,
            "start_ts":     "1970-01-01T00:00:00+00:00",
            "end_ts":       "1970-01-01T00:06:00+00:00",
            "start_temp":   50.0,
            "end_temp":     45.0,
            "valve_state":  False,
            "valve_on_min": None,
            "valve_off_min": 30.0,
        },
    },
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

    # Valve context from boiler agent payload
    valve_state  = dps.get("valve_state")
    valve_on_min = dps.get("valve_on_min")
    valve_off_min = dps.get("valve_off_min")

    # Presence in water rooms
    water_rooms_hit = [
        r for r in WATER_ROOMS
        if state.get_timer(f"room_active:{r}") <= PRESENCE_WINDOW_SEC
    ]

    # Presence in any room
    any_room_hit = False
    rooms_iter = getattr(state, "rooms", None) or {}
    for r in rooms_iter:
        if state.get_timer(f"room_active:{r}") <= PRESENCE_WINDOW_SEC:
            any_room_hit = True
            break

    # 5-category priority classification
    if water_rooms_hit:
        # 1. Human — presence in water room always wins
        cause = "human"
        likely = water_rooms_hit
    elif valve_state and valve_on_min is not None and valve_on_min >= PANEL_VALID_ON:
        # 2. Panel — valve ON long enough, solar cycle drop
        cause = "panel"
        likely = []
    elif not any_room_hit:
        # 3. Thermal — nobody home
        cause = "thermal"
        likely = []
    elif not valve_state and valve_off_min is not None and valve_off_min >= PANEL_VALID_OFF:
        # 4. Boiler — valve OFF long enough, someone home, natural cooling
        cause = "boiler"
        likely = []
    else:
        # 5. Unknown — fallback
        cause = "unknown"
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
