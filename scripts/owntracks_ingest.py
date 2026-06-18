#!/usr/bin/env python3
"""OwnTracks MQTT ingest daemon — runs on LXC 104.

Sole ingest path for phone geolocation since the HA Companion side was
removed 2026-06-03 (see GEOLOCATION/CLAUDE.md for the full removal log).
Subscribes to mqtt://192.168.1.189:1883 on topic `owntracks/+/+`. On
each `_type=location` payload:

  1. Writes a row into device_locations on LXC 102 (with the OwnTracks
     `tst` field as ts, so burst-flushed pings preserve chronology).
  2. Runs the geofence state machine against the apartment center
     configured in dashboard_settings.geolocation. The state machine
     opens provisional trips, commits them via time_fallback (60 s) or
     hard_cap (300 s), emits geofence:away / geofence:home events to
     device_events, and closes trips in phone_trips with full
     statistics (max_dist, path_length, outside_pings).

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

# Flicker filter — trip is discarded on close if BOTH thresholds are unmet.
TRIP_MIN_DURATION_SEC = 60
TRIP_MIN_PATH_LENGTH_M = 100

# Anti-teleport hard rule (since 2026-06-03 trip 301 incident).
# If the previous ping was inside the home radius AND the new ping is
# > IMPOSSIBLE_JUMP_M away, drop it UNCONDITIONALLY — no time-since-last
# guard. Catches Android Fused Location replaying cached far-away coords
# (e.g. Jerusalem) after the phone wakes from sleep while genuinely at
# home. The OLD age_sec<30s guard let cache replays through whenever
# OwnTracks had been silent long enough for the cache to refresh.
#
# Trade-off: a legitimate long trip where the phone sleeps for the entire
# journey (OwnTracks publishes NO intermediate ping) won't get its trip
# opened — first far-away ping is dropped, subsequent pings keep being
# dropped because `last` in DB is still the old inside-home ping. To
# recover, OwnTracks must publish at least one intermediate fix between
# home and the destination. In practice OwnTracks publishes on significant
# motion every few seconds-to-minutes, so this scenario is rare.
IMPOSSIBLE_JUMP_M = 5_000

# "At home" band for the teleport-from-home hard rule. The tight home_radius
# (40 m) was too small: the home GPS scatter has a recurring multipath cluster
# ~155 m SW (the SAME fixed phantom the trip janitor cleans for close fakes),
# which sits just OUTSIDE the radius. That 155 m ping became `last` and
# disqualified the hard rule (which required prev INSIDE the radius), so a
# cached far-jump after a sleep gap (e.g. 115 km to the Jerusalem area) slipped
# past — its implied speed over the ~38 min gap (~180 km/h) fell JUST under
# MAX_SPEED_MS, and a pure speed cap can't go lower without nuking real Israel
# Railways express trips (~160 km/h). Treating anything within this band as
# "at home" drops the ENTIRE far glitch: dropped pings never become `last`, so
# `last` stays pinned near home and every subsequent far ping is dropped too.
# Real trips recover on the first intermediate fix beyond this band (same
# trade-off the hard rule already documents above). Floor — actual band is
# max(home_radius, this). Verified against fake trips 7279/7358 (2026-06-18).
NEAR_HOME_M = 300

# Teleport filter — drop pings whose implied speed exceeds this (m/s).
# 50 m/s = 180 km/h: above any legitimate Israeli ground transport (the
# Israel Railways express tops out at ~160 km/h; freeway speed limit is
# 110 km/h). Lowered from 100 (the previous threshold let a 92 m/s
# Jerusalem-from-home cache replay through — trip 301 incident 2026-06-03).
MAX_SPEED_MS = 50


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
    """Read dashboard_settings.geolocation singleton. HA-free configuration —
    see 2026-06-03 cleanup. `geofence_wifi_min_age_sec` was dropped along
    with the wifi_confirmed commit path (which read an HA sensor)."""
    defaults = {
        'center':                 {'lat': 32.1593, 'lon': 34.8932},
        'home_radius_m':          80,
        'tracked_devices':        [],
        'geofence_events':        True,
        'geofence_heartbeat_sec': 0,
        # State machine: provisional opens on first outside ping; commits
        # via time_fallback (60 s) or hard_cap (300 s). No WiFi-confirm path.
        'geofence_use_state_machine':  True,
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
    """Resolve (group_id, sibling_device_ids, label) from settings.
    Multiple tracked_devices entries can share a `group_id` so future
    additional sources for the same phone are coalesced into a single
    trip row. Entries without group_id fall back to device_id."""
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
    """Open a NEW (already-confirmed) trip row — legacy revert path only.
    Called when `geofence_use_state_machine=false`. The state-machine path
    uses `_open_provisional` instead. The partial unique index
    `uq_phone_trips_open_per_group` enforces one open trip per group."""
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO phone_trips (group_id, device_label, started_at)
               VALUES (%s, %s, %s)
               ON CONFLICT DO NOTHING""",
            (group_id, label, started_at),
        )


