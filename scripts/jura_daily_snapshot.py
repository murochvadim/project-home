#!/usr/bin/env python3
"""Jura per-day drink-count snapshot.

Upserts TODAY's row in jura_daily (LXC 102) with the latest cumulative counters
from devices.last_state (salon_bridge). The Living Room -> Jura tab graphs the
day-over-day delta (minus hot water + milk portions).

Deploy: scp scripts/jura_daily_snapshot.py root@192.168.1.227:/opt/jura_daily_snapshot.py
Cron (LXC 104):  */30 * * * * /usr/bin/python3 /opt/jura_daily_snapshot.py >> /var/log/jura-daily.log 2>&1

Counters only ever increase, so GREATEST keeps the day's high-water value and a
transient low/rejected read can't lower it. If the board is offline the merged
devices.last_state still holds the last good value (no-0-until-read), so the row
just stays where it was — never zeroed.
"""
import sys
import psycopg2

DB = dict(host="192.168.1.219", dbname="home_data", user="postgres")

UPSERT = """
INSERT INTO jura_daily (day, total, hotwater, milk, updated_at)
SELECT (now() AT TIME ZONE 'Asia/Jerusalem')::date,
       (last_state->>'total_dispensed')::int,
       (last_state->>'cnt_hotwater')::int,
       (last_state->>'cnt_milk')::int,
       now()
FROM devices
WHERE id = 'salon_bridge'
  AND last_state ? 'total_dispensed'
ON CONFLICT (day) DO UPDATE SET
  total      = GREATEST(jura_daily.total,    EXCLUDED.total),
  hotwater   = GREATEST(jura_daily.hotwater, EXCLUDED.hotwater),
  milk       = GREATEST(jura_daily.milk,     EXCLUDED.milk),
  updated_at = now();
"""

def main():
    try:
        conn = psycopg2.connect(**DB)
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(UPSERT)
            n = cur.rowcount
        conn.close()
        print("jura_daily snapshot ok (%d row)" % n)
    except Exception as e:
        print("jura_daily snapshot ERROR:", e)
        sys.exit(1)

if __name__ == "__main__":
    main()
