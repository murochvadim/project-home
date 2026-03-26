#!/opt/Agents-agent/venv/bin/python3
"""
Boiler Agent — controls the solar boiler valve via Home Assistant.
Reads settings and data from PostgreSQL, writes decisions back to DB.
"""

import os
import sys
import time
import subprocess
import logging
from datetime import datetime, timedelta

import psycopg2
import psycopg2.extras
import requests
import pytz

# ── Config ────────────────────────────────────────────────────────────────────
TIMEZONE  = pytz.timezone('Asia/Jerusalem')
DB_CONFIG = {
    'host':     '192.168.1.219',
    'database': 'home_data',
    'user':     'postgres',
    'port':     5432,
}
HA_URL    = 'http://192.168.1.110:8123'
HA_TOKEN  = os.environ.get('HA_TOKEN', '')
HA_ENTITY = 'switch.boiler_valve_switch_switch_1'
AGENT_DIR = '/opt/Agents-agent/project'

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[
        logging.FileHandler('/var/log/boiler-agent.log'),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

def now_local():
    return datetime.now(TIMEZONE)


def get_version():
    try:
        r = subprocess.run(
            ['git', 'rev-parse', 'HEAD'],
            capture_output=True, text=True, cwd=AGENT_DIR, timeout=5
        )
        return r.stdout.strip() or None
    except Exception:
        return None


def is_operational_hours(dt=None):
    """True between 07:00 and 18:59 local time."""
    if dt is None:
        dt = now_local()
    return 7 <= dt.hour < 19


def set_valve_ha(state: bool):
    service = 'turn_on' if state else 'turn_off'
    resp = requests.post(
        f'{HA_URL}/api/services/switch/{service}',
        headers={
            'Authorization': f'Bearer {HA_TOKEN}',
            'Content-Type': 'application/json',
        },
        json={'entity_id': HA_ENTITY},
        timeout=10,
    )
    resp.raise_for_status()


def get_trend(values):
    """Returns 'up', 'down', or 'stable' from a list of floats."""
    if len(values) < 2:
        return 'stable'
    mid = max(len(values) // 2, 1)
    first_avg  = sum(values[:mid]) / mid
    second_avg = sum(values[mid:]) / (len(values) - mid)
    diff = second_avg - first_avg
    if diff > 0.3:
        return 'up'
    elif diff < -0.3:
        return 'down'
    return 'stable'


def ensure_utc(ts):
    """Make a datetime timezone-aware (UTC) if it isn't already."""
    if ts is None:
        return None
    if ts.tzinfo is None:
        return pytz.utc.localize(ts)
    return ts


def get_valid_panel_temps(trend_rows, panel_valid_after_on, panel_valid_after_off):
    """
    Filter panel_temp readings from trend_rows based on validity windows.
    - After valve ON:  invalid for first panel_valid_after_on minutes
    - After valve OFF: valid for panel_valid_after_off minutes, then invalid
    Returns list of valid panel_temp floats in chronological order.
    """
    if not trend_rows:
        return []

    transitions = []
    prev_vs = trend_rows[0]['valve_state']
    for row in trend_rows[1:]:
        if row['valve_state'] != prev_vs:
            transitions.append((ensure_utc(row['ts']), row['valve_state']))
            prev_vs = row['valve_state']

    valid = []
    for row in trend_rows:
        row_ts = ensure_utc(row['ts'])

        last_trans_ts    = None
        last_trans_state = None
        for t_ts, t_vs in reversed(transitions):
            if t_ts <= row_ts:
                last_trans_ts    = t_ts
                last_trans_state = t_vs
                break

        if last_trans_ts is None:
            # No transition in window — assume valid (conservative)
            valid.append(float(row['panel_temp']))
            continue

        elapsed_min = (row_ts - last_trans_ts).total_seconds() / 60.0

        if last_trans_state:   # Transition to ON
            is_valid = elapsed_min >= panel_valid_after_on
        else:                  # Transition to OFF
            is_valid = elapsed_min <= panel_valid_after_off

        if is_valid:
            valid.append(float(row['panel_temp']))

    return valid


def get_waiting_run_number(conn, trend_runs):
    """
    Detect if the agent is currently in the waiting phase after a turn_on.
    Returns (run_number, trend_runs) if waiting phase is active, else None.
    run_number is 1-indexed: 1 = first run after turn_on, trend_runs = last run.

    Detection: scan the last trend_runs rows DESC.
    - Rows from most recent must all be 'waiting' until we hit 'turn_on'
    - Any other decision (keep_on, turn_off, hold, no_action) before reaching
      'turn_on' means the waiting phase has already resolved — return None.
    """
    with conn.cursor() as cur:
        cur.execute(
            'SELECT decision FROM agent_boiler_data ORDER BY ts DESC LIMIT %s',
            (trend_runs,)
        )
        rows = [r[0] for r in cur.fetchall()]

    for i, decision in enumerate(rows):
        if decision == 'turn_on':
            return (i + 1, trend_runs)
        if decision != 'waiting':
            # Resolved decision before turn_on — waiting phase is done
            return None

    return None  # turn_on not found within trend_runs rows


def get_time_since_last_close(conn):
    """
    Returns minutes since the last ON→OFF valve transition in raw_data.
    Returns None if no such transition found (valve never been ON — first morning run).
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT ts FROM (
                SELECT ts, valve_state,
                       LAG(valve_state) OVER (ORDER BY ts) AS prev_state
                FROM raw_data
                ORDER BY ts DESC
                LIMIT 500
            ) t
            WHERE valve_state = false AND prev_state = true
            ORDER BY ts DESC
            LIMIT 1
        """)
        row = cur.fetchone()

    if row is None:
        return None

    last_close_ts = ensure_utc(row[0])
    return (datetime.now(pytz.utc) - last_close_ts).total_seconds() / 60.0


def write_result(conn, boiler_temp, panel_temp, valve_state,
                 boiler_trend, panel_trend, decision, why_decision, error, next_ts, version):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO agent_boiler_data
                (ts, boiler_temp, panel_temp, valve_state,
                 boiler_trend, panel_trend, decision, why_decision, error, next_ts, version)
            VALUES
                (NOW(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (boiler_temp, panel_temp, valve_state,
              boiler_trend, panel_trend, decision, why_decision, error, next_ts, version))


# ── Main agent run ─────────────────────────────────────────────────────────────

def run_agent():
    """Execute one full agent cycle. Returns minutes to sleep until next run."""
    now     = now_local()
    version = get_version()
    log.info(f"─── Agent run at {now.strftime('%Y-%m-%d %H:%M:%S %Z')} version={version} ───")

    conn        = None
    settings    = None
    valve_state = None
    boiler_temp = None
    panel_temp  = None

    try:
        conn = psycopg2.connect(**DB_CONFIG)

        # ── Safety Rule A (pre-check) — needs valve_state from raw_data ──────
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute('SELECT * FROM raw_data ORDER BY ts DESC LIMIT 1')
            latest = cur.fetchone()

        if not latest:
            raise RuntimeError('raw_data table is empty')

        valve_state = bool(latest['valve_state'])
        boiler_temp = float(latest['boiler_temp'])
        panel_temp  = float(latest['panel_temp'])

        if valve_state and not is_operational_hours(now):
            log.warning('Safety Rule A: valve ON outside 07:00–19:00 → turning OFF')
            set_valve_ha(False)
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute('SELECT run_interval_min FROM agent_settings LIMIT 1')
                s = cur.fetchone()
            interval = int(s['run_interval_min']) if s else 5
            next_ts  = now + timedelta(minutes=interval)
            write_result(conn, boiler_temp, panel_temp, False,
                         None, None, 'turn_off',
                         'Safety Rule A: valve ON outside operational hours (07:00–19:00)',
                         'NO ERROR', next_ts, version)
            conn.commit()
            return interval

        # ── Step 0: Read settings ─────────────────────────────────────────────
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute('SELECT * FROM agent_settings LIMIT 1')
            settings = cur.fetchone()

        if not settings:
            raise RuntimeError('agent_settings table is empty')

        run_interval_min      = int(settings['run_interval_min'])
        panel_valid_after_on  = int(settings['panel_temp_valid_after_on'])
        panel_valid_after_off = int(settings['panel_temp_valid_after_off'])
        trend_runs            = int(settings['trend_runs'])
        temp_debounce         = float(settings['temp_debounce'])
        probe_interval_min    = int(settings['probe_interval_min'])
        agent_enabled         = bool(settings['agent_enabled'])
        next_ts               = now + timedelta(minutes=run_interval_min)

        if not agent_enabled:
            log.info('Agent disabled → writing disabled')
            write_result(conn, boiler_temp, panel_temp, valve_state,
                         None, None, 'disabled', 'Agent is disabled', 'NO ERROR', next_ts, version)
            conn.commit()
            return run_interval_min

        # ── Step 1: Read trend data ───────────────────────────────────────────
        window_min = trend_runs * run_interval_min
        cutoff     = datetime.now(pytz.utc) - timedelta(minutes=window_min)

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT ts, boiler_temp, panel_temp, valve_state
                FROM raw_data
                WHERE ts >= %s
                ORDER BY ts ASC
            """, (cutoff,))
            trend_rows = cur.fetchall()

        # 1B: Boiler trend — all readings (sensor unaffected by valve transitions)
        boiler_temps = [float(r['boiler_temp']) for r in trend_rows]
        boiler_trend = get_trend(boiler_temps)

        # 1C: Panel trend — validity-filtered readings only
        valid_panel = get_valid_panel_temps(
            trend_rows, panel_valid_after_on, panel_valid_after_off
        )

        error = 'NO ERROR'
        if len(valid_panel) >= 2:
            panel_trend           = get_trend(valid_panel)
            panel_trend_available = True
        else:
            panel_trend           = None
            panel_trend_available = False
            log.warning(f'Panel trend unavailable: {len(valid_panel)} valid readings in window')

        log.info(f"State: boiler={boiler_temp}°C  panel={panel_temp}°C  valve={'ON' if valve_state else 'OFF'}")
        log.info(f"Trends: boiler={boiler_trend}  panel={panel_trend or '(unavailable)'}  valid_panel_readings={len(valid_panel)}")

        # ── Step 4: Decision Logic ────────────────────────────────────────────
        decision     = None
        why_decision = None

        if valve_state:
            # ── Valve is ON ──────────────────────────────────────────────────
            waiting = get_waiting_run_number(conn, trend_runs)

            if waiting:
                run_num, total = waiting
                is_last_run    = (run_num == total)
                log.info(f'Waiting phase: run {run_num}/{total}  last={is_last_run}')

                if is_last_run:
                    # Final waiting run — decide based on panel trend
                    if panel_trend == 'up':
                        decision     = 'keep_on'
                        why_decision = (f'Last waiting run ({run_num}/{total}): '
                                        f'panel trend UP → heating confirmed')
                        log.info('Waiting last run: panel UP → keep_on')

                    elif panel_trend == 'down':
                        decision     = 'turn_off'
                        why_decision = (f'Last waiting run ({run_num}/{total}): '
                                        f'panel trend DOWN → panel is cooling')
                        log.info('Waiting last run: panel DOWN → turn_off')
                        set_valve_ha(False)
                        valve_state = False

                    else:  # stable or unavailable
                        decision     = 'hold'
                        why_decision = (f'Last waiting run ({run_num}/{total}): '
                                        f'panel trend stable/unavailable → hold, re-evaluate next run')
                        log.info('Waiting last run: panel stable/unavailable → hold')

                else:
                    # Mid-wait — early abort if panel trend DOWN (and readings are valid)
                    if panel_trend_available and panel_trend == 'down':
                        decision     = 'turn_off'
                        why_decision = (f'Waiting run {run_num}/{total}: '
                                        f'panel trend DOWN → early abort, panel is cooling')
                        log.info(f'Waiting run {run_num}: panel DOWN → early abort turn_off')
                        set_valve_ha(False)
                        valve_state = False

                    else:
                        decision = 'waiting'
                        if not panel_trend_available:
                            why_decision = (f'Waiting run {run_num}/{total}: '
                                            f'panel readings not yet valid, stabilising')
                        else:
                            why_decision = (f'Waiting run {run_num}/{total}: '
                                            f'panel trend {panel_trend} → continue waiting')
                        log.info(f'Waiting run {run_num}: {why_decision}')

            elif not panel_trend_available:
                # Valve ON, not in waiting, no valid panel trend → WARN
                error        = 'WARN: not valid panel_temp'
                decision     = 'no_action'
                why_decision = ('Panel trend unavailable — cannot evaluate, '
                                'holding current valve state')
                log.warning('Valve ON, not waiting, panel trend unavailable → no_action (WARN)')

            else:
                # Normal Decision — valve ON, waiting complete, panel trend available
                if panel_temp > boiler_temp + temp_debounce:
                    decision     = 'keep_on'
                    why_decision = (f'Panel {panel_temp:.1f}°C > '
                                    f'Boiler {boiler_temp:.1f}°C + debounce {temp_debounce}°C → keep_on')
                    log.info(f'Normal: panel {panel_temp} > boiler {boiler_temp} + {temp_debounce} → keep_on')

                elif panel_temp < boiler_temp - temp_debounce:
                    decision     = 'turn_off'
                    why_decision = (f'Panel {panel_temp:.1f}°C < '
                                    f'Boiler {boiler_temp:.1f}°C - debounce {temp_debounce}°C → turn_off')
                    log.info(f'Normal: panel {panel_temp} < boiler {boiler_temp} - {temp_debounce} → turn_off')
                    set_valve_ha(False)
                    valve_state = False

                else:
                    decision     = 'hold'
                    why_decision = (f'Panel {panel_temp:.1f}°C within '
                                    f'±{temp_debounce}°C of Boiler {boiler_temp:.1f}°C → hold')
                    log.info(f'Normal: |panel - boiler| <= {temp_debounce} → hold')

        else:
            # ── Valve is OFF ─────────────────────────────────────────────────
            if not is_operational_hours(now):
                decision     = 'no_action'
                why_decision = 'Outside operational hours (07:00–19:00)'
                log.info('Valve OFF, outside hours → no_action')

            else:
                time_since_close    = get_time_since_last_close(conn)
                panel_reading_valid = (time_since_close is None or
                                       time_since_close < panel_valid_after_off)

                if panel_reading_valid:
                    # Normal Turn ON — panel reading is reliable
                    if panel_temp > boiler_temp + temp_debounce:
                        decision     = 'turn_on'
                        why_decision = (f'Panel {panel_temp:.1f}°C > '
                                        f'Boiler {boiler_temp:.1f}°C + debounce {temp_debounce}°C → turn_on')
                        log.info(f'Normal Turn ON: panel {panel_temp} > boiler {boiler_temp} + {temp_debounce}')
                        set_valve_ha(True)
                        valve_state = True

                    else:
                        decision     = 'no_action'
                        why_decision = (f'Panel {panel_temp:.1f}°C not warm enough vs '
                                        f'Boiler {boiler_temp:.1f}°C + debounce {temp_debounce}°C')
                        log.info(f'Normal Turn ON check failed: {panel_temp} not > {boiler_temp} + {temp_debounce}')

                else:
                    # Probe logic — panel reading is invalid (too long since last close)
                    close_str = f'{time_since_close:.0f}' if time_since_close is not None else '?'

                    if time_since_close >= probe_interval_min:
                        decision     = 'turn_on'
                        why_decision = (f'Probe: panel reading invalid '
                                        f'(valve OFF {close_str} min > {panel_valid_after_off} min), '
                                        f'opening valve to evaluate solar heating')
                        log.info(f'Probe Turn ON: valve OFF {close_str} min >= probe interval {probe_interval_min} min')
                        set_valve_ha(True)
                        valve_state = True

                    else:
                        decision     = 'no_action'
                        why_decision = (f'Probe: panel reading invalid, probe timer not elapsed '
                                        f'({close_str}/{probe_interval_min} min)')
                        log.info(f'Probe timer not elapsed: {close_str} < {probe_interval_min} min')

        log.info(f"Decision: {decision}  |  Error: {error}")
        log.info(f"Why: {why_decision}")

        # ── Step 6: Write result ──────────────────────────────────────────────
        write_result(conn, boiler_temp, panel_temp, valve_state,
                     boiler_trend, panel_trend, decision, why_decision, error, next_ts, version)
        conn.commit()
        return run_interval_min

    except Exception as exc:
        log.error(f'Hard error: {exc}', exc_info=True)
        error_msg         = f'ERR: {exc}'
        safety_b_triggered = False

        # Treat unknown valve_state as OFF (safe default per spec)
        if valve_state is None:
            valve_state = False

        # Safety Rule B — valve ON + hard error → turn OFF
        if valve_state:
            log.warning('Safety Rule B: hard error with valve ON → turning OFF')
            try:
                set_valve_ha(False)
                valve_state        = False
                safety_b_triggered = True
            except Exception as exc2:
                log.error(f'Failed to turn OFF valve in Safety Rule B: {exc2}')
                error_msg += f' | also failed to turn OFF: {exc2}'

        if conn:
            try:
                interval = int(settings['run_interval_min']) if settings else 5
                next_ts  = now + timedelta(minutes=interval)
                if safety_b_triggered:
                    dec = 'turn_off'
                    why = 'Safety Rule B: hard error, valve was ON → turned OFF'
                else:
                    dec = 'no_action'
                    why = 'Hard error: valve was already OFF, no action taken'
                write_result(conn, boiler_temp, panel_temp, valve_state,
                             None, None, dec, why, error_msg, next_ts, version)
                conn.commit()
            except Exception as write_exc:
                log.error(f'Failed to write error result: {write_exc}')

        return int(settings['run_interval_min']) if settings else 5

    finally:
        if conn:
            conn.close()


# ── Entry point ────────────────────────────────────────────────────────────────

def main():
    log.info('Boiler Agent starting up')
    while True:
        interval = run_agent()
        if not interval:
            interval = 5
        log.info(f'Sleeping {interval} minutes until next run')
        time.sleep(interval * 60)


if __name__ == '__main__':
    main()
