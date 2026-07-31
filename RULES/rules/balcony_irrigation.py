"""Balcony Irrigation — per-zone daily timed watering (HCT-636 water timer).

Two zones (Water Valve 1 / 2), each with ANY NUMBER of schedules set on the
dashboard (Balcony agent → Irrigation tab). Each schedule = enabled + start
time (HH:MM) + duration (min) + days-of-week. Config lives in dashboard_settings
key 'balcony.irrigation':

    {"v1": {"schedules": [
              {"id": "s1", "enabled": true, "start_hm": "07:00",
               "duration_min": 10, "days": [1, 3, 5]},           # Mon/Wed/Fri
              {"id": "s2", "enabled": true, "start_hm": "19:30",
               "duration_min": 8,  "days": [0,1,2,3,4,5,6]}]},    # every day
     "v2": {"schedules": []}}

`days` = weekday ints, 0=Sunday … 6=Saturday (missing = every day; empty =
never). At a schedule's start time (on a matching day) the rule OPENS the zone's
valve; after `duration_min` it CLOSES it. Overlapping schedules extend the
watering window to the latest close. Control is HA-mediated via the engine's
protocol='valve' dispatch (valve.open_valve / valve.close_valve).

SAFETY (why auto-close is heartbeat-reconciled, NOT a _delay_sec timer):
a water valve must never get stuck open. `_delay_sec` is an in-memory
threading.Timer that is LOST if the engine restarts mid-watering → flood risk.
Instead we record `open_until_ts` in state.shared (DB-persisted, survives an
engine restart) and CLOSE on any heartbeat where now >= open_until_ts. Worst
case the valve stays open ~1 extra heartbeat (≤60 s) — safe — and a restart in
the middle still closes the valve on the next tick. No reliance on timers.

Crossing-edge open (fires only when the clock crosses the start minute in
(prev_eval_min, now_min]) + a per-zone daily latch, same pattern as
bedroom_balcony_blinds. Heartbeat-triggered; dedicated single-rule group so its
auto-close is never suppressed by per-group mutual exclusion.
"""

import json
import logging
import time
from datetime import datetime

try:
    from zoneinfo import ZoneInfo
    _TZ = ZoneInfo("Asia/Jerusalem")
except Exception:
    _TZ = None

log = logging.getLogger("rule.balcony_irrigation")

# zone key -> HA valve entity id (which is also the devices-table id)
VALVES = {
    "v1": "valve.water_timer_valve_1",
    "v2": "valve.water_timer_valve_2",
}
_SK          = "irrigation"          # state.shared key prefix
_CONFIG_KEY  = "balcony.irrigation"  # dashboard_settings key
_MAX_MIN     = 720                   # duration hard cap (12 h) — defensive

RULE = {
    "name": "Balcony Irrigation",
    "description": "Waters the balcony: each zone of the water timer opens at its set time and automatically closes after its set number of minutes. Set the time and duration per zone on the Balcony page, Irrigation tab.",
    "triggers": ["heartbeat"],
    "controls": [],
    "category": "control",
    "group": "irrigation",   # dedicated group so the auto-close is never suppressed
    "priority": 10,
}

_cfg_cache = {"data": None, "ts": 0.0}
_CFG_TTL = 30.0


def _load_config(state):
    """Read dashboard_settings['balcony.irrigation'] (30 s TTL cache)."""
    now = time.time()
    if _cfg_cache["data"] is not None and (now - _cfg_cache["ts"]) < _CFG_TTL:
        return _cfg_cache["data"]
    data = {}
    try:
        rows = state.db_query(
            "SELECT value FROM dashboard_settings WHERE key=%s", (_CONFIG_KEY,))
        raw = rows[0][0] if rows else {}
        if isinstance(raw, str):
            raw = json.loads(raw)
        if isinstance(raw, dict):
            data = raw
    except Exception as e:
        log.warning("balcony_irrigation: config read failed: %s", e)
    _cfg_cache["data"] = data
    _cfg_cache["ts"] = now
    return data


