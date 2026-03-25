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

# ── Config ──────────────────────────────────────────────────────────────────
TIMEZONE   = pytz.timezone('Asia/Jerusalem')
DB_CONFIG  = {
    'host':     '192.168.1.219',
    'database': 'home_data',
    'user':     'postgres',
    'port':     5432,
}
HA_URL     = 'http://192.168.1.110:8123'
HA_TOKEN   = os.environ.get('HA_TOKEN', '')
HA_ENTITY  = 'switch.boiler_valve_switch_switch_1'
AGENT_DIR  = '/opt/Agents-agent/project'

# ── Logging ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[
        logging.FileHandler('/var/log/boiler-agent.log'),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger(__name__)


# ── Helpers ──────────────────────────────────────────────────────────────────

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
    Returns a list of valid panel_temp floats (in chronological order).

    Validity rules (applied per row):
    - After valve turned ON  → invalid for first panel_valid_after_on minutes
    - After valve turned OFF → valid for panel_valid_after_off minutes, then invalid
    - If no transition found in the window → conservative: assume valid
    """
    if not trend_rows:
        return []

    # Build list of valve-state transitions in the window (ASC order)
    transitions = []   # [(ts, new_valve_state), ...]
    prev_vs = trend_rows[0]['valve_state']
    for row in trend_rows[1:]:
        if row['valve_state'] != prev_vs:
            transitions.append((ensure_utc(row['ts']), row['valve_state']))
            prev_vs = row['valve_state']

    valid = []
    for row in trend_rows:
        row_ts = ensure_utc(row['ts'])

        # Find the most recent transition before this row
        last_trans_ts    = None
        last_trans_state = None
        for t_ts, t_vs in reversed(transitions):
            if t_ts <= row_ts:
                last_trans_ts    = t_ts
                last_trans_state = t_vs
                break

        if last_trans_ts is None:
            # No transition in window before this row → assume valid
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


def get_runs_since_turn_on(conn, trend_runs):
    """
    Look at the last trend_runs rows in agent_boiler_data.
    Returns how many rows ago 'turn_on' appeared (0 = last row was turn_on).
    Returns None if 'turn_on' not found within trend_runs rows.
    """
    with conn.cursor() as cur:
        cur.execute(
            'SELECT decision FROM agent_boiler_data ORDER BY ts DESC LIMIT %s',
            (trend_runs,)
        )
        rows = cur.fetchall()
    for i, (decision,) in enumerate(rows):
        if decision == 'turn_on':
            return i
    return None


def write_result(conn, boiler_temp, panel_temp, valve_state,
                 boiler_trend, panel_trend, decision, error, next_ts, version):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO agent_boiler_data
                (ts, boiler_temp, panel_temp, valve_state,
                 boiler_trend, panel_trend, decision, error, next_ts, version)
            VALUES
                (NOW(), %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (boiler_temp, panel_temp, valve_state,
              boiler_trend, panel_trend, decision, error, next_ts, version))


# ── Main agent run ────────────────────────────────────────────────────────────

def run_agent():
    """
    Execute one full agent cycle.
    Returns the number of minutes to sleep before the next run.
    """
    now     = now_local()
    version = get_version()
    log.info(f"─── Agent run at {now.strftime('%Y-%m-%d %H:%M:%S %Z')} version={version} ───")

    conn         = None
    settings     = None
    valve_state  = None
    boiler_temp  = None
    panel_temp   = None

    try:
        conn = psycopg2.connect(**DB_CONFIG)

        # ── Read settings ───────────────────────────────────────────
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute('SELECT * FROM agent_settings LIMIT 1')
            settings = cur.fetchone()

        if not settings:
            raise RuntimeError('agent_settings table is empty')

        run_interval_min    = int(settings['run_interval_min'])
        panel_valid_after_on  = int(settings['panel_temp_valid_after_on'])
        panel_valid_after_off = int(settings['panel_temp_valid_after_off'])
        trend_runs          = int(settings['trend_runs'])
        temp_debounce       = float(settings['temp_debounce'])
        agent_enabled       = bool(settings['agent_enabled'])
        next_ts             = now + timedelta(minutes=run_interval_min)

        # ── Get latest raw_data row ─────────────────────────────────
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute('SELECT * FROM raw_data ORDER BY ts DESC LIMIT 1')
            latest = cur.fetchone()

        if not latest:
            raise RuntimeError('raw_data table is empty')

        valve_state = bool(latest['valve_state'])
        boiler_temp = float(latest['boiler_temp'])
        panel_temp  = float(latest['panel_temp'])

        log.info(f"Current state: boiler={boiler_temp}°C panel={panel_temp}°C valve={'ON' if valve_state else 'OFF'}")

        # ── Safety Rule — Condition A ───────────────────────────────
        # Valve ON but outside operational hours → force OFF immediately
        if valve_state and not is_operational_hours(now):
            log.warning('Safety Rule A: valve ON outside 07:00–19:00 → turning OFF')
            set_valve_ha(False)
            write_result(conn, boiler_temp, panel_temp, False,
                         None, None, 'turn_off', 'NO ERROR', next_ts, version)
            conn.commit()
            return run_interval_min

        # ── Step 0: agent_enabled check ────────────────────────────
        if not agent_enabled:
            log.info('Agent is disabled → writing disabled')
            write_result(conn, boiler_temp, panel_temp, valve_state,
                         None, None, 'disabled', 'NO ERROR', next_ts, version)
            conn.commit()
            return run_interval_min

        # ── Step 1: Read trend data ─────────────────────────────────
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

        # Boiler trend (always available)
        boiler_temps = [float(r['boiler_temp']) for r in trend_rows]
        boiler_trend = get_trend(boiler_temps)

        # Panel trend (validity-filtered)
        valid_panel = get_valid_panel_temps(
            trend_rows, panel_valid_after_on, panel_valid_after_off
        )

        error  = 'NO ERROR'
        panel_trend = None

        if len(valid_panel) < 2:
            error = 'WARN: not valid panel_temp'
            panel_trend_available = False
            log.warning('No valid panel_temp readings for trend calculation')
        else:
            panel_trend = get_trend(valid_panel)
            panel_trend_available = True

        log.info(f"Trends: boiler={boiler_trend} panel={panel_trend or '(unavailable)'} valid_panel_readings={len(valid_panel)}")

        # ── Step 5: Decision Logic ──────────────────────────────────
        decision = None

        if valve_state:
            # ── Valve is ON ────────────────────────────────────────
            runs_since_on = get_runs_since_turn_on(conn, trend_runs)

            if runs_since_on is not None and runs_since_on < trend_runs:
                # Still in waiting phase after turn_on
                log.info(f'Waiting phase: {runs_since_on + 1}/{trend_runs} runs waited')
                decision = 'waiting'

            elif not panel_trend_available:
                # No valid panel readings — cannot evaluate, keep current state
                log.info('No valid panel trend — no_action (valve stays ON)')
                decision = 'no_action'

            else:
                # Decision after waiting
                if panel_temp > boiler_temp + temp_debounce:
                    log.info(f'Panel {panel_temp} > boiler {boiler_temp} + debounce {temp_debounce} → keep_on')
                    decision = 'keep_on'
                elif panel_temp < boiler_temp - temp_debounce:
                    log.info(f'Panel {panel_temp} < boiler {boiler_temp} - debounce {temp_debounce} → turn_off')
                    set_valve_ha(False)
                    valve_state = False
                    decision = 'turn_off'
                else:
                    log.info(f'|panel - boiler| <= debounce {temp_debounce} → hold')
                    decision = 'hold'

        else:
            # ── Valve is OFF ───────────────────────────────────────
            if not is_operational_hours(now):
                log.info('Outside operational hours → no_action')
                decision = 'no_action'
            elif panel_temp > boiler_temp + temp_debounce:
                log.info(f'Panel {panel_temp} > boiler {boiler_temp} + debounce {temp_debounce} → turn_on')
                set_valve_ha(True)
                valve_state = True
                decision = 'turn_on'
            else:
                log.info(f'Panel not warm enough (panel={panel_temp} boiler={boiler_temp} debounce={temp_debounce}) → no_action')
                decision = 'no_action'

        log.info(f"Decision: {decision}  error: {error}")

        # ── Step 7: Write result ────────────────────────────────────
        write_result(conn, boiler_temp, panel_temp, valve_state,
                     boiler_trend, panel_trend, decision, error, next_ts, version)
        conn.commit()
        return run_interval_min

    except Exception as exc:
        log.error(f'Hard error: {exc}', exc_info=True)
        error_msg = f'ERR: {exc}'

        # ── Safety Rule — Condition B ───────────────────────────────
        if valve_state:
            log.warning('Safety Rule B: hard error with valve ON → turning OFF')
            try:
                set_valve_ha(False)
            except Exception as exc2:
                log.error(f'Failed to turn OFF valve: {exc2}')
                error_msg += f' | also failed to turn OFF: {exc2}'
            if conn:
                try:
                    write_result(conn, boiler_temp, panel_temp, False,
                                 None, None, 'turn_off', error_msg, None, version)
                    conn.commit()
                except Exception:
                    pass
        else:
            if conn and settings:
                try:
                    run_interval_min = int(settings.get('run_interval_min', 5))
                    next_ts = now + timedelta(minutes=run_interval_min)
                    write_result(conn, boiler_temp, panel_temp, False,
                                 None, None, 'no_action', error_msg, next_ts, version)
                    conn.commit()
                except Exception:
                    pass

        return int(settings['run_interval_min']) if settings else 5

    finally:
        if conn:
            conn.close()


# ── Entry point ───────────────────────────────────────────────────────────────

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
