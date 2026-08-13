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
import json
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

# ── Places-layer far-teleport rule (2026-07-26; absolute-path + re-stitch 2026-07-26b) ──
# The rules above act on phone_trips (Home-trips) ONLY; the Places layer
# (phone_place_trips / phone_places) had NO phantom cleaner. A GPS cache-replay
# can park the phone at a far ghost long enough for geo_places.py to build a bogus
# anchor + legs — e.g. a 115 km 'الجيزة, الأردن' stay reached on a 12 m path.
#
# TELEPORT signal = ABSOLUTE tiny path (NOT a path/dist ratio): a home_to_place /
# place_to_home leg with `max_dist_m > TELEPORT_FAR_M` AND `path_length_m <
# PLACE_TELEPORT_MAX_PATH_M` — you cannot be 20+ km away having *moved only a few
# metres*. ⚠ The first version used `path < 0.5*max_dist`, which WRONGLY flagged a
# REAL 20 km drive into a real place (leg #160: origin was a mislabeled ghost, so
# its stored max_dist looked huge, but its pings were a genuine drive) and deleted
# it. An absolute path floor can NEVER flag a real drive — 20 km of path is real
# travel regardless of the (mislabeled) origin distance.
#
# The phantom anchor = a teleport leg's place endpoint. We delete the anchor + the
# teleport legs, but a REAL leg that merely referenced the phantom (its own pings
# are a genuine drive) is RE-STITCHED to Home: its ghost endpoint is swapped for
# Home and its max_dist/path recomputed from Home — so a mislabeled 'ghost ->
# Ashdod' becomes the real 'Home -> Ashdod'. Overridable via
# place_teleport_max_path_m.
PLACE_TELEPORT_MAX_PATH_M = 1000

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
    place_max_path = float(val.get('place_teleport_max_path_m') or PLACE_TELEPORT_MAX_PATH_M)
    center = val.get('center') or {}
    clat = float(center['lat']) if center.get('lat') is not None else None
    clon = float(center['lon']) if center.get('lon') is not None else None
    gmap = {}
    for d in (val.get('tracked_devices') or []):
        g, dev = d.get('group_id'), d.get('device_id')
        if g and dev:
            gmap.setdefault(g, []).append(dev)
    return far_m, clat, clon, acc_gate, gmap, tele_far, tele_inner, fix_spacing_m, place_max_path


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


def classify_trip(t, good_dists, cmax, far_m, tele_far, tele_inner, fix_spacing_m):
    """Return the deletion reason for a trip, or None to keep it. Pure function of
    the trip row (`max_dist_m`/`path_length_m`/`outside_pings`/`duration_sec`) plus
    its good-accuracy distances + clean-max reach — so both main() and the Filter
    Test (J1-J4) evaluate the SAME rules. Rules are OR'd, first match wins."""
    stored = t['max_dist_m'] or 0
    opings = t['outside_pings'] or 0
    plen = t['path_length_m'] or 0
    fix_spacing = (plen / opings) if opings > 0 else 0.0
    # Rule 1 — close phantom: short trips that never credibly left ~far_m.
    if t['duration_sec'] < MAX_TRIP_SEC and cmax <= far_m:
        return 'close-phantom'
    # Rule 2 — far teleport: reached far on good pings but with NO fixes in the
    # intermediate band → no path was travelled (cache replay). Any duration.
    if good_dists and cmax > tele_far:
        band_lo, band_hi = tele_inner, cmax - tele_inner
        if band_hi > band_lo and not any(band_lo <= d <= band_hi for d in good_dists):
            return 'teleport'
    # Rule 3 — sparse track: reached far (> far_m) but the fixes are spaced too far
    # apart to be a real path (> fix_spacing_m per outside fix). Catches the fixed
    # ~1 km ghost that lives in the gap between rules 1 & 2. Any duration.
    if stored > far_m and opings > 0 and fix_spacing > fix_spacing_m:
        return 'sparse-track'
    return None


def _recompute_leg_from_home(conn, dev_ids, started_at, returned_at, clat, clon):
    """(max_home_dist_m, path_m) for a leg's span, measured from HOME over the
    device's real pings — used after re-origining a leg to Home so its stored
    max_dist (which had been measured from a now-deleted ghost) is corrected.
    Returns (None, None) when there's no home center or no pings (keep stored)."""
    if clat is None or clon is None or not dev_ids:
        return None, None
    with conn.cursor() as cur:
        cur.execute(
            "SELECT lat, lon FROM device_locations "
            "WHERE device_id = ANY(%s) AND ts BETWEEN %s AND %s ORDER BY ts",
            (dev_ids, started_at, returned_at))
        rows = cur.fetchall()
    if not rows:
        return None, None
    max_d = 0.0
    path = 0.0
    prev = None
    for lat, lon in rows:
        la, lo = float(lat), float(lon)
        d = haversine_m(clat, clon, la, lo)
        if d > max_d:
            max_d = d
        if prev is not None:
            path += haversine_m(prev[0], prev[1], la, lo)
        prev = (la, lo)
    return int(max_d), int(path)


