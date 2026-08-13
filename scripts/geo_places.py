#!/usr/bin/env python3
"""Geolocation "Places" layer — dynamic away-bases. Runs on LXC 104 via cron.

ADDITIVE ONLY. This script NEVER touches owntracks_ingest.py, its Home state
machine, phone_trips, device_locations (read-only), or geo_trip_janitor.py. It
reads the already-cleaned device_locations ping stream and maintains a SEPARATE
anchor model in phone_places / phone_place_trips. See GEOLOCATION/CLAUDE.md.

Model (per tracked group):
  - Anchors = Home (implicit) + every spot the phone dwells at >= place_dwell_min
    within place_radius_m, and > place_min_dist_m from Home. Each such dwell
    creates a phone_places row (auto-named via Nominatim) — the "Stay" line.
  - A "leg" (phone_place_trips row) is recorded on ARRIVAL at an anchor, from the
    previous anchor: home_to_place / place_to_place / place_loop / place_to_home.
  - Home->Home excursions are DROPPED — phone_trips already records those; we
    don't duplicate them.
  - A journey's anchors persist until the phone returns Home (which clears them).
    So returning to an earlier anchor (e.g. Beach -> Haifa) closes a leg there
    without a new Stay row, exactly matching the user's intended 6-line example.

Incremental: geo_place_state holds a per-group cursor (last_ts) + the serialized
machine state, so each cron run only processes pings newer than last_ts.

Opt-in: does nothing unless dashboard_settings.geolocation.places_enabled = true.

Required env:
  DB_PASS   Postgres password (optional — pg_hba trusts the subnet)
"""
import json
import logging
import math
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import RealDictCursor

DB_CONFIG = {
    'host':     '192.168.1.219',
    'database': 'home_data',
    'user':     'postgres',
    'password': os.environ.get('DB_PASS', ''),
    'port':     5432,
}

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('geo_places')

# Leg flicker guard — drop a degenerate leg (pure GPS noise at an anchor edge).
# Real legs (even a short step-out loop) clear this easily.
LEG_MIN_DURATION_SEC = 15
LEG_MIN_PATH_M = 40

# Departure debounce (mirrors the Home machine's provisional→commit). A single
# GPS ping straying outside an anchor's radius during a stay must NOT count as
# leaving — the phone has to stay continuously outside for this long before the
# departure commits. A ping back inside the SAME anchor cancels it (jitter).
# Kills the ~154 m multipath phantom spawning spurious `Place ⟲` loop legs +
# truncating a stay's duration. Backdated: the committed leg's start is the FIRST
# outside ping, so the debounce only delays finalization, never shifts the time.
PLACE_EXIT_SEC = 120

# Nominatim reverse-geocode (verified reachable from LXC 104, 2026-07-03).
NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse'
NOMINATIM_UA = 'home-dashboard-geoplaces/1.0 (murochvadim@gmail.com)'


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6_371_000
    p1 = math.radians(lat1); p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))


_db_conn = None
def get_conn():
    global _db_conn
    if _db_conn is None or _db_conn.closed:
        _db_conn = psycopg2.connect(**DB_CONFIG)
        _db_conn.autocommit = True
    return _db_conn


def read_settings():
    defaults = {
        'center':          {'lat': 32.1593, 'lon': 34.8932},
        'home_radius_m':   40,
        'tracked_devices': [],
        'places_enabled':  False,
        'place_dwell_min': 20,
        'place_min_dist_m': 500,
        'place_radius_m':  120,
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


def _iso(dt):
    return dt.isoformat() if dt else None


def _dt(s):
    return datetime.fromisoformat(s) if s else None


# ─── Nominatim reverse geocode ───────────────────────────────────────
def reverse_geocode(lat, lon):
    """Return a short human place name for a coordinate. One call per place
    creation (rare), so no aggressive caching needed. Falls back gracefully."""
    try:
        q = urllib.parse.urlencode({
            'format': 'json', 'lat': f'{lat:.6f}', 'lon': f'{lon:.6f}',
            'zoom': 16, 'addressdetails': 1,
        })
        req = urllib.request.Request(f'{NOMINATIM_URL}?{q}',
                                     headers={'User-Agent': NOMINATIM_UA})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        addr = data.get('address') or {}
        local = (addr.get('neighbourhood') or addr.get('suburb')
                 or addr.get('quarter') or addr.get('hamlet')
                 or addr.get('city_district'))
        city = (addr.get('city') or addr.get('town') or addr.get('village')
                or addr.get('municipality') or addr.get('county'))
        cc = (addr.get('country_code') or '').lower()
        parts = []
        if local and city and local != city:
            parts = [local, city]
        elif city:
            parts = [city]
        elif local:
            parts = [local]
        name = ', '.join(parts) if parts else (data.get('display_name') or '')[:60]
        if cc and cc != 'il' and addr.get('country'):
            name = f'{name}, {addr["country"]}' if name else addr['country']
        return name.strip() or f'Place @{lat:.4f},{lon:.4f}'
    except Exception as e:
        log.warning('reverse geocode failed for %.5f,%.5f: %s', lat, lon, e)
        return f'Place @{lat:.4f},{lon:.4f}'


# ─── DB writes (all additive; never touch phone_trips) ───────────────
def insert_place(group_id, name, lat, lon, radius, arrived_at):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO phone_places (group_id, name, lat, lon, radius_m, arrived_at)
               VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
            (group_id, name, lat, lon, radius, arrived_at),
        )
        return cur.fetchone()[0]


