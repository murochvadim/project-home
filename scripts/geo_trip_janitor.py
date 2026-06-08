#!/usr/bin/env python3
"""Geo trip janitor — deletes fake phone "trips" caused by GPS bouncing.

Runs on LXC 104 via cron (*/5). It does NOT touch the trip-detection algorithm
in owntracks_ingest.py — it is a pure, separate cleanup pass that removes trips
which, in hindsight, sat inside a GPS multipath / "ghost oscillation" storm.

Why a separate, deferred pass: when a trip closes the bouncing is not yet
visible — the phone keeps flapping between a real spot and a ~150 m "ghost"
spot for ~10 min afterward. Only once that full window of pings exists can we
tell a fake trip (phone never moved, GPS bounced) from a real short trip.

Fingerprint of a fake trip:
  The phone crossed the home boundary MANY times in a short window. A real trip
  crosses the boundary twice (out once, back once). A glitch storm crosses it
  4+ times within ~15 min. We scan the pings from started_at-10m..returned_at+15m
  and count home<->outside crossings; >= CROSSINGS_DELETE => delete the trip.

Only short trips are even considered (duration < MAX_TRIP_SEC) so long, genuine
journeys are never looked at.

Env:
  DB_PASS    Postgres password (optional — pg_hba trusts the subnet)

Flags:
  --dry-run  Report what WOULD be deleted; make no changes. (Default is to
             actually delete — cron runs without the flag.)
"""
import argparse
import json
import logging
import math
import os
import sys
from datetime import timedelta

import psycopg2
from psycopg2.extras import RealDictCursor

DB_CONFIG = {
    'host':     '192.168.1.219',
    'database': 'home_data',
    'user':     'postgres',
    'password': os.environ.get('DB_PASS', ''),
    'port':     5432,
}

# Only short trips can be GPS-bounce artifacts. A real multi-hour journey is
# never examined.
MAX_TRIP_SEC = 3600          # 1 hour

# Look-back window: only trips closed within this many hours are re-checked
# (so the janitor is cheap and doesn't churn over ancient rows).
RECENT_TRIPS_HOURS = 48

# Context window around the trip used to reveal the bouncing.
PRE_SEC  = 10 * 60           # started_at - 10 min
POST_SEC = 15 * 60           # returned_at + 15 min

# Boundary crossings within the context window that mark a bouncing storm.
# A real trip = 2 crossings (out, back). 4+ in ~25 min = the phone is flapping.
CROSSINGS_DELETE = 4

# Never delete on thin evidence: require at least this many pings in the window
# so sparse/pruned old data can't accidentally reach the crossing threshold.
MIN_PINGS = 6

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('geo_trip_janitor')


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6_371_000
    p1 = math.radians(lat1); p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def read_geo_settings(conn):
    """Center + radius from the same dashboard_settings.geolocation singleton the
    ingest uses, so the boundary math is identical."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT value FROM dashboard_settings WHERE key = 'geolocation'")
        row = cur.fetchone()
    val = (row or {}).get('value') or {}
    center = val.get('center') or {}
    lat = center.get('lat')
    lon = center.get('lon')
    radius = float(val.get('home_radius_m') or 80)
    return lat, lon, radius


def count_crossings(conn, center_lat, center_lon, radius_m, t_from, t_to):
    """Count home<->outside boundary crossings among ALL phone pings in the
    window. Returns (crossings, ping_count). Uses every owntracks ping (any
    device) in the window — siblings share one phone."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT lat::float AS lat, lon::float AS lon, ts
               FROM device_locations
               WHERE source = 'owntracks_mqtt' AND ts BETWEEN %s AND %s
               ORDER BY ts ASC""",
            (t_from, t_to),
        )
        pings = cur.fetchall()
    crossings = 0
    prev_home = None
    for p in pings:
        d = haversine_m(center_lat, center_lon, p['lat'], p['lon'])
        is_home = d <= radius_m
        if prev_home is not None and is_home != prev_home:
            crossings += 1
        prev_home = is_home
    return crossings, len(pings)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true',
                    help='report only; make no changes')
    args = ap.parse_args()

    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = True

    center_lat, center_lon, radius_m = read_geo_settings(conn)
    if center_lat is None or center_lon is None:
        log.error('no geolocation center configured — nothing to do')
        sys.exit(0)
    log.info('center=(%.6f,%.6f) radius=%.0fm  %s',
             center_lat, center_lon, radius_m,
             '[DRY RUN]' if args.dry_run else '[LIVE]')

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT id, started_at, returned_at, duration_sec,
                      max_dist_m, path_length_m, outside_pings
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
        t_from = t['started_at'] - timedelta(seconds=PRE_SEC)
        t_to   = t['returned_at'] + timedelta(seconds=POST_SEC)
        crossings, npings = count_crossings(conn, center_lat, center_lon,
                                            radius_m, t_from, t_to)
        is_storm = crossings >= CROSSINGS_DELETE and npings >= MIN_PINGS
        verdict = 'DELETE' if is_storm else 'keep'
        log.info('trip #%d  dur=%ds max=%dm path=%dm  crossings=%d (pings=%d) -> %s',
                 t['id'], t['duration_sec'], t['max_dist_m'],
                 t['path_length_m'], crossings, npings, verdict)
        if is_storm:
            to_delete.append((t, crossings))

    if not to_delete:
        log.info('nothing to delete')
        return

    if args.dry_run:
        log.info('[DRY RUN] would delete %d trip(s): %s',
                 len(to_delete), ', '.join(f'#{t["id"]}(x{c})' for t, c in to_delete))
        return

    with conn.cursor() as cur:
        for t, crossings in to_delete:
            # Also remove the fake trip's geofence markers (the "left home" /
            # "came home" rows in device_events). Scoped to the trip's OWN span
            # [started_at..returned_at] — by definition that span is the fake
            # excursion, so any geofence event inside it is an artifact. The
            # span is never wide enough to touch a genuine away/home event from
            # a real trip outside it.
            cur.execute(
                """DELETE FROM device_events
                   WHERE source = 'owntracks_ingest'
                     AND dps->>'kind' = 'geofence'
                     AND ts BETWEEN %s AND %s""",
                (t['started_at'], t['returned_at']),
            )
            ev_removed = cur.rowcount
            cur.execute("DELETE FROM phone_trips WHERE id = %s", (t['id'],))
            log.info('deleted fake trip #%d (crossings=%d) + %d geofence marker(s) in its span',
                     t['id'], crossings, ev_removed)


if __name__ == '__main__':
    main()
