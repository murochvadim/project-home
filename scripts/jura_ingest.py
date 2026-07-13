#!/usr/bin/env python3
"""Jura COFFEE-count live ingest daemon — runs on LXC 104.

Event-driven: SUBSCRIBES to the jura board's status topic and updates
jura_daily the instant the board publishes — no polling. Always listening.

The board (jura) reads the Jura over BLE (~10 s poll + publish-on-change while
the machine is on) and publishes its counters to mur/home/esp/jura/status.
Each message carries cnt_coffee; when it ADVANCES we:
  • upsert TODAY's jura_daily row: coffee = GREATEST(cnt_coffee)  (high-water)
  • recompute made = coffee − previous logged day's coffee (coffees made today)
  • append one jura_drinks event (ts + qty) — the per-coffee timestamped log
    that feeds the sub-day (6h/24h) graph; day+ ranges use jura_daily.made
  • stamp updated_at

Only the Coffee counter is tracked (per the user). Both tables are preserved
forever (retention = forever + protected). The first message after a (re)start
is a baseline: it seeds _last_coffee WITHOUT logging a jura_drinks event, so a
restart can't invent a phantom coffee (jura_daily's high-water still catches any
coffee brewed during downtime, only its exact timestamp is lost).

Required env:
  ESP_BOARDS_MQTT_PASS   password for the shared `esp_boards` MQTT user
  DB_PASS                Postgres password (optional — pg_hba trusts the subnet)

Deploy:
  scp scripts/jura_ingest.py root@192.168.1.227:/opt/jura_ingest.py
  systemd unit jura-ingest.service (EnvironmentFile=/etc/jura-ingest.env)
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

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('jura_ingest')

UPSERT = """
INSERT INTO jura_daily (day, coffee, updated_at)
VALUES ((now() AT TIME ZONE 'Asia/Jerusalem')::date, %s, now())
ON CONFLICT (day) DO UPDATE SET
  coffee     = GREATEST(jura_daily.coffee, EXCLUDED.coffee),
  updated_at = now();
"""
# Recompute today's per-day count. FROM returns a row only if a prior day
# exists, so the first logged day keeps made = NULL.
UPDATE_MADE = """
UPDATE jura_daily t
   SET made = t.coffee - p.coffee
  FROM (SELECT coffee FROM jura_daily
         WHERE day < (now() AT TIME ZONE 'Asia/Jerusalem')::date
         ORDER BY day DESC LIMIT 1) p
 WHERE t.day = (now() AT TIME ZONE 'Asia/Jerusalem')::date;
"""

_db_conn = None
def get_conn():
    global _db_conn
    if _db_conn is None or _db_conn.closed:
        _db_conn = psycopg2.connect(**DB_CONFIG)
        _db_conn.autocommit = True
    return _db_conn


_last_coffee = None   # only touch the DB when the count actually advances

def on_message(client, userdata, msg):
    global _last_coffee
    try:
        try:
            payload = json.loads(msg.payload.decode('utf-8'))
        except Exception:
            return
        coffee = payload.get('cnt_coffee')
        if coffee is None:
            return   # status without stats (board hasn't read the machine yet)
        coffee = int(coffee)
        if _last_coffee is not None and coffee == _last_coffee:
            return   # unchanged since last write — nothing to do
        conn = get_conn()
        with conn.cursor() as cur:
            cur.execute(UPSERT, (coffee,))
            cur.execute(UPDATE_MADE)
            # Per-coffee timestamped event(s) for the sub-day (6h/24h) graph —
            # only a REAL increment (not the first-message baseline, not a
            # counter reset). qty = how many coffees since the last report.
            if _last_coffee is not None and coffee > _last_coffee:
                cur.execute("INSERT INTO jura_drinks (ts, qty) VALUES (now(), %s)",
                            (coffee - _last_coffee,))
        _last_coffee = coffee
        log.info('jura_daily updated: coffee=%d', coffee)
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