def set_place_left(place_id, ts):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE phone_places SET left_at = %s WHERE id = %s AND left_at IS NULL",
            (ts, place_id),
        )


def _leg_stats(siblings, started_at, returned_at, o_lat, o_lon):
    """max_dist from ORIGIN anchor, path length, outside-origin ping count."""
    conn = get_conn()
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT lat::float AS lat, lon::float AS lon, ts
               FROM device_locations
               WHERE device_id = ANY(%s) AND ts BETWEEN %s AND %s
               ORDER BY ts ASC""",
            (siblings, started_at, returned_at),
        )
        pings = cur.fetchall()
    max_dist = 0
    path = 0.0
    prev = None
    for p in pings:
        d = haversine_m(o_lat, o_lon, p['lat'], p['lon'])
        if d > max_dist:
            max_dist = int(d)
        if prev is not None:
            path += haversine_m(prev['lat'], prev['lon'], p['lat'], p['lon'])
        prev = p
    return max_dist, int(path), len(pings)


def record_leg(group_id, label, kind, origin, dest, started_at, returned_at, siblings):
    """Insert a COMPLETED leg row (no in-flight rows). Applies the flicker
    guard. `origin`/`dest` are dicts {name, lat, lon, place_id|None}."""
    dur = max(0, int((returned_at - started_at).total_seconds()))
    max_dist, path, outside = _leg_stats(siblings, started_at, returned_at,
                                         origin['lat'], origin['lon'])
    if dur < LEG_MIN_DURATION_SEC and path < LEG_MIN_PATH_M:
        log.info('drop flicker leg group=%s %s->%s dur=%ds path=%dm',
                 group_id, origin['name'], dest['name'], dur, path)
        return
    conn = get_conn()
    # FK guard: from_place_id / to_place_id both REFERENCE phone_places ON DELETE SET
    # NULL, but a fresh INSERT naming a since-deleted place still violates the FK. If
    # the janitor deleted an endpoint's place mid-run (after _scrub_dangling_places ran
    # this tick), insert NULL for that column instead of crashing — keep the *_name.
    o_pid, d_pid = origin.get('place_id'), dest.get('place_id')
    check = [p for p in (o_pid, d_pid) if p is not None]
    if check:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM phone_places WHERE id = ANY(%s)", (check,))
            alive = {r[0] for r in cur.fetchall()}
        if o_pid is not None and o_pid not in alive:
            log.warning('record_leg: origin place %s gone — from_place_id NULL', o_pid)
            o_pid = None
        if d_pid is not None and d_pid not in alive:
            log.warning('record_leg: dest place %s gone — to_place_id NULL', d_pid)
            d_pid = None
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO phone_place_trips
               (group_id, device_label, kind, origin_name, dest_name,
                from_place_id, to_place_id, started_at, returned_at,
                duration_sec, max_dist_m, path_length_m, outside_pings)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (group_id, label, kind, origin['name'], dest['name'],
             o_pid, d_pid,
             started_at, returned_at, dur, max_dist, path, outside),
        )
    log.info('leg group=%s %s: %s -> %s dur=%ds max=%dm path=%dm',
             group_id, kind, origin['name'], dest['name'], dur, max_dist, path)


# ─── State persistence ───────────────────────────────────────────────
def load_state(group_id):
    conn = get_conn()
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT last_ts, state FROM geo_place_state WHERE group_id = %s",
                    (group_id,))
        return cur.fetchone()


def save_state(group_id, last_ts, state):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO geo_place_state (group_id, last_ts, state, updated_at)
               VALUES (%s, %s, %s::jsonb, NOW())
               ON CONFLICT (group_id) DO UPDATE
                 SET last_ts = EXCLUDED.last_ts, state = EXCLUDED.state,
                     updated_at = NOW()""",
            (group_id, last_ts, json.dumps(state)),
        )


