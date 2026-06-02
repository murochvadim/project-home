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

# Flicker filter — GPS / WiFi state oscillates around the geofence boundary
# for a few seconds on every real crossing (verified 2026-06-01: the return
# crossing of a 22-min trip produced 4 spurious events within ~30 s). Without
# a filter the trips table would accumulate 2-4 garbage rows per real trip.
# At close time, if BOTH thresholds are unmet, the row is deleted instead of
# updated. The AND gate keeps short-but-real trips (e.g. a 30-second jog to
# the corner store, < 60s but > 100m) and long-but-stationary visits (> 60s
# even if path is small). The device_events rows are kept either way for
# diagnostic visibility.
TRIP_MIN_DURATION_SEC = 60
TRIP_MIN_PATH_LENGTH_M = 100


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


def _safe_ha_state(entity_id, max_age_sec=600):
    """Returns (state_value, age_sec) if entity is fresh, else (None, None).
    Used by the sensor-veto cross-check — stale sensors aren't trusted to
    veto geofence events."""
    if not entity_id:
        return None, None
    try:
        s = ha_get_state(entity_id)
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
    """Returns True if the phone's HA Companion sensors say it's SETTLED at
    home. The age check on BOTH wifi and activity is what distinguishes a
    real "I've been at home for a while" state from a transient signal —
    when returning home from a trip, WiFi reconnects to the home SSID a
    few seconds before the user actually crosses the geofence inward, and
    activity flips to 'still' as soon as they stop at the door. Without
    age guards, the veto kills the real `away` event as the user walks
    those last 50-60 m.

    Signals (all gated by min age = still_debounce_sec):
      1. Android Auto = 'on' → phone is in a car → DO NOT veto (override)
      2. WiFi connection = home SSID AND settled ≥ debounce → veto
      3. Activity = 'still' AND settled ≥ debounce → veto

    Critical: pass `max_age_sec=86400` to `_safe_ha_state` so settled-for-hours
    sensors aren't treated as stale. The default 600 s cap silently broke
    this function — a phone on home WiFi for > 10 min would return None for
    `wifi_state`, causing the veto to return False for someone who'd been
    home all evening (and letting GPS jitter through unchecked).
    """
    if not veto_enabled:
        return False
    # 1. Android Auto override — only blocks veto if AA has actually been
    # 'on' for at least debounce seconds. Transient AA state flips on
    # phone unlock should not flip the override.
    aa_state, aa_age = _safe_ha_state(dev.get('android_auto_entity'), max_age_sec=86400)
    if aa_state == 'on' and aa_age is not None and aa_age >= still_debounce_sec:
        return False
    # 2. WiFi SSID check with age guard
    wifi_ent  = dev.get('wifi_entity')
    home_ssid = dev.get('wifi_home_ssid')
    if wifi_ent and home_ssid:
        wifi_state, wifi_age = _safe_ha_state(wifi_ent, max_age_sec=86400)
        if wifi_state == home_ssid and wifi_age is not None and wifi_age >= still_debounce_sec:
            return True
    # 3. Debounced "still" activity check
    act_ent = dev.get('activity_entity')
    if act_ent:
        act_state, act_age = _safe_ha_state(act_ent, max_age_sec=86400)
        if act_state == 'still' and act_age is not None and act_age >= still_debounce_sec:
            return True
    return False


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
        'sensor_veto_enabled':    False,
        'sensor_veto_still_debounce_sec': 60,
        'stale_alert_hours':      6,
        'dedup_radius_m':         25,
        'dedup_window_sec':       60,
        # WiFi-confirmed state machine (since 2026-06-02). When enabled, the
        # away event is deferred until either the phone's wi_fi sensor has
        # been off-Home for `wifi_min_age_sec`, or `time_fallback_sec`
        # elapsed, or `hard_cap_sec` elapsed. Filters GPS jitter where the
        # phone briefly registers outside the radius while never actually
        # leaving home WiFi range. Flip use_state_machine=false to revert
        # to the legacy "emit on first outside ping" behavior.
        'geofence_use_state_machine':  True,
        'geofence_wifi_min_age_sec':   10,
        'geofence_time_fallback_sec':  60,
        'geofence_hard_cap_sec':       300,
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


