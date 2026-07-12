#!/usr/bin/env python3
"""Kazir_15 network-scan ingest daemon — runs on LXC 104.

Sole ingest path for the KZ15 building-network monitor. Subscribes to
mqtt://192.168.1.189:1883 on `mur/home/esp/kazir_15/event` (as the shared
`esp_boards` MQTT user — its `readwrite mur/home/esp/+/#` ACL covers this).

On each `kind:"scan"` event published by the Kazir_15 board:
  1. Mark every host previously known in that scan's /24 `subnet` as
     down (up=false) + stamp last_scan_at — so hosts that stopped
     answering flip to down.
  2. UPSERT each up-host from the event (ip / mac / rtt) as up=true with
     last_seen=now.

The board's /event only carries UP hosts, so the mark-down-then-upsert
gives an accurate up/down picture per sweep. Results land in
kazir15_hosts on LXC 102 — a table completely separate from the home
net_devices/devices inventory (KZ15 is a different building network).

The board's /status (eth link/IP, host counts) is NOT handled here — the
rule engine already projects it into esp_boards.last_status, which the
dashboard's Kazir 15 page reads directly.

Long-running daemon. Reconnects on broker/DB blips.

Required env:
  ESP_BOARDS_MQTT_PASS   password for the `esp_boards` MQTT user
  DB_PASS                Postgres password (optional — pg_hba trusts the subnet)

Deploy:
  scp scripts/kazir15_ingest.py root@192.168.1.227:/opt/kazir15_ingest.py
  systemd unit: kazir15-ingest.service (EnvironmentFile=/etc/kazir15-ingest.env)
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
TOPIC     = 'mur/home/esp/kazir_15/event'

DB_CONFIG = {
    'host':     '192.168.1.219',
    'database': 'home_data',
    'user':     'postgres',
    'password': os.environ.get('DB_PASS', ''),
    'port':     5432,
}

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('kazir15_ingest')


_db_conn = None
def get_conn():
    """Lazy-connect + reconnect-on-failure so the daemon survives a DB blip."""
    global _db_conn
    if _db_conn is None or _db_conn.closed:
        _db_conn = psycopg2.connect(**DB_CONFIG)
        _db_conn.autocommit = True
    return _db_conn


def ingest_scan(subnet, hosts):
    """Mark the subnet down, then upsert the up-hosts. mac is COALESCEd so a
    scan where the ARP harvest missed a host's MAC doesn't wipe a previously
    resolved one."""
    conn = get_conn()
    with conn.cursor() as cur:
        if subnet:
            cur.execute(
                "UPDATE kazir15_hosts SET up = false, last_scan_at = now() WHERE subnet = %s",
                (subnet,),
            )
        up = 0
        for h in hosts or []:
            ip = h.get('ip')
            if not ip:
                continue
            mac = h.get('mac')
            rtt = h.get('rtt')
            cur.execute(
                """INSERT INTO kazir15_hosts
                     (ip, mac, up, rtt_ms, subnet, first_seen, last_seen, last_scan_at)
                   VALUES (%s, %s, true, %s, %s, now(), now(), now())
                   ON CONFLICT (ip) DO UPDATE SET
                     mac          = COALESCE(EXCLUDED.mac, kazir15_hosts.mac),
                     up           = true,
                     rtt_ms       = EXCLUDED.rtt_ms,
                     subnet       = EXCLUDED.subnet,
                     last_seen    = now(),
                     last_scan_at = now()""",
                (ip, mac, rtt, subnet),
            )
            up += 1
        # Prune hosts gone for > 30 min so the page always shows CURRENT
        # reality — no stale rows piling up from old sweeps. A host that
        # comes back is re-inserted on the next scan that sees it.
        if subnet:
            cur.execute(
                "DELETE FROM kazir15_hosts WHERE subnet = %s AND up = false "
                "AND last_seen < now() - interval '30 minutes'",
                (subnet,),
            )
    log.info('scan ingested: subnet=%s up_hosts=%d', subnet, up)


def on_message(client, userdata, msg):
    try:
        try:
            payload = json.loads(msg.payload.decode('utf-8'))
        except Exception:
            return  # non-JSON (shouldn't happen on this topic) — ignore
        if not isinstance(payload, dict) or payload.get('kind') != 'scan':
            return  # acks / ota-state events on the same topic — ignore
        ingest_scan(payload.get('subnet'), payload.get('hosts'))
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
    client = mqtt.Client(client_id='kazir15_ingest_lxc104')
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
