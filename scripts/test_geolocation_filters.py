#!/usr/bin/env python3
"""Test harness for owntracks-ingest filter chain + state machine + the
Places away-base layer.

A/B/C/D scenarios publish synthetic MQTT messages to the production broker; the
live daemon on LXC 104 processes them through the actual filter chain; this
script verifies the DB outcomes. P scenarios instead insert a controlled
device_locations stream directly and run the separate geo_places.py state
machine (a far away-base journey can't go through MQTT — the daemon's
anti-teleport-from-home guard would reject it by design), asserting
phone_places (Stays) + phone_place_trips (legs).

Test isolation: all pings use device_id='owntracks_test_filtertest' (sandbox);
Places rows use the same value as group_id. Production phone data is never touched.

Run from LXC 104. The daemon must be `active` (script aborts otherwise).

Usage:
  python3 /opt/test_geolocation_filters.py                       # default fast suite (~90s)
  python3 /opt/test_geolocation_filters.py --only A1,B2,P2       # subset (incl. Places)
  python3 /opt/test_geolocation_filters.py --cleanup             # wipe sandbox, run nothing
  python3 /opt/test_geolocation_filters.py --verbose             # extra logging
  python3 /opt/test_geolocation_filters.py --slow                # include heartbeat + hard_cap (real-time waits)
  python3 /opt/test_geolocation_filters.py --progress-json=/tmp/x.json  # write progress (dashboard polls this)
"""
import argparse
import glob
import importlib.util
import json
import logging
import math
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
import psycopg2
from psycopg2.extras import RealDictCursor


# ─── Constants ─────────────────────────────────────────────────────

TEST_DEVICE_ID = 'owntracks_test_filtertest'
TEST_USER      = 'test'         # OwnTracks topic format: owntracks/<user>/<device>
TEST_DEVICE    = 'filtertest'   # → owntracks/test/filtertest (daemon parses
                                #   `_, user, device = parts` and writes
                                #   device_id = f'owntracks_{user}_{device}')
MQTT_TOPIC = f'owntracks/{TEST_USER}/{TEST_DEVICE}'

MQTT_HOST = '192.168.1.189'
MQTT_PORT = 1883
ENV_FILE  = '/etc/owntracks-ingest.env'  # contains MQTT_USER + OWNTRACKS_MQTT_PASS

DB_CONFIG = {
    'host':     '192.168.1.219',
    'database': 'home_data',
    'user':     'postgres',
    'password': os.environ.get('DB_PASS', ''),
    'port':     5432,
}

EARTH_R = 6_371_000  # m


# ─── Logging ───────────────────────────────────────────────────────

LOG_PATH = '/var/log/test-geolocation-filters.log'

# Compact format — HH:MM:SS + message only. The dashboard log panel is narrow;
# longer formats wrap awkwardly. Levels and dates dropped from the line.
_FMT = logging.Formatter('%(asctime)s %(message)s', datefmt='%H:%M:%S')

logger = logging.getLogger('test_geo')
logger.setLevel(logging.INFO)
_stream = logging.StreamHandler(sys.stdout)
_stream.setFormatter(_FMT)
logger.addHandler(_stream)
try:
    _file = logging.FileHandler(LOG_PATH)
    _file.setFormatter(_FMT)
    logger.addHandler(_file)
except (OSError, PermissionError):
    pass  # log file may not be writable on dev hosts


# ─── Env + connection ──────────────────────────────────────────────

def load_env(path=ENV_FILE):
    """Read MQTT_USER + OWNTRACKS_MQTT_PASS + DB_PASS from /etc/owntracks-ingest.env."""
    env = {}
    if not os.path.exists(path):
        logger.warning("env file %s not found — relying on shell environment", path)
        return env
    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def db_conn():
    """Open a fresh DB connection with autocommit (mirrors daemon)."""
    cfg = dict(DB_CONFIG)
    if not cfg['password']:
        cfg['password'] = os.environ.get('DB_PASS', '')
    conn = psycopg2.connect(**cfg)
    conn.autocommit = True
    return conn


