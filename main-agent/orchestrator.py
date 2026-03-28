#!/opt/main-agent/venv/bin/python3
"""
Main Agent — Orchestrator
Runs hourly. For each registered agent:
  1. Checks if the agent is running on schedule (next_ts overdue?)
  2. Checks for recent hard errors (ERR: in error column)
  3. Checks systemd service status via SSH
  4. Runs retention cleanup if due
Writes results to orchestrator_log.
"""

import os
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

OVERDUE_GRACE_MIN = 5       # agent is "overdue" if next_ts is this many minutes past
ERROR_LOOKBACK_ROWS = 10    # check last N rows for hard errors

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


# ── Agent health check ───────────────────────────────────────────────────────
def check_agent_schedule(cur, agent):
    """Returns (ok, message) — is the agent running on time?"""
    table = agent['data_table']
    try:
        cur.execute(f"SELECT next_ts FROM {table} ORDER BY ts DESC LIMIT 1")
        row = cur.fetchone()
        if not row or not row['next_ts']:
            return False, f"Agent '{agent['name']}': no next_ts found in {table}"
        next_ts = row['next_ts']
        if next_ts.tzinfo is None:
            next_ts = next_ts.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        overdue_by = (now - next_ts).total_seconds() / 60.0
        if overdue_by > OVERDUE_GRACE_MIN:
            return False, f"Agent '{agent['name']}': overdue by {overdue_by:.0f} min (next_ts was {next_ts.strftime('%H:%M')})"
        return True, f"Agent '{agent['name']}': on schedule (next_ts {next_ts.strftime('%H:%M')})"
    except Exception as e:
        return False, f"Agent '{agent['name']}': schedule check failed — {e}"


def check_agent_errors(cur, agent):
    """Returns (ok, message) — any recent hard errors?"""
    table = agent['data_table']
    try:
        cur.execute(f"SELECT error FROM {table} ORDER BY ts DESC LIMIT %s", (ERROR_LOOKBACK_ROWS,))
        rows = cur.fetchall()
        hard_errors = [r['error'] for r in rows if r['error'] and r['error'].startswith('ERR:')]
        if hard_errors:
            return False, f"Agent '{agent['name']}': {len(hard_errors)} hard error(s) in last {ERROR_LOOKBACK_ROWS} rows — latest: {hard_errors[0][:120]}"
        return True, None
    except Exception as e:
        return False, f"Agent '{agent['name']}': error check failed — {e}"


def check_agent_service(agent):
    """Returns (ok, message) — is the systemd service active?"""
    lxc_ip      = agent['lxc_ip']
    service     = agent['service_name']
    if not lxc_ip or not service:
        return None, None  # no SSH target configured
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(lxc_ip, username='root', key_filename='/root/.ssh/id_ed25519', timeout=10)
        _, stdout, _ = ssh.exec_command(f'systemctl is-active {service}')
        status = stdout.read().decode().strip()
        ssh.close()
        ok = (status == 'active')
        return ok, f"Agent '{agent['name']}': service {service} is {status}"
    except Exception as e:
        return False, f"Agent '{agent['name']}': SSH service check failed — {e}"


# ── Retention cleanup ────────────────────────────────────────────────────────
def run_retention(cur):
    """Delete old rows for tables where auto_clean=true and interval has elapsed."""
    cur.execute("""
        SELECT table_name, keep_days, clean_interval_hours, last_cleaned_at
        FROM retention_policies
        WHERE auto_clean = true AND keep_days IS NOT NULL
    """)
    policies = cur.fetchall()
    results = []
    now = datetime.now(timezone.utc)

    for p in policies:
        table             = p['table_name']
        keep_days         = p['keep_days']
        interval_h        = p['clean_interval_hours']
        last_cleaned      = p['last_cleaned_at']

        # Check if interval has elapsed
        if last_cleaned:
            if last_cleaned.tzinfo is None:
                last_cleaned = last_cleaned.replace(tzinfo=timezone.utc)
            hours_since = (now - last_cleaned).total_seconds() / 3600.0
            if hours_since < interval_h:
                continue  # not due yet

        # Detect timestamp column (ts or detected_at)
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = %s AND column_name IN ('ts','detected_at')
            ORDER BY ordinal_position LIMIT 1
        """, (table,))
        col_row = cur.fetchone()
        if not col_row:
            continue
        ts_col = col_row['column_name']

        cutoff = now - timedelta(days=keep_days)
        cur.execute(f"DELETE FROM {table} WHERE {ts_col} < %s", (cutoff,))
        deleted = cur.rowcount
        cur.execute(
            "UPDATE retention_policies SET last_cleaned_at = %s WHERE table_name = %s",
            (now, table)
        )
        results.append((table, deleted))

    return results


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    log.info('Orchestrator run started')
    try:
        db  = get_db()
        db.autocommit = False
        cur = db.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    except Exception as e:
        log.error(f'DB connection failed: {e}')
        sys.exit(1)

    try:
        # Load all registered agents
        cur.execute("SELECT * FROM agents WHERE enabled = true ORDER BY name")
        agents = cur.fetchall()
        write_log(cur, 'info', f'Checking {len(agents)} agent(s): {", ".join(a["name"] for a in agents)}')

        all_ok = True

        for agent in agents:
            # 1. Schedule check
            ok, msg = check_agent_schedule(cur, agent)
            if msg:
                write_log(cur, 'info' if ok else 'warn', msg)
            if not ok:
                all_ok = False

            # 2. Error check
            ok, msg = check_agent_errors(cur, agent)
            if msg:
                write_log(cur, 'info' if ok else 'warn', msg)
            if not ok:
                all_ok = False

            # 3. Service check
            ok, msg = check_agent_service(agent)
            if msg:
                write_log(cur, 'info' if ok else 'error', msg)
            if ok is False:
                all_ok = False

        # 4. Retention cleanup
        cleaned = run_retention(cur)
        if cleaned:
            detail = ', '.join(f'{t}: {d} rows' for t, d in cleaned)
            write_log(cur, 'info', f'Retention cleanup: {detail}')
        else:
            write_log(cur, 'info', 'Retention cleanup: nothing due')

        # 5. Summary
        write_log(cur, 'info' if all_ok else 'warn',
                  'Run complete — all OK' if all_ok else 'Run complete — issues found (see above)')

        db.commit()
        log.info('Done')

    except Exception as e:
        db.rollback()
        log.error(f'Orchestrator run failed: {e}')
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
        cur.close()
        db.close()


if __name__ == '__main__':
    main()
