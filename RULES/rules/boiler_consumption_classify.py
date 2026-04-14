"""Classify hot-water drop events into 5 categories based on presence + valve state.

Reacts to consumption events published by the boiler agent to
`mur/home/device/boiler/event`. For each new drop, queries device_events at
the drop's start_ts to get accurate historical state (time-travel), then applies:
1. human  — presence in water room (always wins)
2. panel  — valve was ON >= PANEL_VALID_ON min, no human
3. thermal — nobody home
4. boiler — valve OFF >= PANEL_VALID_OFF min, someone home, no human
5. unknown — fallback

Does NOT rely on MQTT payload valve context or in-memory timers — all state
is queried from device_events at the actual drop time.
"""

import logging
from datetime import datetime, timedelta, timezone

log = logging.getLogger('rule.boiler_consumption_classify')

# Boiler Valve Tuya device id — queried from device_events for valve state history
BOILER_VALVE_ID = 'bffb608d69654a9b09eqgt'
VALVE_DPS_KEY = '1'

WATER_ROOMS = ("Bathroom", "Kitchen", "My BathRoom")  # exact casing from rooms table
PRESENCE_WINDOW_SEC = 900   # 15 min — presence window around drop's start_ts
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
    "depends_on": ["Home Activity", "People Home"],
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
        },
    },
}


def _parse_ts(ts):
    """Parse ISO string or pass through datetime; always return UTC-aware datetime or None."""
    if ts is None:
        return None
    if isinstance(ts, datetime):
        dt = ts
    else:
        try:
            dt = datetime.fromisoformat(str(ts))
        except (ValueError, TypeError):
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _truthy_presence(val):
    return val in (True, 1, "true", "True", "presence", "1")


def evaluate(event, state):
    if event.get("source") != "event":
        return []

    dps = event.get("dps", {})
    if dps.get("event_type") != "consumption":
        return []

    start_ts_raw = dps.get("start_ts")
    drop_c = dps.get("drop_c")
    if not start_ts_raw or drop_c is None:
        return []

    start_ts = _parse_ts(start_ts_raw)
    if start_ts is None:
        log.warning("Classify: cannot parse start_ts=%s — skipping", start_ts_raw)
        return []

    # ── Valve state at drop time (from device_events, not MQTT payload) ──
    valve_dps = state.get_device_state_at(BOILER_VALVE_ID, start_ts)
    valve_state = None
    if valve_dps is not None:
        v = valve_dps.get(VALVE_DPS_KEY)
        valve_state = v in (True, 1, "true", "True")

    # ── Valve on/off duration at drop time ──
    valve_on_min = None
    valve_off_min = None
    transition = state.get_last_transition_before(BOILER_VALVE_ID, VALVE_DPS_KEY, start_ts)
    if transition is not None:
        trans_ts, _prev, _new = transition
        trans_dt = _parse_ts(trans_ts)
        if trans_dt is not None:
            elapsed_min = (start_ts - trans_dt).total_seconds() / 60.0
            if valve_state is True:
                valve_on_min = round(elapsed_min, 1)
            elif valve_state is False:
                valve_off_min = round(elapsed_min, 1)

    # ── Presence in water rooms at drop time ──
    # Get presence sensor device IDs grouped by room (from in-memory registry)
    water_room_sensors = {r: [] for r in WATER_ROOMS}
    all_presence_sensors = []
    for dev_id, dev in state.devices.items():
        if dev.get('device_type') != 'presence':
            continue
        room = dev.get('room', '')
        if not room:
            continue
        all_presence_sensors.append(dev_id)
        if room in water_room_sensors:
            water_room_sensors[room].append(dev_id)

    # Query motion events near start_ts
    from_ts = start_ts - timedelta(seconds=PRESENCE_WINDOW_SEC)
    to_ts = start_ts + timedelta(seconds=300)  # +5 min for late-arriving events

    water_rooms_hit = []
    for room, sensor_ids in water_room_sensors.items():
        if not sensor_ids:
            continue
        events = state.get_events_between(sensor_ids, from_ts, to_ts)
        for _ev_ts, _dev_id, ev_dps in events:
            if _truthy_presence(ev_dps.get('1')):
                water_rooms_hit.append(room)
                break

    # ── Home state at drop time (virtual device) ──
    home_dps = state.get_device_state_at('virtual:people_home', start_ts)
    if home_dps is not None:
        any_room_hit = bool(home_dps.get('someone_home', False))
    else:
        # Fallback: check motion events across any presence sensor
        any_events = state.get_events_between(all_presence_sensors, from_ts, to_ts)
        any_room_hit = any(_truthy_presence(ev_dps.get('1')) for _t, _d, ev_dps in any_events)

    # ── 5-category priority classification ──
    if water_rooms_hit:
        cause = "human"
        likely = sorted(set(water_rooms_hit))
    elif valve_state is True and valve_on_min is not None and valve_on_min >= PANEL_VALID_ON:
        cause = "panel"
        likely = []
    elif not any_room_hit:
        cause = "thermal"
        likely = []
    elif valve_state is False and valve_off_min is not None and valve_off_min >= PANEL_VALID_OFF:
        cause = "boiler"
        likely = []
    else:
        cause = "unknown"
        likely = []

    log.info(
        "Classified drop %.1f°C at %s as '%s' (valve=%s on_min=%s off_min=%s water_rooms=%s any_room=%s)",
        float(drop_c), start_ts.isoformat(), cause,
        valve_state, valve_on_min, valve_off_min, water_rooms_hit, any_room_hit,
    )

    state.shared["last_consumption_cause"] = cause
    state.shared["last_consumption_rooms"] = likely
    state.shared["last_consumption_drop_c"] = drop_c
    state.shared["last_consumption_ts"] = start_ts_raw
    state.set_timer("last_consumption")

    # Emit virtual device event for downstream rules / dashboards
    state.emit_virtual_event(
        virtual_id='virtual:boiler_status',
        dps={
            'last_cause': cause,
            'last_drop_c': float(drop_c),
            'last_rooms': likely,
            'last_start_ts': start_ts.isoformat(),
        },
        source='rule:Boiler Consumption Classify',
        name='Boiler Consumption State',
        dps_labels={
            'last_cause': 'Last Cause',
            'last_drop_c': 'Last Drop (°C)',
            'last_rooms': 'Likely Rooms',
            'last_start_ts': 'Last Drop Start',
        },
    )

    # Write cause back to boiler_consumptions; check rowcount to catch silent failures
    rc = state.db_execute(
        "UPDATE boiler_consumptions SET cause = %s, likely_rooms = %s WHERE start_ts = %s",
        (cause, likely if likely else None, start_ts_raw),
    )
    if rc == 0:
        log.warning("Classify: UPDATE affected 0 rows — start_ts=%s may not exist in boiler_consumptions", start_ts_raw)

    return []
