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

    dev_id = event.get("device_id", "")
    device = state.devices.get(dev_id, {})
    dtype = device.get("device_type", "")
    room = device.get("room", "")
    activity = state.shared.get("activity_level", "idle")
    try:
        people = int(state.shared.get("people_home", 0))
    except (ValueError, TypeError):
        people = 0

    # ── Entrance/corridor presence → push welcome preset ──
    if dtype == "presence" and room.lower() in ("entrance", "corridor"):
        dps = event.get("dps", {})
        presence_val = dps.get("1")
        if presence_val in (True, "true", "presence", 1, "True"):
            cooldown = state.get_timer("pixoo_last_push")
            if cooldown > COOLDOWN_SEC:
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
            if state.shared.get("_pixoo_resumed") != "yes":
                state.shared["_pixoo_resumed"] = "yes"
                commands.append({
                    "device_id": "pixoo",
                    "protocol": "pixoo",
                    "action": "resume",
                })
    else:
        state.shared["_pixoo_resumed"] = "no"

    return commands
