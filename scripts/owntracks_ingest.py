#!/usr/bin/env python3
"""OwnTracks MQTT ingest daemon — runs on LXC 104.

Subscribes to mqtt://192.168.1.189:1883 on topic `owntracks/+/+` and
writes each incoming `_type=location` payload into device_locations on
LXC 102 — same shape as the HA Companion path written by
geolocation_ingest.py. Also handles geofence transition + heartbeat
event emission against the apartment center configured in
dashboard_settings.geolocation, identical to the HA Companion ingest.

Topic format expected: owntracks/<username>/<device_id>
Device row identifier: f"owntracks_{username}_{device_id}"

Long-running daemon. Reconnects on broker disconnect. Reads settings on
every message (cheap — small JSONB row) so the daemon picks up any
center/radius/heartbeat changes without restart.

Required env:
  OWNTRACKS_MQTT_PASS    password for `owntracks_phone` MQTT user
  DB_PASS                Postgres password (optional — pg_hba trusts subnet)
"""
import json
import logging
import math
import os
import sys
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
import psycopg2
from psycopg2.extras import RealDictCursor

MQTT_HOST = '192.168.1.189'
MQTT_PORT = 1883
MQTT_USER = 'owntracks_phone'
MQTT_PASS = os.environ.get('OWNTRACKS_MQTT_PASS', '')

DB_CONFIG = {
    'host':     '192.168.1.219',
    'database': 'home_data',
    'user':     'postgres',
    'password': os.environ.get('DB_PASS', ''),
    'port':     5432,
}

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
)
log = logging.getLogger('owntracks_ingest')


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6_371_000
    p1 = math.radians(lat1); p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))


_db_conn = None
def get_conn():
    """Lazy-connect + reconnect-on-failure. Daemon stays up across DB
    blips (e.g. LXC 102 reboot)."""
    global _db_conn
    if _db_conn is None or _db_conn.closed:
        _db_conn = psycopg2.connect(**DB_CONFIG)
        _db_conn.autocommit = True
    return _db_conn


def read_settings():
    """Read dashboard_settings.geolocation singleton. Defaults match
    geolocation_ingest.py so behaviour is identical for OwnTracks pings."""
    defaults = {
        'center':                 {'lat': 32.1593, 'lon': 34.8932},
        'home_radius_m':          80,
        'tracked_devices':        [],
        'geofence_events':        True,
        'geofence_heartbeat_sec': 0,
    }
    try:
        conn = get_conn()
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT value FROM dashboard_settings WHERE key = 'geolocation'")
            row = cur.fetchone()
        if row and row['value']:
            return {**defaults, **row['value']}
    except Exception as e:
        log.warning('settings read failed: %s', e)
    return defaults


_registered_devices = set()  # auto-register cache — avoid spamming devices table

def ensure_device_registered(device_id, name):
    """Auto-create devices row for a new OwnTracks device so subsequent
    geofence events satisfy the FK constraint. Idempotent + cached."""
    if device_id in _registered_devices:
        return
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO devices (id, name, device_type, protocol, room, enabled,
                                    show_dashboard, dps_labels, dps_config, channel_config)
               VALUES (%s, %s, 'phone', 'owntracks', 'Mobile', true, false,
                       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
               ON CONFLICT (id) DO NOTHING""",
            (device_id, name),
        )
    _registered_devices.add(device_id)


def insert_location(device_id, lat, lon, acc, alt, speed, battery):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO device_locations
               (device_id, lat, lon, accuracy_m, altitude_m, speed, battery_pct, source)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (device_id, lat, lon, acc, alt, speed, battery, 'owntracks_mqtt'),
        )


def emit_geofence_event(device_id, event, lat, lon):
    conn = get_conn()
    payload = json.dumps({'kind': 'geofence', 'event': event,
                          'lat': lat, 'lon': lon, 'source': 'owntracks'})
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO device_events (ts, device_id, source, dps)
               VALUES (NOW(), %s, 'owntracks_ingest', %s::jsonb)""",
            (device_id, payload),
        )


