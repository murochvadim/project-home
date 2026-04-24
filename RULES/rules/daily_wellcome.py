"""Daily Welcome — keep the Daily_Wellcome Pixoo preset on screen all day
and wipe the display at the end of the operational window.

During the window (default 08:00→23:59 local) this rule re-pushes the
Daily_Wellcome preset every 30 minutes and emits `virtual:pixoo` so
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
    "name": "Daily_Wellcome",
    "description": "Push Daily_Wellcome preset every 30 min during the window; wipe at window end",
    "triggers": ["heartbeat"],
    "controls": [],
    "category": "display",
    "group": "pixoo",
    # Low priority — Daily_Wellcome is the always-on default. Any future
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

    # Wipe time = window end. Reads the live RULE dict, which the engine
    # mutates in place when dashboard overrides are applied, so whatever
    # end time is configured is where the wipe fires. Falls back to the
    # file default only if the key is somehow missing.
    wipe_hhmm = (RULE.get("conditions", {})
                     .get("time", {})
                     .get("before", "23:59"))

    # End-of-day wipe — checked before the push path so it always wins at
    # the boundary. One-hour cooldown prevents double-fire across the 60s
    # heartbeats inside the boundary minute.
    if now_hhmm == wipe_hhmm:
        if state.get_timer("daily_wellcome_wipe_cooldown") >= WIPE_COOLDOWN_SEC:
            state.set_timer("daily_wellcome_wipe_cooldown")
            state.emit_virtual_event(
                virtual_id="virtual:pixoo",
                dps={
                    "current_preset": None,
                    "current_owner":  None,
                    "last_push_ts":   datetime.now(timezone.utc).isoformat(),
                },
                source="rule:Daily_Wellcome",
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
                "rule":      "Daily_Wellcome",
            }]
        return []

    # Cooldown short-circuit — the vast majority of heartbeats return here.
    if state.get_timer("daily_wellcome_cooldown") < COOLDOWN_SEC:
        return []

    state.set_timer("daily_wellcome_cooldown")

    # Update the shared Pixoo state so other Pixoo rules + dashboards know
    # what's currently on the screen and which rule put it there.
    state.emit_virtual_event(
        virtual_id="virtual:pixoo",
        dps={
            "current_preset": "Daily_Wellcome",
            "current_owner":  "Daily_Wellcome",
            "last_push_ts":   datetime.now(timezone.utc).isoformat(),
        },
        source="rule:Daily_Wellcome",
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
        "preset_name": "Daily_Wellcome",
        "rule":        "Daily_Wellcome",
    }]
