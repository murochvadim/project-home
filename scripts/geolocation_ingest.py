#!/usr/bin/env python3
"""
Geolocation Ingest — LXC 104

Polls Home Assistant every 30 s for each tracked device_tracker entity,
INSERTs movement pings into `device_locations`, and emits `geofence:home`
/ `geofence:away` events into `device_events` when the phone crosses
the apartment radius. Reads its config live from
`dashboard_settings.geolocation` so the Settings card on Project
General → Geolocation tab is the single source of truth.

Why a separate cron-style script (instead of patching device-agent's
HA WebSocket adapter on LXC 103):

  - Single failure domain (a bad query / DB hiccup doesn't affect
    Tuya / Zigbee / Z-Wave ingest)
  - Matches the project's existing pattern for LXC 104 watchdogs
    (netbird_watchdog.py, group_health_watchdog.py, arp_scan.py)
  - 30 s REST poll is plenty for human-scale movement (phones running
    HA Companion publish on adaptive cadence; we never miss a meaningful
    transition between polls)
  - Easy to test/debug standalone — no WS lifecycle to worry about

Trade-off: 30 s REST poll captures the LATEST state at poll time, not
every state change between polls. Acceptable for v1; can upgrade to
WS in a later phase if "every micro-movement" matters.

Companion to:
  - DB tables:     device_locations (LXC 102) + geofence rows in device_events
  - Dashboard:     project-general.html → Geolocation tab + js/project-general.js
  - Settings:      dashboard_settings.geolocation (JSON blob, single row)
  - Agent index:   GEOLOCATION/CLAUDE.md
  - Env:           /etc/geolocation-ingest.env (HA_TOKEN, optional HA_URL override)

Run via systemd timer `*/30 sec` on LXC 104 OR cron every minute with
an internal sleep loop. We use the systemd-timer approach for sub-minute
cadence (cron's minimum is 1 min).
"""

import json
import logging
import math
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import RealDictCursor

log = logging.getLogger('geolocation-ingest')
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
)

# ─── Config ───────────────────────────────────────────────────────
DB = {
    'host':     '192.168.1.219',
    'port':     5432,
    'database': 'home_data',
    'user':     'postgres',
}
HA_URL   = (os.environ.get('HA_URL')   or 'http://192.168.1.110:8123').rstrip('/')
HA_TOKEN = (os.environ.get('HA_TOKEN') or '').strip()


def haversine_m(lat1, lon1, lat2, lon2):
    """Great-circle distance between two GPS points, in meters."""
    R = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1) * math.cos(p2) * math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))


def ha_get_state(entity_id):
    """Fetch one entity's full state from HA REST API."""
    if not HA_TOKEN:
        raise RuntimeError('HA_TOKEN not set')
    req = urllib.request.Request(
        f'{HA_URL}/api/states/{entity_id}',
        headers={
            'Authorization': f'Bearer {HA_TOKEN}',
            'Content-Type':  'application/json',
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))


def read_settings(conn):
    """Read the singleton dashboard_settings.geolocation row. Defaults
    embedded here mirror what the dashboard's POST endpoint will create
    on first save."""
    defaults = {
        'center':                 {'lat': 32.1593, 'lon': 34.8932},
        'home_radius_m':          80,
        'tracked_devices':        [],
        'retention_days':         30,
        'geofence_events':        True,
        'geofence_heartbeat_sec':  0,
        'trail_window_default':   '24h',
        'low_accuracy_filter_m':  100,
        'stale_alert_hours':      6,
        'dedup_radius_m':         25,
        'dedup_window_sec':       60,
    }
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT value FROM dashboard_settings WHERE key = 'geolocation'")
        row = cur.fetchone()
        if not row:
            return defaults
        val = row['value']
        if isinstance(val, str):
            try: val = json.loads(val)
            except Exception: return defaults
        if not isinstance(val, dict):
            return defaults
        # Merge defaults so missing keys don't crash later
        for k, v in defaults.items():
            val.setdefault(k, v)
        return val


