#!/usr/bin/env python3
"""backup_watchdog.py — backup freshness watchdog (LXC 104, cron hourly).

Backups run unattended at night and fail silently. Worse, they can keep
REPORTING SUCCESS while copying a frozen source — which is exactly what
happened 2026-08-23 → 2026-09-06: the nightly Drive uploads ran fine every
night and re-uploaded the SAME 15-day-old QNAP snapshot, because the two jobs
that refresh that snapshot ('Claude Project Folder' + 'Claude Memory') were
disabled. 148 commits sat outside every off-site copy and nothing said a word.
A run-time-only check would have shown green the whole time.

So each OFF-SITE backup is checked on TWO axes:

  1. did it RUN recently?      dashboard_settings.privacy.<key>.last_ok
  2. is what it COPIED fresh?  age of the newest QNAP source snapshot dir

Scope is deliberately limited to the off-site (Drive) backups and the snapshots
they read. The local backup_jobs rows are already covered by orchestrator.py's
'backup_overdue' check — see the note above main().

Writes to system_alerts and auto-resolves when the condition clears — same
shape and helpers as group_health_watchdog / netbird_watchdog / phonelink_watchdog.
Read-only apart from system_alerts; it never touches a backup or a job.

Deploy: scp scripts/backup_watchdog.py root@192.168.1.227:/opt/backup_watchdog.py
Cron:   17 * * * * /usr/bin/python3 /opt/backup_watchdog.py >> /var/log/backup-watchdog.log 2>&1
"""

import os
import re
import sys
import glob
import json
import datetime as dt

import psycopg2

DB = {
    'host':     '192.168.1.219',
    'port':     5432,
    'database': 'home_data',
    'user':     'postgres',
}
SOURCE = 'backup_watchdog'
AGENT  = 'backup'

HOUR = 3600

# ── 1. Off-site (Drive) backups: did the job run? ────────────────────────────
# key = dashboard_settings key under 'privacy.', holding {"last_ok": "YYYY-MM-DD HH:MM"}.
# max_age is generous — 2x the cadence — so one skipped night is not an alarm.
CLOUD_BACKUPS = [
    # (settings key,        label,                    max age)
    ('privacy.project_backup', 'Project folder → Drive',  48 * HOUR),
    ('privacy.cloud_backup',   'Privacy budget → Drive',  48 * HOUR),
    ('privacy.db_backup',      'Database → Drive',        48 * HOUR),
    ('privacy.guests_backup',  'Guest images → Drive',     9 * 24 * HOUR),  # weekly, Sun 04:00
    # Written by the memory half of privacy-project-cloud-backup.sh, which runs AFTER that
    # script stamps privacy.project_backup and whose backup_log job is disabled — so without
    # its own marker a failing memory upload is invisible on both axes.
    ('privacy.memory_backup',  'Claude memory → Drive',   48 * HOUR),
]

# ── 2. The source those uploads read from ────────────────────────────────────
# THIS is the check that would have caught the Aug-23 freeze. The upload can be
# perfectly healthy while the directory it reads has stopped being refreshed.
SOURCE_SNAPSHOTS = [
    # (glob of snapshot dirs,                  label,                        max age)
    ('/mnt/qnap-claude/Claude Project/*/', 'Project folder → QNAP snapshot', 48 * HOUR),
    ('/mnt/qnap-claude/Claude_Memory/*/',  'Claude memory → QNAP snapshot',  48 * HOUR),
]


# ── system_alerts helpers (match group/netbird/phonelink watchdog) ───────────
def upsert_alert(cur, alert_type, severity, message):
    cur.execute(
        "SELECT id FROM system_alerts WHERE alert_type = %s AND resolved_at IS NULL",
        (alert_type,),
    )
    row = cur.fetchone()
    if row:
        # severity too, not just ts+message: this script raises the same alert_type at
        # 'warn' (never ran) and 'error' (stale), so an escalation must be visible.
        cur.execute("UPDATE system_alerts SET ts = NOW(), message = %s, severity = %s WHERE id = %s",
                    (message, severity, row[0]))
    else:
        cur.execute(
            """INSERT INTO system_alerts (ts, source, severity, alert_type, affected_agent, message)
               VALUES (NOW(), %s, %s, %s, %s, %s)""",
            (SOURCE, severity, alert_type, AGENT, message),
        )