def clean_place_phantoms(conn, tele_far, max_tele_path_m, gmap, clat, clon, dry_run, only_group=None):
    """Far-teleport cleanup for the PLACES layer (phone_place_trips / phone_places),
    which the phone_trips rules never touch. See PLACE_TELEPORT_MAX_PATH_M. A TRUE
    teleport = a home_to_place/place_to_home leg that reached far (max_dist_m >
    tele_far) on an ABSOLUTELY tiny path (path_length_m < max_tele_path_m) — you
    can't be 20+ km away having moved a few metres. The phantom anchor = that leg's
    place endpoint. We delete the anchor + the teleport legs, but a REAL leg that
    only *referenced* the phantom (its own pings are a genuine drive) is RE-STITCHED
    to Home (ghost endpoint -> Home, max_dist/path recomputed from Home) so the real
    trip survives — a mislabeled 'ghost -> Ashdod' becomes the real 'Home ->
    Ashdod'. FK is ON DELETE SET NULL, so re-stitch/delete legs before the anchor."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT id, kind, from_place_id, to_place_id
               FROM phone_place_trips
               WHERE kind IN ('home_to_place', 'place_to_home')
                 AND returned_at > NOW() - make_interval(hours => %s)
                 AND max_dist_m > %s AND path_length_m < %s
                 AND (%s::text IS NULL OR group_id = %s)""",
            (RECENT_TRIPS_HOURS, tele_far, max_tele_path_m, only_group, only_group),
        )
        tele_legs = cur.fetchall()

    phantom_ids = set()
    for lg in tele_legs:
        aid = lg['to_place_id'] if lg['kind'] == 'home_to_place' else lg['from_place_id']
        if aid is not None:
            phantom_ids.add(aid)
    if not phantom_ids:
        log.info('places: no far-teleport phantoms')
        return
    ids = list(phantom_ids)

    # Every leg touching a phantom anchor: itself-a-teleport (delete) vs real (re-stitch).
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """SELECT id, group_id, kind, origin_name, dest_name, from_place_id, to_place_id,
                      started_at, returned_at, max_dist_m, path_length_m
               FROM phone_place_trips
               WHERE from_place_id = ANY(%s) OR to_place_id = ANY(%s)
               ORDER BY started_at""",
            (ids, ids),
        )
        legs = cur.fetchall()
        cur.execute("SELECT id, name FROM phone_places WHERE id = ANY(%s)", (ids,))
        anchors = cur.fetchall()

    delete_legs, restitch = [], []
    for lg in legs:
        is_tele = (lg['path_length_m'] is not None and lg['path_length_m'] < max_tele_path_m
                   and (lg['max_dist_m'] or 0) > tele_far)
        (delete_legs if is_tele else restitch).append(lg)

    if dry_run:
        log.info('[DRY RUN] places: phantom anchor(s) %s | delete teleport leg(s) %s | re-stitch real leg(s)->Home %s',
                 ', '.join(f'#{a["id"]}("{a["name"]}")' for a in anchors) or 'none',
                 ', '.join(f'#{l["id"]}' for l in delete_legs) or 'none',
                 ', '.join(f'#{l["id"]}("{l["origin_name"]}"->"{l["dest_name"]}")' for l in restitch) or 'none')
        return

    with conn.cursor() as cur:
        for lg in restitch:
            new_max, new_path = _recompute_leg_from_home(
                conn, gmap.get(lg['group_id'], []), lg['started_at'], lg['returned_at'], clat, clon)
            set_max = new_max if new_max is not None else lg['max_dist_m']
            set_path = new_path if new_path is not None else lg['path_length_m']
            if lg['from_place_id'] in phantom_ids:       # ghost was the ORIGIN
                new_kind = 'place_to_home' if lg['to_place_id'] is None else 'home_to_place'
                cur.execute(
                    "UPDATE phone_place_trips SET from_place_id = NULL, origin_name = 'Home', "
                    "kind = %s, max_dist_m = %s, path_length_m = %s WHERE id = %s",
                    (new_kind, set_max, set_path, lg['id']))
            else:                                         # ghost was the DEST
                cur.execute(
                    "UPDATE phone_place_trips SET to_place_id = NULL, dest_name = 'Home', "
                    "kind = 'place_to_home', max_dist_m = %s, path_length_m = %s WHERE id = %s",
                    (set_max, set_path, lg['id']))
            log.info('places: re-stitched real leg #%s "%s"->"%s" to Home (max %sm -> %sm, path %sm)',
                     lg['id'], lg['origin_name'], lg['dest_name'], lg['max_dist_m'], set_max, set_path)
        if delete_legs:
            cur.execute("DELETE FROM phone_place_trips WHERE id = ANY(%s)", ([l['id'] for l in delete_legs],))
        cur.execute("DELETE FROM phone_places WHERE id = ANY(%s)", (ids,))
    _scrub_state_place_ids(conn, ids)   # keep geo_places.py's cursor from dangling
    log.info('places: cleaned %d phantom anchor(s) %s — deleted %d teleport leg(s), re-stitched %d real leg(s) to Home',
             len(ids), ids, len(delete_legs), len(restitch))


