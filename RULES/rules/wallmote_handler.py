"""Wallmote Handler — dispatch device commands on Wallmote button presses.

Reads bindings from `dashboard_settings` (key=`living-room.wallmote_bindings`),
saved by the Living Room Agent dashboard page. Each button × event type (pushed /
held) maps to a list of target devices with per-device actions (turn_on /
turn_off / toggle).

Triggered by any HA state change (trigger `*`); filters for the two wallmote
device_ids and looks for a `pushed:` / `held:` prefix in the button event DPS
value. Toggle resolves against in-memory `state.devices[id].dps[channel]`.

Bindings are cached 30 seconds to avoid hitting the DB on every event.
"""

import json
import logging
import time

log = logging.getLogger("rule.wallmote_handler")

RULE = {
    "name": "Wallmote Handler",
    "description": "Dispatch device commands based on Wallmote button presses (pushed/held)",
    "triggers": ["*"],
    "controls": [],  # dynamic — resolved per binding
    "category": "control",
    "group": "living-room",
    "priority": 5,
    "depends_on": [],
    "test_event": {
        "device_id": "e410cc7b-a734-4177-b941-2394dd7a5f7f",
        "source": "ha_api",
        "dps": {"button1": "pushed:2026-04-14T15:00:00+00:00"},
    },
}

# Map wallmote HA device_id → slug used in the dashboard bindings keys
WALLMOTE_IDS = {
    "e410cc7b-a734-4177-b941-2394dd7a5f7f": "wm1",
    "62f40d30-5c63-4d97-bf55-c602d1e2ee93": "wm2",
}

_bindings_cache = {"data": None, "ts": 0.0}
_CACHE_TTL_SEC = 30


def _get_bindings(state):
    """Load wallmote bindings from dashboard_settings with TTL cache."""
    now = time.time()
    if _bindings_cache["data"] is not None and (now - _bindings_cache["ts"]) < _CACHE_TTL_SEC:
        return _bindings_cache["data"]

    rows = state.db_query(
        "SELECT value FROM dashboard_settings WHERE key = 'living-room.wallmote_bindings'"
    )
    data = {}
    if rows:
        v = rows[0][0]
        if isinstance(v, str):
            try:
                v = json.loads(v)
            except Exception:
                v = {}
        if isinstance(v, dict):
            data = v

    _bindings_cache["data"] = data
    _bindings_cache["ts"] = now
    return data


def evaluate(event, state):
    dev_id = event.get("device_id", "")
    wm_slug = WALLMOTE_IDS.get(dev_id)
    if not wm_slug:
        return []

    dps = event.get("dps", {}) or {}

    # Find the button event: dps value looks like 'pushed:<ts>' or 'held:<ts>'
    button = None
    event_type = None
    for k, v in dps.items():
        if not isinstance(k, str) or not k.startswith("button"):
            continue
        if not isinstance(v, str):
            continue
        if v.startswith("pushed:"):
            button, event_type = k, "pushed"
            break
        if v.startswith("held:"):
            button, event_type = k, "held"
            break
    if not button:
        return []

    bindings = _get_bindings(state)
    slot_key = f"{wm_slug}:{button}:{event_type}"
    slot = bindings.get(slot_key, [])
    if not slot:
        log.info("Wallmote %s %s %s — no binding", wm_slug, button, event_type)
        return []

    commands = []
    for b in slot:
        device_id = b.get("device_id")
        if not device_id:
            continue
        channel = b.get("channel")
        action = b.get("action", "turn_on")

        if action == "toggle":
            dev_state = state.devices.get(device_id, {}) or {}
            cur_dps = dev_state.get("dps", {}) or {}
            key = channel or "1"
            cur_val = cur_dps.get(key)
            # Interpret various truthy/falsy shapes
            if cur_val in (True, 1, "on", "ON", "true", "True"):
                target = "turn_off"
            else:
                target = "turn_on"
        elif action in ("turn_on", "turn_off"):
            target = action
        else:
            log.warning("Unknown action '%s' in binding for %s — skipping", action, slot_key)
            continue

        cmd = {
            "device_id": device_id,
            "action": target,
            "rule": "Wallmote Handler",
        }
        if channel:
            cmd["channel"] = channel
        commands.append(cmd)

    log.info(
        "Wallmote %s %s %s → %d commands: %s",
        wm_slug, button, event_type, len(commands),
        [(c["device_id"], c.get("channel"), c["action"]) for c in commands],
    )
    return commands