def latest_ping_ts(siblings):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("SELECT MAX(ts) FROM device_locations WHERE device_id = ANY(%s)",
                    (siblings,))
        r = cur.fetchone()
        return r[0] if r else None


def _scrub_dangling_places(state):
    """Self-heal: drop cursor references to phone_places rows that no longer exist.

    The trip janitor's phantom cleaner DELETEs phantom `phone_places` rows but can't
    touch this opaque state JSON, so a deleted place_id can linger in anchors /
    pending_origin / at_anchor. record_leg() then INSERTs a phone_place_trips row with
    that place_id as from_/to_place_id and the FK rejects it → the run crashes EVERY
    tick (and re-promotes duplicate stays). Removing the dangling refs here, once per
    run, breaks that loop no matter how the place got deleted. Mutates + returns state."""
    referenced = set()
    for a in state.get('anchors') or []:
        if a.get('place_id') is not None:
            referenced.add(a['place_id'])
    for key in ('pending_origin', 'at_anchor'):
        v = state.get(key)
        if v and v.get('kind') == 'place' and v.get('place_id') is not None:
            referenced.add(v['place_id'])
    if not referenced:
        return state
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM phone_places WHERE id = ANY(%s)", (list(referenced),))
        alive = {r[0] for r in cur.fetchall()}
    gone = referenced - alive
    if not gone:
        return state
    log.warning('scrubbing %d dangling place ref(s) %s from cursor (deleted from phone_places)',
                len(gone), sorted(gone))
    state['anchors'] = [a for a in (state.get('anchors') or [])
                        if a.get('place_id') not in gone]
    for key in ('pending_origin', 'at_anchor'):
        v = state.get(key)
        if v and v.get('kind') == 'place' and v.get('place_id') in gone:
            state[key] = None
    return state


# ─── The state machine ───────────────────────────────────────────────
HOME_ANCHOR = {'kind': 'home', 'name': 'Home'}


def _classify(state, p_lat, p_lon, cfg):
    """Where is this ping? Home / a known journey anchor / None (transit)."""
    c = cfg['center']
    if haversine_m(c['lat'], c['lon'], p_lat, p_lon) <= cfg['home_radius_m']:
        return dict(HOME_ANCHOR)
    for a in state.get('anchors', []):
        if haversine_m(a['lat'], a['lon'], p_lat, p_lon) <= a['radius']:
            return {'kind': 'place', 'place_id': a['place_id'], 'name': a['name'],
                    'lat': a['lat'], 'lon': a['lon']}
    return None


def _same_anchor(a, b):
    if not a or not b or a.get('kind') != b.get('kind'):
        return False
    if a['kind'] == 'home':
        return True
    return a.get('place_id') == b.get('place_id')


def _within_any_anchor(state, lat, lon):
    for a in state.get('anchors', []):
        if haversine_m(a['lat'], a['lon'], lat, lon) <= a['radius']:
            return True
    return False


def _origin_from(prev, c, started_iso):
    """Build a pending-origin dict from the anchor we departed."""
    o = {'kind': prev['kind'], 'name': prev.get('name', 'Home'),
         'lat': c['lat'], 'lon': c['lon'],
         'place_id': prev.get('place_id'), 'started_at': started_iso}
    if prev['kind'] == 'place':
        o['lat'] = prev['lat']; o['lon'] = prev['lon']
    return o


