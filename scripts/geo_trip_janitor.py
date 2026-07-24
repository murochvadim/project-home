#!/usr/bin/env python3
"""Geo trip janitor — deletes fake phone "trips" caused by GPS phantoms.

Runs on LXC 104 via cron (*/5). It does NOT touch the trip-detection / state
machine in owntracks_ingest.py — it is a pure, separate cleanup pass that only
ever DELETES fake trip rows (+ their geofence markers).

ROOT CAUSE (proven 2026-06-09 from 4 days of pings + the full trip history):
a FIXED GPS-multipath phantom sits ~154 m SW of home — hundreds of pings cluster
there and the state machine turns those excursions into confirmed "trips". Every
genuine trip in history reaches >= 324 m; the phantom cluster sits ~154 m. So a
confirmed short trip whose max distance never left ~250 m is fake.

ACCURACY-GATE REFINEMENT (2026-06-10, trip #2344):
a phantom ping was flung to 268 m — ABOVE the 250 m distance rule — so the pure
distance-only test missed it and the fake showed. But that 268 m ping had 73 m
accuracy (junk); the trip's GOOD-accuracy reach was only ~156 m. Fix: don't let a
low-accuracy ping define a trip's reach. We re-query the trip's pings and compute
`clean_max` = the farthest distance reached on a ping with accuracy <= the gate
(PHANTOM_ACCURACY_GATE_M, 50 m). The phantom test now runs on `clean_max`, not the
raw stored max.

Why this is strictly safe (never deletes a trip the old rule kept-and-shouldn't):
`clean_max <= stored_max` always (it's a max over a subset of pings). So:
  * every trip the old rule deleted (stored_max <= far) is still deleted, and
  * the ONLY new deletions are trips that reached past `far` *solely* via
    low-accuracy pings — i.e. they never credibly left ~250 m.
Real >250 m trips reach their distance on GOOD-accuracy pings outdoors, so their
clean_max stays > far and they're kept. Fallback: if a trip has NO good-accuracy
pings at all (can't recompute), we fall back to the stored max_dist_m — old
behavior, so a data-starved trip is never deleted on empty evidence.

Only short trips are considered (duration < MAX_TRIP_SEC); a real multi-hour
journey is never examined.

Env:
  DB_PASS    Postgres password (optional — pg_hba trusts the subnet)

Flags:
  --dry-run  Report what WOULD be deleted; make no changes. (Default deletes —
             cron runs without the flag.)
"""
import argparse
import logging
import math
import os

import psycopg2
from psycopg2.extras import RealDictCursor

DB_CONFIG = {
    'host':     '192.168.1.219',
    'database': 'home_data',
    'user':     'postgres',
    'password': os.environ.get('DB_PASS', ''),
    'port':     5432,
}

# Only short trips can be phantom artifacts. A real multi-hour journey is never
# examined.
MAX_TRIP_SEC = 3600          # 1 hour

# Look-back: only trips closed within this many hours are re-checked (cheap; the
# dashboard display filter hides any older ones anyway).
RECENT_TRIPS_HOURS = 48

# THE separator. A trip whose (clean) max distance from home is at/under this (m)
# never credibly left the ~154 m phantom => fake. Every real trip in history
# reaches >= 324 m. Overridable via real_trip_min_far_m in
# dashboard_settings.geolocation.
REAL_TRIP_MIN_FAR_M = 250

# Pings worse than this accuracy (m) cannot define a trip's reach — a far reading
# with poor accuracy is GPS multipath, not movement. Overridable via
# phantom_accuracy_gate_m. 50 m keeps real outdoor far-points (typically 5-30 m,
# occasionally ~45 m) while excluding the junk ghost pings (70 m+).
PHANTOM_ACCURACY_GATE_M = 50

# ── Far-teleport rule (forever fix, 2026-06-18) ──────────────────────────────
# A confirmed trip can also be a GPS glitch when the phone CACHE-REPLAYS to a
# fixed FAR coordinate (observed: ~115 km SE, Jerusalem area — fake trips
# 7279/7358), teleporting out and back with NO path in between. The close-
# phantom rule above misses these (they're >250 m AND >1 h, outside its scope),
# and a speed cap can't help (115 km / 38 min ≈ 180 km/h looks legit, right on
# the Israel-Railways-express axis). The robust, distance- and launch-agnostic
# signal is CONTINUITY: a real journey to X km has fixes at intermediate
# distances (5, 20, 50 …); a teleport has fixes ONLY near home and at X, with an
# empty band between. So a trip whose good-accuracy reach exceeds TELEPORT_FAR_M
# but has ZERO good pings in the intermediate band [INNER, reach-INNER] is a
# teleport => fake. Applies at ANY duration (unlike the close-phantom rule).
# Safe for real trips: a genuine far trip — even one silent on the way OUT —
# still has return-leg fixes in the band; only a trip silent BOTH ways over
# tens of km (physically implausible, and it returns to the exact origin) would
# trip it. Overridable via teleport_far_m / teleport_inner_m.
TELEPORT_FAR_M = 20000      # only jumps beyond 20 km are teleport candidates
TELEPORT_INNER_M = 1500     # band = [INNER, reach - INNER]

