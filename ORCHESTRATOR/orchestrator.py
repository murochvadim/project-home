#!/opt/main-agent/venv/bin/python3
"""
Main Agent — Orchestrator
Runs hourly. For each registered agent:
  1. Checks if the agent is running on schedule (next_ts overdue?)
  2. Checks for recent hard errors (ERR: in error column)
  3. Checks systemd service status via SSH
  4. Checks boiler temperature data freshness (raw_data age — written by wf96c_ingest since 2026-04-23)
  5. Runs retention cleanup if due
Writes problems to system_alerts (and resolves them when fixed).
Logs all activity to orchestrator_log.
"""

import os
import re
import sys
import logging
import psycopg2
import psycopg2.extras
import paramiko
from datetime import datetime, timezone, timedelta

# ── Config ──────────────────────────────────────────────────────────────────
DB_HOST     = '192.168.1.219'
DB_PORT     = 5432
DB_NAME     = 'home_data'
DB_USER     = 'postgres'
DB_PASS     = os.environ.get('DB_PASS', '')

OVERDUE_GRACE_MIN    = 5
ERROR_LOOKBACK_ROWS  = 10
DATA_STALE_MIN       = 15   # raw_data older than this = stale. Written by wf96c_ingest (LXC 103) which is event-driven from the WF96C MQTT publisher — expect a fresh row every few seconds. 15 min threshold catches genuine outages (WF96C offline, MQTT broker down, LXC 103 down) without false-positiving on brief temp-stable gaps.
WEATHER_STALE_MIN    = 65   # collect_weather: raw_weather older than this = stale (runs every 60 min, 65 min gives margin)

# Table/column names allowed in dynamic SQL — prevents injection if DB is compromised
_ALLOWED_TABLES  = re.compile(r'^[a-z_][a-z0-9_]*$')
_ALLOWED_COLUMNS = re.compile(r'^[a-z_][a-z0-9_]*$')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
log = logging.getLogger('orchestrator')


# ── DB ───────────────────────────────────────────────────────────────────────
def get_db():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
        user=DB_USER, password=DB_PASS
    )


def write_log(cur, severity, message, source='orchestrator'):
    cur.execute(
        "INSERT INTO orchestrator_log (severity, message, source) VALUES (%s, %s, %s)",
        (severity, message, source)
    )
    log.info(f'[{severity}] {message}')


# ── Alert management ─────────────────────────────────────────────────────────
def get_active_alert(cur, alert_type, affected_agent):
    """Return existing unresolved alert of this type for this agent, or None."""
    cur.execute("""
        SELECT id FROM system_alerts
        WHERE alert_type = %s
          AND (affected_agent = %s OR (affected_agent IS NULL AND %s IS NULL))
          AND resolved_at IS NULL
        LIMIT 1
    """, (alert_type, affected_agent, affected_agent))
    row = cur.fetchone()
    return row['id'] if row else None


def raise_alert(cur, alert_type, affected_agent, severity, message):
    """Create a new alert only if one doesn't already exist for this type+agent."""
    existing = get_active_alert(cur, alert_type, affected_agent)
    if existing:
        return  # already active — don't duplicate
    cur.execute("""
        INSERT INTO system_alerts (severity, affected_agent, alert_type, message)
        VALUES (%s, %s, %s, %s)
    """, (severity, affected_agent, alert_type, message))
    write_log(cur, severity, f'ALERT raised [{alert_type}] {f"→ {affected_agent}" if affected_agent else "(all)"}: {message}')


def resolve_alert(cur, alert_type, affected_agent):
    """Resolve ALL active alerts of this type+agent (handles duplicate rows)."""
    cur.execute(
        """UPDATE system_alerts SET resolved_at = NOW()
           WHERE alert_type = %s
             AND (affected_agent IS NOT DISTINCT FROM %s)
             AND resolved_at IS NULL
           RETURNING id""",
        (alert_type, affected_agent)
    )
    rows = cur.fetchall()
    if not rows:
        return
    suffix = f' (cleared {len(rows)} duplicate rows)' if len(rows) > 1 else ''
    write_log(cur, 'info',
              f'ALERT resolved [{alert_type}] {f"→ {affected_agent}" if affected_agent else "(all)"}{suffix}')


