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
import threading
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

# Aeotec wallmotes fire `pushed` on press-start and `held` on the ~2-3 sec
# mark if still held, then another `held` every ~5 sec afterwards. A normal
# human press triggers both pushed AND the first held within 3-5s, so any
# binding that maps pushed=turn_on and held=turn_off ends in OFF on fast
# (zigbee) devices. Suppress `held` events that arrive within this window
# after the matching `pushed` on the same wallmote+button — so a quick tap
# or normal press only fires `pushed`, while a deliberate long hold (>7s,
# when the SECOND held arrives outside the window) still triggers the
# held binding for explicit off.
HELD_SUPPRESS_WITHIN_SEC = 5.0
# Aeotec wallmotes re-fire `held` every ~5 sec while the button is still
# depressed. Each repeat causes a fresh dispatch — for a multi-channel off
# binding (3 commands × 3+ repeats) this overshoots the rule_engine loop
# guard (4 same-target commands / 10s), auto-disabling the rule for ~6 min
# and making subsequent button presses appear to do nothing. Allow one held
# per physical press; silently drop repeats that arrive within this window
# after the last FIRING held on the same wm_slug+button.
HELD_REPEAT_SUPPRESS_SEC = 12.0
_last_pushed_ts: dict[str, float] = {}   # key = "wm_slug:button" → unix ts
_last_held_ts: dict[str, float] = {}     # key = "wm_slug:button" → unix ts of last FIRED held
_last_pushed_lock = threading.Lock()     # guards both dicts' read+write (paho thread races)


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

    # Debounce: suppress `held` arriving shortly after a `pushed` on the
    # same wallmote+button. Prevents the normal-press flash (pushed=on
    # followed by held=off 3s later) on fast zigbee devices while still
    # letting a long deliberate hold (7+ sec — second `held` fires outside
    # the window) trigger the off binding.
    tracker_key = f"{wm_slug}:{button}"
    now = time.time()
    suppress_reason = None
    # Lock the whole read-decide-write so two concurrent wallmote events on
    # the same button can't both pass the "outside window" check, or race the
    # pushed/held writes vs the held reads.
    with _last_pushed_lock:
        if event_type == "pushed":
            _last_pushed_ts[tracker_key] = now
            # New press ends the previous held-repeat window so a fresh
            # long-hold on the same button can fire again.
            _last_held_ts.pop(tracker_key, None)
        elif event_type == "held":
            last_push = _last_pushed_ts.get(tracker_key, 0.0)
            since_push = now - last_push
            last_held = _last_held_ts.get(tracker_key, 0.0)
            since_held = (now - last_held) if last_held else float("inf")
            if since_push < HELD_SUPPRESS_WITHIN_SEC:
                suppress_reason = f"{since_push:.1f}s after pushed"
            elif since_held < HELD_REPEAT_SUPPRESS_SEC:
                suppress_reason = f"{since_held:.1f}s after previous held (repeat)"
            else:
                # About to fire — record as the last firing held so the
                # next wallmote-repeat within the window gets suppressed.
                _last_held_ts[tracker_key] = now
    if event_type == "held" and suppress_reason:
        log.info("Wallmote %s %s held suppressed (%s)", wm_slug, button, suppress_reason)
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
            # Resolve current state — dps key varies by protocol/vendor:
            #   Tuya local: "1"
            #   Zigbee multi-gang: "state_l1", "state_l2", etc. (via channel)
            #   SmartThings/HA-mapped: custom name (e.g., "spots", "state")
            if channel:
                cur_val = cur_dps.get(channel)
            elif "1" in cur_dps:
                cur_val = cur_dps["1"]
            elif "state" in cur_dps:
                cur_val = cur_dps["state"]
            elif "power" in cur_dps:
                cur_val = cur_dps["power"]
            elif len(cur_dps) == 1:
                cur_val = next(iter(cur_dps.values()))  # single key — use its value
            else:
                cur_val = None
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
            # Human-input rule — skip the same-action-4x-in-10s loop guard.
            # Multi-channel "Master OFF" bindings legitimately fire 4+ turn_off
            # commands to the same device in one press, which was tripping the
            # guard and silently disabling the rule until the next engine
            # restart. Same fix as balcony_buttons.py / balcony_smart_switch_handler.py.
            "_skip_loop_guard": True,
        }
        if channel:
            cmd["channel"] = channel
        if "page_num" in b:
            cmd["page_num"] = b["page_num"]
        commands.append(cmd)

    log.info(
        "Wallmote %s %s %s → %d commands: %s",
        wm_slug, button, event_type, len(commands),
        [(c["device_id"], c.get("channel"), c["action"]) for c in commands],
    )
    return commands
