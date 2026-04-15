"""Daily Welcome — keep the Daily_Wellcome Pixoo preset on screen all day.

During the operational window (08:00 → 01:00 next morning, wraps midnight),
this rule re-pushes the Daily_Wellcome preset every 30 minutes. Acts as both
the initial morning push AND the periodic alive-check: if Pixoo was offline
when the rule fired, the next 30-min cycle will land it once the device is
back. Once the preset is on screen, the pixoo service's internal 60-second
{{time}} ticker keeps the clock ticking — this rule does not need to fire
that often, just often enough to recover from outages and to refresh the
ownership claim in virtual:pixoo.

Wildcard trigger with cooldown short-circuit: every device event hits the
cooldown check first and returns in microseconds when not yet due, so the
rule is cheap even at high event rates.
"""

from datetime import datetime, timezone


RULE = {
    "name": "Daily_Wellcome",
    "description": "Push Daily_Wellcome preset every 30 min during 08:00→01:00",
    "triggers": ["*"],
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
        # Wraps midnight — rule engine handles after > before correctly.
        "time": {"after": "08:00", "before": "01:00"},
    },
    # Wildcard rule listens to any event, so the synthetic presence test the
    # engine generates by default would also fire it. Keeping an explicit
    # test_event makes Test results deterministic.
    "test_event": {
        "device_id": "boiler",
        "source":    "event",
        "dps":       {"event_type": "manual_test"},
    },
}


COOLDOWN_SEC = 30 * 60  # 30 min between pushes


def evaluate(event, state):
    # Cooldown short-circuit — the vast majority of wildcard events return here.
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
