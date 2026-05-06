"""My BathRoom Button Mirror — keep panel button visuals synced to real device state.

The complement of `my_bathroom_buttons.py`:
  buttons.py:  panel press → device command   (input: hasp → device)
  mirror.py:   device state → panel pXbY.val  (output: device → hasp)

For every `hasp_buttons` row with action_type='device' on the my-bathroom panel,
this rule subscribes (via wildcard early-return) to the bound device's state
events and publishes `hasp/my-bathroom/command/p<page>b<button_id>.val` = 0/1
whenever `dps[channel]` flips. That keeps the button's @checked tint in sync
when the device is toggled OUT-OF-BAND (HA dashboard, mobile app, manual
switch, another rule), not just from panel presses.

Bindings are cached for 30 s. Setting `.val` on a HASP toggle-button writes
the visual state without emitting an event — no feedback loop.
"""

import logging
import time

log = logging.getLogger("rule.my_bathroom_button_mirror")

RULE = {
    "name": "My BathRoom Button Mirror",
    "description": "Sync HASP my-bathroom panel button visuals to bound device state",
    "triggers": ["*"],  # wildcard with prefix early-return — see evaluate()
    "controls": [],
    "category": "display",
    "group": "my-bathroom",
    "priority": 60,
    "depends_on": ["My BathRoom Buttons"],
}

_CACHE_TTL_SEC = 30
_cache = {"data": None, "ts": 0.0}
_last_sent = {}  # (page, button_id) → last val we published (0 or 1)


def _bindings_by_device(state):
    """Return dict device_id → [{page, button_id, channel}, …] for every
    button whose first device-type binding points at that device.

    'First device' semantics: a button with N bindings can fan out to N
    devices, but the panel's @checked tint is binary — we mirror only the
    first device-type binding's state. User puts the 'representative'
    device first if it matters.
    30 s TTL cache.
    """
    now = time.time()
    if _cache["data"] is not None and (now - _cache["ts"]) < _CACHE_TTL_SEC:
        return _cache["data"]

    rows = state.db_query(
        """
        SELECT b.page, b.button_id, b.bindings
        FROM hasp_buttons b
        JOIN hasp_panels p ON p.id = b.panel_id
        WHERE p.name = 'my-bathroom'
          AND b.bindings IS NOT NULL
          AND jsonb_array_length(b.bindings) > 0
        """
    )
    by_device = {}
    for row in rows or []:
        page, bid, bindings = row
        if not bindings:
            continue
        # Find first device-type binding (skip hasp_command / pixoo_preset)
        first = next((b for b in bindings
                      if (b.get("type") in (None, "device")) and b.get("device_id")), None)
        if not first:
            continue
        target = first.get("device_id")
        channel = first.get("channel")
        if not channel:
            continue
        by_device.setdefault(target, []).append(
            {"page": page, "button_id": bid, "channel": channel}
        )
    _cache["data"] = by_device
    _cache["ts"] = now
    return by_device


def evaluate(event, state):
    dev_id = event.get("device_id", "")
    if not dev_id:
        return []

    bindings = _bindings_by_device(state).get(dev_id)
    if not bindings:
        return []

    dps = event.get("dps", {})
    if not isinstance(dps, dict):
        return []

    commands = []
    for b in bindings:
        channel = b["channel"]
        if channel not in dps:
            continue  # this state event doesn't carry the bound channel

        val = dps[channel]
        is_on = val in (True, 1, "on", "ON", "true", "True")
        target_val = 1 if is_on else 0

        key = (b["page"], b["button_id"])
        if _last_sent.get(key) == target_val:
            continue  # no change — skip
        _last_sent[key] = target_val

        commands.append({
            "device_id": "hasp:my-bathroom",
            "protocol": "hasp",
            "path": f"p{b['page']}b{b['button_id']}.val",
            "value": target_val,
            "rule": "My BathRoom Button Mirror",
            "_skip_loop_guard": True,
        })

    if commands:
        log.info("My BathRoom Button Mirror: %s → %d button visuals updated",
                 dev_id, len(commands))
    return commands