def insert_location(conn, device_id, ts, lat, lon, accuracy_m, altitude_m, speed,
                    battery_pct, source='ha_companion'):
    """Insert one ping with explicit ts. Use the entity's last_changed
    timestamp, not NOW() — burst-delivered or stale-but-just-published
    pings get the correct chronological position, so the teleport check
    in the next pass compares against real elapsed time, not against
    when we happened to INSERT."""
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO device_locations
               (device_id, ts, lat, lon, accuracy_m, altitude_m, speed, battery_pct, source)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (device_id, ts, lat, lon, accuracy_m, altitude_m, speed, battery_pct, source),
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


def _group_info(cfg, device_id):
    """Look up the group_id, sibling device_ids, and display label for one
    tracked device. group_id defaults to device_id when not configured
    (a single phone with no sibling source still gets a group of size 1).
    """
    devs = cfg.get('tracked_devices') or []
    dev = next((d for d in devs if d.get('device_id') == device_id), None)
    if not dev:
        return device_id, [device_id], device_id
    gid = dev.get('group_id') or device_id
    label = dev.get('name') or device_id
    siblings = [d.get('device_id') for d in devs
                if (d.get('group_id') or d.get('device_id')) == gid]
    return gid, siblings, label


def open_trip(conn, group_id, label, started_at):
    """Open a new trip row. Unique partial index `uq_phone_trips_open_per_group`
    guarantees at most one open trip per group, so concurrent ingest paths
    racing on the same `away` event collapse to one row via ON CONFLICT."""
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO phone_trips (group_id, device_label, started_at)
               VALUES (%s, %s, %s)
               ON CONFLICT DO NOTHING""",
            (group_id, label, started_at),
        )


# ─── WiFi-confirmed state machine (since 2026-06-02) ──────────────────
#
# Defers `geofence:away` event emission until the phone has been outside
# the radius AND its `wi_fi_connection` sensor has been off-Home for a
# debounce window. Filters GPS jitter where the phone briefly registers
# outside the radius while never actually leaving home WiFi range.
#
# Flow per outside ping for a group:
#   1. _get_open_trip() — fetch any in-flight provisional/confirmed trip
#   2. If no open trip → _open_provisional() creates one (no event yet)
#   3. If provisional → should_commit() checks wifi/time conditions:
#      - committed: _confirm_trip() + emit_geofence_event(away)
#      - not yet:   keep waiting on subsequent pings
#   4. If confirmed → already-fired, heartbeat eligible
# Flow per inside ping:
#   1. If provisional → _delete_provisional() (silent jitter filter)
#   2. If confirmed   → emit_geofence_event(home) + close_trip()

def _get_open_trip(conn, group_id):
    """Fetch the open trip (provisional OR confirmed) for this group, or
    None. Returned dict includes the `confirmed` column so the caller can
    dispatch to the right branch."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT id, started_at, confirmed
               FROM phone_trips
               WHERE group_id = %s AND returned_at IS NULL
               ORDER BY started_at DESC LIMIT 1""",
            (group_id,),
        )
        return cur.fetchone()


def _open_provisional(conn, group_id, label, started_at):
    """Insert a provisional trip row (confirmed=false). The unique partial
    index `uq_phone_trips_open_per_group` swallows races between HA
    Companion and OwnTracks via ON CONFLICT DO NOTHING."""
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO phone_trips (group_id, device_label, started_at, confirmed)
               VALUES (%s, %s, %s, FALSE)
               ON CONFLICT DO NOTHING""",
            (group_id, label, started_at),
        )


