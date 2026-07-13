#!/usr/bin/env python3
"""Jura per-DRINK live ingest daemon — runs on LXC 104.

Event-driven: SUBSCRIBES to the jura board's status topic and updates the DB
the instant the board publishes — no polling. Always listening.

The board (jura) reads the Jura over BLE (~10 s poll + publish-on-change while
the machine is on) and publishes its lifetime per-drink counters to
mur/home/esp/jura/status. We track EVERY drink except **Hot Water** and
**Flat White** (Flat White sits at stat index 46, past the board's single
STATS_DATA read, so it always decodes 0 — untrackable without a sketch reflash;
Hot Water is excluded per the user). Milk Portion IS a drink and IS tracked.

The per-drink counters are independent and sum to total_dispensed, so each drink
press advances exactly ONE counter (verified live) — no double counting.

On each message, for every tracked counter:
  • per-counter HIGH-WATER baseline (`_hw`) — only ever moves UP. A counter that
    reads below its high-water is a transient/partial BLE read and is IGNORED
    (no re-baseline down), so a dip-then-recover can't invent a phantom drink.
  • when a counter ADVANCES above its high-water, append one jura_drinks event
    (ts + qty + drink_type) — the per-drink timestamped log for the 6h/24h graph.
  • upsert TODAY's jura_daily row:
      - coffee        = GREATEST high-water of cnt_coffee  (legacy, coffee-only)
      - cum_by_type   = per-type GREATEST high-water of every tracked counter
      - made          = coffee − prev logged day's coffee  (legacy)
      - made_by_type  = per-type (today.cum − prev day's cum), ONLY for types the
        previous day already has a baseline for (else that type is skipped, like
        `made` is NULL on the first day) — this prevents the transition day from
        attributing a type's whole lifetime count as "made today".
    Week..3yr graph ranges read jura_daily.made_by_type; 6h/24h read jura_drinks.

The FIRST message after a (re)start is a baseline: it seeds `_hw` and refreshes
jura_daily WITHOUT logging any jura_drinks events, so a restart can't invent
phantom drinks (jura_daily's high-water still catches anything brewed during
downtime; only the exact per-drink timestamp is lost).

Both tables are preserved forever (retention = forever + protected).

Required env:
  ESP_BOARDS_MQTT_PASS   password for the shared `esp_boards` MQTT user
  DB_PASS                Postgres password (optional — pg_hba trusts the subnet)

Deploy:
  scp scripts/jura_ingest.py root@192.168.1.227:/opt/jura_ingest.py
  systemctl restart jura-ingest        (unit: EnvironmentFile=/etc/jura-ingest.env)
"""
import json
import logging
import os
import sys
import time

import paho.mqtt.client as mqtt
import psycopg2

MQTT_HOST = '192.168.1.189'
MQTT_PORT = 1883
MQTT_USER = 'esp_boards'
MQTT_PASS = os.environ.get('ESP_BOARDS_MQTT_PASS', '')
TOPIC     = 'mur/home/esp/jura/status'

DB_CONFIG = {
    'host':     '192.168.1.219',
    'database': 'home_data',
    'user':     'postgres',
    'password': os.environ.get('DB_PASS', ''),
    'port':     5432,
}

# Drinks we log. (status payload key -> drink_type slug). Ordered coffee-first.
# EXCLUDED on purpose: cnt_hotwater (not a drink), cnt_flat_white (board can't
# read stat index 46, always 0). The slugs match the frontend label map.
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

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('jura_ingest')

TODAY = "(now() AT TIME ZONE 'Asia/Jerusalem')::date"

# Upsert TODAY's daily row: coffee high-water (legacy) + cum_by_type per-type
# high-water (per-key GREATEST merge of existing vs the new cumulative snapshot).
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

# Legacy coffee-only per-day count. FROM returns a row only if a prior day
# exists, so the first logged day keeps made = NULL.
UPDATE_MADE = f"""
UPDATE jura_daily t
   SET made = t.coffee - p.coffee
  FROM (SELECT coffee FROM jura_daily
         WHERE day < {TODAY} ORDER BY day DESC LIMIT 1) p
 WHERE t.day = {TODAY};
"""