# Two-strike rule for service checks (added 2026-04-30):
# A single failed SSH or service check is treated as a SOFT failure (logged
# as 'warn' to orchestrator_log, no alert row in system_alerts). Only on the
# SECOND consecutive failure within ~7 minutes does it escalate to a real
# alert. Eliminates the false-alarm cascade after every UPS recovery / LXC
# restart, where an LXC is briefly unreachable for 15-30 s and a single
# orchestrator quick-run pass coincides with that window.
SOFT_FAIL_PREFIX = 'soft-fail'
SOFT_FAIL_WINDOW_MIN = 7

def is_repeat_soft_fail(cur, alert_type, affected_agent):
    """Did we record a soft-fail of this kind for this agent in the last 7 min?"""
    pattern = f'{SOFT_FAIL_PREFIX}:{alert_type}:{affected_agent or "_"}:%'
    cur.execute(
        f"""SELECT 1 FROM orchestrator_log
            WHERE source = 'orchestrator'
              AND severity = 'warn'
              AND message LIKE %s
              AND ts > now() - interval '{SOFT_FAIL_WINDOW_MIN} minutes'
            LIMIT 1""",
        (pattern,)
    )
    return cur.fetchone() is not None

def record_soft_fail(cur, alert_type, affected_agent, detail):
    """Log a soft-fail without raising an alert. Escalation logic in the caller."""
    write_log(cur, 'warn',
              f'{SOFT_FAIL_PREFIX}:{alert_type}:{affected_agent or "_"}: {detail}')


# ── Agent health checks ──────────────────────────────────────────────────────
def check_schedule(cur, agent):
    table = agent['data_table']
    if not table:
        return
    if not _ALLOWED_TABLES.match(table):
        write_log(cur, 'warn', f"check_schedule: invalid table name '{table}' for agent {agent['name']} — skipping")
        return
    # Use a savepoint so a DB error (e.g. table missing) doesn't abort the
    # outer transaction and make the subsequent raise_alert call also fail.
    cur.execute("SAVEPOINT check_schedule")
    try:
        cur.execute(f"SELECT next_ts FROM {table} ORDER BY ts DESC LIMIT 1")
        row = cur.fetchone()
        cur.execute("RELEASE SAVEPOINT check_schedule")
    except Exception as e:
        cur.execute("ROLLBACK TO SAVEPOINT check_schedule")
        cur.execute("RELEASE SAVEPOINT check_schedule")
        raise_alert(cur, 'agent_schedule_check_failed', agent['name'], 'error', str(e))
        return

    if not row or not row['next_ts']:
        resolve_alert(cur, 'agent_schedule_check_failed', agent['name'])
        raise_alert(cur, 'agent_no_data', agent['name'], 'warn',
                    f"No rows found in {table} — agent may never have run")
        return
    next_ts = row['next_ts']
    if next_ts.tzinfo is None:
        next_ts = next_ts.replace(tzinfo=timezone.utc)
    overdue = (datetime.now(timezone.utc) - next_ts).total_seconds() / 60.0
    if overdue > OVERDUE_GRACE_MIN:
        raise_alert(cur, 'agent_overdue', agent['name'], 'error',
                    f"Agent overdue by {overdue:.0f} min (next_ts was {next_ts.strftime('%H:%M')})")
    else:
        resolve_alert(cur, 'agent_overdue', agent['name'])
        resolve_alert(cur, 'agent_no_data', agent['name'])
        resolve_alert(cur, 'agent_schedule_check_failed', agent['name'])  # clear previous check failures


