"""Estimates people count and home mode from active rooms.

Reads active_rooms from home_activity rule (shared state).
Applies movement corridor logic: if person moved A→B within 15s,
that's one person not two.

People count logic:
- Base = number of rooms with presence sensor active (high confidence)
- Subtract corridor movements (A→B within 15s = same person)
- If no presence sensors active but rooms have recent interaction → at least 1
- BSH appliance running + no other activity → at least 1 (someone started it)
- All clear for 30+ min → away
"""

CORRIDOR_SEC = 15   # max seconds between rooms to consider same person moving

RULE = {
    "name": "People Home",
    "description": "Estimate people count from active rooms + corridor movement analysis",
    "triggers": ["*"],
    "controls": [],
    "category": "info",
    "group": "info",
    "priority": 2,
    "depends_on": ["Home Activity"],
}


def evaluate(event, state):
    device = state.devices.get(event.get("device_id", ""), {})
    dtype = device.get("device_type", "")
    room = device.get("room", "")

    # ── Track presence room transitions for corridor detection ──
    if dtype == "presence" and room:
        val = event.get("dps", {}).get("1")
        if val in (True, 1, "true", "presence", "True"):
            prev_room = state.shared.get("_prev_presence_room", "")
            prev_timer = state.get_timer("_prev_presence_time")
            state.shared["_prev_presence_room"] = room
            state.set_timer("_prev_presence_time")
            # If different room within corridor window → same person moved
            if prev_room and prev_room != room and prev_timer < CORRIDOR_SEC:
                state.set_timer(f"corridor:{prev_room}>{room}")

    # ── Count rooms with HIGH confidence (presence sensor active) ──
    presence_rooms = []
    for did, dev in state.devices.items():
        if dev.get("device_type") != "presence":
            continue
        if not dev.get("online", False):
            continue
        r = dev.get("room", "")
        if not r or r in presence_rooms:
            continue
        val = dev.get("dps", {}).get("1")
        if val in (True, 1, "true", "presence", "True"):
            presence_rooms.append(r)

    # ── People count from presence rooms minus corridor movements ──
    people_count = len(presence_rooms)
    if people_count > 1:
        for i, r1 in enumerate(presence_rooms):
            for r2 in presence_rooms[i + 1:]:
                if (state.get_timer(f"corridor:{r1}>{r2}") < CORRIDOR_SEC or
                        state.get_timer(f"corridor:{r2}>{r1}") < CORRIDOR_SEC):
                    people_count -= 1
        people_count = max(1, people_count)

    # ── Fallback: active rooms from home_activity (interaction-based) ──
    active_rooms = state.shared.get("active_rooms", [])
    someone_home = state.shared.get("someone_home", False)

    if people_count == 0 and active_rooms:
        # No presence sensor active but rooms have recent interaction
        people_count = 1
    elif people_count == 0 and someone_home:
        # BSH appliance running, no other activity
        people_count = 1

    # ── Occupied rooms = union of presence + active ──
    occupied_rooms = sorted(set(presence_rooms) | set(active_rooms))

    # ── Home mode ──
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
