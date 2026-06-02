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
import urllib.error
import urllib.request
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

# HA REST credentials for the sensor-veto cross-check. Loaded lazily from
# /etc/owntracks-ingest.env (same env file as MQTT_PASS, supervised by
# systemd). Optional — if absent, the sensor-veto step silently no-ops.
HA_URL   = (os.environ.get('HA_URL')   or 'http://192.168.1.110:8123').rstrip('/')
HA_TOKEN = os.environ.get('HA_TOKEN', '')

# Flicker filter — keep in sync with geolocation_ingest. AND gate: trip is
# discarded only if BOTH thresholds are unmet.
TRIP_MIN_DURATION_SEC = 60
TRIP_MIN_PATH_LENGTH_M = 100


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6_371_000
    p1 = math.radians(lat1); p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))


def _safe_ha_state(entity_id, max_age_sec=600):
    """Returns (state_value, age_sec) if the HA entity is fresh, else
    (None, None). Used by the sensor-veto cross-check. Silently no-ops if
    HA_TOKEN is unset or the call fails (defense — never break ingest
    just because HA is unreachable)."""
    if not entity_id or not HA_TOKEN:
        return None, None
    try:
        req = urllib.request.Request(
            f'{HA_URL}/api/states/{entity_id}',
            headers={
                'Authorization': f'Bearer {HA_TOKEN}',
                'Content-Type':  'application/json',
            },
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            s = json.loads(resp.read().decode('utf-8'))
        last_changed = s.get('last_changed') or s.get('last_updated')
        age = None
        if last_changed:
            ts = datetime.fromisoformat(last_changed.replace('Z', '+00:00'))
            age = (datetime.now(timezone.utc) - ts).total_seconds()
            if age > max_age_sec:
                return None, None
        return s.get('state'), age
    except Exception as e:
        log.debug('safe_ha_state %s failed: %s', entity_id, e)
        return None, None


def phone_appears_at_home(dev, veto_enabled, still_debounce_sec):
    """Returns True if phone's HA Companion sensors say it's SETTLED at
    home. Mirrors geolocation_ingest.phone_appears_at_home — keep in
    sync. Age guards on BOTH wifi and activity prevent the veto from
    killing real `away` events as the user walks the last 50-60 m back
    toward home (WiFi reconnects to home SSID a few seconds before the
    geofence crossing inward; activity flips 'still' the moment they
    stop at the door).
    """
    if not veto_enabled:
        return False
    # max_age_sec=86400 overrides _safe_ha_state's default 600s cap so
    # settled-for-hours sensors aren't treated as stale (a phone on home
    # WiFi for > 10 min would otherwise return None for wifi_state,
    # silently disabling the veto). Same fix in geolocation_ingest.
    aa_state, aa_age = _safe_ha_state(dev.get('android_auto_entity'), max_age_sec=86400)
    if aa_state == 'on' and aa_age is not None and aa_age >= still_debounce_sec:
        return False
    wifi_ent  = dev.get('wifi_entity')
    home_ssid = dev.get('wifi_home_ssid')
    if wifi_ent and home_ssid:
        wifi_state, wifi_age = _safe_ha_state(wifi_ent, max_age_sec=86400)
        if wifi_state == home_ssid and wifi_age is not None and wifi_age >= still_debounce_sec:
            return True
    act_ent = dev.get('activity_entity')
    if act_ent:
        act_state, act_age = _safe_ha_state(act_ent, max_age_sec=86400)
        if act_state == 'still' and act_age is not None and act_age >= still_debounce_sec:
            return True
    return False


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
        # State-machine defaults — see geolocation_ingest.py for full doc.
        'geofence_use_state_machine':  True,
        'geofence_wifi_min_age_sec':   10,
        'geofence_time_fallback_sec':  60,
        'geofence_hard_cap_sec':       300,
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


def insert_location(device_id, ts, lat, lon, acc, alt, speed, battery):
    """Insert one ping with explicit ts (from OwnTracks `tst`). OwnTracks
    queues pings while the phone is offline + flushes the batch on
    reconnect — passing the ping's own ts keeps batch members in their
    real chronological order so the next pass's teleport check sees real
    elapsed time, not the millisecond gap between MQTT deliveries."""
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO device_locations
               (device_id, ts, lat, lon, accuracy_m, altitude_m, speed, battery_pct, source)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (device_id, ts, lat, lon, acc, alt, speed, battery, 'owntracks_mqtt'),
        )