def get_last_location(device_id):
    conn = get_conn()
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT ts, lat, lon FROM device_locations
               WHERE device_id = %s ORDER BY ts DESC LIMIT 1""",
            (device_id,),
        )
        return cur.fetchone()


def get_last_event_ts(device_id):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """SELECT MAX(ts) FROM device_events
               WHERE device_id = %s AND source = 'owntracks_ingest'""",
            (device_id,),
        )
        r = cur.fetchone()
        return r[0] if r else None


def on_message(client, userdata, msg):
    try:
        parts = msg.topic.split('/')
        if len(parts) != 3 or parts[0] != 'owntracks':
            return
        _, user, device = parts
        device_id   = f'owntracks_{user}_{device}'
        friendly    = f'{user.title()} {device.title()} (OwnTracks)'
        ensure_device_registered(device_id, friendly)

        try:
            payload = json.loads(msg.payload.decode('utf-8'))
        except Exception:
            log.warning('non-json payload on %s', msg.topic)
            return

        # OwnTracks emits multiple message types: location, lwt, status,
        # waypoint, transition. We only ingest location pings.
        if payload.get('_type') != 'location':
            return

        lat = payload.get('lat'); lon = payload.get('lon')
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            return

        acc     = payload.get('acc')
        alt     = payload.get('alt')
        speed   = payload.get('vel')   # OwnTracks: velocity (km/h, optional)
        battery = payload.get('batt')  # OwnTracks: 0..100

        # Dedup vs last DB row (radius+window). Reuse settings shape.
        cfg = read_settings()
        dedup_r = float(cfg.get('dedup_radius_m') or 25)
        dedup_s = float(cfg.get('dedup_window_sec') or 60)
        radius_m = float(cfg.get('home_radius_m') or 80)
        lo_acc   = float(cfg.get('low_accuracy_filter_m') or 100)

        # Low-accuracy filter — drop garbage pings (cell-tower fallbacks with
        # 1000+ m uncertainty often land hundreds of km from real position).
        # Matches geolocation_ingest.py behaviour. Default 100 m.
        if isinstance(acc, (int, float)) and lo_acc > 0 and acc > lo_acc:
            log.info('drop low-accuracy ping from %s: acc=%s m > filter %s m',
                     device_id, acc, lo_acc)
            return
        center = cfg.get('center') or {}
        center_lat = center.get('lat'); center_lon = center.get('lon')
        do_geo = bool(cfg.get('geofence_events', True))
        hb_sec = int(cfg.get('geofence_heartbeat_sec') or 0)

        last = get_last_location(device_id)
        deduped = False
        if last:
            try:
                dist    = haversine_m(float(last['lat']), float(last['lon']), lat, lon)
                age_sec = (time.time() - last['ts'].timestamp())
                # Teleport filter — Android WiFi-location DB poisoning produces
                # impossibly-fast jumps. Drop if implied speed > max_speed_ms
                # (default 100 m/s = 360 km/h, faster than typical highway driving).
                if age_sec > 0:
                    speed = dist / age_sec
                    max_speed = float(cfg.get('max_speed_ms') or 100)
                    if max_speed > 0 and speed > max_speed:
                        log.info('drop teleport ping from %s: %.0fm in %.0fs '
                                 '= %.0fm/s (filter %sm/s)',
                                 device_id, dist, age_sec, speed, max_speed)
                        return
                if dist < dedup_r and age_sec < dedup_s:
                    deduped = True
            except Exception:
                pass

        if not deduped:
            insert_location(device_id, lat, lon, acc, alt, speed, battery)
            log.info('ingested ping from %s — lat=%.6f lon=%.6f acc=%s',
                     device_id, lat, lon, acc)

        # Geofence transition + heartbeat
        if do_geo and center_lat is not None and center_lon is not None and radius_m:
            dist_home = haversine_m(center_lat, center_lon, lat, lon)
            is_home   = dist_home <= radius_m
            event     = 'home' if is_home else 'away'
            emit_reason = None

            if last and not deduped:
                try:
                    prev_dist = haversine_m(center_lat, center_lon,
                                            float(last['lat']), float(last['lon']))
                    was_home  = prev_dist <= radius_m
                    if is_home != was_home:
                        emit_reason = 'crossing'
                except Exception:
                    pass

            if emit_reason is None and hb_sec > 0:
                last_evt_ts = get_last_event_ts(device_id)
                if (last_evt_ts is None
                        or (datetime.now(timezone.utc) - last_evt_ts).total_seconds()
                            >= hb_sec):
                    emit_reason = 'heartbeat'

            if emit_reason is not None:
                emit_geofence_event(device_id, event, lat, lon)
                log.info('%s geofence %s -> %s (dist %.0f m)',
                         device_id, emit_reason, event, dist_home)

    except Exception as e:
        log.exception('on_message error: %s', e)


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        log.info('connected to MQTT %s:%s as %s', MQTT_HOST, MQTT_PORT, MQTT_USER)
        client.subscribe('owntracks/+/+')
    else:
        log.error('connect failed rc=%s', rc)


def on_disconnect(client, userdata, rc):
    log.warning('disconnected from MQTT rc=%s; paho will auto-reconnect', rc)


def main():
    if not MQTT_PASS:
        log.error('OWNTRACKS_MQTT_PASS not set in env — exiting')
        sys.exit(1)
    client = mqtt.Client(client_id='owntracks_ingest_lxc104')
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