def step(state, ping, cfg, group_id, label, siblings):
    lat = float(ping['lat']); lon = float(ping['lon']); ts = ping['ts']
    cur = _classify(state, lat, lon, cfg)
    prev = state.get('at_anchor')
    dwell_sec = cfg['place_dwell_min'] * 60
    place_radius = cfg['place_radius_m']
    min_dist = cfg['place_min_dist_m']
    c = cfg['center']

    # ── Departure debounce ───────────────────────────────────────────
    # We armed `leaving_since` on the first ping that strayed outside the current
    # anchor. Resolve it before anything else.
    ls = state.get('leaving_since')
    if ls is not None:
        if cur is not None and _same_anchor(cur, prev):
            state['leaving_since'] = None      # back inside same anchor → jitter, cancel
            state['at_anchor'] = cur
            state['dwell'] = None
            return
        if cur is None:
            if (ts - _dt(ls)).total_seconds() < PLACE_EXIT_SEC:
                return                          # still within debounce — keep waiting
            # Commit the departure, backdated to the first outside ping (ls).
            state['pending_origin'] = _origin_from(prev, c, ls)
            if prev['kind'] == 'place':
                set_place_left(prev['place_id'], _dt(ls))
            state['at_anchor'] = None
            state['leaving_since'] = None
            state['dwell'] = {'clat': lat, 'clon': lon, 'n': 1,
                              'first_ts': _iso(ts), 'last_ts': _iso(ts)}
            return
        # Jumped straight into a DIFFERENT anchor / home while leaving — commit the
        # departure from `prev` and fall through to arrival handling below.
        if state.get('pending_origin') is None:
            state['pending_origin'] = _origin_from(prev, c, ls)
            if prev['kind'] == 'place':
                set_place_left(prev['place_id'], _dt(ls))
        state['leaving_since'] = None

    if cur and cur['kind'] == 'home':
        if not _same_anchor(prev, HOME_ANCHOR):
            # Arriving Home → journey ends.
            po = state.get('pending_origin')
            if po and po['kind'] == 'place':
                record_leg(group_id, label, 'place_to_home', po, dict(HOME_ANCHOR),
                           _dt(po['started_at']), ts, siblings)
            elif prev and prev.get('kind') == 'place':
                # place -> home with no transit ping recorded: close its stay + leg.
                set_place_left(prev['place_id'], ts)
                record_leg(group_id, label, 'place_to_home', prev, dict(HOME_ANCHOR),
                           ts, ts, siblings)
            # origin==home → home loop → dropped (phone_trips owns it).
            state['anchors'] = []
            state['pending_origin'] = None
        state['at_anchor'] = dict(HOME_ANCHOR)
        state['dwell'] = None

    elif cur and cur['kind'] == 'place':
        if not _same_anchor(prev, cur):
            # Arriving at a KNOWN anchor (re-arrival) → close leg, no new Stay.
            po = state.get('pending_origin')
            if po and po['kind'] == 'place':
                kind = 'place_loop' if po.get('place_id') == cur['place_id'] else 'place_to_place'
                record_leg(group_id, label, kind, po, cur,
                           _dt(po['started_at']), ts, siblings)
            elif po and po['kind'] == 'home':
                record_leg(group_id, label, 'home_to_place', po, cur,
                           _dt(po['started_at']), ts, siblings)
            state['pending_origin'] = None
        state['at_anchor'] = cur
        state['dwell'] = None

    else:  # transit (outside home + all anchors)
        if prev is not None:
            # First ping outside the current anchor → ARM the debounce (don't
            # leave yet). The leaving_since block at the top commits the departure
            # once the phone stays outside for PLACE_EXIT_SEC, or cancels it if a
            # ping lands back inside the same anchor (jitter).
            state['leaving_since'] = _iso(ts)
            return
        else:
            # Continuing in transit — grow/reset the dwell candidate; maybe promote.
            d = state.get('dwell')
            if not d:
                state['dwell'] = {'clat': lat, 'clon': lon, 'n': 1,
                                  'first_ts': _iso(ts), 'last_ts': _iso(ts)}
                return
            if haversine_m(d['clat'], d['clon'], lat, lon) <= place_radius:
                n1 = d['n'] + 1
                d['clat'] = (d['clat'] * d['n'] + lat) / n1
                d['clon'] = (d['clon'] * d['n'] + lon) / n1
                d['n'] = n1
                d['last_ts'] = _iso(ts)
                span = (ts - _dt(d['first_ts'])).total_seconds()
                far_enough = haversine_m(c['lat'], c['lon'], d['clat'], d['clon']) > min_dist
                if (span >= dwell_sec and far_enough
                        and not _within_any_anchor(state, d['clat'], d['clon'])):
                    # PROMOTE → new place (Stay) + close the incoming leg.
                    name = reverse_geocode(d['clat'], d['clon'])
                    arrived = _dt(d['first_ts'])
                    pid = insert_place(group_id, name, d['clat'], d['clon'],
                                       place_radius, arrived)
                    dest = {'kind': 'place', 'place_id': pid, 'name': name,
                            'lat': d['clat'], 'lon': d['clon']}
                    po = state.get('pending_origin')
                    if po:  # None only if places enabled mid-journey (no origin)
                        kind = 'home_to_place' if po['kind'] == 'home' else 'place_to_place'
                        record_leg(group_id, label, kind, po, dest,
                                   _dt(po['started_at']), arrived, siblings)
                    log.info('%s new place #%d "%s" (%.5f,%.5f) dwell=%ds',
                             group_id, pid, name, d['clat'], d['clon'], int(span))
                    state['anchors'] = state.get('anchors', []) + [{
                        'place_id': pid, 'name': name, 'lat': d['clat'],
                        'lon': d['clon'], 'radius': place_radius}]
                    state['at_anchor'] = dest
                    state['pending_origin'] = None
                    state['dwell'] = None
            else:
                # Moved beyond the candidate cluster → start a fresh one.
                state['dwell'] = {'clat': lat, 'clon': lon, 'n': 1,
                                  'first_ts': _iso(ts), 'last_ts': _iso(ts)}