def _delete_provisional(conn, trip_id):
    """Discard a provisional trip silently — the phone returned home before
    the commit conditions were met, so this was GPS jitter, not a real
    excursion. No `device_events` row was ever written for this trip."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM phone_trips WHERE id = %s AND confirmed = FALSE", (trip_id,))


def _confirm_trip(conn, trip_id):
    """Mark a provisional trip as confirmed. Caller is responsible for
    emitting the `geofence:away` event in the same pass."""
    with conn.cursor() as cur:
        cur.execute("UPDATE phone_trips SET confirmed = TRUE WHERE id = %s", (trip_id,))


def should_commit(trip_row, ping_ts, cfg, dev):
    """Decide whether to commit a provisional trip to confirmed (and fire
    the `geofence:away` event) on the current outside-radius ping.

    Returns (commit_bool, reason_str).
      - reason='wifi_confirmed' → fast path; phone's wi_fi sensor reports
        off-home AND has been settled there for >= wifi_min_age_sec
      - reason='time_fallback' → wifi sensor missing/unreachable AND phone
        has been outside ≥ time_fallback_sec (broken-sensor safety net).
        SKIPPED when WiFi sensor explicitly says phone is at Home —
        otherwise we'd fire away events on GPS-drift days while the phone
        is sitting at home with strong WiFi.
      - reason='hard_cap' → defensive ceiling; commit after hard_cap_sec
        no matter what. Even with WiFi-says-home, this fires — observability
        signal for "GPS has been drifting outside for 5+ min, something is
        wrong." Should never trigger in normal operation.
    """
    age_outside_sec = (ping_ts - trip_row['started_at']).total_seconds()
    hard_cap = float(cfg.get('geofence_hard_cap_sec') or 300)
    if age_outside_sec >= hard_cap:
        return True, 'hard_cap'
    wifi_min_age = float(cfg.get('geofence_wifi_min_age_sec') or 10)
    wifi_entity  = dev.get('wifi_entity')
    home_ssid    = dev.get('wifi_home_ssid')
    # WiFi tristate: 'away' (confirmed off-home + settled) / 'home' (at
    # home_ssid) / 'unknown' (sensor missing/unreachable or HA-reserved
    # null state). Determines whether the time_fallback safety net applies.
    # `max_age_sec=86400` overrides _safe_ha_state's default 600s cap so a
    # phone on home WiFi for > 10 min (very common) still returns the real
    # state instead of None. Without this override the wifi check is dead
    # weight after 10 min of home presence.
    wifi_verdict = 'unknown'
    if wifi_entity and home_ssid:
        wifi_state, wifi_age = _safe_ha_state(wifi_entity, max_age_sec=86400)
        # HA's reserved null states must NOT be treated as "phone is on a
        # different SSID" — they mean the sensor is in a transient bad
        # state (HA restart, companion app offline, etc.). Map them to
        # 'unknown' so the time_fallback safety net handles them.
        if wifi_state in (None, 'unavailable', 'unknown', ''):
            wifi_verdict = 'unknown'
        elif wifi_state == home_ssid:
            wifi_verdict = 'home'
        elif wifi_age is not None and wifi_age >= wifi_min_age:
            return True, 'wifi_confirmed'
        # else: wifi != home but age < min → still settling, leave verdict='unknown'
    # Time fallback ONLY applies when WiFi can't confirm we're at home.
    # When WiFi explicitly says 'Home', trust it — don't fire away based
    # on GPS-drift alone (this was the trip-67 bug on 2026-06-02 where the
    # phone reported 66m for 60s while sitting on home WiFi).
    if wifi_verdict != 'home':
        time_fallback = float(cfg.get('geofence_time_fallback_sec') or 60)
        if age_outside_sec >= time_fallback:
            return True, 'time_fallback'
    return False, None


def close_trip(conn, group_id, returned_at, center_lat, center_lon,
               radius_m, sibling_device_ids):
    """Close the currently-open trip (if any) for this group and compute
    summary stats. Path length is summed from every ping by any sibling
    device within the trip window — both HA Companion + OwnTracks
    contribute. No-op if there is no open trip for this group (e.g.
    `home` event fired without a prior `away`)."""
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
    # Pull every ping by any sibling device within the trip window.
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
    # Flicker filter — see comment on TRIP_MIN_* constants. AND gate so
    # either threshold met = keep.
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


def emit_geofence_event(conn, device_id, event, lat, lon, ts=None):
    """Write a geofence transition into device_events (same shape as
    Tuya/Zigbee push events the rule engine consumes). event = 'home'
    or 'away'.

    `ts=None` → ts column gets NOW() (legacy behavior + home events).
    `ts=<datetime>` → backdated to that moment, used by the state machine
    for `away` events so historical queries reflect the actual physical
    exit time, not the commit moment.
    """
    payload = json.dumps({'kind': 'geofence', 'event': event, 'lat': lat, 'lon': lon})
    with conn.cursor() as cur:
        if ts is None:
            cur.execute(
                """INSERT INTO device_events (device_id, ts, source, dps)
                   VALUES (%s, NOW(), %s, %s::jsonb)""",
                (device_id, 'geolocation_ingest', payload),
            )
        else:
            cur.execute(
                """INSERT INTO device_events (device_id, ts, source, dps)
                   VALUES (%s, %s, %s, %s::jsonb)""",
                (device_id, ts, 'geolocation_ingest', payload),
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
    veto_on  = bool(cfg.get('sensor_veto_enabled', False))
    veto_db  = int(cfg.get('sensor_veto_still_debounce_sec') or 60)
    state_machine_on = bool(cfg.get('geofence_use_state_machine', True))

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

        # Use the entity's own last_changed as the ping ts (falls back to
        # last_updated, then to now()). Burst-published pings or pings from
        # a phone that just reconnected after being offline carry a real
        # earlier timestamp — preserving it means the teleport check next
        # pass measures real elapsed time, not "time since I happened to
        # poll." Defensive: if HA's timestamp parses fail for any reason,
        # fall back to now() so a malformed payload never blocks ingest.
        ping_ts = datetime.now(timezone.utc)
        try:
            tsraw = state.get('last_changed') or state.get('last_updated')
            if tsraw:
                ping_ts = datetime.fromisoformat(tsraw.replace('Z', '+00:00'))
        except Exception:
            pass

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
                # Real elapsed time = ping's own ts vs last DB row's ts.
                age_sec = ping_ts.timestamp() - last['ts'].timestamp()
                # Stale HA state: when phone stops publishing, HA caches
                # the last fix and `last_changed` stays frozen. Successive
                # polls produce age_sec = 0 with identical coords — must
                # still dedup. age_sec < 0 = out-of-order ping (rare; HA
                # rolled its state back somehow); treat as dedup too so we
                # don't pollute DB or emit a backward geofence transition.
                if age_sec <= 0:
                    log.debug('dedup %s: stale/out-of-order ping (age_sec=%.1f)', device_id, age_sec)
                    deduped = True
                else:
                    # Teleport filter — WiFi-DB poisoning produces impossibly-
                    # fast jumps. Use a SEPARATE `implied_speed` var so we
                    # don't clobber the GPS-reported `speed` we'll insert.
                    implied_speed = dist / age_sec
                    max_speed = float(cfg.get('max_speed_ms') or 100)
                    if max_speed > 0 and implied_speed > max_speed:
                        log.info('drop teleport ping from %s: %.0fm in %.0fs '
                                 '= %.0fm/s (filter %sm/s)',
                                 device_id, dist, age_sec, implied_speed, max_speed)
                        continue
                    if dist < dedup_r and age_sec < dedup_s:
                        log.debug('dedup %s: %sm < %sm AND %ss < %ss', device_id, dist, dedup_r, age_sec, dedup_s)
                        deduped = True
            except Exception as e:
                log.debug('dedup compare error: %s', e)

        if not deduped:
            battery = get_battery(batt_ent)
            insert_location(conn, device_id, ping_ts, lat, lon, acc, alt, speed, battery)
            inserts += 1

        # Geofence transition check + optional heartbeat re-emit. Runs every
        # pass — heartbeat must fire even when the new ping was deduped, since
        # a stationary phone will be deduped for hours at a time.
        if can_geofence:
            dist_home = haversine_m(center_lat, center_lon, lat, lon)
            is_home   = dist_home <= radius_m
            gid, siblings, label = _group_info(cfg, device_id)

            if state_machine_on:
                # ─── NEW: WiFi-confirmed state machine ─────────────────
                # away event is deferred until the wi_fi sensor confirms the
                # exit (or time fallback / hard cap elapse). Filters GPS
                # jitter where the phone briefly spikes outside the radius
                # while never actually leaving home WiFi range.
                trip_row = _get_open_trip(conn, gid)
                # Track state evolution explicitly so the heartbeat block
                # below sees the POST-state-machine status, not the stale
                # pre-fetched trip_row. Without this, opening a provisional
                # leaves the local trip_row=None → heartbeat fires the very
                # event we just tried to defer.
                provisional_in_flight = bool(trip_row and not trip_row.get('confirmed'))
                event_emitted_this_pass = False  # commit-away or crossing-home → suppress heartbeat
                if is_home:
                    if trip_row and not trip_row['confirmed']:
                        # Phone returned home before commit conditions met.
                        # Silent jitter filter — no device_events row was
                        # ever written, no row in phone_trips survives.
                        _delete_provisional(conn, trip_row['id'])
                        log.info('%s provisional deleted (jitter, no event fired)', gid)
                        provisional_in_flight = False
                    elif trip_row and trip_row['confirmed']:
                        # Real trip ending — fire the home event + close.
                        emit_geofence_event(conn, device_id, 'home', lat, lon)
                        close_trip(conn, gid, ping_ts, center_lat, center_lon,
                                   radius_m, siblings)
                        geofence_crossings += 1
                        event_emitted_this_pass = True
                        log.info('%s geofence crossing -> home (dist %.0f m)',
                                 device_id, dist_home)
                else:  # outside radius
                    if not trip_row:
                        # First outside ping for this group → open
                        # provisional, NO event yet.
                        _open_provisional(conn, gid, label, ping_ts)
                        log.info('%s provisional opened at %s (dist %.0f m, no event yet)',
                                 gid, ping_ts.isoformat(), dist_home)
                        provisional_in_flight = True
                    elif not trip_row['confirmed']:
                        # Sensor veto still applies — suppress commit if
                        # the phone's own sensors say it's at home.
                        if phone_appears_at_home(dev, veto_on, veto_db):
                            log.info('%s sensor veto blocking commit (provisional age %.0fs, dist %.0fm)',
                                     gid, (ping_ts - trip_row['started_at']).total_seconds(), dist_home)
                        else:
                            commit, reason = should_commit(trip_row, ping_ts, cfg, dev)
                            if commit:
                                _confirm_trip(conn, trip_row['id'])
                                emit_geofence_event(conn, device_id, 'away', lat, lon,
                                                    ts=trip_row['started_at'])
                                geofence_crossings += 1
                                event_emitted_this_pass = True
                                log.info('%s geofence commit:%s -> away (started_at=%s, dist %.0f m)',
                                         device_id, reason,
                                         trip_row['started_at'].isoformat(),
                                         dist_home)
                                provisional_in_flight = False
                    # else: already confirmed → continued away, no per-ping
                    # action. Heartbeat handled below.

                # Heartbeat — suppressed when EITHER a provisional is in
                # flight OR an event already fired in this pass. The latter
                # protects against a backdated away-event commit (ts is
                # `started_at`, potentially hours old for burst-flushed
                # trips) leaving MAX(ts) older than hb_sec, which would
                # otherwise let the heartbeat block fire a second event
                # at NOW() within seconds of the real one.
                if hb_sec > 0 and not provisional_in_flight and not event_emitted_this_pass:
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
                            event = 'home' if is_home else 'away'
                            emit_geofence_event(conn, device_id, event, lat, lon)
                            geofence_crossings += 1
                            log.info('%s geofence heartbeat -> %s (dist %.0f m)',
                                     device_id, event, dist_home)
                    except Exception as e:
                        log.warning('geofence heartbeat check error: %s', e)
            else:
                # ─── LEGACY: emit-on-first-crossing (revert path) ─────
                # Preserved byte-for-byte from before 2026-06-02. Reachable
                # via the dashboard's "Use state machine" toggle. Flip
                # cfg.geofence_use_state_machine=false to use this path.
                event     = 'home' if is_home else 'away'
                emit_reason = None
                if last and not deduped:
                    try:
                        prev_dist = haversine_m(center_lat, center_lon,
                                                float(last['lat']), float(last['lon']))
                        was_home  = prev_dist <= radius_m
                        if is_home != was_home:
                            emit_reason = 'crossing'
                    except Exception as e:
                        log.debug('geofence compare error: %s', e)
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
                if emit_reason is not None and event == 'away' and phone_appears_at_home(dev, veto_on, veto_db):
                    log.info('%s sensor veto: phone says at home; suppressing AWAY event (would have been %s, dist %.0f m)',
                             device_id, emit_reason, dist_home)
                    emit_reason = None
                if emit_reason is not None:
                    emit_geofence_event(conn, device_id, event, lat, lon)
                    geofence_crossings += 1
                    log.info('%s geofence %s -> %s (dist %.0f m)',
                             device_id, emit_reason, event, dist_home)
                    if event == 'away':
                        open_trip(conn, gid, label, ping_ts)
                    else:
                        close_trip(conn, gid, ping_ts, center_lat, center_lon,
                                   radius_m, siblings)

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
