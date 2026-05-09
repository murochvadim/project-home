"""Daily Welcome — keep the Daily_Welcome Pixoo preset on screen all day
and wipe the display at the end of the operational window.

During the window (default 08:00→23:59 local) this rule re-pushes the
Daily_Welcome preset every 30 minutes and emits `virtual:pixoo` so
other Pixoo rules + dashboards see the current owner. At the exact
minute of the window's `before` time it issues a single wipe (clears
the display + the virtual ownership) so the Pixoo sits dark overnight
until next morning's first push.

The wipe time is derived at evaluation time from the rule's own
`conditions.time.before` — so editing the end time (in code here or
via the dashboard's DB override) automatically moves the wipe to
match. Single source of truth.

Heartbeat trigger (every 60s) ensures the boundary minute is reliably
caught regardless of device-event timing.
"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo


LOCAL_TZ = ZoneInfo("Asia/Jerusalem")

COOLDOWN_SEC       = 30 * 60        # 30 min between pushes
WIPE_COOLDOWN_SEC  = 60 * 60        # at most one wipe per hour (safety)


RULE = {
    "name": "Daily_Welcome",
    "description": "Push Daily_Welcome preset every 30 min during the window; wipe at window end",
    "triggers": ["heartbeat"],
    "controls": [],
    "category": "display",
    "group": "pixoo",
    # Low priority — Daily_Welcome is the always-on default. Any future
    # pixoo rule (alarms, notifications, status banners) should use a
    # smaller number so it wins the group conflict and overrides the
    # welcome temporarily. Lower number = higher priority in this engine.
    "priority": 90,
    "depends_on": [],
    "conditions": {
        # Wipe fires at `before` exactly; editing this (or overriding
        # via the dashboard) also moves the wipe — `evaluate` reads it.
        "time": {"after": "08:00", "before": "23:59"},
    },
    # Heartbeat trigger fires once per 60s; test_event mirrors the shape
    # the engine's heartbeat loop produces so the Test button path matches
    # production firing.
    "test_event": {
        "device_id": "heartbeat",
        "source":    "tick",
        "dps":       {},
    },
}


def evaluate(event, state):
    now_local = datetime.now(LOCAL_TZ)
    now_hhmm  = now_local.strftime("%H:%M")
    now_min   = now_local.hour * 60 + now_local.minute
    today_iso = now_local.date().isoformat()

    # Wipe time = window end. Reads the live RULE dict, which the engine
    # mutates in place when dashboard overrides are applied, so whatever
    # end time is configured is where the wipe fires. Falls back to the
    # file default only if the key is somehow missing.
    wipe_hhmm = (RULE.get("conditions", {})
                     .get("time", {})
                     .get("before", "23:59"))
    try:
        _wh, _wm = wipe_hhmm.split(":")
        wipe_min = int(_wh) * 60 + int(_wm)
    except (ValueError, AttributeError):
        wipe_min = 23 * 60 + 59

    # End-of-day wipe — crossing-edge detection on the wipe minute.
    # Exact equality (`now_hhmm == wipe_hhmm`) silently misses whenever the
    # 60 s heartbeat tick drifts past the minute boundary (state load takes
    # ~1 s, pushing datetime.now() one minute past where the tick was
    # scheduled). Crossing-edge tolerates drift; the daily latch + 1 h
    # cooldown still prevent double-fire.
    prev_now_min = state.shared.get("_daily_welcome_last_eval_min")
    state.shared["_daily_welcome_last_eval_min"] = now_min
    last_wipe_date = state.shared.get("_daily_welcome_wipe_date", "")

    wipe_crossed = False
    if isinstance(prev_now_min, int):
        delta = (now_min - prev_now_min) % 1440
        if 0 < ((wipe_min - prev_now_min) % 1440) <= delta:
            wipe_crossed = True

    if wipe_crossed and last_wipe_date != today_iso:
        if state.get_timer("daily_welcome_wipe_cooldown") >= WIPE_COOLDOWN_SEC:
            state.set_timer("daily_welcome_wipe_cooldown")
            state.shared["_daily_welcome_wipe_date"] = today_iso
            state.emit_virtual_event(
                virtual_id="virtual:pixoo",
                dps={
                    "current_preset": None,
                    "current_owner":  None,
                    "last_push_ts":   datetime.now(timezone.utc).isoformat(),
                },
                source="rule:Daily_Welcome",
                name="Pixoo State",
                dps_labels={
                    "current_preset": "Current Preset",
                    "current_owner":  "Current Owner (rule)",
                    "last_push_ts":   "Last Push",
                },
            )
            return [{
                "device_id": "pixoo",
                "protocol":  "pixoo",
                "action":    "wipe",
                "rule":      "Daily_Welcome",
            }]
        return []

    # Cooldown short-circuit — the vast majority of heartbeats return here.
    if state.get_timer("daily_welcome_cooldown") < COOLDOWN_SEC:
        return []

    state.set_timer("daily_welcome_cooldown")

    # Update the shared Pixoo state so other Pixoo rules + dashboards know
    # what's currently on the screen and which rule put it there.
    state.emit_virtual_event(
        virtual_id="virtual:pixoo",
        dps={
            "current_preset": "Daily_Welcome",
            "current_owner":  "Daily_Welcome",
            "last_push_ts":   datetime.now(timezone.utc).isoformat(),
        },
        source="rule:Daily_Welcome",
        name="Pixoo State",
        dps_labels={
            "current_preset": "Current Preset",
            "current_owner":  "Current Owner (rule)",
            "last_push_ts":   "Last Push",
        },
    )

    return [{
        "device_id":   "pixoo",
        "protocol":    "pixoo",
        "action":      "push_preset",
        "preset_name": "Daily_Welcome",
        "rule":        "Daily_Welcome",
    }]