def _groups(cfg):
    """group_id -> {siblings:[device_id...], label}."""
    out = {}
    for d in cfg.get('tracked_devices') or []:
        did = d.get('device_id')
        if not did:
            continue
        gid = d.get('group_id') or did
        g = out.setdefault(gid, {'siblings': [], 'label': d.get('name') or gid})
        g['siblings'].append(did)
    return out


def process_group(cfg, gid, siblings, label):
    row = load_state(gid)
    if not row:
        # First run for this group — init cursor to newest ping so we track
        # FORWARD only (never backfill history into fake places).
        newest = latest_ping_ts(siblings)
        c = cfg['center']
        init_anchor = None
        if newest is not None:
            with get_conn().cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """SELECT lat::float AS lat, lon::float AS lon FROM device_locations
                       WHERE device_id = ANY(%s) ORDER BY ts DESC LIMIT 1""",
                    (siblings,))
                lp = cur.fetchone()
            if lp and haversine_m(c['lat'], c['lon'], lp['lat'], lp['lon']) <= cfg['home_radius_m']:
                init_anchor = dict(HOME_ANCHOR)
        state = {'at_anchor': init_anchor, 'anchors': [],
                 'pending_origin': None, 'dwell': None}
        save_state(gid, newest, state)
        log.info('%s initialized (cursor=%s, at=%s)', gid, newest,
                 init_anchor['kind'] if init_anchor else 'transit')
        return

    last_ts = row['last_ts']
    state = row['state'] or {'at_anchor': None, 'anchors': [],
                             'pending_origin': None, 'dwell': None}
    _scrub_dangling_places(state)   # self-heal any janitor-deleted place refs
    conn = get_conn()
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        if last_ts is not None:
            cur.execute(
                """SELECT lat::float AS lat, lon::float AS lon, ts
                   FROM device_locations
                   WHERE device_id = ANY(%s) AND ts > %s
                   ORDER BY ts ASC LIMIT 5000""",
                (siblings, last_ts))
        else:
            cur.execute(
                """SELECT lat::float AS lat, lon::float AS lon, ts
                   FROM device_locations
                   WHERE device_id = ANY(%s) ORDER BY ts ASC LIMIT 5000""",
                (siblings,))
        pings = cur.fetchall()
    if not pings:
        return
    for p in pings:
        try:
            step(state, p, cfg, gid, label, siblings)
        except Exception as e:
            log.exception('%s step error at ts=%s: %s', gid, p['ts'], e)
    save_state(gid, pings[-1]['ts'], state)
    log.info('%s processed %d pings (cursor=%s, at=%s, anchors=%d)',
             gid, len(pings), pings[-1]['ts'],
             (state.get('at_anchor') or {}).get('kind', 'transit'),
             len(state.get('anchors', [])))


def main():
    cfg = read_settings()
    if not cfg.get('places_enabled'):
        log.info('places_enabled is false — nothing to do')
        return
    groups = _groups(cfg)
    if not groups:
        log.info('no tracked devices — nothing to do')
        return
    for gid, g in groups.items():
        try:
            process_group(cfg, gid, g['siblings'], g['label'])
        except Exception as e:
            log.exception('process_group %s failed: %s', gid, e)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log.exception('fatal: %s', e)
        sys.exit(1)
