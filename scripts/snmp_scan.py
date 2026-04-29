#!/usr/bin/env python3
"""SNMP scan agent — polls Aruba 1960 ports, writes to PostgreSQL on LXC 102."""
import subprocess, re, psycopg2
from datetime import datetime, timezone

DB      = dict(host='192.168.1.219', dbname='home_data', user='postgres')
SWITCH  = '192.168.1.215'
COMMUNITY = 'public'
OID_NAMES  = '1.3.6.1.2.1.31.1.1.1.1'   # ifName
OID_STATUS = '1.3.6.1.2.1.2.2.1.8'       # ifOperStatus (1=up, 2=down)

def snmpwalk(oid):
    result = subprocess.run(
        ['snmpwalk', '-v2c', '-c', COMMUNITY, SWITCH, oid],
        capture_output=True, text=True
    )
    data = {}
    for line in result.stdout.splitlines():
        m = re.match(r'iso\.[\d.]+\.(\d+)\s+=\s+(?:STRING:\s+"(.+)"|INTEGER:\s+(\d+))', line)
        if m:
            idx   = int(m.group(1))
            value = m.group(2) if m.group(2) is not None else m.group(3)
            data[idx] = value
    return data

def main():
    names   = snmpwalk(OID_NAMES)
    statuses = snmpwalk(OID_STATUS)
    now = datetime.now(timezone.utc)

    with psycopg2.connect(**DB) as conn:
        with conn.cursor() as cur:
            for idx, if_name in names.items():
                raw_status = statuses.get(idx, '2')
                status = 'up' if str(raw_status) == '1' else 'down'

                cur.execute("""
                    INSERT INTO net_ports (port_index, if_name, status, last_changed)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (port_index) DO UPDATE SET
                        if_name      = EXCLUDED.if_name,
                        status       = EXCLUDED.status,
                        last_changed = CASE
                            WHEN net_ports.status IS DISTINCT FROM EXCLUDED.status
                            THEN EXCLUDED.last_changed
                            ELSE net_ports.last_changed
                        END
                """, (idx, if_name, status, now))
        conn.commit()

    up   = sum(1 for s in statuses.values() if str(s) == '1')
    down = sum(1 for s in statuses.values() if str(s) == '2')
    print(f"[snmp_scan] {now.isoformat()} — ports up:{up} down:{down} total:{len(names)}")

if __name__ == '__main__':
    main()