def _start_min(spec):
    """Parse 'HH:MM' -> minutes-since-midnight, or None."""
    hm = str(spec.get("start_hm", "")).strip()
    if ":" not in hm:
        return None
    try:
        h, m = hm.split(":", 1)
        h, m = int(h), int(m)
        if 0 <= h < 24 and 0 <= m < 60:
            return h * 60 + m
    except (ValueError, TypeError):
        pass
    return None


def _duration_sec(spec):
    try:
        d = int(spec.get("duration_min", 0))
    except (ValueError, TypeError):
        return 0
    return max(0, min(_MAX_MIN, d)) * 60


def _crossed(target_min, prev_min, now_min):
    """True if target_min falls in (prev_min, now_min] mod 1440. First run
    (prev_min None) primes without firing."""
    if prev_min is None or prev_min == now_min:
        return False
    if prev_min < now_min:
        return prev_min < target_min <= now_min
    return target_min > prev_min or target_min <= now_min   # wrapped past midnight


def _day_ok(days, dow):
    """days: list of weekday ints (0=Sun … 6=Sat). None → every day; a list →
    only those days (empty list → never)."""
    if days is None:
        return True
    if isinstance(days, list):
        return dow in days
    return True


def evaluate(event, state):
    commands = []
    cfg = _load_config(state)

    now = datetime.now(_TZ) if _TZ else datetime.now()
    now_ts  = time.time()
    now_min = now.hour * 60 + now.minute
    today   = now.strftime("%Y-%m-%d")
    dow     = int(now.strftime("%w"))   # 0=Sunday … 6=Saturday

    prev_min = state.shared.get(f"{_SK}.last_eval_min")
    state.shared[f"{_SK}.last_eval_min"] = now_min   # advance cursor every tick

    for vk, entity in VALVES.items():
        spec = cfg.get(vk) or {}
        scheds = spec.get("schedules")
        if not isinstance(scheds, list):
            scheds = [spec] if spec.get("start_hm") else []   # back-compat: lone schedule
        ou_key = f"{_SK}.{vk}.open_until_ts"

        # ── OPEN: each enabled schedule whose start minute is crossed today,
        #    on a matching weekday, once per day (per-schedule latch). ──
        for sched in scheds:
            if not isinstance(sched, dict) or sched.get("enabled") is False:
                continue
            smin = _start_min(sched)
            dsec = _duration_sec(sched)
            if smin is None or dsec <= 0 or not _day_ok(sched.get("days"), dow):
                continue
            sid = str(sched.get("id") or sched.get("start_hm") or smin)
            date_key = f"{_SK}.{vk}.{sid}.date"
            if _crossed(smin, prev_min, now_min) and state.shared.get(date_key) != today:
                commands.append({"device_id": entity, "protocol": "valve",
                                 "action": "open", "rule": RULE["name"]})
                try:
                    prev_ou = float(state.shared.get(ou_key) or 0)
                except (TypeError, ValueError):
                    prev_ou = 0.0
                state.shared[ou_key]   = max(prev_ou, now_ts + dsec)   # overlaps extend the window
                state.shared[date_key] = today
                log.info("Balcony Irrigation: %s OPEN (%s, %d min)", vk, sched.get("start_hm"), dsec // 60)

        # ── CLOSE when the watering window elapses (restart-safe reconcile) ──
        try:
            ou = float(state.shared.get(ou_key) or 0)
        except (TypeError, ValueError):
            ou = 0.0
        if ou and now_ts >= ou:
            commands.append({"device_id": entity, "protocol": "valve",
                             "action": "close", "rule": RULE["name"]})
            state.shared[ou_key] = 0   # falsy sentinel (state.shared is UPSERT-only)
            log.info("Balcony Irrigation: %s CLOSE (watering window elapsed)", vk)

    return commands