# Per-type per-day count = today.cum − prev logged day's cum, per type, floored
# at 0. A type is included ONLY if the previous day already has a baseline for it
# (`p.cum_by_type ? k`) — otherwise the transition day would attribute a type's
# whole lifetime count as "made today". Types without a prior baseline are simply
# skipped until they have one (mirrors coffee `made` being NULL on the first day).
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

_db_conn = None
def get_conn():
    global _db_conn
    if _db_conn is None or _db_conn.closed:
        _db_conn = psycopg2.connect(**DB_CONFIG)
        _db_conn.autocommit = True
    return _db_conn


_hw = {}   # drink_type slug -> high-water cumulative counter (only ever rises)


def _extract(payload):
    """Pull the tracked counters from a status payload, or None if not trustworthy."""
    # The board sets stats_valid=false until a plausible stats read succeeds; the
    # counters in such a frame are stale/zero — don't act on them.
    if payload.get('stats_valid') is False:
        return None
    cur = {}
    for key, slug in TRACKED:
        v = payload.get(key)
        if v is None:
            continue
        try:
            cur[slug] = int(v)
        except (TypeError, ValueError):
            continue
    return cur or None


def _write_daily(cur, hw):
    """Refresh TODAY's jura_daily row from the current high-water cumulative."""
    cur.execute(UPSERT_DAILY, (hw.get('coffee'), json.dumps(hw)))
    cur.execute(UPDATE_MADE)
    cur.execute(UPDATE_MADE_BY_TYPE)


def on_message(client, userdata, msg):
    global _hw
    try:
        try:
            payload = json.loads(msg.payload.decode('utf-8'))
        except Exception:
            return
        cur = _extract(payload)
        if cur is None:
            return
        conn = get_conn()

        # First trustworthy message after (re)start: seed the high-water and
        # refresh the daily row, but DON'T log events (would be phantom drinks).
        if not _hw:
            _hw = dict(cur)
            with conn.cursor() as c:
                _write_daily(c, _hw)
            log.info('baseline seeded (%d counters), coffee=%s',
                     len(_hw), _hw.get('coffee'))
            return

        # Detect per-counter advances against the high-water.
        logged = []
        for slug, val in cur.items():
            prev = _hw.get(slug)
            if prev is None:
                _hw[slug] = val         # counter first-seen this run — seed, no log
                continue
            if val > prev:
                logged.append((slug, val - prev))
                _hw[slug] = val
            # val <= prev -> transient/partial read; ignore (never baseline down)

        if not logged:
            return

        with conn.cursor() as c:
            for slug, qty in logged:
                c.execute(
                    "INSERT INTO jura_drinks (ts, qty, drink_type) VALUES (now(), %s, %s)",
                    (qty, slug))
            _write_daily(c, _hw)
        log.info('logged drink event(s): %s', logged)
    except Exception as e:
        log.exception('on_message error: %s', e)


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        log.info('connected to MQTT %s:%s as %s', MQTT_HOST, MQTT_PORT, MQTT_USER)
        client.subscribe(TOPIC)
        log.info('subscribed to %s', TOPIC)
    else:
        log.error('connect failed rc=%s', rc)


def on_disconnect(client, userdata, rc):
    log.warning('disconnected from MQTT rc=%s; paho will auto-reconnect', rc)


def main():
    if not MQTT_PASS:
        log.error('ESP_BOARDS_MQTT_PASS not set in env — exiting')
        sys.exit(1)
    client = mqtt.Client(client_id='jura_ingest_lxc104')
    client.username_pw_set(MQTT_USER, MQTT_PASS)
    client.on_connect    = on_connect
    client.on_disconnect = on_disconnect
    client.on_message    = on_message
    while True:
        try:
            client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
            client.loop_forever()
        except Exception as e:
            log.error('mqtt loop crashed: %s — retrying in 5s', e)
            time.sleep(5)


if __name__ == '__main__':
    main()