def _scrub_state_place_ids(conn, gone_ids):
    """After deleting phantom phone_places rows, strip every reference to them from
    the Places-layer cursor (geo_place_state.state JSON) — anchors[], pending_origin,
    at_anchor. Without this the cursor keeps naming a deleted place and geo_places.py's
    record_leg() FK-crashes every run (the 2026-08 "trip won't finish" incident).
    Mirrors _scrub_dangling_places() in geo_places.py, applied at the delete source."""
    gone = set(gone_ids)
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT group_id, state FROM geo_place_state")
        rows = cur.fetchall()
    for row in rows:
        st = row['state'] or {}
        changed = False
        anchors = st.get('anchors') or []
        kept = [a for a in anchors if a.get('place_id') not in gone]
        if len(kept) != len(anchors):
            st['anchors'] = kept
            changed = True
        for key in ('pending_origin', 'at_anchor'):
            v = st.get(key)
            if v and v.get('kind') == 'place' and v.get('place_id') in gone:
                st[key] = None
                changed = True
        if changed:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE geo_place_state SET state = %s::jsonb, updated_at = NOW() "
                    "WHERE group_id = %s",
                    (json.dumps(st), row['group_id']))
            log.info('places: scrubbed cursor group=%s of deleted place id(s) %s',
                     row['group_id'], sorted(gone))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true',
                    help='report only; make no changes')
    args = ap.parse_args()

    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = True

    far_m, clat, clon, acc_gate, gmap, tele_far, tele_inner, fix_spacing_m, place_max_path = read_cfg(conn)
    log.info('close-phantom: clean_max(acc<=%.0fm) <= %.0fm (dur < %ds) | '
             'teleport: reach > %.0fm with empty band [%.0fm .. reach-%.0fm] | '
             'sparse-track: reach > %.0fm AND > %.0fm/fix (any dur) | '
             'places-teleport: leg reach > %.0fm AND path < %.0fm (re-stitch real legs)  %s',
             acc_gate, far_m, MAX_TRIP_SEC, tele_far, tele_inner, tele_inner,
             far_m, fix_spacing_m, tele_far, place_max_path,
             '[DRY RUN]' if args.dry_run else '[LIVE]')

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
        reason = classify_trip(t, good_dists, cmax, far_m, tele_far, tele_inner, fix_spacing_m)

        log.info('trip #%d dur=%ds stored=%dm clean=%dm (good %d/%d pings, %dm/fix) -> %s',
                 t['id'], t['duration_sec'], stored, int(cmax), len(good_dists), total,
                 int(fix_spacing), ('DELETE:' + reason) if reason else 'keep(real)')
        if reason:
            t['_reason'] = reason
            to_delete.append(t)

    # ── Home-trip phantoms (phone_trips) ──
    if not to_delete:
        log.info('no home-trip phantoms to delete')
    elif args.dry_run:
        log.info('[DRY RUN] would delete %d home trip(s): %s',
                 len(to_delete),
                 ', '.join(f'#{t["id"]}({t["max_dist_m"]}m)' for t in to_delete))
    else:
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

    # ── Places-layer far-teleport phantoms (phone_place_trips / phone_places) ──
    clean_place_phantoms(conn, tele_far, place_max_path, gmap, clat, clon, args.dry_run)


if __name__ == '__main__':
    main()
