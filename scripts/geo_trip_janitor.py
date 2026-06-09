#!/usr/bin/env python3
"""Geo trip janitor — deletes fake phone "trips" caused by a fixed GPS phantom.

Runs on LXC 104 via cron (*/5). It does NOT touch the trip-detection algorithm
in owntracks_ingest.py — it is a pure, separate cleanup pass.

ROOT CAUSE (proven 2026-06-09 from 4 days of pings + the full trip history):
a single FIXED GPS-multipath phantom sits ~154 m SW of home — hundreds of pings
cluster at one spot and the dense cluster never exceeds ~167 m. The state machine
turns phantom excursions into confirmed "trips". Every such fake reaches a max
distance of ~156 m; meanwhile EVERY genuine trip in history reaches >= 324 m, and
the 171-250 m band is completely empty. So one clean test separates them with a
168 m-wide buffer:

    a confirmed short trip whose max_dist_m <= real_trip_min_far_m (250 m default)
    never left the phantom => it is fake => delete it.

No boundary-crossing counts, no dwell heuristics, no ping re-query — the trip
row's own stored max_dist_m IS the whole signal. This replaced an earlier
crossings+dwell approach whose "dwelled-away = real" guard was defeated by a
sustained phantom-sit (the phone parking at the 154 m phantom for 190-360 s),
which let fakes survive (e.g. trips #1145/#1152).

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

# THE separator. A trip whose max distance from home is at/under this (m) never
# left the ~154 m phantom => fake. Every real trip in history reaches >= 324 m,
# so 250 sits inside a 168 m-wide empty buffer. Overridable via the
# real_trip_min_far_m key in dashboard_settings.geolocation.
REAL_TRIP_MIN_FAR_M = 250

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('geo_trip_janitor')


def read_far_m(conn):
    """Phantom/real distance threshold from the dashboard_settings.geolocation
    singleton, so this janitor and the dashboard display filter stay in lock-step."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT value FROM dashboard_settings WHERE key = 'geolocation'")
        row = cur.fetchone()
    val = (row or {}).get('value') or {}
    return float(val.get('real_trip_min_far_m') or REAL_TRIP_MIN_FAR_M)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true',
                    help='report only; make no changes')
    args = ap.parse_args()

    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = True

    far_m = read_far_m(conn)
    log.info('phantom threshold: max_dist <= %.0fm  %s',
             far_m, '[DRY RUN]' if args.dry_run else '[LIVE]')

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT id, started_at, returned_at, duration_sec, max_dist_m
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
        is_phantom = (t['max_dist_m'] or 0) <= far_m
        log.info('trip #%d  dur=%ds max=%dm -> %s',
                 t['id'], t['duration_sec'], t['max_dist_m'],
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