def check_errors(cur, agent):
    table = agent['data_table']
    if not table:
        return
    if not _ALLOWED_TABLES.match(table):
        write_log(cur, 'warn', f"check_errors: invalid table name '{table}' for agent {agent['name']} — skipping")
        return
    cur.execute("SAVEPOINT check_errors")
    try:
        cur.execute(f"SELECT error FROM {table} ORDER BY ts DESC LIMIT %s", (ERROR_LOOKBACK_ROWS,))
        rows = cur.fetchall()
        cur.execute("RELEASE SAVEPOINT check_errors")
        hard = [r['error'] for r in rows if r['error'] and r['error'].startswith('ERR:')]
        if hard:
            raise_alert(cur, 'agent_hard_errors', agent['name'], 'error',
                        f"{len(hard)} hard error(s) in last {ERROR_LOOKBACK_ROWS} rows — latest: {hard[0][:120]}")
        else:
            resolve_alert(cur, 'agent_hard_errors', agent['name'])
    except Exception as e:
        cur.execute("ROLLBACK TO SAVEPOINT check_errors")
        cur.execute("RELEASE SAVEPOINT check_errors")
        write_log(cur, 'warn', f"Error check failed for {agent['name']}: {e}")


def check_service(cur, agent):
    lxc_ip     = agent['lxc_ip']
    service    = agent['service_name']
    is_oneshot = agent.get('service_oneshot', False)
    if not lxc_ip or not service:
        return
    # Validate service name before using in shell commands
    if not re.match(r'^[a-zA-Z0-9_.-]+$', service):
        write_log(cur, 'warn', f"check_service: invalid service name '{service}' — skipping")
        return
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(lxc_ip, username='root', key_filename='/root/.ssh/id_ed25519', timeout=10)
        try:
            if is_oneshot:
                _, stdout, _ = ssh.exec_command(f'systemctl is-active {service}.timer')
                status = stdout.read().decode().strip()
                ok = (status == 'active')
                label = f'{service}.timer'
            else:
                _, stdout, _ = ssh.exec_command(f'systemctl is-active {service}')
                status = stdout.read().decode().strip()
                ok = (status == 'active')
                label = service
        finally:
            ssh.close()

        if not ok:
            # Attempt auto-restart before raising alert
            restart_cmd = (f'systemctl start {service}.timer' if is_oneshot
                           else f'systemctl restart {service}')
            write_log(cur, 'warn', f'Auto-restart: {label} is down on {lxc_ip} — running: {restart_cmd}')
            new_status = ''
            ssh2 = paramiko.SSHClient()
            ssh2.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            ssh2.connect(lxc_ip, username='root', key_filename='/root/.ssh/id_ed25519', timeout=10)
            try:
                ssh2.exec_command(restart_cmd)[1].channel.recv_exit_status()  # wait for completion
                check_unit = f'{service}.timer' if is_oneshot else service
                _, stdout2, _ = ssh2.exec_command(f'systemctl is-active {check_unit}')
                new_status = stdout2.read().decode().strip()
            finally:
                ssh2.close()
            if new_status == 'active':
                write_log(cur, 'info', f'Auto-restart succeeded: {label} is now active on {lxc_ip}')
                resolve_alert(cur, 'service_down',       agent['name'])
                resolve_alert(cur, 'service_ssh_failed', agent['name'])
            else:
                # Two-strike: only raise after a prior soft-fail within 7 min.
                if is_repeat_soft_fail(cur, 'service_down', agent['name']):
                    write_log(cur, 'error', f'Auto-restart failed: {label} still {new_status!r} on {lxc_ip}')
                    raise_alert(cur, 'service_down', agent['name'], 'critical',
                                f"{label} on {lxc_ip} is '{new_status}' after auto-restart attempt")
                else:
                    record_soft_fail(cur, 'service_down', agent['name'],
                                     f"{label} still {new_status!r} after auto-restart (will alert if next run also fails)")
        else:
            resolve_alert(cur, 'service_down',       agent['name'])
            resolve_alert(cur, 'service_ssh_failed', agent['name'])
    except Exception as e:
        # Two-strike: a single SSH/check failure (LXC briefly unreachable during
        # recovery, brief restart, network blip) is logged but not alerted.
        # Escalates only if next run (~5 min later) also fails.
        if is_repeat_soft_fail(cur, 'service_ssh_failed', agent['name']):
            raise_alert(cur, 'service_ssh_failed', agent['name'], 'error',
                        f"SSH service check failed for {lxc_ip}: {e}")
        else:
            record_soft_fail(cur, 'service_ssh_failed', agent['name'],
                             f"SSH check failed for {lxc_ip}: {e} (will alert if next run also fails)")


