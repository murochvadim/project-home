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
    (far_m, center_lat, center_lon, acc_gate, group_device_map)."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT value FROM dashboard_settings WHERE key = 'geolocation'")
        row = cur.fetchone()
    val = (row or {}).get('value') or {}
    far_m = float(val.get('real_trip_min_far_m') or REAL_TRIP_MIN_FAR_M)
    acc_gate = float(val.get('phantom_accuracy_gate_m') or PHANTOM_ACCURACY_GATE_M)
    center = val.get('center') or {}
    clat = float(center['lat']) if center.get('lat') is not None else None
    clon = float(center['lon']) if center.get('lon') is not None else None
    gmap = {}
    for d in (val.get('tracked_devices') or []):
        g, dev = d.get('group_id'), d.get('device_id')
        if g and dev:
            gmap.setdefault(g, []).append(dev)
    return far_m, clat, clon, acc_gate, gmap


def clean_max_dist(conn, device_ids, start, end, clat, clon, acc_gate, fallback_m):
    """Farthest distance from home reached on a GOOD-accuracy ping in the trip
    window. Pings with accuracy_m > acc_gate are excluded (junk can't define
    reach); pings with NULL accuracy are kept (treated as good). If there is no
    good ping to measure, return fallback_m (the stored max) so we never delete
    on empty evidence. Returns (clean_max_m, good_count, total_count)."""
    if not device_ids or clat is None or clon is None:
        return fallback_m, 0, 0  # cannot recompute → keep old (distance-only) behavior
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT lat::float AS lat, lon::float AS lon, accuracy_m
               FROM device_locations
               WHERE device_id = ANY(%s) AND ts BETWEEN %s AND %s""",
            (device_ids, start, end),
        )
        pings = cur.fetchall()
    good = 0
    cmax = 0.0
    for p in pings:
        acc = p['accuracy_m']
        if acc is not None and float(acc) > acc_gate:
            continue
        good += 1
        d = haversine_m(clat, clon, p['lat'], p['lon'])
        if d > cmax:
            cmax = d
    if good == 0:
        return fallback_m, 0, len(pings)  # no good evidence → keep old behavior
    return cmax, good, len(pings)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true',
                    help='report only; make no changes')
    args = ap.parse_args()

    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = True

    far_m, clat, clon, acc_gate, gmap = read_cfg(conn)
    log.info('phantom rule: clean_max(acc<=%.0fm) <= %.0fm  %s',
             acc_gate, far_m, '[DRY RUN]' if args.dry_run else '[LIVE]')

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT id, group_id, started_at, returned_at, duration_sec, max_dist_m
               FROM phone_trips
               WHERE confirmed = TRUE
                 AND returned_at IS NOT NULL
                 AND returned_at > NOW() - make_interval(hours => %s)
                 AND duration_sec < %s
               ORDER BY started_at DESC""",
            (RECENT_TRIPS_HOURS, MAX_TRIP_SEC),
        )
        trips = cur.fetchall()

    log.info('examining %d recent short trip(s) (< %ds, last %dh)',
             len(trips), MAX_TRIP_SEC, RECENT_TRIPS_HOURS)

    to_delete = []
    for t in trips:
        stored = t['max_dist_m'] or 0
        dev_ids = gmap.get(t['group_id'], [])
        cmax, good, total = clean_max_dist(
            conn, dev_ids, t['started_at'], t['returned_at'],
            clat, clon, acc_gate, stored)
        is_phantom = cmax <= far_m
        log.info('trip #%d  dur=%ds stored=%dm clean=%dm (good %d/%d pings) -> %s',
                 t['id'], t['duration_sec'], stored, int(cmax), good, total,
                 'DELETE' if is_phantom else 'keep(real)')
        if is_phantom:
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