# ─── Trip state machine (HA-free since 2026-06-03) ───────────────────
# Two-phase trip lifecycle:
#   1. First outside ping  → _open_provisional        (confirmed=false)
#   2a. inside ping while provisional → _delete_provisional (jitter filtered)
#   2b. outside ping with age ≥ time_fallback (60 s) → _commit_away_atomic
#       (UPDATE confirmed=true + INSERT geofence:away in one tx, backdated
#       ts = trip.started_at). Hard cap at 300 s is the defensive ceiling.
#   3. inside ping while confirmed → emit geofence:home + close_trip
# The legacy revert path (open_trip → close_trip directly, no provisional)
# is used when `geofence_use_state_machine=false` in settings.

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


def should_commit(trip_row, ping_ts, cfg):
    """Pure GPS-only commit logic. Two gates:
      - hard_cap    (default 300 s) — ultimate fail-safe ceiling
      - time_fallback (default 60 s) — normal commit threshold
    """
    age_outside_sec = (ping_ts - trip_row['started_at']).total_seconds()
    hard_cap = float(cfg.get('geofence_hard_cap_sec') or 300)
    if age_outside_sec >= hard_cap:
        return True, 'hard_cap'
    time_fallback = float(cfg.get('geofence_time_fallback_sec') or 60)
    if age_outside_sec >= time_fallback:
        return True, 'time_fallback'
    return False, None


def close_trip(group_id, returned_at, center_lat, center_lon, radius_m, sibling_device_ids):
    """Close the open trip for this group, computing path length + max
    distance + outside-pings from every sibling ping in the trip window.
    Applies the flicker filter on close (drop trips < 60 s AND < 100 m
    path length) so micro-jitter doesn't pollute the trips table."""
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
        state_machine_on = bool(cfg.get('geofence_use_state_machine', True))

        last = get_last_location(device_id)

        # Anti-teleport HARD rule. If previous ping was inside the home
        # radius AND new ping is > IMPOSSIBLE_JUMP_M away → DROP. No time
        # constraint — catches Android Fused Location replaying cached
        # far-away coords (e.g. Jerusalem coords after the phone wakes
        # from sleep while genuinely sitting at home). To get out, the
        # phone must publish at least ONE intermediate ping between home
        # and the destination.
        if (last is not None and center_lat is not None
                and center_lon is not None and radius_m):
            try:
                _prev_dist = haversine_m(center_lat, center_lon,
                                         float(last['lat']), float(last['lon']))
                _near_home = max(radius_m, NEAR_HOME_M)
                if _prev_dist <= _near_home:
                    _new_dist = haversine_m(center_lat, center_lon, lat, lon)
                    if _new_dist > IMPOSSIBLE_JUMP_M:
                        _age_sec = ping_ts.timestamp() - last['ts'].timestamp()
                        log.warning(
                            'drop teleport-from-home ping from %s: prev_dist=%.0fm '
                            '(near home <= %.0fm) → new_dist=%.0fm > %.0fm '
                            '(age=%.0fs, acc=%s) — suspected Fused-Location cache replay',
                            device_id, _prev_dist, _near_home, _new_dist,
                            IMPOSSIBLE_JUMP_M, _age_sec, acc)
                        return
            except Exception as e:
                log.debug('anti-teleport check error: %s', e)

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
                    # insert isn't overwritten. Threshold is the module
                    # constant MAX_SPEED_MS — not user-configurable.
                    implied_speed = dist / age_sec
                    if implied_speed > MAX_SPEED_MS:
                        log.info('drop teleport ping from %s: %.0fm in %.0fs '
                                 '= %.0fm/s (filter %dm/s)',
                                 device_id, dist, age_sec, implied_speed, MAX_SPEED_MS)
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
                # State machine — see helper-block comment above.
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
                        # HA-free commit logic. should_commit returns
                        # (True, 'time_fallback'|'hard_cap') once an age
                        # threshold trips; else (False, None) → wait.
                        commit, reason = should_commit(trip_row, ping_ts, cfg)
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
