#!/usr/bin/env python3
"""WF96C → raw_data ingest service.

Persistent MQTT subscriber on LXC 103. Consumes temperature events from the
WF96C-TD Controller (Tuya device 116508838cce4eef9273) and writes rows to
raw_data, then wakes the boiler agent via sync_signals.

Replaces the ha_to_pg cron for boiler_temp and panel_temp. valve_state is
still read from HA (switch.boiler_valve_switch_switch_1) on a 30-second
cache so HA isn't hit on every MQTT event (~1 event every few seconds).

Encoding: WF96C DPS 103/104 are °C × 10 (e.g. 585 = 58.5°C).
"""

import json
import logging
import os
import signal
import sys
import time
from datetime import datetime

import paho.mqtt.client as mqtt
import psycopg2
import pytz
import requests

log = logging.getLogger('wf96c_ingest')

# ── Config from env ──────────────────────────────────────────────────────
MQTT_HOST = os.environ.get('MQTT_HOST', '192.168.1.189')
MQTT_PORT = int(os.environ.get('MQTT_PORT', '1883'))
MQTT_USER = os.environ.get('MQTT_USER', 'boiler_agent')
MQTT_PASS = os.environ.get('MQTT_PASS', '')
HA_URL    = os.environ.get('HA_URL', 'http://192.168.1.110:8123')
HA_TOKEN  = os.environ.get('HA_TOKEN', '')
DB_PASS   = os.environ.get('DB_PASS', '')

WF96C_DEVICE_ID = '116508838cce4eef9273'
WF96C_TOPIC = f'mur/home/device/{WF96C_DEVICE_ID}/event'
VALVE_ENTITY = 'switch.boiler_valve_switch_switch_1'
VALVE_CACHE_TTL = 30.0  # seconds

PG_CONF = {
    'host': '192.168.1.219',
    'port': 5432,
    'dbname': 'home_data',
    'user': 'postgres',
    'password': DB_PASS,
}

# ── Running state ────────────────────────────────────────────────────────
# Latest seen temps (WF96C events often carry only one of the two DPS, so
# we need last-values to compose a full raw_data row on each tick).
_last_boiler_temp = None  # °C
_last_panel_temp  = None  # °C
_valve_cache = None       # (value, wall_clock_ts)
_event_count = 0


# ── HA valve read with 30s cache ─────────────────────────────────────────

def _fetch_valve_state():
    """Read the HA switch entity. Returns True / False / None."""
    try:
        r = requests.get(
            f'{HA_URL}/api/states/{VALVE_ENTITY}',
            headers={'Authorization': f'Bearer {HA_TOKEN}'},
            timeout=5,
        )
        r.raise_for_status()
        v = r.json().get('state')
        if v in (None, 'unknown', 'unavailable'):
            return None
        return v.lower() in ('on', 'open', 'true')
    except Exception as e:
        log.warning(f'HA valve fetch failed: {e}')
        return None


def _get_cached_valve_state():
    global _valve_cache
    now = time.time()
    if _valve_cache is not None and (now - _valve_cache[1]) < VALVE_CACHE_TTL:
        return _valve_cache[0]
    val = _fetch_valve_state()
    if val is not None:
        _valve_cache = (val, now)
    elif _valve_cache is not None:
        # HA temporarily unreachable — serve stale cache rather than NULL,
        # matching ha_to_pg behavior of preferring last-good over nothing.
        return _valve_cache[0]
    return val


# ── DB write ─────────────────────────────────────────────────────────────

def _write_row(boiler_temp, panel_temp, valve_state):
    now = datetime.now(pytz.utc)
    try:
        with psycopg2.connect(**PG_CONF) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'INSERT INTO raw_data (ts, boiler_temp, panel_temp, valve_state) '
                    'VALUES (%s, %s, %s, %s)',
                    (now, boiler_temp, panel_temp, valve_state),
                )
                cur.execute(
                    "INSERT INTO sync_signals (source) VALUES ('wf96c_ingest')"
                )
            conn.commit()
    except Exception as e:
        # Don't crash — just log. Next event will retry. Boiler agent is
        # tolerant of short raw_data gaps (it looks back trend_runs rows).
        log.error(f'DB insert failed: {e}')


# ── MQTT callbacks ───────────────────────────────────────────────────────

def _on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        log.info(f'MQTT connected — subscribing to {WF96C_TOPIC}')
        client.subscribe(WF96C_TOPIC, qos=0)
    else:
        log.error(f'MQTT connect failed: rc={rc}')


def _on_disconnect(client, userdata, rc, properties=None, reason_code=None):
    log.warning(f'MQTT disconnected (rc={rc}) — paho will auto-reconnect')


def _on_message(client, userdata, msg):
    global _last_boiler_temp, _last_panel_temp, _event_count
    try:
        payload = json.loads(msg.payload.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        log.warning(f'Bad payload on {msg.topic}: {e}')
        return

    dps = payload.get('dps', {})
    if not isinstance(dps, dict):
        return

    changed = False
    if '103' in dps:
        try:
            _last_boiler_temp = float(dps['103']) / 10.0
            changed = True
        except (TypeError, ValueError):
            log.warning(f'DPS 103 not numeric: {dps["103"]!r}')
    if '104' in dps:
        try:
            _last_panel_temp = float(dps['104']) / 10.0
            changed = True
        except (TypeError, ValueError):
            log.warning(f'DPS 104 not numeric: {dps["104"]!r}')

    if not changed:
        return  # event carried other DPS we don't care about

    # NULL guard — same rule as ha_to_pg: skip if we have no usable temp yet.
    if _last_boiler_temp is None and _last_panel_temp is None:
        return

    valve_state = _get_cached_valve_state()
    _write_row(_last_boiler_temp, _last_panel_temp, valve_state)

    _event_count += 1
    if _event_count % 50 == 0:
        log.info(
            f'Ingested {_event_count} rows — '
            f'latest boiler={_last_boiler_temp}°C panel={_last_panel_temp}°C valve={valve_state}'
        )


# ── Entry point ──────────────────────────────────────────────────────────

def main():
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s',
    )
    # DB_PASS is intentionally NOT required — Postgres on LXC 102 uses trust
    # auth for the 192.168.1.0/24 subnet (see pg_hba.conf), matching the
    # existing ha_to_pg cron's behavior.
    for name in ('HA_TOKEN', 'MQTT_PASS'):
        if not os.environ.get(name):
            log.error(f'{name} not set — refusing to start')
            sys.exit(1)

    # paho-mqtt 2.x introduced CallbackAPIVersion. Fall back cleanly on
    # older builds.
    try:
        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id='wf96c-ingest',
        )
    except (AttributeError, TypeError):
        client = mqtt.Client(client_id='wf96c-ingest')

    client.username_pw_set(MQTT_USER, MQTT_PASS)
    client.on_connect = _on_connect
    client.on_disconnect = _on_disconnect
    client.on_message = _on_message
    client.reconnect_delay_set(min_delay=1, max_delay=30)

    def _shutdown(signum, frame):
        log.info('SIGTERM — disconnecting')
        client.disconnect()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    log.info(f'Connecting to MQTT {MQTT_HOST}:{MQTT_PORT} as {MQTT_USER}')
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_forever()


if __name__ == '__main__':
    main()
