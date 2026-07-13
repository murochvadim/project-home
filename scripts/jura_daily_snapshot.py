#!/usr/bin/env python3
"""Jura per-day COFFEE-count snapshot.

Preserves, forever, how many **Coffees** were made each day. Reads the
jura cumulative Coffee counter (last_state->>'cnt_coffee') and writes
TODAY's row in jura_daily (LXC 102):
  • coffee = cumulative cnt_coffee, GREATEST high-water for the day
  • made   = coffee − previous logged day's coffee = coffees MADE today
  • updated_at = timestamp

Only the Coffee counter is tracked (per the user's request) — no cappuccino /
espresso / hot water / milk. `made` is the explicit per-day count so the history
is stored, not just derivable. The first logged day has no prior day → made
stays NULL (dropped from the graph).

jura_daily retention = forever + protected (never auto-cleaned).

Deploy: scp scripts/jura_daily_snapshot.py root@192.168.1.227:/opt/jura_daily_snapshot.py
Cron (LXC 104):  */30 * * * * /usr/bin/python3 /opt/jura_daily_snapshot.py >> /var/log/jura-daily.log 2>&1

Counters only ever increase, so GREATEST keeps the day's high value and a
transient low/rejected read can't lower it.
"""
import sys
import psycopg2

DB = dict(host="192.168.1.219", dbname="home_data", user="postgres")

UPSERT = """
INSERT INTO jura_daily (day, coffee, updated_at)
SELECT (now() AT TIME ZONE 'Asia/Jerusalem')::date,
       (last_state->>'cnt_coffee')::int,
       now()
FROM devices
WHERE id = 'jura'
  AND last_state ? 'cnt_coffee'
ON CONFLICT (day) DO UPDATE SET
  coffee     = GREATEST(jura_daily.coffee, EXCLUDED.coffee),
  updated_at = now();
"""

# Recompute today's per-day count = today's cumulative − the previous logged
# day's cumulative. The FROM subquery returns a row only when a prior day
# exists, so on the first logged day `made` is left NULL.
UPDATE_MADE = """
UPDATE jura_daily t
   SET made = t.coffee - p.coffee
  FROM (SELECT coffee FROM jura_daily
         WHERE day < (now() AT TIME ZONE 'Asia/Jerusalem')::date
         ORDER BY day DESC LIMIT 1) p
 WHERE t.day = (now() AT TIME ZONE 'Asia/Jerusalem')::date;
"""

def main():
    try:
        conn = psycopg2.connect(**DB)
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(UPSERT)
            n = cur.rowcount
            cur.execute(UPDATE_MADE)
        conn.close()
        print("jura_daily coffee snapshot ok (%d row)" % n)
    except Exception as e:
        print("jura_daily snapshot ERROR:", e)
        sys.exit(1)

if __name__ == "__main__":
    main()