# ── Sparse-track (fix-spacing) rule (2026-07-23) ─────────────────────────────
# A NEW, fixed GPS ghost ~1 km SW of home makes the phone teleport out-and-back
# while it is physically at home; the "trip" then reaches ~1 km on only a handful
# of fixes (proven on trips 14779-14784, 14865: 2-13 outside pings for a ~1 km
# reach). Rule 1 (close-phantom, <=250 m) is too near, Rule 2 (teleport, >20 km)
# is too far — this ~1 km ghost lives in the gap between them, and the
# continuity/empty-band test can't reach down here (home GPS scatter reaching
# 300-400 m pollutes the band; sparse phantoms have too few good pings).
#
# The clean, distance- and duration-agnostic signal is TRACK DENSITY: a real
# moving phone drops a fix every ~25-45 m of travel (OwnTracks publishes on
# displacement); a phantom's path_length is mostly imaginary teleport distance,
# so its fixes are hundreds of metres apart. Measured over the last 24 h:
#   phantoms  282-945 m/fix   |   real trips  25-45 m/fix   (a clean 6x gap).
# So a trip that reached FAR (> far_m) but whose path_length / outside_pings
# exceeds PHANTOM_FIX_SPACING_M covered its "distance" without a real track =>
# fake. Uses only stored columns (no ping re-fetch). Overridable via
# phantom_fix_spacing_m. 150 m sits safely between the two clusters (real <=45,
# phantom >=282) — a >2x margin on each side.
PHANTOM_FIX_SPACING_M = 150

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('geo_trip_janitor')


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def read_cfg(conn):
    """Read the dashboard_settings.geolocation singleton so this janitor and the
    dashboard display filter stay in lock-step. Returns
    (far_m, center_lat, center_lon, acc_gate, group_device_map, tele_far, tele_inner, near_m)."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT value FROM dashboard_settings WHERE key = 'geolocation'")
        row = cur.fetchone()
    val = (row or {}).get('value') or {}
    far_m = float(val.get('real_trip_min_far_m') or REAL_TRIP_MIN_FAR_M)
    acc_gate = float(val.get('phantom_accuracy_gate_m') or PHANTOM_ACCURACY_GATE_M)
    tele_far = float(val.get('teleport_far_m') or TELEPORT_FAR_M)
    tele_inner = float(val.get('teleport_inner_m') or TELEPORT_INNER_M)
    fix_spacing_m = float(val.get('phantom_fix_spacing_m') or PHANTOM_FIX_SPACING_M)
    center = val.get('center') or {}
    clat = float(center['lat']) if center.get('lat') is not None else None
    clon = float(center['lon']) if center.get('lon') is not None else None
    gmap = {}
    for d in (val.get('tracked_devices') or []):
        g, dev = d.get('group_id'), d.get('device_id')
        if g and dev:
            gmap.setdefault(g, []).append(dev)
    return far_m, clat, clon, acc_gate, gmap, tele_far, tele_inner, fix_spacing_m


def trip_good_dists(conn, device_ids, start, end, clat, clon, acc_gate):
    """Home-distances (m) for the GOOD-accuracy pings in the trip window, sorted
    ascending. A ping is "good" if accuracy_m <= acc_gate (junk far readings
    can't define reach) or NULL (treated as good). Returns (good_dists, total).
    The caller derives both the clean-max reach (last element) and the
    intermediate-band occupancy (for the teleport rule) from this one fetch, so
    pings are queried once per trip. Empty good_dists → no good evidence."""
    if not device_ids or clat is None or clon is None:
        return [], 0  # cannot recompute → caller falls back to stored max
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT lat::float AS lat, lon::float AS lon, accuracy_m
               FROM device_locations
               WHERE device_id = ANY(%s) AND ts BETWEEN %s AND %s""",
            (device_ids, start, end),
        )
        pings = cur.fetchall()
    good = []
    for p in pings:
        acc = p['accuracy_m']
        if acc is not None and float(acc) > acc_gate:
            continue
        good.append(haversine_m(clat, clon, p['lat'], p['lon']))
    good.sort()
    return good, len(pings)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true',
                    help='report only; make no changes')
    args = ap.parse_args()

    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = True

    far_m, clat, clon, acc_gate, gmap, tele_far, tele_inner, fix_spacing_m = read_cfg(conn)
    log.info('close-phantom: clean_max(acc<=%.0fm) <= %.0fm (dur < %ds) | '
             'teleport: reach > %.0fm with empty band [%.0fm .. reach-%.0fm] | '
             'sparse-track: reach > %.0fm AND > %.0fm/fix (any dur)  %s',
             acc_gate, far_m, MAX_TRIP_SEC, tele_far, tele_inner, tele_inner,
             far_m, fix_spacing_m, '[DRY RUN]' if args.dry_run else '[LIVE]')

    # All confirmed closed trips in the look-back — ANY duration. The close-
    # phantom rule self-limits to < MAX_TRIP_SEC; the teleport rule needs to see
    # long trips too (the 115 km fakes were 100-127 min, i.e. > 1 h).
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT id, group_id, started_at, returned_at, duration_sec,
                      max_dist_m, path_length_m, outside_pings
               FROM phone_trips
               WHERE confirmed = TRUE
                 AND returned_at IS NOT NULL
                 AND returned_at > NOW() - make_interval(hours => %s)
               ORDER BY started_at DESC""",
            (RECENT_TRIPS_HOURS,),
        )
        trips = cur.fetchall()

    log.info('examining %d recent trip(s) (last %dh, any duration)',
             len(trips), RECENT_TRIPS_HOURS)

    to_delete = []
    for t in trips:
        stored = t['max_dist_m'] or 0
        dev_ids = gmap.get(t['group_id'], [])
        good_dists, total = trip_good_dists(
            conn, dev_ids, t['started_at'], t['returned_at'], clat, clon, acc_gate)
        # clean reach = farthest good-accuracy ping; fall back to stored max when
        # there's no good evidence (never delete on empty evidence).
        cmax = good_dists[-1] if good_dists else float(stored)
        # Track density: metres of path per outside fix. Real trips ~25-45 m/fix;
        # a stationary-phone ghost covers its "distance" on a handful of fixes.
        opings = t['outside_pings'] or 0
        plen = t['path_length_m'] or 0
        fix_spacing = (plen / opings) if opings > 0 else 0.0

        reason = None
        # Rule 1 — close phantom: short trips that never credibly left ~250 m.
        if t['duration_sec'] < MAX_TRIP_SEC and cmax <= far_m:
            reason = 'close-phantom'
        # Rule 2 — far teleport: reached far on good pings but with NO fixes in
        # the intermediate band → no path was travelled (cache replay). Any dur.
        elif good_dists and cmax > tele_far:
            band_lo, band_hi = tele_inner, cmax - tele_inner
            if band_hi > band_lo and not any(band_lo <= d <= band_hi for d in good_dists):
                reason = 'teleport'
        # Rule 3 — sparse track: reached far (> far_m) but the fixes are spaced too
        # far apart to be a real path (> fix_spacing_m per outside fix). Catches the
        # fixed ~1 km ghost that lives in the gap between rules 1 & 2. Any duration.
        elif stored > far_m and opings > 0 and fix_spacing > fix_spacing_m:
            reason = 'sparse-track'

        log.info('trip #%d dur=%ds stored=%dm clean=%dm (good %d/%d pings, %dm/fix) -> %s',
                 t['id'], t['duration_sec'], stored, int(cmax), len(good_dists), total,
                 int(fix_spacing), ('DELETE:' + reason) if reason else 'keep(real)')
        if reason:
            t['_reason'] = reason
            to_delete.append(t)

    if not to_delete:
        log.info('nothing to delete')
        return

    if args.dry_run:
        log.info('[DRY RUN] would delete %d trip(s): %s',
                 len(to_delete),
                 ', '.join(f'#{t["id"]}({t["max_dist_m"]}m)' for t in to_delete))
        return

    with conn.cursor() as cur:
        for t in to_delete:
            # Also remove the fake trip's geofence markers (the "left home" /
            # "came home" rows in device_events), scoped to the trip's OWN span
            # [started_at..returned_at] — by definition that span is the fake
            # excursion, so any geofence event inside it is an artifact. The span
            # is never wide enough to touch a genuine away/home event outside it.
            cur.execute(
                """DELETE FROM device_events
                   WHERE source = 'owntracks_ingest'
                     AND dps->>'kind' = 'geofence'
                     AND ts BETWEEN %s AND %s""",
                (t['started_at'], t['returned_at']),
            )
            ev_removed = cur.rowcount
            cur.execute("DELETE FROM phone_trips WHERE id = %s", (t['id'],))
            log.info('deleted fake trip #%d (max=%dm) + %d geofence marker(s) in its span',
                     t['id'], t['max_dist_m'], ev_removed)


if __name__ == '__main__':
    main()
