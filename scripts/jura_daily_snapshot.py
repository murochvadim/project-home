#!/usr/bin/env python3
"""Jura per-day per-DRINK snapshot — BACKSTOP for the jura-ingest daemon.

Preserves, forever, how many of each drink were made per day. Reads the jura
cumulative per-drink counters from devices.last_state (projected there by the
rule engine from the board's MQTT status) and refreshes TODAY's jura_daily row:
  • coffee        = cnt_coffee high-water                       (legacy, coffee)
  • cum_by_type   = per-type high-water of every tracked counter (per-key GREATEST)
  • made          = coffee − prev logged day's coffee           (legacy)
  • made_by_type  = per-type (today.cum − prev day's cum), only for types the
                    previous day already has a baseline for (transition-safe)

Tracks every drink EXCEPT Hot Water and Flat White (see jura_ingest.py for why).
Milk Portion IS tracked. Uses the SAME SQL as the daemon so the two writers can
never diverge — the daemon owns freshness (event-driven), this owns durability
if the daemon was down. Counters only rise, so GREATEST keeps the day's high
value and a transient low/rejected read can't lower it.

jura_daily retention = forever + protected (never auto-cleaned).

Deploy: scp scripts/jura_daily_snapshot.py root@192.168.1.227:/opt/jura_daily_snapshot.py
Cron (LXC 104):  */30 * * * * /usr/bin/python3 /opt/jura_daily_snapshot.py >> /var/log/jura-daily.log 2>&1
"""
import json
import sys

import psycopg2

DB = dict(host="192.168.1.219", dbname="home_data", user="postgres")

# Same tracked set + slugs as the daemon (jura_ingest.py). Keep in sync.
TRACKED = (
    ('cnt_coffee',        'coffee'),
    ('cnt_espresso',      'espresso'),
    ('cnt_cappuccino',    'cappuccino'),
    ('cnt_latte',         'latte'),
    ('cnt_esp_macchiato', 'esp_macchiato'),
    ('cnt_ristretto',     'ristretto'),
    ('cnt_milk',          'milk'),
    ('cnt_2espressi',     '2espressi'),
    ('cnt_2coffee',       '2coffee'),
    ('cnt_2ristretti',    '2ristretti'),
)

TODAY = "(now() AT TIME ZONE 'Asia/Jerusalem')::date"

UPSERT_DAILY = f"""
INSERT INTO jura_daily (day, coffee, cum_by_type, updated_at)
VALUES ({TODAY}, %s, %s::jsonb, now())
ON CONFLICT (day) DO UPDATE SET
  coffee = GREATEST(COALESCE(jura_daily.coffee, 0), COALESCE(EXCLUDED.coffee, 0)),
  cum_by_type = (
    SELECT COALESCE(jsonb_object_agg(k, GREATEST(
             COALESCE((jura_daily.cum_by_type ->> k)::int, 0),
             COALESCE((EXCLUDED.cum_by_type   ->> k)::int, 0))), '{{}}'::jsonb)
    FROM (SELECT jsonb_object_keys(jura_daily.cum_by_type || EXCLUDED.cum_by_type) AS k) ks
  ),
  updated_at = now();
"""

UPDATE_MADE = f"""
UPDATE jura_daily t
   SET made = t.coffee - p.coffee
  FROM (SELECT coffee FROM jura_daily
         WHERE day < {TODAY} ORDER BY day DESC LIMIT 1) p
 WHERE t.day = {TODAY};
"""

UPDATE_MADE_BY_TYPE = f"""
UPDATE jura_daily x
   SET made_by_type = (
     SELECT COALESCE(jsonb_object_agg(k, d), '{{}}'::jsonb)
     FROM (
       SELECT k, ((x.cum_by_type ->> k)::int - (p.cum_by_type ->> k)::int) AS d
       FROM (SELECT jsonb_object_keys(x.cum_by_type) AS k) ks
       WHERE (p.cum_by_type ? k)
     ) z WHERE d > 0
   )
  FROM (SELECT cum_by_type FROM jura_daily
         WHERE day < {TODAY} AND cum_by_type <> '{{}}'::jsonb
         ORDER BY day DESC LIMIT 1) p
 WHERE x.day = {TODAY};
"""


def main():
    try:
        conn = psycopg2.connect(**DB)
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("SELECT last_state FROM devices WHERE id = 'jura'")
            row = cur.fetchone()
            state = (row[0] if row else None) or {}
            cum = {}
            for key, slug in TRACKED:
                v = state.get(key)
                if v is None:
                    continue
                try:
                    cum[slug] = int(v)
                except (TypeError, ValueError):
                    continue
            if 'coffee' not in cum:
                print("jura_daily snapshot: no cnt_coffee in last_state — skip")
                conn.close()
                return
            cur.execute(UPSERT_DAILY, (cum.get('coffee'), json.dumps(cum)))
            cur.execute(UPDATE_MADE)
            cur.execute(UPDATE_MADE_BY_TYPE)
        conn.close()
        print("jura_daily per-drink snapshot ok (%d types)" % len(cum))
    except Exception as e:
        print("jura_daily snapshot ERROR:", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