def get_last_location(conn, device_id):
    """Latest row for a device. Used for dedup (don't insert duplicate stationary
    pings) and for geofence-state tracking across runs."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT lat, lon, ts, accuracy_m FROM device_locations
               WHERE device_id = %s ORDER BY ts DESC LIMIT 1""",
            (device_id,),
        )
        return cur.fetchone()


def insert_location(conn, device_id, lat, lon, accuracy_m, altitude_m, speed,
                    battery_pct, source='ha_companion'):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO device_locations
               (device_id, ts, lat, lon, accuracy_m, altitude_m, speed, battery_pct, source)
               VALUES (%s, NOW(), %s, %s, %s, %s, %s, %s, %s)""",
            (device_id, lat, lon, accuracy_m, altitude_m, speed, battery_pct, source),
        )


def get_battery(entity_id):
    """Best-effort battery read for the phone. Returns int 0-100 or None."""
    if not entity_id:
        return None
    try:
        state = ha_get_state(entity_id)
        val = state.get('state')
        return int(float(val)) if val not in (None, 'unknown', 'unavailable') else None
    except Exception:
        return None


def get_recent_home_state(conn, device_id, lookback_sec=600):
    """Compute "was the device in home zone on its previous in-radius ping?"
    by re-running the radius check against the most recent ping. Returns
    True/False/None (None = no prior pings)."""
    settings_row = None  # filled below by caller; placeholder
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT lat, lon FROM device_locations
               WHERE device_id = %s ORDER BY ts DESC LIMIT 1 OFFSET 1""",
            (device_id,),
        )
        prev = cur.fetchone()
    return prev


