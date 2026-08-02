"""Irrigation Log — record every valve open→close watering session to the DB.

Triggers on the 4 water-timer valve ids. On a valve 'open' state it stamps the
open time (+ source) in state.shared; on 'closed' it computes the duration and
INSERTs one `irrigation_log` row (valve_id, valve_name, opened_at, closed_at,
duration_sec, source). Captures BOTH scheduled (Balcony Irrigation rule) and
manual (dashboard button) opens — each changes the valve's HA state, which the
device agent publishes as a `mur/home/device/<id>/event` the rule engine fires on.

source = 'schedule' if the Balcony Irrigation rule's `irrigation.<vk>.open_until_ts`
is still in the future at open time (an active scheduled window), else 'manual'.

Private tracking keys are `_`-prefixed so this info rule doesn't inflate its Runs
counter on every valve event (the engine's real-fire gate ignores `_` keys) while
still persisting across an engine restart. Own group so it never collides with the
heartbeat-driven Balcony Irrigation rule.
"""

import logging
import time

log = logging.getLogger("rule.irrigation_log")

# valve entity id -> schedule key (matches balcony_irrigation.VALVES)
VALVES = {
    "valve.water_timer_valve_1":      "v1",
    "valve.water_timer_valve_2":      "v2",
    "valve.rf_water_timer_3_valve_1": "v3",
    "valve.rf_water_timer_3_valve_2": "v4",
}
_MAX_SESSION_SEC = 24 * 3600   # guard: ignore absurd durations (stuck-open / lost close)

RULE = {
    "name": "Irrigation Log",
    "description": "Records every watering session (a valve opening then closing) to the database with the valve name, start time and how long it ran — for both scheduled and manual runs. View it on the Balcony page → Irrigation tab → Watering history card.",
    "triggers": list(VALVES.keys()),
    "controls": [],
    "category": "info",
    "group": "irrigation-log",
    "priority": 10,
}


def evaluate(event, state):
    dev_id = event.get("device_id")
    if dev_id not in VALVES:
        return []
    st = (event.get("dps") or {}).get("state")
    if st is None:
        st = ((state.devices.get(dev_id, {}) or {}).get("dps") or {}).get("state")
    if st is None:
        return []
    st = str(st).lower()
    vk = VALVES[dev_id]
    ok = f"_irrigation_log.{dev_id}.open_ts"
    sk = f"_irrigation_log.{dev_id}.source"
    now_ts = time.time()

    # ── OPEN: start a session (skip if already open — dedupes repeat 'open' reports) ──
    if st in ("open", "opening"):
        try:
            already = float(state.shared.get(ok) or 0)
        except (TypeError, ValueError):
            already = 0.0
        if not already:
            state.shared[ok] = now_ts
            try:
                ou = float(state.shared.get(f"irrigation.{vk}.open_until_ts") or 0)
            except (TypeError, ValueError):
                ou = 0.0
            state.shared[sk] = "schedule" if ou > now_ts else "manual"
            log.info("irrigation_log: %s OPEN (source=%s)", dev_id, state.shared[sk])
        return []

    # ── CLOSE: end a session and log it. 'closing' is intermediate → wait for 'closed'. ──
    if st == "closing":
        return []
    if st == "closed":
        try:
            open_ts = float(state.shared.get(ok) or 0)
        except (TypeError, ValueError):
            open_ts = 0.0
        if not open_ts:
            return []   # spurious close (no open seen, e.g. startup/re-seed) → ignore
        dur = int(round(now_ts - open_ts))
        state.shared[ok] = 0            # clear (state.shared is UPSERT-only → falsy sentinel, not pop)
        if dur <= 0 or dur > _MAX_SESSION_SEC:
            log.info("irrigation_log: %s CLOSE skipped (duration %ss out of range)", dev_id, dur)
            return []
        name = (state.devices.get(dev_id, {}) or {}).get("name") or dev_id
        source = state.shared.get(sk) or "unknown"
        try:
            state.db_execute(
                """INSERT INTO irrigation_log
                     (valve_id, valve_name, opened_at, closed_at, duration_sec, source)
                   VALUES (%s, %s, to_timestamp(%s), to_timestamp(%s), %s, %s)""",
                (dev_id, name, open_ts, now_ts, dur, source))
            log.info("irrigation_log: %s logged — %s, %ss, source=%s", dev_id, name, dur, source)
        except Exception as e:
            log.warning("irrigation_log: DB insert failed for %s: %s", dev_id, e)
        return []

    return []
