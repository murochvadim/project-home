#!/usr/bin/env python3
"""UPS poll agent — runs on LXC 105 (NIS slave host), reads apcaccess locally,
writes one row to ups_status on LXC 102 PostgreSQL.

Cadence: every 60 s via systemd timer net-ups-poll.timer.
Source of truth: scripts/ups_poll.py in the project repo.
Deployed path: /opt/network-agent/ups_poll.py.
"""
import json
import re
import subprocess
from datetime import datetime, timezone

import psycopg2

DB = dict(host='192.168.1.219', dbname='home_data', user='postgres')

# Subset of apcaccess keys we extract into typed columns. Everything else is
# preserved in the JSONB `raw` column for forensics.
NUMERIC_KEYS = {
    'BCHARGE':  'battery_pct',
    'TIMELEFT': 'runtime_min',
    'LINEV':    'line_volt',
    'BATTV':    'battery_volt',
    'LOADPCT':  'load_pct',
}
TEXT_KEYS = {
    'STATUS':   'status',
    'MODEL':    'model',
    'SERIALNO': 'serial',
    'LASTXFER': 'last_xfer',
}


def parse_apcaccess(out: str) -> dict:
    """Parse `apcaccess status` output into a dict of {key: value_string}."""
    fields = {}
    for line in out.splitlines():
        m = re.match(r'^([A-Z][A-Z0-9_ ]*?)\s*:\s*(.*?)\s*$', line)
        if not m:
            continue
        key = m.group(1).strip()
        val = m.group(2).strip()
        fields[key] = val
    return fields


def coerce_numeric(s: str):
    """Pull the leading float out of values like '98.0 Percent' or '232.0 Volts'."""
    if not s:
        return None
    m = re.match(r'^\s*([-+]?\d+(?:\.\d+)?)', s)
    return float(m.group(1)) if m else None


def main():
    # Query master directly via NIS — the local slave only forwards a subset of
    # fields (just STATUS, no BCHARGE/TIMELEFT/LINEV/BATTV). Going to the master
    # at 192.168.1.101:3551 returns the full apcaccess key set.
    proc = subprocess.run(['/usr/sbin/apcaccess', 'status', '192.168.1.101:3551'],
                          capture_output=True, text=True, timeout=10)
    if proc.returncode != 0:
        print(f'[ups_poll] apcaccess failed (rc={proc.returncode}): {proc.stderr[:200]}')
        return 1

    fields = parse_apcaccess(proc.stdout)
    if not fields:
        print('[ups_poll] apcaccess returned no parseable fields')
        return 1

    row = {col: None for col in (*NUMERIC_KEYS.values(), *TEXT_KEYS.values())}
    for k, col in NUMERIC_KEYS.items():
        row[col] = coerce_numeric(fields.get(k, ''))
    for k, col in TEXT_KEYS.items():
        row[col] = fields.get(k) or None

    raw_json = json.dumps(fields)
    now = datetime.now(timezone.utc)

    with psycopg2.connect(**DB) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO ups_status
                  (ts, status, battery_pct, runtime_min, line_volt,
                   battery_volt, load_pct, model, serial, last_xfer, raw)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            """, (now, row['status'], row['battery_pct'], row['runtime_min'],
                  row['line_volt'], row['battery_volt'], row['load_pct'],
                  row['model'], row['serial'], row['last_xfer'], raw_json))
            # Symmetric safety net for the apcupsd commok hook. The hook
            # only fires on a transition during a single running process —
            # if apcupsd dies while in commlost state and restarts cleanly
            # (e.g. after a manual host reboot), no commok event ever
            # fires and the alert stays raised forever. Whenever the
            # poller observes a healthy STATUS, resolve any active
            # ups_commlost row. Same approach as orchestrator's
            # check_errors symmetric raise/resolve.
            if row['status'] and 'COMMLOST' not in row['status'].upper():
                cur.execute("""
                    UPDATE system_alerts
                       SET resolved_at = NOW()
                     WHERE alert_type = 'ups_commlost'
                       AND resolved_at IS NULL
                """)
        conn.commit()

    print(f"[ups_poll] {now.isoformat()} status={row['status']} "
          f"bat={row['battery_pct']}% line={row['line_volt']}V "
          f"runtime={row['runtime_min']}min")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