def emit_geofence_event(device_id, event, lat, lon, ts=None):
    """`ts=None` → NOW() (legacy + home events). `ts=<datetime>` → backdated,
    used by the state machine for `away` events so historical queries see
    the actual physical exit time, not the commit moment."""
    conn = get_conn()
    payload = json.dumps({'kind': 'geofence', 'event': event,
                          'lat': lat, 'lon': lon, 'source': 'owntracks'})
    with conn.cursor() as cur:
        if ts is None:
            cur.execute(
                """INSERT INTO device_events (ts, device_id, source, dps)
                   VALUES (NOW(), %s, 'owntracks_ingest', %s::jsonb)""",
                (device_id, payload),
            )
        else:
            cur.execute(
                """INSERT INTO device_events (ts, device_id, source, dps)
                   VALUES (%s, %s, 'owntracks_ingest', %s::jsonb)""",
                (ts, device_id, payload),
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


def _group_info(cfg, device_id):
    """Mirror of geolocation_ingest._group_info — keep in sync."""
    devs = cfg.get('tracked_devices') or []
    dev = next((d for d in devs if d.get('device_id') == device_id), None)
    if not dev:
        return device_id, [device_id], device_id
    gid = dev.get('group_id') or device_id
    label = dev.get('name') or device_id
    siblings = [d.get('device_id') for d in devs
                if (d.get('group_id') or d.get('device_id')) == gid]
    return gid, siblings, label


def open_trip(group_id, label, started_at):
    """Open a new trip row. Same shape as geolocation_ingest.open_trip —
    `uq_phone_trips_open_per_group` partial unique index ensures only one
    open trip per group across both ingest paths."""
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO phone_trips (group_id, device_label, started_at)
               VALUES (%s, %s, %s)
               ON CONFLICT DO NOTHING""",
            (group_id, label, started_at),
        )


# ─── WiFi-confirmed state machine (since 2026-06-02) ──────────────────
# Mirror of geolocation_ingest helpers. Keep in sync. See that file for
# the full state-machine doc.

def _get_open_trip(group_id):
    conn = get_conn()
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT id, started_at, confirmed
               FROM phone_trips
               WHERE group_id = %s AND returned_at IS NULL
               ORDER BY started_at DESC LIMIT 1""",
            (group_id,),
        )
        return cur.fetchone()


