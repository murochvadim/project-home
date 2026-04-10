"""Pixoo display control — push presets based on home state.

- Entrance motion → push "welcome" preset with person count
- Home idle 10 min → resume rotation
- Cooldown: 5 min between pushes to avoid rapid fire
"""

COOLDOWN_SEC = 300      # 5 min between preset pushes
IDLE_TIMEOUT_SEC = 600  # 10 min idle → resume rotation

RULE = {
    "name": "Pixoo Display",
    "description": "Control Pixoo64 display based on home activity",
    "triggers": ["*"],
    "controls": [],
    "category": "display",
}


def evaluate(event, state):
    commands = []

    last_motion_room = state.shared.get("last_motion_room", "")
    activity = state.shared.get("activity_level", "idle")
    people = state.shared.get("people_home", 0)

    # Track previous activity to detect transitions
    prev_activity = state.shared.get("_pixoo_prev_activity", "idle")
    state.shared["_pixoo_prev_activity"] = activity

    # ── Entrance activity → push welcome preset ──
    if last_motion_room.lower() in ("entrance", "corridor"):
        cooldown = state.get_timer("pixoo_last_push")
        if cooldown > COOLDOWN_SEC:
            # Transition from idle/low to active at entrance
            if activity in ("active", "low") and prev_activity == "idle":
                state.set_timer("pixoo_last_push")
                commands.append({
                    "device_id": "pixoo",
                    "protocol": "pixoo",
                    "action": "push_preset",
                    "preset_name": "welcome",
                    "vars": {"name": str(people) + (" people" if people != 1 else " person")},
                })

    # ── Idle timeout → resume rotation ──
    if activity == "idle":
        idle_time = state.get_timer("last_motion")
        if idle_time > IDLE_TIMEOUT_SEC:
            # Only resume once (check if already resumed)
            if state.shared.get("_pixoo_resumed") != "yes":
                state.shared["_pixoo_resumed"] = "yes"
                commands.append({
                    "device_id": "pixoo",
                    "protocol": "pixoo",
                    "action": "resume",
                })
    else:
        # Reset resumed flag when activity returns
        state.shared["_pixoo_resumed"] = "no"

    return commands
