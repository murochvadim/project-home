"""
Template rule — copy this file and modify for your rule.
Files starting with _ are skipped by the rule loader.
"""

RULE = {
    "name": "Template Rule",
    "description": "Copy this file and modify for your rule",
    "triggers": [],     # device IDs that trigger this rule (or ["*"] for any event)
    "controls": [],     # device IDs this rule may command (empty = read-only)
    "category": "info", # lighting, security, comfort, info
    # Optional — only needed if the rule reacts to a custom event payload
    # (not a normal presence/switch event). The dashboard Test button will
    # use this payload to synthesize an event so the rule actually fires.
    # Without it, Test defaults to the first presence device's current state.
    # "test_event": {
    #     "device_id": "boiler",
    #     "source":    "event",
    #     "dps":       {"event_type": "consumption", "drop_c": 5.0, ...},
    # },
}


def evaluate(event, state):
    """
    Called on each matching MQTT event.

    Args:
        event: {"device_id": str, "dps": dict, "source": str, "ts": str}
        state: StateManager instance
            state.devices[id] → {"dps": {...}, "online": bool, "name": str, "room": str, "device_type": str}
            state.rooms[name] → {"devices": [id, ...]}
            state.shared → dict (persistent shared state)
            state.set_timer(name) / state.get_timer(name) → float seconds

    Returns:
        list of command dicts: [{"device_id": str, "action": str, "channel": str, ...}]
        Return [] for no action (read-only rules always return [])
    """
    return []