def emit_geofence_event(conn, device_id, event, lat, lon):
    """Write a geofence transition into device_events (same shape as
    Tuya/Zigbee push events the rule engine consumes). event = 'home'
    or 'away'.
    """
    payload = json.dumps({'kind': 'geofence', 'event': event, 'lat': lat, 'lon': lon})
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO device_events (device_id, ts, source, dps)
               VALUES (%s, NOW(), %s, %s::jsonb)""",
            (device_id, 'geolocation_ingest', payload),
        )


# ─── Main pass ────────────────────────────────────────────────────
def run():
    if not HA_TOKEN:
        log.error('HA_TOKEN not set — refusing to run')
        sys.exit(2)

    conn = psycopg2.connect(**DB)
    conn.autocommit = False

    cfg      = read_settings(conn)
    devices  = cfg.get('tracked_devices') or []
    center   = cfg.get('center') or {}
    radius_m = float(cfg.get('home_radius_m') or 80)
    dedup_r  = float(cfg.get('dedup_radius_m') or 25)
    dedup_s  = float(cfg.get('dedup_window_sec') or 60)
    lo_acc   = float(cfg.get('low_accuracy_filter_m') or 100)
    do_geo   = bool(cfg.get('geofence_events', True))
    hb_sec   = int(cfg.get('geofence_heartbeat_sec') or 0)

    if not devices:
        log.info('no tracked_devices configured — exit')
        conn.close()
        return

    center_lat = center.get('lat')
    center_lon = center.get('lon')
    can_geofence = (center_lat is not None
                    and center_lon is not None
                    and radius_m
                    and do_geo)

    inserts = 0
    geofence_crossings = 0
    for dev in devices:
        device_id  = dev.get('device_id')
        entity     = dev.get('ha_entity')
        batt_ent   = dev.get('battery_entity')
        if not device_id or not entity:
            continue

        try:
            state = ha_get_state(entity)
        except urllib.error.HTTPError as e:
            log.warning('HA fetch %s HTTP %s', entity, e.code)
            continue
        except Exception as e:
            log.warning('HA fetch %s failed: %s', entity, e)
            continue

        attrs   = state.get('attributes') or {}
        lat     = attrs.get('latitude')
        lon     = attrs.get('longitude')
        acc     = attrs.get('gps_accuracy')
        alt     = attrs.get('altitude')
        speed   = attrs.get('speed')

        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        if isinstance(acc, (int, float)) and lo_acc > 0 and acc > lo_acc:
            log.debug('skip %s low-accuracy ping (%s m > %s m)', device_id, acc, lo_acc)
            continue

        # Fetch the last DB row up-front — needed for dedup, teleport filter,
        # AND geofence transition compare. Pulling it here means the geofence
        # block below runs even when the new ping gets deduped (heartbeat
        # fires regardless of new location data).
        last = get_last_location(conn, device_id)
        deduped = False
        if last:
            try:
                last_lat = float(last['lat']); last_lon = float(last['lon'])
                dist     = haversine_m(last_lat, last_lon, lat, lon)
                age_sec  = (time.time() - last['ts'].timestamp())
                # Teleport filter — Android's WiFi-based location occasionally
                # returns coords from a poisoned access-point DB entry, with
                # fake-tight accuracy. If the implied speed since the last
                # known ping is greater than max_speed_ms (default 100 m/s =
                # 360 km/h), the ping is physically impossible and dropped.
                # Skipped if age_sec <= 0 (clock anomaly) or no prior row.
                if age_sec > 0:
                    speed = dist / age_sec
                    max_speed = float(cfg.get('max_speed_ms') or 100)
                    if max_speed > 0 and speed > max_speed:
                        log.info('drop teleport ping from %s: %.0fm in %.0fs '
                                 '= %.0fm/s (filter %sm/s)',
                                 device_id, dist, age_sec, speed, max_speed)
                        continue
                if dist < dedup_r and age_sec < dedup_s:
                    log.debug('dedup %s: %sm < %sm AND %ss < %ss', device_id, dist, dedup_r, age_sec, dedup_s)
                    deduped = True
            except Exception as e:
                log.debug('dedup compare error: %s', e)

        if not deduped:
            battery = get_battery(batt_ent)
            insert_location(conn, device_id, lat, lon, acc, alt, speed, battery)
            inserts += 1

        # Geofence transition check + optional heartbeat re-emit. Runs every
        # pass — heartbeat must fire even when the new ping was deduped, since
        # a stationary phone will be deduped for hours at a time.
        if can_geofence:
            dist_home = haversine_m(center_lat, center_lon, lat, lon)
            is_home   = dist_home <= radius_m
            event     = 'home' if is_home else 'away'
            emit_reason = None
            # Compare to the PREVIOUS state (the last DB row).
            if last and not deduped:
                try:
                    prev_dist = haversine_m(center_lat, center_lon,
                                            float(last['lat']), float(last['lon']))
                    was_home  = prev_dist <= radius_m
                    if is_home != was_home:
                        emit_reason = 'crossing'
                except Exception as e:
                    log.debug('geofence compare error: %s', e)
            # Heartbeat: re-emit current state every hb_sec seconds even when
            # no boundary crossing happened — useful for periodic confirmation
            # the pipeline is alive. Disabled when hb_sec == 0.
            if emit_reason is None and hb_sec > 0:
                try:
                    with conn.cursor() as cur:
                        cur.execute(
                            "SELECT MAX(ts) FROM device_events "
                            "WHERE device_id = %s AND source = 'geolocation_ingest'",
                            (device_id,))
                        row = cur.fetchone()
                        last_evt_ts = row[0] if row else None
                    if (last_evt_ts is None
                            or (datetime.now(timezone.utc) - last_evt_ts).total_seconds()
                                >= hb_sec):
                        emit_reason = 'heartbeat'
                except Exception as e:
                    log.warning('geofence heartbeat check error: %s', e)
            if emit_reason is not None:
                emit_geofence_event(conn, device_id, event, lat, lon)
                geofence_crossings += 1
                log.info('%s geofence %s -> %s (dist %.0f m)',
                         device_id, emit_reason, event, dist_home)

    conn.commit()
    conn.close()
    log.info('Pass complete: %d devices polled, %d inserts, %d geofence crossings',
             len(devices), inserts, geofence_crossings)


if __name__ == '__main__':
    try:
        run()
    except Exception:
        log.exception('Ingest pass failed')
        sys.exit(1)