def resolve_alert(cur, alert_type):
    cur.execute(
        "UPDATE system_alerts SET resolved_at = NOW() WHERE alert_type = %s AND resolved_at IS NULL",
        (alert_type,),
    )


def _fmt_age(sec):
    """Human age: '3.2 days' reads better than '77 hours' in an alert message."""
    if sec is None:
        return 'never'
    d = sec / 86400.0
    return f'{d:.1f} days' if d >= 1 else f'{sec / 3600.0:.1f} hours'


def _slug(text):
    return re.sub(r'[^a-z0-9]+', '_', text.lower()).strip('_')


# ── check 1: did the off-site job run? ───────────────────────────────────────
def check_cloud_runs(cur, now):
    for key, label, max_age in CLOUD_BACKUPS:
        atype = f'backup_stale:{key.split(".", 1)[1]}'
        cur.execute("SELECT value FROM dashboard_settings WHERE key = %s", (key,))
        row = cur.fetchone()
        last_ok, age = None, None
        if row and row[0]:
            val = row[0] if isinstance(row[0], dict) else json.loads(row[0])
            raw = (val or {}).get('last_ok')
            if raw:
                try:
                    last_ok = dt.datetime.strptime(str(raw).strip(), '%Y-%m-%d %H:%M')
                    age = (now - last_ok).total_seconds()
                except ValueError:
                    age = None  # unparseable → treat as unknown, alert below

        if age is None:
            upsert_alert(cur, atype, 'warn',
                         f'{label}: no successful run recorded — the backup may never have run, '
                         f'or its success marker is unreadable')
        elif age > max_age:
            upsert_alert(cur, atype, 'error',
                         f'{label}: last success was {_fmt_age(age)} ago '
                         f'(threshold {_fmt_age(max_age)}) — off-site copy is not current')
        else:
            resolve_alert(cur, atype)


# ── check 2: is the thing being copied actually fresh? ───────────────────────
def check_source_freshness(cur, now):
    """The Aug-2026 lesson: a healthy upload of a frozen source is still a dead backup."""
    for pattern, label, max_age in SOURCE_SNAPSHOTS:
        atype = f'backup_source_stale:{_slug(label)}'
        # Guard the mount first. Without this a dropped CIFS mount reads as "no snapshot
        # found at all", which sends you looking at backup jobs instead of the mount.
        mount = '/mnt/qnap-claude'
        if not os.path.ismount(mount):
            upsert_alert(cur, atype, 'error',
                         f'{label}: {mount} is not mounted — cannot tell whether the backup '
                         f'source is fresh. Check the CIFS mount on LXC 104, not the backup job.')
            continue
        dirs = sorted(glob.glob(pattern), key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0)
        if not dirs:
            upsert_alert(cur, atype, 'error',
                         f'{label}: no snapshot found at all — the off-site upload has nothing '
                         f'current to send')
            continue
        newest = dirs[-1]
        age = now.timestamp() - os.path.getmtime(newest)
        if age > max_age:
            upsert_alert(cur, atype, 'error',
                         f'{label}: newest snapshot is {_fmt_age(age)} old '
                         f'({os.path.basename(newest.rstrip("/"))}) — the nightly upload is '
                         f'succeeding but sending a STALE copy. Check the backup job is enabled.')
        else:
            resolve_alert(cur, atype)


# NOTE — deliberately NOT checked here: whether an ENABLED backup_jobs row has run
# recently. ORCHESTRATOR/orchestrator.py already raises 'backup_overdue' for exactly
# that, with a grace period and node-pause awareness this script would not reproduce.
# An earlier version of this file duplicated it and produced two alerts per job for
# one condition. If you are tempted to add it back, read orchestrator.py ~line 354.


def main():
    now = dt.datetime.now()          # LXC 104 is Asia/Jerusalem; backups never follow travel time
    conn = psycopg2.connect(**DB)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            check_cloud_runs(cur, now)
            check_source_freshness(cur, now)
            cur.execute("SELECT count(*) FROM system_alerts "
                        "WHERE alert_type LIKE 'backup%%' AND resolved_at IS NULL")
            active = cur.fetchone()[0]
        conn.commit()
        print(f'{dt.datetime.now():%Y-%m-%d %H:%M} backup_watchdog ok — {active} active backup alert(s)')
    except Exception as exc:
        conn.rollback()
        print(f'{dt.datetime.now():%Y-%m-%d %H:%M} backup_watchdog FAILED: '
              f'{type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