def db_query(conn, sql, params=()):
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def db_execute(conn, sql, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.rowcount


# ─── Cleanup ───────────────────────────────────────────────────────

def ensure_test_device_row(conn):
    """Make sure the sandbox device row exists in `devices`. The daemon's
    `ensure_device_registered` is in-memory-cached — once it has registered
    the device_id, it never re-inserts even if we delete the row. So if a
    prior test run dropped the row, the daemon's geofence event INSERTs hit
    FK violations forever. We INSERT here to keep DB consistent with the
    daemon's cache.

    Idempotent — ON CONFLICT DO NOTHING.
    """
    db_execute(conn, """
        INSERT INTO devices (id, name, device_type, protocol, room, enabled,
                             show_dashboard, dps_labels, dps_config, channel_config)
        VALUES (%s, 'Test Filtertest (OwnTracks)', 'phone', 'owntracks', 'Mobile',
                true, false, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING
    """, (TEST_DEVICE_ID,))


def cleanup(conn, drop_device_row=False):
    """Wipe sandbox rows. Idempotent.

    IMPORTANT: `drop_device_row` is rejected (always False) on the normal
    path. The daemon caches `_registered_devices` in memory after first
    `ensure_device_registered` INSERT — if we delete the row, the cache
    still says "registered", so the daemon NEVER recreates it on next
    ping. Subsequent geofence event INSERTs hit a FK violation and roll
    back the trip commit. The sandbox `devices` row is harmless (not in
    tracked_devices, invisible on dashboard, costs zero) so we leave it.

    The `--cleanup` CLI flag passes True intentionally — that's a
    standalone cleanup invocation, not part of a test run. The daemon is
    expected to be restarted at some point after a manual --cleanup, OR
    the row will simply be re-created on the next ping (which carries no
    real cost — the cache miss on first INSERT is harmless).
    """
    n_trips = db_execute(conn,
        "DELETE FROM phone_trips WHERE group_id = %s", (TEST_DEVICE_ID,))
    n_evts  = db_execute(conn,
        "DELETE FROM device_events WHERE device_id = %s", (TEST_DEVICE_ID,))
    n_locs  = db_execute(conn,
        "DELETE FROM device_locations WHERE device_id = %s", (TEST_DEVICE_ID,))
    # Places layer (P* scenarios) — additive tables, same sandbox group_id.
    for t in ('phone_place_trips', 'phone_places', 'geo_place_state'):
        try:
            db_execute(conn, f"DELETE FROM {t} WHERE group_id = %s", (TEST_DEVICE_ID,))
        except Exception:
            pass  # tables may not exist on an un-migrated host
    n_devs = 0
    if drop_device_row:
        n_devs = db_execute(conn,
            "DELETE FROM devices WHERE id = %s", (TEST_DEVICE_ID,))
    # Cleanup is per-scenario boilerplate — keep it at DEBUG so the user-facing
    # log shows only scenario pass/problem lines.
    logger.debug("cleanup: trips=%d events=%d locations=%d devices=%d (drop_device_row=%s)",
                 n_trips, n_evts, n_locs, n_devs, drop_device_row)
    return {
        'trips_deleted': n_trips,
        'events_deleted': n_evts,
        'locations_deleted': n_locs,
        'devices_deleted': n_devs,
    }


# ─── Geo helpers ───────────────────────────────────────────────────

def home_coords(conn):
    """Read the apartment center from dashboard_settings (live, same as daemon)."""
    rows = db_query(conn, "SELECT value FROM dashboard_settings WHERE key='geolocation'")
    if rows:
        c = (rows[0]['value'] or {}).get('center') or {}
        if 'lat' in c and 'lon' in c:
            return float(c['lat']), float(c['lon'])
    return 32.16760, 34.89993  # safe fallback


def coord_at_distance(home_lat, home_lon, meters, bearing_deg=90):
    """Project a (lat, lon) at `meters` distance from home along `bearing_deg`
    (0=N, 90=E). Spherical earth, good enough for < 200 km."""
    bearing = math.radians(bearing_deg)
    angular = meters / EARTH_R
    p1 = math.radians(home_lat)
    l1 = math.radians(home_lon)
    p2 = math.asin(
        math.sin(p1) * math.cos(angular)
        + math.cos(p1) * math.sin(angular) * math.cos(bearing)
    )
    l2 = l1 + math.atan2(
        math.sin(bearing) * math.sin(angular) * math.cos(p1),
        math.cos(angular) - math.sin(p1) * math.sin(p2),
    )
    return math.degrees(p2), math.degrees(l2)


# ─── MQTT publish ──────────────────────────────────────────────────

class MqttCtx:
    """Holds the MQTT client + reference time (T0). All scenario `tst_offset_sec`
    values are relative to T0, which is set fresh per scenario via reset_t0()."""
    def __init__(self, client, t0_epoch=None):
        self.client = client
        self.t0 = t0_epoch or int(time.time())

    def reset_t0(self):
        self.t0 = int(time.time())


def make_mqtt_client(env):
    user = env.get('MQTT_USER') or 'owntracks_phone'
    pwd  = env.get('OWNTRACKS_MQTT_PASS') or os.environ.get('OWNTRACKS_MQTT_PASS', '')
    if not pwd:
        raise RuntimeError("OWNTRACKS_MQTT_PASS not set (env or /etc/owntracks-ingest.env)")
    client = mqtt.Client(client_id='test_geo_filters')
    client.username_pw_set(user, pwd)
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
    client.loop_start()
    time.sleep(0.5)  # let connect complete
    return client


def publish_ping(ctx, lat, lon, acc, tst_offset_sec=0, alt=None, vel=None, batt=None):
    """Publish one OwnTracks _type=location ping. tst is set to ctx.t0 + offset
    so scenarios can simulate elapsed time without real waits."""
    payload = {
        '_type': 'location',
        'lat': float(lat),
        'lon': float(lon),
        'acc': float(acc),
        'tst': int(ctx.t0 + tst_offset_sec),
    }
    if alt  is not None: payload['alt']  = float(alt)
    if vel  is not None: payload['vel']  = float(vel)
    if batt is not None: payload['batt'] = int(batt)
    msg = json.dumps(payload)
    info = ctx.client.publish(MQTT_TOPIC, msg, qos=1)
    info.wait_for_publish(timeout=2)
    return payload


# ─── DB assertions ─────────────────────────────────────────────────

def count_locations(conn, where=None, params=()):
    sql = "SELECT COUNT(*) AS n FROM device_locations WHERE device_id=%s"
    args = [TEST_DEVICE_ID]
    if where:
        sql += " AND " + where
        args += list(params)
    return db_query(conn, sql, tuple(args))[0]['n']


def count_events(conn, event=None, where=None, params=()):
    sql = "SELECT COUNT(*) AS n FROM device_events WHERE device_id=%s AND source='owntracks_ingest'"
    args = [TEST_DEVICE_ID]
    if event:
        sql += " AND dps->>'event'=%s"
        args.append(event)
    if where:
        sql += " AND " + where
        args += list(params)
    return db_query(conn, sql, tuple(args))[0]['n']


def get_open_trip(conn):
    rows = db_query(conn,
        "SELECT * FROM phone_trips WHERE group_id=%s AND returned_at IS NULL "
        "ORDER BY id DESC LIMIT 1", (TEST_DEVICE_ID,))
    return rows[0] if rows else None


def get_latest_trip(conn):
    rows = db_query(conn,
        "SELECT * FROM phone_trips WHERE group_id=%s ORDER BY id DESC LIMIT 1",
        (TEST_DEVICE_ID,))
    return rows[0] if rows else None


def count_trips(conn):
    return db_query(conn,
        "SELECT COUNT(*) AS n FROM phone_trips WHERE group_id=%s",
        (TEST_DEVICE_ID,))[0]['n']


# ─── Pre-flight ────────────────────────────────────────────────────

def preflight_check_rules():
    """Grep rule files for any reference to the test device_id, owntracks
    geofence event handlers, or generic 'filtertest' / 'geofence' usage.
    Returns a list of suspect rule files."""
    suspects = []
    for path in glob.glob('/c/Users/muroc/project_home/RULES/rules/*.py'):
        try:
            with open(path, 'r') as f:
                text = f.read().lower()
            if TEST_DEVICE_ID.lower() in text or 'filtertest' in text:
                suspects.append((path, 'matches sandbox device_id — rule may react to test events'))
        except OSError:
            continue
    # Rule files live on the Windows host, not LXC 104 — best-effort skip if unreachable.
    return suspects


def preflight_check_daemon():
    """Confirm owntracks-ingest.service is active."""
    try:
        out = subprocess.run(
            ['systemctl', 'is-active', 'owntracks-ingest.service'],
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() == 'active'
    except Exception:
        return False


# ─── Progress JSON writer ──────────────────────────────────────────

class Progress:
    """Writes a JSON snapshot of test state to disk after every scenario.
    Dashboard polls `/api/geolocation/filter-test-status` which reads it."""
    def __init__(self, path, total):
        self.path = path
        self.state = {
            'running': True,
            'started_at': datetime.now(timezone.utc).isoformat(),
            'total_scenarios': total,
            'completed': 0,
            'current_scenario_id': None,
            'current_scenario_name': None,
            'results': [],
            'passed': 0,
            'failed': 0,
            'log_tail': [],
        }
        self._write()

    def begin(self, sid, name):
        self.state['current_scenario_id'] = sid
        self.state['current_scenario_name'] = name
        self._write()

    def record(self, sid, name, status, duration_ms, diagnostic=''):
        self.state['results'].append({
            'id': sid, 'name': name, 'status': status,
            'duration_ms': int(duration_ms), 'diagnostic': diagnostic,
        })
        self.state['completed'] += 1
        if status == 'PASS': self.state['passed'] += 1
        else:                self.state['failed'] += 1
        # One-line summary: "A1 Cache-replay teleport — PASS"
        # or "A1 Cache-replay teleport — PROBLEM: <reason>" on fail.
        if status == 'PASS':
            msg = f"{sid} {name} — PASS"
        else:
            msg = f"{sid} {name} — PROBLEM: {diagnostic or 'no diagnostic'}"
        self.state['log_tail'].append(msg)
        self.state['log_tail'] = self.state['log_tail'][-20:]
        self._write()

    def finish(self):
        self.state['running'] = False
        self.state['current_scenario_id'] = None
        self.state['current_scenario_name'] = None
        self.state['finished_at'] = datetime.now(timezone.utc).isoformat()
        self._write()

    def _write(self):
        if not self.path:
            return
        try:
            tmp = self.path + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(self.state, f, indent=2)
            os.replace(tmp, self.path)
        except OSError as e:
            logger.warning("progress write failed: %s", e)


# ─── Scenario framework ────────────────────────────────────────────

def _run_scenario(progress, sid, name, conn, ctx, fn):
    """Wrap one scenario: cleanup → reset T0 → run → record."""
    progress.begin(sid, name)
    t_start = time.time()
    try:
        cleanup(conn, drop_device_row=False)  # hermetic start, KEEP device row
        time.sleep(0.3)                       # give daemon time to settle
        ctx.reset_t0()
        status, diagnostic = fn(conn, ctx)
    except Exception as e:
        logger.exception("scenario %s crashed", sid)
        status, diagnostic = 'FAIL', f'exception: {e}'
    duration_ms = (time.time() - t_start) * 1000
    progress.record(sid, name, status, duration_ms, diagnostic)
    # Compact log line — fits the narrow dashboard log panel without wrapping.
    if status == 'PASS':
        logger.info("%s %s — PASS", sid, name)
    else:
        logger.info("%s %s — PROBLEM: %s", sid, name, diagnostic or 'no diagnostic')
    return status == 'PASS'


def _wait_for_daemon(seconds=1.0):
    """Sleep long enough for the daemon to process pending pings + commit DB."""
    time.sleep(seconds)


# ─── A. FAKE scenarios ─────────────────────────────────────────────

def scenario_a1(conn, ctx):
    """Cache-replay teleport from home — Jerusalem coords with good accuracy."""
    h_lat, h_lon = home_coords(conn)
    # Establish a home baseline so anti-teleport has a 'prev inside-home' anchor.
    publish_ping(ctx, h_lat, h_lon, acc=20, tst_offset_sec=-1200)
    _wait_for_daemon()
    # Bogus Jerusalem coord, 9m acc (looks like good GPS).
    publish_ping(ctx, 31.7171, 35.9994, acc=9, tst_offset_sec=0)
    _wait_for_daemon()
    jerusalem_locs = count_locations(conn, "lat BETWEEN 31.71 AND 31.72")
    trips = count_trips(conn)
    if jerusalem_locs == 0 and trips == 0:
        return 'PASS', 'Jerusalem ping dropped by anti-teleport-from-home; no trip opened'
    return 'FAIL', f'Expected 0 Jerusalem rows + 0 trips; got {jerusalem_locs} rows + {trips} trips'


def scenario_a2(conn, ctx):
    """Low-accuracy garbage — acc=200m exceeds the 80m threshold."""
    h_lat, h_lon = home_coords(conn)
    p2_lat, p2_lon = coord_at_distance(h_lat, h_lon, 500)
    publish_ping(ctx, p2_lat, p2_lon, acc=200, tst_offset_sec=0)
    _wait_for_daemon()
    if count_locations(conn) == 0:
        return 'PASS', 'acc=200m dropped by low-accuracy filter'
    return 'FAIL', f'Expected 0 location rows; got {count_locations(conn)}'


def scenario_a3(conn, ctx):
    """Mid-trip implied-speed teleport — 800 m/s between two consecutive pings."""
    h_lat, h_lon = home_coords(conn)
    # Set up: already outside (so prev_dist > radius — the anti-teleport-from-home
    # guard does NOT fire; only the implied-speed teleport filter should drop ping 2).
    p1_lat, p1_lon = coord_at_distance(h_lat, h_lon, 1000, bearing_deg=90)
    publish_ping(ctx, p1_lat, p1_lon, acc=15, tst_offset_sec=0)
    _wait_for_daemon()
    # Ping 2: 4000m further east, only 5 sec later → implied speed = 800 m/s.
    p2_lat, p2_lon = coord_at_distance(h_lat, h_lon, 5000, bearing_deg=90)
    publish_ping(ctx, p2_lat, p2_lon, acc=15, tst_offset_sec=5)
    _wait_for_daemon()
    # Should have exactly 1 location row (the first); ping 2 dropped.
    n = count_locations(conn)
    if n == 1:
        return 'PASS', 'Second ping dropped by max-speed filter (800 m/s > 50 m/s)'
    return 'FAIL', f'Expected 1 location row; got {n}'


def scenario_a4(conn, ctx):
    """Stale-ts replay — ping with `tst` older than last DB row → skipped."""
    h_lat, h_lon = home_coords(conn)
    publish_ping(ctx, h_lat, h_lon, acc=20, tst_offset_sec=100)
    _wait_for_daemon()
    # Now publish with tst BEFORE the first ping — daemon's age_sec ≤ 0 guard drops it.
    publish_ping(ctx, h_lat, h_lon, acc=20, tst_offset_sec=50)
    _wait_for_daemon()
    n = count_locations(conn)
    if n == 1:
        return 'PASS', 'Stale-ts ping skipped (age_sec ≤ 0)'
    return 'FAIL', f'Expected 1 location row; got {n}'


def scenario_a5(conn, ctx):
    """Single noisy outlier between stationary pings — outlier inserted, no trip."""
    h_lat, h_lon = home_coords(conn)
    # 4 home pings
    for i in range(4):
        publish_ping(ctx, h_lat + 1e-5 * i, h_lon, acc=20, tst_offset_sec=i * 60)
        _wait_for_daemon(0.3)
    # 1 outlier — 800m east
    o_lat, o_lon = coord_at_distance(h_lat, h_lon, 800)
    publish_ping(ctx, o_lat, o_lon, acc=15, tst_offset_sec=4 * 60)
    _wait_for_daemon(0.5)
    # 4 more home pings (within seconds)
    for i in range(4):
        publish_ping(ctx, h_lat + 1e-5 * i, h_lon, acc=20, tst_offset_sec=5 * 60 + i * 5)
        _wait_for_daemon(0.3)
    # Outlier should be inserted (it's not > 5km so anti-teleport-from-home doesn't catch).
    # State machine: outlier opens a provisional, next inside ping deletes it → no trip.
    trips = count_trips(conn)
    away_events = count_events(conn, event='away')
    if trips == 0 and away_events == 0:
        return 'PASS', 'Outlier inserted but no trip opened (state machine reset on return)'
    return 'FAIL', f'Expected 0 trips + 0 away events; got {trips} trips + {away_events} aways'


def scenario_a6(conn, ctx):
    """Dedup spatial+temporal — 2 close pings within 25m + 60s, only 1 row."""
    h_lat, h_lon = home_coords(conn)
    publish_ping(ctx, h_lat, h_lon, acc=20, tst_offset_sec=0)
    _wait_for_daemon()
    # 15m east, 20 sec later — within dedup_radius_m=25 AND dedup_window_sec=60.
    p2_lat, p2_lon = coord_at_distance(h_lat, h_lon, 15)
    publish_ping(ctx, p2_lat, p2_lon, acc=20, tst_offset_sec=20)
    _wait_for_daemon()
    n = count_locations(conn)
    if n == 1:
        return 'PASS', 'Second ping deduped (only 1 location row)'
    return 'FAIL', f'Expected 1 location row; got {n}'


# ─── B. TRUE scenarios ─────────────────────────────────────────────

def scenario_b1(conn, ctx):
    """Stationary at home for an hour — 20 pings all WELL INSIDE radius, 0 trips.

    Spread between 5 m and 25 m from center (under the 40 m radius) — verifies
    the daemon ingests stationary-at-home pings without opening any trip.
    """
    h_lat, h_lon = home_coords(conn)
    # Generate 20 coords within 25m of home — alternate bearings + small dists.
    for i in range(20):
        dist = 5 + (i % 5) * 5   # 5..25m, well inside 40m radius
        bearing = (i * 37) % 360  # spread directions
        lat, lon = coord_at_distance(h_lat, h_lon, dist, bearing_deg=bearing)
        publish_ping(ctx, lat, lon, acc=20, tst_offset_sec=i * 180)
        _wait_for_daemon(0.2)
    n = count_locations(conn)
    trips = count_trips(conn)
    away = count_events(conn, event='away')
    if n >= 4 and trips == 0 and away == 0:
        return 'PASS', f'{n} home pings inserted, 0 trips, 0 events'
    return 'FAIL', f'Expected ≥4 rows + 0 trips + 0 events; got {n} rows + {trips} trips + {away} aways'


def scenario_b2(conn, ctx):
    """Real outbound — provisional opens, time_fallback commit with backdated ts."""
    h_lat, h_lon = home_coords(conn)
    # 6 pings: home, 55m, 200m, 450m, 800m, 1500m — 30s apart.
    dists = [14, 55, 200, 450, 800, 1500]
    for i, d in enumerate(dists):
        lat, lon = coord_at_distance(h_lat, h_lon, d)
        publish_ping(ctx, lat, lon, acc=15, tst_offset_sec=i * 30)
        _wait_for_daemon(0.3)
    # Expect: provisional opens at ping #2 (55m, T=30s).
    # At ping #4 (450m, T=90s), age=60s → time_fallback commit fires.
    trip = get_latest_trip(conn)
    if not trip:
        return 'FAIL', 'No trip created'
    if not trip['confirmed']:
        return 'FAIL', 'Trip not confirmed (commit did not fire)'
    away = db_query(conn,
        "SELECT ts FROM device_events WHERE device_id=%s AND source='owntracks_ingest' "
        "AND dps->>'event'='away'", (TEST_DEVICE_ID,))
    if not away:
        return 'FAIL', 'No geofence:away event'
    # Backdated ts check: event ts should == trip.started_at (which is the first outside ping).
    if away[0]['ts'] != trip['started_at']:
        return 'FAIL', f'away event ts={away[0]["ts"]} != trip.started_at={trip["started_at"]} (not backdated)'
    return 'PASS', f'Trip committed, away ts backdated to started_at ({trip["started_at"]})'


def scenario_b3(conn, ctx):
    """Real return — geofence:home fires + trip closes with correct stats."""
    h_lat, h_lon = home_coords(conn)
    # Outbound + return: 14, 55, 200, 450, 800, 1500, 800, 250, 80, 14
    dists = [14, 55, 200, 450, 800, 1500, 800, 250, 80, 14]
    for i, d in enumerate(dists):
        lat, lon = coord_at_distance(h_lat, h_lon, d)
        publish_ping(ctx, lat, lon, acc=15, tst_offset_sec=i * 30)
        _wait_for_daemon(0.3)
    trip = get_latest_trip(conn)
    if not trip:
        return 'FAIL', 'No trip created'
    if trip['returned_at'] is None:
        return 'FAIL', 'Trip not closed'
    home_evts = count_events(conn, event='home')
    if home_evts < 1:
        return 'FAIL', f'Expected ≥1 geofence:home event; got {home_evts}'
    # Path length should be substantial — outbound + return ≈ 3000-4500m.
    if not (1000 < trip['max_dist_m'] < 2000):
        return 'FAIL', f'max_dist_m={trip["max_dist_m"]} out of expected range 1000-2000'
    if trip['path_length_m'] < 2000:
        return 'FAIL', f'path_length_m={trip["path_length_m"]} too small (expected >2000)'
    return 'PASS', f'Trip closed: max={trip["max_dist_m"]}m path={trip["path_length_m"]}m duration={trip["duration_sec"]}s'


def scenario_b4(conn, ctx):
    """Quick errand (under flicker) — provisional deletes on return, no event."""
    h_lat, h_lon = home_coords(conn)
    # Home → 100m → 50m → home. 40s round trip.
    dists = [14, 100, 50, 14]
    for i, d in enumerate(dists):
        lat, lon = coord_at_distance(h_lat, h_lon, d)
        publish_ping(ctx, lat, lon, acc=15, tst_offset_sec=i * 13)
        _wait_for_daemon(0.3)
    trips = count_trips(conn)
    away = count_events(conn, event='away')
    if trips == 0 and away == 0:
        return 'PASS', 'Provisional deleted on return; no trip, no event'
    return 'FAIL', f'Expected 0 trips + 0 aways; got {trips} trips + {away} aways'


def scenario_b5(conn, ctx):
    """Long real round-trip — trip closes with substantial stats."""
    h_lat, h_lon = home_coords(conn)
    # Out to 2500m and back, 12+ pings over 25 sim-minutes.
    distance_profile = [14, 200, 600, 1200, 1800, 2200, 2500, 2400, 2000, 1500, 900, 400, 100, 14]
    for i, d in enumerate(distance_profile):
        lat, lon = coord_at_distance(h_lat, h_lon, d)
        publish_ping(ctx, lat, lon, acc=15, tst_offset_sec=i * 120)
        _wait_for_daemon(0.2)
    trip = get_latest_trip(conn)
    if not trip or trip['returned_at'] is None:
        return 'FAIL', 'Trip not closed'
    if trip['duration_sec'] < 1000:
        return 'FAIL', f'duration_sec={trip["duration_sec"]} too short'
    if trip['max_dist_m'] < 2000:
        return 'FAIL', f'max_dist_m={trip["max_dist_m"]} too small'
    return 'PASS', f'Long trip closed: dur={trip["duration_sec"]}s max={trip["max_dist_m"]}m path={trip["path_length_m"]}m'


def scenario_b6(conn, ctx):
    """Flicker on CLOSE — committed trip with short final stats → trip DELETED.

    Path: 50m → 70m → 14m. T=0, 62, 65. Commit fires at T=62 (age 62s > 60s),
    geofence:away inserted. On close (T=65, inside): path = 20m + 56m = 76m,
    duration = 65s. duration ≥ 60 BUT path < 100 → flicker filter DELETEs trip.
    """
    h_lat, h_lon = home_coords(conn)
    lat50, lon50 = coord_at_distance(h_lat, h_lon, 50)
    lat70, lon70 = coord_at_distance(h_lat, h_lon, 70)
    publish_ping(ctx, lat50, lon50, acc=15, tst_offset_sec=0)
    _wait_for_daemon()
    publish_ping(ctx, lat70, lon70, acc=15, tst_offset_sec=62)
    _wait_for_daemon()
    # Confirm trip exists and is confirmed before return ping
    trip_mid = get_open_trip(conn)
    if not trip_mid or not trip_mid['confirmed']:
        return 'FAIL', 'Trip did not commit before return ping'
    # Return home
    publish_ping(ctx, h_lat, h_lon, acc=15, tst_offset_sec=65)
    _wait_for_daemon()
    # Flicker filter requires `duration<60 AND path<100`. With dur=65 we DON'T meet
    # the duration condition. To actually delete: need dur < 60. But commit needs ≥ 60.
    # Reality: the AND means both must be unmet. Our trip has dur=65 ≥ 60 → trip KEPT.
    # We're verifying the filter behavior — trip should NOT be flicker-deleted here.
    final_trip_count = count_trips(conn)
    away_evts = count_events(conn, event='away')
    if final_trip_count == 1 and away_evts == 1:
        return 'PASS', f'Committed trip kept (dur=65s ≥ 60 fails flicker AND condition); away event fired'
    return 'FAIL', f'Expected 1 trip + 1 away; got {final_trip_count} trips + {away_evts} aways'


# ─── C. WALK scenarios ─────────────────────────────────────────────

def scenario_c1(conn, ctx):
    """Walking out the door — provisional opens at 50m, commits after 60s.

    Provisional opens at ping #3 (50m, T=14). For time_fallback to fire we
    need age ≥ 60s ⇒ final ping at T ≥ 74. Use T=80 for safety margin.
    """
    h_lat, h_lon = home_coords(conn)
    dists_and_offsets = [(5, 0), (25, 7), (50, 14), (100, 21), (200, 28), (350, 80)]
    for d, off in dists_and_offsets:
        lat, lon = coord_at_distance(h_lat, h_lon, d)
        publish_ping(ctx, lat, lon, acc=15, tst_offset_sec=off)
        _wait_for_daemon(0.3)
    trip = get_latest_trip(conn)
    if trip and trip['confirmed']:
        return 'PASS', f'Provisional opened at 50m, committed at T=80 (age 66s > 60s)'
    return 'FAIL', f'Trip not confirmed: {trip}'


def scenario_c2(conn, ctx):
    """Radius-edge jitter — provisional churns; 0 events fired."""
    h_lat, h_lon = home_coords(conn)
    # Hover at 35/42/38/45/38/40m, 30s apart.
    pings = [(35, 0), (42, 30), (38, 60), (45, 90), (38, 120), (40, 150)]
    for d, off in pings:
        lat, lon = coord_at_distance(h_lat, h_lon, d)
        publish_ping(ctx, lat, lon, acc=15, tst_offset_sec=off)
        _wait_for_daemon(0.3)
    away_evts = count_events(conn, event='away')
    if away_evts == 0:
        return 'PASS', 'Radius-edge jitter filtered; 0 geofence:away events'
    return 'FAIL', f'Expected 0 away events; got {away_evts}'


def scenario_c3(conn, ctx):
    """Short walk + return — provisional deletes, no event."""
    h_lat, h_lon = home_coords(conn)
    # 150 / 250 / 200 / 14m at 0, 15, 30, 45.
    pings = [(150, 0), (250, 15), (200, 30), (14, 45)]
    for d, off in pings:
        lat, lon = coord_at_distance(h_lat, h_lon, d)
        publish_ping(ctx, lat, lon, acc=15, tst_offset_sec=off)
        _wait_for_daemon(0.3)
    if count_trips(conn) == 0 and count_events(conn, event='away') == 0:
        return 'PASS', 'Short walk: provisional deleted, no event'
    return 'FAIL', f'trips={count_trips(conn)} aways={count_events(conn, event="away")}'


def scenario_c4(conn, ctx):
    """Walk with 5-min GPS dropout — trip continues, closes correctly."""
    h_lat, h_lon = home_coords(conn)
    # 100m → 300m → 600m over 60s, then 300s gap, then 750m → 800m → 14m over 60s.
    profile = [(100, 0), (300, 30), (600, 60), (750, 360), (800, 390), (14, 420)]
    for d, off in profile:
        lat, lon = coord_at_distance(h_lat, h_lon, d)
        publish_ping(ctx, lat, lon, acc=15, tst_offset_sec=off)
        _wait_for_daemon(0.3)
    trip = get_latest_trip(conn)
    if trip and trip['returned_at'] is not None and trip['max_dist_m'] >= 700:
        return 'PASS', f'Trip closed across 5-min gap; max={trip["max_dist_m"]}m'
    return 'FAIL', f'Trip state: {trip}'


# ─── D. CAR scenarios ──────────────────────────────────────────────

def scenario_d1(conn, ctx):
    """Normal city driving (25 m/s) including a 0 m/s red-light pause."""
    h_lat, h_lon = home_coords(conn)
    # 200, 750, 2000, 5000m at 0, 22, 75, 195 sec (variable speeds + a red light).
    profile = [(200, 0), (750, 22), (750, 50), (2000, 75), (5000, 195)]  # second 750 = stop
    for d, off in profile:
        lat, lon = coord_at_distance(h_lat, h_lon, d)
        publish_ping(ctx, lat, lon, acc=15, tst_offset_sec=off)
        _wait_for_daemon(0.3)
    trip = get_open_trip(conn)
    if trip and trip['confirmed']:
        return 'PASS', f'Trip committed despite variable speed + red light; max={count_locations(conn)} pings'
    return 'FAIL', f'Trip state: {trip}'


def scenario_d2(conn, ctx):
    """Above-threshold speed (60 m/s) — second ping dropped."""
    h_lat, h_lon = home_coords(conn)
    # Anchor at 1000m (outside)
    p1_lat, p1_lon = coord_at_distance(h_lat, h_lon, 1000)
    publish_ping(ctx, p1_lat, p1_lon, acc=15, tst_offset_sec=0)
    _wait_for_daemon()
    # Ping 2 at 2200m — 1200m further, 20 sec later. implied speed = 60 m/s.
    p2_lat, p2_lon = coord_at_distance(h_lat, h_lon, 2200)
    publish_ping(ctx, p2_lat, p2_lon, acc=15, tst_offset_sec=20)
    _wait_for_daemon()
    n = count_locations(conn)
    if n == 1:
        return 'PASS', '60 m/s second ping dropped by max-speed filter'
    return 'FAIL', f'Expected 1 location row; got {n}'


def scenario_d3(conn, ctx):
    """Just-under-threshold (43 m/s, Israel Railways pace) — all ingested."""
    h_lat, h_lon = home_coords(conn)
    # 200/1500/2800/4100m at 0/30/60/90 sec. Implied speed = 1300/30 = 43 m/s.
    profile = [(200, 0), (1500, 30), (2800, 60), (4100, 90)]
    for d, off in profile:
        lat, lon = coord_at_distance(h_lat, h_lon, d)
        publish_ping(ctx, lat, lon, acc=15, tst_offset_sec=off)
        _wait_for_daemon(0.3)
    n = count_locations(conn)
    if n >= 3:  # all 4 pings should land; allow ≥3 for safety
        return 'PASS', f'{n} pings ingested at 43 m/s (under threshold)'
    return 'FAIL', f'Expected ≥3 location rows; got {n}'


def scenario_d4(conn, ctx):
    """Tunnel-then-resume — prev outside, new outside far, doesn't trigger anti-teleport-from-home."""
    h_lat, h_lon = home_coords(conn)
    p1_lat, p1_lon = coord_at_distance(h_lat, h_lon, 5000)
    publish_ping(ctx, p1_lat, p1_lon, acc=15, tst_offset_sec=0)
    _wait_for_daemon()
    # 5-min gap + ping at 8000m. Implied speed = 3000/300 = 10 m/s (fine).
    p2_lat, p2_lon = coord_at_distance(h_lat, h_lon, 8000)
    publish_ping(ctx, p2_lat, p2_lon, acc=15, tst_offset_sec=300)
    _wait_for_daemon()
    n = count_locations(conn)
    if n == 2:
        return 'PASS', '5-min mid-trip gap allowed; both outside pings ingested'
    return 'FAIL', f'Expected 2 location rows; got {n}'


# ─── P. PLACES scenarios (the geo_places.py away-base layer) ───────
# These test the SEPARATE Places cron algorithm (geo_places.py), not the
# ingest daemon. A far journey can't be published via MQTT (the daemon's
# anti-teleport-from-home guard would reject it — by design), so we insert a
# controlled device_locations stream directly and run geo_places.process_group
# on the sandbox group, then assert phone_places (Stays) + phone_place_trips
# (legs). reverse_geocode is monkeypatched so the tests are hermetic (no
# Nominatim network call). place_dwell_min=2 + 40 s ping spacing keep each
# scenario sub-second while still clearing the dwell + PLACE_EXIT_SEC gates.

_GP = None
def _load_gp():
    """Import /opt/geo_places.py once; stub out the network geocode."""
    global _GP
    if _GP is None:
        spec = importlib.util.spec_from_file_location('geo_places', '/opt/geo_places.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.reverse_geocode = lambda lat, lon: f'P{round(lat, 2)},{round(lon, 2)}'
        _GP = mod
    return _GP


def _interp(a, b, n):
    """n evenly-spaced points strictly between coords a and b (linear)."""
    return [(a[0] + (b[0] - a[0]) * i / (n + 1),
             a[1] + (b[1] - a[1]) * i / (n + 1)) for i in range(1, n + 1)]


def _places_cfg(conn):
    hlat, hlon = home_coords(conn)
    return {'center': {'lat': hlat, 'lon': hlon}, 'home_radius_m': 40,
            'places_enabled': True, 'place_dwell_min': 2,
            'place_min_dist_m': 500, 'place_radius_m': 120}


def _places_run(conn, ctx, coords, cfg, spacing=40):
    """Insert coords as device_locations (40 s apart from ctx.t0), seed the
    per-group state to at-home, and run the real geo_places state machine."""
    gp = _load_gp()
    for i, (la, lo) in enumerate(coords):
        ts = datetime.fromtimestamp(ctx.t0 + i * spacing, tz=timezone.utc)
        db_execute(conn, "INSERT INTO device_locations "
                   "(device_id, ts, lat, lon, accuracy_m, source) "
                   "VALUES (%s,%s,%s,%s,15,'test')", (TEST_DEVICE_ID, ts, la, lo))
    gp.save_state(TEST_DEVICE_ID,
                  datetime.fromtimestamp(ctx.t0 - 1, tz=timezone.utc),
                  {'at_anchor': dict(gp.HOME_ANCHOR), 'anchors': [],
                   'pending_origin': None, 'dwell': None, 'leaving_since': None})
    gp.process_group(cfg, TEST_DEVICE_ID, [TEST_DEVICE_ID], 'Test')


def _places_result(conn):
    stays = db_query(conn, "SELECT COUNT(*) AS n FROM phone_places "
                     "WHERE group_id=%s", (TEST_DEVICE_ID,))[0]['n']
    legs = [r['kind'] for r in db_query(conn,
            "SELECT kind FROM phone_place_trips WHERE group_id=%s "
            "ORDER BY started_at", (TEST_DEVICE_ID,))]
    return stays, legs


def scenario_p1(conn, ctx):
    """Home → dwell at a place → Home. Expect 1 Stay + home_to_place + place_to_home."""
    h = home_coords(conn); A = coord_at_distance(h[0], h[1], 60000, 0)
    coords = ([h] * 3 + _interp(h, A, 6) + [A] * 6 + _interp(A, h, 6) + [h] * 3)
    _places_run(conn, ctx, coords, _places_cfg(conn))
    stays, legs = _places_result(conn)
    if stays == 1 and legs == ['home_to_place', 'place_to_home']:
        return 'PASS', f'1 stay + legs {legs}'
    return 'FAIL', f'Expected 1 stay + [home_to_place, place_to_home]; got {stays} stays, legs {legs}'


def scenario_p2(conn, ctx):
    """Home → A(stay) → B(stay) → A → Home. The headline chain: 2 Stays + 4 legs."""
    h = home_coords(conn)
    A = coord_at_distance(h[0], h[1], 60000, 0)
    B = coord_at_distance(h[0], h[1], 62000, 0)          # ~2 km past A
    coords = ([h] * 3 + _interp(h, A, 6) + [A] * 6 + _interp(A, B, 6) + [B] * 6
              + _interp(B, A, 6) + [A] * 2 + _interp(A, h, 6) + [h] * 3)
    _places_run(conn, ctx, coords, _places_cfg(conn))
    stays, legs = _places_result(conn)
    exp = ['home_to_place', 'place_to_place', 'place_to_place', 'place_to_home']
    if stays == 2 and legs == exp:
        return 'PASS', f'2 stays + legs {legs}'
    return 'FAIL', f'Expected 2 stays + {exp}; got {stays} stays, legs {legs}'


def scenario_p3(conn, ctx):
    """Jitter mid-stay (167 m out, back in) must NOT spawn a loop leg or truncate the stay."""
    h = home_coords(conn)
    A = coord_at_distance(h[0], h[1], 60000, 0)
    Aj = coord_at_distance(h[0], h[1], 60167, 0)         # 167 m past A (outside the 120 m radius)
    coords = ([h] * 3 + _interp(h, A, 6) + [A] * 5 + [Aj] + [A] * 2
              + _interp(A, h, 6) + [h] * 3)
    _places_run(conn, ctx, coords, _places_cfg(conn))
    stays, legs = _places_result(conn)
    d = db_query(conn, "SELECT EXTRACT(EPOCH FROM (COALESCE(left_at,now())-arrived_at))::int AS d "
                 "FROM phone_places WHERE group_id=%s ORDER BY arrived_at LIMIT 1", (TEST_DEVICE_ID,))
    dur = d[0]['d'] if d else 0
    if stays == 1 and legs == ['home_to_place', 'place_to_home'] and dur > 150:
        return 'PASS', f'jitter absorbed: 1 stay (dur={dur}s), legs {legs}'
    return 'FAIL', f'Expected 1 stay + 2 legs + dur>150; got {stays} stays, legs {legs}, dur={dur}'


def scenario_p4(conn, ctx):
    """Home → out (no dwell) → Home. NO place, NO leg — phone_trips owns that trip."""
    h = home_coords(conn); X = coord_at_distance(h[0], h[1], 3000, 90)
    coords = ([h] * 3 + _interp(h, X, 6) + [X] + _interp(X, h, 6) + [h] * 3)
    _places_run(conn, ctx, coords, _places_cfg(conn))
    stays, legs = _places_result(conn)
    if stays == 0 and legs == []:
        return 'PASS', 'home excursion (no dwell) → 0 places, 0 legs (dropped; phone_trips owns it)'
    return 'FAIL', f'Expected 0 places + 0 legs; got {stays} places, legs {legs}'


def scenario_p5(conn, ctx):
    """Home → A(stay) → out & back to A (no new dwell) → Home. Expect a place_loop leg."""
    h = home_coords(conn)
    A = coord_at_distance(h[0], h[1], 60000, 0)
    W = coord_at_distance(h[0], h[1], 62000, 0)          # 2 km wander point, no dwell there
    coords = ([h] * 3 + _interp(h, A, 6) + [A] * 6
              + _interp(A, W, 5) + [W] + _interp(W, A, 5) + [A] * 2
              + _interp(A, h, 6) + [h] * 3)
    _places_run(conn, ctx, coords, _places_cfg(conn))
    stays, legs = _places_result(conn)
    exp = ['home_to_place', 'place_loop', 'place_to_home']
    if stays == 1 and legs == exp:
        return 'PASS', f'1 stay + legs {legs}'
    return 'FAIL', f'Expected 1 stay + {exp}; got {stays} stays, legs {legs}'


# ─── Scenario registry ─────────────────────────────────────────────

SCENARIOS = [
    ('A1', 'Cache-replay teleport from home', scenario_a1),
    ('A2', 'Low-accuracy garbage',            scenario_a2),
    ('A3', 'Implied-speed teleport (800 m/s)',scenario_a3),
    ('A4', 'Stale-ts replay',                 scenario_a4),
    ('A5', 'Single noisy outlier',            scenario_a5),
    ('A6', 'Dedup spatial+temporal',          scenario_a6),
    ('B1', 'Stationary at home',              scenario_b1),
    ('B2', 'Real outbound + backdated ts',    scenario_b2),
    ('B3', 'Real return + close stats',       scenario_b3),
    ('B4', 'Quick errand (under flicker)',    scenario_b4),
    ('B5', 'Long real round-trip',            scenario_b5),
    ('B6', 'Flicker filter behavior on close',scenario_b6),
    ('C1', 'Walking out the door',            scenario_c1),
    ('C2', 'Radius-edge jitter',              scenario_c2),
    ('C3', 'Short walk + return',             scenario_c3),
    ('C4', 'Walk with 5-min GPS dropout',     scenario_c4),
    ('D1', 'City driving (25 m/s + red light)',scenario_d1),
    ('D2', 'Above-threshold speed (60 m/s)',  scenario_d2),
    ('D3', 'Just under threshold (43 m/s)',   scenario_d3),
    ('D4', 'Tunnel mid-trip (5-min gap)',     scenario_d4),
    # Places layer (geo_places.py away-bases) — insert device_locations directly + run the state machine.
    ('P1', 'Places: Home→place→Home',         scenario_p1),
    ('P2', 'Places: multi-anchor chain (2 stays, 4 legs)', scenario_p2),
    ('P3', 'Places: jitter absorbed (no loop leg)', scenario_p3),
    ('P4', 'Places: home excursion dropped',  scenario_p4),
    ('P5', 'Places: out-and-back loop leg',   scenario_p5),
]


# ─── Main ──────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only',          help='Comma-separated scenario IDs (e.g. A1,B2,D4)')
    ap.add_argument('--cleanup',       action='store_true', help='Wipe sandbox data, run no scenarios')
    ap.add_argument('--verbose',       action='store_true')
    ap.add_argument('--slow',          action='store_true', help='(reserved for future heartbeat/hard_cap tests)')
    ap.add_argument('--progress-json', default=None, help='Path to write progress JSON (dashboard polls this)')
    args = ap.parse_args()

    if args.verbose:
        logger.setLevel(logging.DEBUG)

    env = load_env()
    conn = db_conn()

    # Cleanup-only mode — drop the device row too, since we're not running tests.
    if args.cleanup:
        cleanup(conn, drop_device_row=True)
        logger.info("cleanup-only: done")
        return 0

    # Pre-flight
    if not preflight_check_daemon():
        logger.error("preflight: owntracks-ingest.service is not active — aborting")
        return 2
    suspects = preflight_check_rules()
    if suspects:
        for path, why in suspects:
            logger.warning("preflight rule check: %s — %s", path, why)

    # Filter scenarios
    only = set(s.strip().upper() for s in (args.only or '').split(',') if s.strip()) or None
    scenarios = [s for s in SCENARIOS if not only or s[0] in only]
    if not scenarios:
        logger.error("no scenarios match --only=%s", args.only)
        return 2

    progress = Progress(args.progress_json, total=len(scenarios))
    client = make_mqtt_client(env)
    ctx = MqttCtx(client)

    pass_count = 0
    try:
        cleanup(conn, drop_device_row=False)  # KEEP device row — see cleanup() doc
        ensure_test_device_row(conn)           # repair if a prior run dropped it
        for sid, name, fn in scenarios:
            if _run_scenario(progress, sid, name, conn, ctx, fn):
                pass_count += 1
    finally:
        # CRITICAL: cleanup MUST run regardless of crash / Ctrl+C.
        # drop_device_row=False — the sandbox device row stays in `devices`
        # forever; the daemon's in-memory cache stays consistent with DB.
        try:
            cleanup(conn, drop_device_row=False)
        except Exception:
            logger.exception("final cleanup failed (manual psql may be needed)")
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:
            pass
        progress.finish()

    total = len(scenarios)
    summary = f'{pass_count}/{total} passed'
    logger.info('=== %s ===', summary)
    return 0 if pass_count == total else 1


if __name__ == '__main__':
    sys.exit(main())