def _open_provisional(group_id, label, started_at):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO phone_trips (group_id, device_label, started_at, confirmed)
               VALUES (%s, %s, %s, FALSE)
               ON CONFLICT DO NOTHING""",
            (group_id, label, started_at),
        )


def _delete_provisional(trip_id):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("DELETE FROM phone_trips WHERE id = %s AND confirmed = FALSE", (trip_id,))


def _confirm_trip(trip_id):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("UPDATE phone_trips SET confirmed = TRUE WHERE id = %s", (trip_id,))


def _commit_away_atomic(trip_id, device_id, lat, lon, ts):
    """Atomically: UPDATE trip to confirmed AND INSERT the geofence:away
    event row. Both in the same transaction so a crash between them can't
    leave a confirmed trip without its paired away event (which rules would
    see as an unpaired home event next inside ping).

    Necessary because `get_conn()` returns the daemon's connection with
    `autocommit=True` — each cursor.execute commits independently. This
    helper temporarily flips autocommit off, runs both writes, commits,
    then restores autocommit so the rest of on_message keeps its
    statement-at-a-time commit semantics.
    """
    conn = get_conn()
    prev_ac = conn.autocommit
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE phone_trips SET confirmed = TRUE WHERE id = %s", (trip_id,))
            payload = json.dumps({'kind': 'geofence', 'event': 'away',
                                  'lat': lat, 'lon': lon, 'source': 'owntracks'})
            cur.execute(
                """INSERT INTO device_events (ts, device_id, source, dps)
                   VALUES (%s, %s, 'owntracks_ingest', %s::jsonb)""",
                (ts, device_id, payload),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.autocommit = prev_ac


def should_commit(trip_row, ping_ts, cfg, dev):
    """Mirror of geolocation_ingest.should_commit — see that file for doc.
    Critical: time_fallback is SKIPPED when WiFi explicitly reports 'Home'
    (prevents GPS drift from firing away events while phone is at home)."""
    age_outside_sec = (ping_ts - trip_row['started_at']).total_seconds()
    hard_cap = float(cfg.get('geofence_hard_cap_sec') or 300)
    if age_outside_sec >= hard_cap:
        return True, 'hard_cap'
    wifi_min_age = float(cfg.get('geofence_wifi_min_age_sec') or 10)
    wifi_entity  = dev.get('wifi_entity')
    home_ssid    = dev.get('wifi_home_ssid')
    wifi_verdict = 'unknown'
    if wifi_entity and home_ssid:
        # max_age_sec=86400 — see geolocation_ingest for rationale.
        wifi_state, wifi_age = _safe_ha_state(wifi_entity, max_age_sec=86400)
        # HA-reserved null states must NOT be treated as off-home SSID.
        if wifi_state in (None, 'unavailable', 'unknown', ''):
            wifi_verdict = 'unknown'
        elif wifi_state == home_ssid:
            wifi_verdict = 'home'
        elif wifi_age is not None and wifi_age >= wifi_min_age:
            return True, 'wifi_confirmed'
    if wifi_verdict != 'home':
        time_fallback = float(cfg.get('geofence_time_fallback_sec') or 60)
        if age_outside_sec >= time_fallback:
            return True, 'time_fallback'
    return False, None


def close_trip(group_id, returned_at, center_lat, center_lon, radius_m, sibling_device_ids):
    """Close the open trip for this group, computing path length from
    every sibling ping in the trip window. Mirror of
    geolocation_ingest.close_trip — keep in sync."""
    conn = get_conn()
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT id, started_at FROM phone_trips "
            "WHERE group_id = %s AND returned_at IS NULL "
            "ORDER BY started_at DESC LIMIT 1",
            (group_id,),
        )
        row = cur.fetchone()
    if not row:
        return False
    trip_id    = row['id']
    started_at = row['started_at']
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT lat::float AS lat, lon::float AS lon, ts
               FROM device_locations
               WHERE device_id = ANY(%s) AND ts BETWEEN %s AND %s
               ORDER BY ts ASC""",
            (sibling_device_ids, started_at, returned_at),
        )
        pings = cur.fetchall()
    duration_sec = max(0, int((returned_at - started_at).total_seconds()))
    max_dist_m = 0
    path_length_m = 0.0
    outside_pings = 0
    prev = None
    for p in pings:
        d = haversine_m(center_lat, center_lon, p['lat'], p['lon'])
        if d > radius_m:
            outside_pings += 1
        if d > max_dist_m:
            max_dist_m = int(d)
        if prev is not None:
            path_length_m += haversine_m(prev['lat'], prev['lon'], p['lat'], p['lon'])
        prev = p
    # Flicker filter — see TRIP_MIN_* comment.
    if (duration_sec < TRIP_MIN_DURATION_SEC
            and int(path_length_m) < TRIP_MIN_PATH_LENGTH_M):
        with conn.cursor() as cur:
            cur.execute("DELETE FROM phone_trips WHERE id = %s", (trip_id,))
        log.info('discarded flicker trip group=%s duration=%ds path=%dm (< %ds AND < %dm)',
                 group_id, duration_sec, int(path_length_m),
                 TRIP_MIN_DURATION_SEC, TRIP_MIN_PATH_LENGTH_M)
        return False
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE phone_trips
               SET returned_at = %s,
                   duration_sec = %s,
                   max_dist_m = %s,
                   path_length_m = %s,
                   outside_pings = %s
               WHERE id = %s""",
            (returned_at, duration_sec, max_dist_m, int(path_length_m),
             outside_pings, trip_id),
        )
    log.info('closed trip group=%s duration=%ds max=%dm path=%dm pings=%d',
             group_id, duration_sec, max_dist_m, int(path_length_m), outside_pings)
    return True


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

        # OwnTracks `tst` is the unix timestamp of the GPS fix (seconds).
        # When queued pings are batch-delivered after the phone reconnects,
        # each carries the real ts — preserve it so DB chronology is
        # correct and the teleport check measures real elapsed time.
        tst = payload.get('tst')
        if isinstance(tst, (int, float)) and tst > 0:
            ping_ts = datetime.fromtimestamp(tst, tz=timezone.utc)
        else:
            ping_ts = datetime.now(timezone.utc)

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
        veto_on = bool(cfg.get('sensor_veto_enabled', False))
        state_machine_on = bool(cfg.get('geofence_use_state_machine', True))
        veto_db = int(cfg.get('sensor_veto_still_debounce_sec') or 60)
        # Locate this device's tracked_devices entry so we can read its
        # per-device sensor entity IDs for the veto check.
        dev_entry = next((td for td in (cfg.get('tracked_devices') or [])
                          if td.get('device_id') == device_id), None) or {}

        last = get_last_location(device_id)
        deduped = False
        if last:
            try:
                dist    = haversine_m(float(last['lat']), float(last['lon']), lat, lon)
                # Real elapsed time between the two pings (NOT between MQTT
                # delivery moments). Queue-flushes arrive ms apart but the
                # `tst` deltas span real minutes — without this fix the
                # teleport filter dropped all but the first of a batch.
                age_sec = ping_ts.timestamp() - last['ts'].timestamp()
                if age_sec <= 0:
                    # Stale / out-of-order — most likely a retained-message
                    # replay or an MQTT reorder. Skip everything (no insert,
                    # no geofence emit) to avoid duplicate rows + backward
                    # transitions.
                    log.debug('dedup %s: stale/out-of-order ping (age_sec=%.1f)', device_id, age_sec)
                    deduped = True
                else:
                    # Teleport filter — separate `implied_speed` var so the
                    # device-reported `speed` (`vel` from OwnTracks) we'll
                    # insert isn't overwritten.
                    implied_speed = dist / age_sec
                    max_speed = float(cfg.get('max_speed_ms') or 100)
                    if max_speed > 0 and implied_speed > max_speed:
                        log.info('drop teleport ping from %s: %.0fm in %.0fs '
                                 '= %.0fm/s (filter %sm/s)',
                                 device_id, dist, age_sec, implied_speed, max_speed)
                        return
                    if dist < dedup_r and age_sec < dedup_s:
                        deduped = True
            except Exception:
                pass

        if not deduped:
            insert_location(device_id, ping_ts, lat, lon, acc, alt, speed, battery)
            log.info('ingested ping from %s — lat=%.6f lon=%.6f acc=%s ts=%s',
                     device_id, lat, lon, acc, ping_ts.isoformat())

        # Geofence transition + heartbeat
        if do_geo and center_lat is not None and center_lon is not None and radius_m:
            dist_home = haversine_m(center_lat, center_lon, lat, lon)
            is_home   = dist_home <= radius_m
            gid, siblings, label = _group_info(cfg, device_id)

            if state_machine_on:
                # ─── NEW: WiFi-confirmed state machine ─────────────────
                # See geolocation_ingest.py for full state-machine doc.
                trip_row = _get_open_trip(gid)
                # Track state evolution explicitly — heartbeat below MUST
                # see post-state-machine status, not the stale pre-fetch.
                # Without this, opening a provisional leaves trip_row=None
                # locally → heartbeat fires the very event we deferred.
                provisional_in_flight = bool(trip_row and not trip_row.get('confirmed'))
                event_emitted_this_pass = False  # commit-away or crossing-home → suppress heartbeat
                if is_home:
                    if trip_row and not trip_row['confirmed']:
                        _delete_provisional(trip_row['id'])
                        log.info('%s provisional deleted (jitter, no event fired)', gid)
                        provisional_in_flight = False
                    elif trip_row and trip_row['confirmed']:
                        emit_geofence_event(device_id, 'home', lat, lon)
                        close_trip(gid, ping_ts, center_lat, center_lon,
                                   radius_m, siblings)
                        event_emitted_this_pass = True
                        log.info('%s geofence crossing -> home (dist %.0f m)',
                                 device_id, dist_home)
                else:  # outside radius
                    if not trip_row:
                        _open_provisional(gid, label, ping_ts)
                        log.info('%s provisional opened at %s (dist %.0f m, no event yet)',
                                 gid, ping_ts.isoformat(), dist_home)
                        provisional_in_flight = True
                    elif not trip_row['confirmed']:
                        if phone_appears_at_home(dev_entry, veto_on, veto_db):
                            log.info('%s sensor veto blocking commit (provisional age %.0fs, dist %.0fm)',
                                     gid, (ping_ts - trip_row['started_at']).total_seconds(), dist_home)
                        else:
                            commit, reason = should_commit(trip_row, ping_ts, cfg, dev_entry)
                            if commit:
                                _commit_away_atomic(trip_row['id'], device_id, lat, lon, trip_row['started_at'])
                                event_emitted_this_pass = True
                                log.info('%s geofence commit:%s -> away (started_at=%s, dist %.0f m)',
                                         device_id, reason,
                                         trip_row['started_at'].isoformat(),
                                         dist_home)
                                provisional_in_flight = False
                # Heartbeat — suppressed when EITHER a provisional is in
                # flight OR an event already fired this pass. The latter
                # protects against backdated away-commit ts leaving
                # MAX(ts) stale and the heartbeat firing a duplicate at NOW().
                if hb_sec > 0 and not provisional_in_flight and not event_emitted_this_pass:
                    last_evt_ts = get_last_event_ts(device_id)
                    if (last_evt_ts is None
                            or (datetime.now(timezone.utc) - last_evt_ts).total_seconds()
                                >= hb_sec):
                        event = 'home' if is_home else 'away'
                        emit_geofence_event(device_id, event, lat, lon)
                        log.info('%s geofence heartbeat -> %s (dist %.0f m)',
                                 device_id, event, dist_home)
            else:
                # ─── LEGACY: emit-on-first-crossing (revert path) ─────
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
                if emit_reason is not None and event == 'away' and phone_appears_at_home(dev_entry, veto_on, veto_db):
                    log.info('%s sensor veto: phone says at home; suppressing AWAY event (would have been %s, dist %.0f m)',
                             device_id, emit_reason, dist_home)
                    emit_reason = None
                if emit_reason is not None:
                    emit_geofence_event(device_id, event, lat, lon)
                    log.info('%s geofence %s -> %s (dist %.0f m)',
                             device_id, emit_reason, event, dist_home)
                    if event == 'away':
                        open_trip(gid, label, ping_ts)
                    else:
                        close_trip(gid, ping_ts, center_lat, center_lon,
                                   radius_m, siblings)

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
