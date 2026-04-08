"""Determines which rooms are active from ALL device types.

Evidence sources (strongest to weakest):
- Presence sensor: DPS "1" = presence/true → direct human detection (continuous)
- Switch/light/circuit_breaker/curtain/remote: recent DPS change → someone operated it
- BSH appliance running: someone started it → "someone is home" but not "in this room"

Timing:
- Presence detected → room immediately active
- Presence cleared → 10s hold-off (avoids sensor flicker)
- Device operated → room active for 120s (interaction window)
- BSH running → contributes to "someone_home" flag, not room activity

Ignored device types (not presence indicators):
- siren, gateway, gas_detector, co_alarm, water_sensor, temp_controller
"""

HOLD_OFF_SEC = 10       # presence sensor clear hold-off
INTERACT_WINDOW = 120   # seconds after device operation to count room as active

# Device types that indicate someone operated a device in the room
INTERACT_TYPES = {'switch', 'circuit_breaker', 'light', 'curtain', 'remote',
                  'water_heater', 'door_sensor'}

# BSH appliance types — indicate someone is home but not necessarily in the room
BSH_TYPES = {'dishwasher', 'oven', 'washer', 'hood', 'hob'}

# Ignored — infrastructure or alert devices, not presence indicators
IGNORE_TYPES = {'siren', 'gateway', 'gas_detector', 'co_alarm',
                'water_sensor', 'temp_controller'}

RULE = {
    "name": "Home Activity",
    "description": "Track active rooms from all device types — presence, switches, appliances",
    "triggers": ["*"],
    "controls": [],
    "category": "info",
}


def evaluate(event, state):
    device = state.devices.get(event.get("device_id", ""), {})
    dtype = device.get("device_type", "")
    room = device.get("room", "")
    dev_id = event.get("device_id", "")

    # Skip ignored device types
    if dtype in IGNORE_TYPES:
        return []

    # ── Track events per device type ──

    if dtype == "presence":
        event_val = event.get("dps", {}).get("1")
        if event_val in (True, "true", "presence") and room:
            state.set_timer(f"room_active:{room}")
            state.shared["last_motion_room"] = room
            state.set_timer("last_motion")
        elif room:
            # Clear event — still set timer so hold-off works
            state.set_timer(f"room_active:{room}")

    elif dtype in INTERACT_TYPES and room:
        # Any DPS change from an interactive device = someone in the room
        # Skip startup events — we only care about real-time changes
        if event.get("source") != "startup":
            state.set_timer(f"room_interact:{room}")
            state.set_timer(f"room_active:{room}")
            state.shared["last_motion_room"] = room
            state.set_timer("last_motion")

    elif dtype in BSH_TYPES:
        # BSH appliance event — track globally, not per-room
        state.set_timer("bsh_active")

    # ── Scan all devices to build active rooms list ──

    active_rooms = []
    bsh_running = False

    for did, dev in state.devices.items():
        dt = dev.get("device_type", "")
        if dt in IGNORE_TYPES:
            continue
        if not dev.get("online", False):
            continue
        r = dev.get("room", "")
        if not r or r in active_rooms:
            continue

        # Presence sensor — strongest signal
        if dt == "presence":
            val = dev.get("dps", {}).get("1")
            if val in (True, "true", "presence"):
                active_rooms.append(r)
                continue
            # Hold-off after clear
            if state.get_timer(f"room_active:{r}") < HOLD_OFF_SEC:
                active_rooms.append(r)
                continue

        # Interactive device — recent operation
        if dt in INTERACT_TYPES:
            if state.get_timer(f"room_interact:{r}") < INTERACT_WINDOW:
                active_rooms.append(r)
                continue

        # BSH appliance — check if running
        if dt in BSH_TYPES:
            dps = dev.get("dps", {})
            op = dps.get("BSH.Common.Status.OperationState", "")
            if "Run" in str(op):
                bsh_running = True

    # ── Determine activity level ──

    count = len(active_rooms)
    if count == 0:
        level = "idle"
    elif count <= 2:
        level = "low"
    else:
        level = "active"

    # ── Update shared state ──

    state.shared["activity_level"] = level
    state.shared["active_rooms"] = sorted(active_rooms)
    state.shared["active_room_count"] = count
    state.shared["someone_home"] = count > 0 or bsh_running

    return []