def check_weather_freshness(cur):
    """Check collect_weather: is raw_weather recent enough?"""
    try:
        cur.execute("SELECT MAX(ts) AS last_ts FROM raw_weather")
        row = cur.fetchone()
        last_ts = row['last_ts'] if row else None
        if not last_ts:
            raise_alert(cur, 'weather_stale', 'collect_weather', 'warn',
                        'raw_weather table is empty — collect_weather may never have run')
            return
        if last_ts.tzinfo is None:
            last_ts = last_ts.replace(tzinfo=timezone.utc)
        age_min = (datetime.now(timezone.utc) - last_ts).total_seconds() / 60.0
        if age_min > WEATHER_STALE_MIN:
            raise_alert(cur, 'weather_stale', 'collect_weather', 'warn',
                        f"raw_weather is {age_min:.0f} min old — collect_weather may be failing (threshold: {WEATHER_STALE_MIN} min)")
        else:
            resolve_alert(cur, 'weather_stale', 'collect_weather')
    except Exception as e:
        raise_alert(cur, 'weather_stale', 'collect_weather', 'warn', f"Weather freshness check failed: {e}")


def check_data_freshness(cur):
    """Check boiler temperature data: is raw_data recent enough?"""
    try:
        cur.execute("SELECT MAX(ts) AS last_ts FROM raw_data")
        row = cur.fetchone()
        last_ts = row['last_ts'] if row else None
        if not last_ts:
            raise_alert(cur, 'data_stale', 'boiler', 'critical',
                        'raw_data table is empty — boiler temperature ingest (wf96c_ingest) may have never run')
            return
        if last_ts.tzinfo is None:
            last_ts = last_ts.replace(tzinfo=timezone.utc)
        age_min = (datetime.now(timezone.utc) - last_ts).total_seconds() / 60.0
        if age_min > DATA_STALE_MIN:
            raise_alert(cur, 'data_stale', 'boiler', 'error',
                        f"raw_data is {age_min:.0f} min old — wf96c_ingest (LXC 103) may be failing, or WF96C / MQTT broker may be down (threshold: {DATA_STALE_MIN} min)")
        else:
            resolve_alert(cur, 'data_stale', 'boiler')
    except Exception as e:
        raise_alert(cur, 'data_stale', 'boiler', 'error', f"Data freshness check failed: {e}")


BACKUP_GRACE_HOURS = 4  # alert if last ok > max_age_hours + this grace


def check_backup_freshness(cur):
    """Check each enabled backup job: is last successful backup within max_age_hours + grace?"""
    cur.execute("SAVEPOINT check_backup_freshness")
    try:
        cur.execute("""
            SELECT j.id, j.name, j.max_age_hours,
                   MAX(l.started_at) FILTER (WHERE l.status = 'ok') AS last_ok
            FROM backup_jobs j
            LEFT JOIN backup_log l ON l.job_id = j.id
            WHERE j.enabled = TRUE
            GROUP BY j.id, j.name, j.max_age_hours
        """)
        jobs = cur.fetchall()
        cur.execute("RELEASE SAVEPOINT check_backup_freshness")
    except Exception as e:
        cur.execute("ROLLBACK TO SAVEPOINT check_backup_freshness")
        cur.execute("RELEASE SAVEPOINT check_backup_freshness")
        write_log(cur, 'warn', f'Backup freshness check failed: {e}')
        return

    for job in jobs:
        agent_name = f"backup:{job['name']}"
        threshold_h = job['max_age_hours'] + BACKUP_GRACE_HOURS
        last_ok = job['last_ok']

        if not last_ok:
            raise_alert(cur, 'backup_overdue', agent_name, 'warn',
                        f"Backup job '{job['name']}' has never completed successfully")
            continue

        if last_ok.tzinfo is None:
            last_ok = last_ok.replace(tzinfo=timezone.utc)
        age_h = (datetime.now(timezone.utc) - last_ok).total_seconds() / 3600.0

        if age_h > threshold_h:
            raise_alert(cur, 'backup_overdue', agent_name, 'warn',
                        f"Backup job '{job['name']}' last OK {age_h:.1f}h ago (threshold: {threshold_h}h)")
        else:
            resolve_alert(cur, 'backup_overdue', agent_name)


# ── Retention cleanup ────────────────────────────────────────────────────────
def run_retention(cur):
    cur.execute("""
        SELECT table_name, keep_days, clean_interval_hours, last_cleaned_at
        FROM retention_policies
        WHERE auto_clean = true AND keep_days IS NOT NULL
    """)
    policies = cur.fetchall()
    results = []
    now = datetime.now(timezone.utc)

    for p in policies:
        last_cleaned = p['last_cleaned_at']
        if last_cleaned:
            if last_cleaned.tzinfo is None:
                last_cleaned = last_cleaned.replace(tzinfo=timezone.utc)
            if (now - last_cleaned).total_seconds() / 3600.0 < p['clean_interval_hours']:
                continue

        # Pick the row-timestamp column to age rows on. Priority: ts > detected_at > started_at.
        # `started_at` added 2026-05-18 so backup_log (which has no `ts` / `detected_at`,
        # only `started_at`) actually gets cleaned — before this, its retention_policies
        # row was honored by config but silently skipped here, leaving last_cleaned_at NULL forever.
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = %s
              AND column_name IN ('ts','detected_at','started_at')
            ORDER BY
              CASE column_name
                WHEN 'ts' THEN 1
                WHEN 'detected_at' THEN 2
                WHEN 'started_at' THEN 3
              END
            LIMIT 1
        """, (p['table_name'],))
        col_row = cur.fetchone()
        if not col_row:
            continue

        if not _ALLOWED_TABLES.match(p['table_name']) or not _ALLOWED_COLUMNS.match(col_row['column_name']):
            log.warning(f"run_retention: invalid table/column name '{p['table_name']}'/'{col_row['column_name']}' — skipping")
            continue
        cutoff = now - timedelta(days=p['keep_days'])
        # Use SAVEPOINT so a failure on one table doesn't roll back others
        cur.execute("SAVEPOINT retention_delete")
        try:
            cur.execute(f"DELETE FROM {p['table_name']} WHERE {col_row['column_name']} < %s", (cutoff,))
            deleted = cur.rowcount
            cur.execute("UPDATE retention_policies SET last_cleaned_at = %s WHERE table_name = %s",
                        (now, p['table_name']))
            cur.execute("RELEASE SAVEPOINT retention_delete")
            results.append((p['table_name'], deleted))
        except Exception as e:
            cur.execute("ROLLBACK TO SAVEPOINT retention_delete")
            log.warning(f'Retention cleanup failed for {p["table_name"]}: {e}')

    return results


# ── Weekly VACUUM ANALYZE ─────────────────────────────────────────────────────
def run_vacuum_if_due(db, cur):
    """Run VACUUM ANALYZE weekly. VACUUM cannot run inside a transaction."""
    cur.execute("""
        SELECT ts FROM orchestrator_log
        WHERE message LIKE 'VACUUM ANALYZE%'
        ORDER BY ts DESC LIMIT 1
    """)
    row = cur.fetchone()
    now = datetime.now(timezone.utc)
    if row:
        last_ts = row['ts']
        if last_ts.tzinfo is None:
            last_ts = last_ts.replace(tzinfo=timezone.utc)
        if (now - last_ts).total_seconds() < 7 * 24 * 3600:
            return False
    db.commit()
    db.autocommit = True
    try:
        with db.cursor() as vc:
            vc.execute('VACUUM ANALYZE')
    finally:
        db.autocommit = False
    # Log VACUUM completion in its own transaction so it's not lost on later rollback
    with db.cursor() as vc:
        vc.execute(
            "INSERT INTO orchestrator_log (severity, message) VALUES ('info', 'VACUUM ANALYZE completed — all tables cleaned')"
        )
    db.commit()
    return True


# ── Main ─────────────────────────────────────────────────────────────────────
def main(quick=False):
    mode = 'quick-check' if quick else 'full'
    log.info(f'Orchestrator run started ({mode})')
    db = None
    cur = None
    try:
        db  = get_db()
        db.autocommit = False
        cur = db.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    except Exception as e:
        log.error(f'DB connection failed: {e}')
        sys.exit(1)

    try:
        cur.execute("SELECT * FROM agents WHERE enabled = true ORDER BY name")
        agents = cur.fetchall()

        if quick:
            # Lightweight: schedule + service-state + per-agent errors + data freshness (no retention).
            # check_service was added to the quick run 2026-04-30 so service_down /
            # service_ssh_failed alerts auto-resolve within 5 min instead of 60 min
            # (cost: ~1-2 s SSH per agent × 6 agents = ~6-12 s per quick run).
            # check_errors was added 2026-05-07 so agent_hard_errors auto-resolves
            # within 5 min instead of 60 min once conditions clear (the resolve
            # branch was already symmetric in the function; only the call site
            # was missing from the quick path). Cost: ~1 small SELECT per agent.
            for agent in agents:
                check_schedule(cur, agent)
                check_service(cur, agent)
                check_errors(cur, agent)
            check_data_freshness(cur)
            check_weather_freshness(cur)
            check_backup_freshness(cur)
            cur.execute("SELECT COUNT(*) AS n FROM system_alerts WHERE resolved_at IS NULL")
            active = cur.fetchone()['n']
            write_log(cur, 'warn' if active else 'info',
                      f'Quick check — {active} active alert(s)' if active else 'Quick check — all OK')
        else:
            write_log(cur, 'info', f'Checking {len(agents)} agent(s): {", ".join(a["name"] for a in agents)}')
            for agent in agents:
                check_schedule(cur, agent)
                check_errors(cur, agent)
                check_service(cur, agent)

            check_data_freshness(cur)
            check_weather_freshness(cur)
            check_backup_freshness(cur)

            cleaned = run_retention(cur)
            if cleaned:
                detail = ', '.join(f'{t}: {d} rows' for t, d in cleaned)
                write_log(cur, 'info', f'Retention cleanup: {detail}')
            else:
                write_log(cur, 'info', 'Retention cleanup: nothing due')

            # Weekly VACUUM ANALYZE (logs its own completion inside the function)
            run_vacuum_if_due(db, cur)

            # Count active alerts for summary
            cur.execute("SELECT COUNT(*) AS n FROM system_alerts WHERE resolved_at IS NULL")
            active = cur.fetchone()['n']
            if active:
                write_log(cur, 'warn', f'Run complete — {active} active alert(s)')
            else:
                write_log(cur, 'info', 'Run complete — all OK')

        db.commit()
        log.info('Done')

    except Exception as e:
        db.rollback()
        log.error(f'Orchestrator run failed: {e}')
        if cur:
            try:
                cur.execute(
                    "INSERT INTO orchestrator_log (severity, message) VALUES ('error', %s)",
                    (f'Orchestrator run failed: {e}',)
                )
                db.commit()
            except Exception:
                pass
        sys.exit(1)
    finally:
        if cur:
            cur.close()
        if db:
            db.close()


if __name__ == '__main__':
    quick_mode = '--quick' in sys.argv
    main(quick=quick_mode)
