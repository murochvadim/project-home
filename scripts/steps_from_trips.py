#!/usr/bin/env python3
"""Walking-trip -> Personal Health steps importer (LXC 104 cron, */15).

SEGMENT-BASED classifier (2026-06-27). For each candidate — a confirmed closed
phone_trips row (source='trip') OR a Places-layer phone_place_trips leg
(source='place_leg', since 2026-07-04) — not yet imported, pull its GPS points from
device_locations and decide walk / drive / phantom from PER-POINT segment speeds.
Driving legs (home_to_place / place_to_home) auto-skip, only genuine walks import.
Instead of trusting the GPS-jitter-inflated path_length_m (which can't tell a steady
walk from drive->park->drive, and reads a normal walk as "too fast"). Steps come
from the CLEAN (good-accuracy) path distance.

GPS-GLITCH GUARD (2026-07-05): a segment faster than `glitch_kmh` (45) between two
adjacent pings is a physically-impossible GPS teleport (e.g. the dot jumps 124 m in
4 s = 112 km/h on a real walk). Such segments are dropped from the distance AND break
the consecutive fast-run — so a short GPS glitch cluster can no longer make a real
walk look like a car (the bug that skipped trip 13212's 3.6 km walk on 2026-07-05).
Glitches are KEPT in the p85 pool, so a genuinely sustained fast drive still trips it.

  walking  -> insert ph_steps (steps = clean_km * steps_per_km, measured_at = returned_at)
  driving  -> skip (a sustained fast run, or a fast 85th-percentile)
  phantom  -> skip (clean movement below a floor = GPS ghost / drove-nowhere)
  no points (aged out / wiped, or trip's group not mapped) -> skip (don't guess)

Mapped to a member by device_label -> household_users; deduped by trip_id
(partial-unique index + NOT EXISTS). Reconciles trip-steps whose trip the geo
janitor later deleted. Idempotent on a */15 cron.

Deploy: scp scripts/steps_from_trips.py root@192.168.1.227:/opt/steps_from_trips.py
Cron:   */15 * * * * /usr/bin/python3 /opt/steps_from_trips.py >> /var/log/steps-from-trips.log 2>&1
"""
import json
import math
import psycopg2
from psycopg2.extras import RealDictCursor

DB = dict(host='192.168.1.219', dbname='home_data', user='postgres')
# Knobs (overridable from dashboard_settings.medical.steps):
DEFAULTS = {
    'steps_per_km':    1300,
    'walk_max_km':     30.0,    # hard distance cap (above this = not a walk)
    'accuracy_gate_m': 35.0,    # a segment counts only if BOTH endpoints are this accurate
    'phantom_min_m':   150.0,   # clean distance below this = GPS phantom / no real trip
    'drive_kmh':       15.0,    # vehicle-like: drives if p85 segment speed > this, OR
    'drive_run_segs':  3,       # >= this many CONSECUTIVE segments faster than drive_kmh, ...
    'walk_ceiling_kmh': 10.0,   # ...but the consecutive-run rule ONLY fires when p85 is above
                                # this. If p85 <= this the trip is clearly walking-pace overall,
                                # so a short fast-run is GPS noise, not a car — keep it as a walk.
                                # The p85>drive_kmh rule still catches real (moving) drives on its
                                # own. Fixes noisy walks wrongly dropped as drives (2026-08-17).
    'glitch_kmh':      45.0,    # a segment faster than this between two ADJACENT pings is a
                                # GPS teleport glitch (impossible on foot): its phantom distance
                                # is dropped AND it breaks the consecutive fast-run, so a few GPS
                                # blips can't make a real walk look like a car. Kept in the p85
                                # pool so a genuinely sustained fast drive still trips the p85 test.
}


def haversine(a_lat, a_lon, b_lat, b_lon):
    R = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat)
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def pctile(xs, q):
    if not xs:
        return 0.0
    s = sorted(xs)
    return s[min(len(s) - 1, int(q * len(s)))]


def main():
    conn = psycopg2.connect(**DB)
    conn.autocommit = True
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cfg = dict(DEFAULTS)
    try:
        cur.execute("SELECT value FROM dashboard_settings WHERE key = 'medical.steps'")
        row = cur.fetchone()
        if row and row['value']:
            v = row['value'] if isinstance(row['value'], dict) else json.loads(row['value'])
            for k in DEFAULTS:
                if v.get(k) is not None:
                    cfg[k] = v[k]
    except Exception as e:
        print('config read failed, using defaults:', e)
    spk        = float(cfg['steps_per_km'])
    maxkm      = float(cfg['walk_max_km'])
    acc_gate   = float(cfg['accuracy_gate_m'])
    phantom_min = float(cfg['phantom_min_m'])
    drive_kmh  = float(cfg['drive_kmh'])
    drive_run  = int(cfg['drive_run_segs'])
    walk_ceiling = float(cfg['walk_ceiling_kmh'])
    glitch_kmh = float(cfg['glitch_kmh'])

    # reconcile: drop trip-steps whose trip the geo janitor has since deleted
    cur.execute("DELETE FROM ph_steps WHERE source = 'trip' "
                "AND NOT EXISTS (SELECT 1 FROM phone_trips t WHERE t.id = ph_steps.trip_id)")
    reconciled = cur.rowcount
    cur.execute("DELETE FROM ph_steps WHERE source = 'place_leg' "
                "AND NOT EXISTS (SELECT 1 FROM phone_place_trips t WHERE t.id = ph_steps.trip_id)")
    reconciled += cur.rowcount

    # device_label -> household_users.id
    cur.execute("SELECT id, device_label FROM household_users WHERE device_label IS NOT NULL")
    dev2user = {r['device_label'].strip(): r['id'] for r in cur.fetchall()
                if r['device_label'] and r['device_label'].strip()}

    # group_id -> [device_id] from the geolocation settings (so we can fetch a trip's pings)
    group_devices = {}
    try:
        cur.execute("SELECT value FROM dashboard_settings WHERE key = 'geolocation'")
        gr = cur.fetchone()
        geo = (gr['value'] if gr and isinstance(gr['value'], dict)
               else (json.loads(gr['value']) if gr and gr['value'] else {}))
        for d in geo.get('tracked_devices', []):
            if d.get('group_id') and d.get('device_id'):
                group_devices.setdefault(d['group_id'], []).append(d['device_id'])
    except Exception as e:
        print('geolocation settings read failed:', e)

    # candidate trips: confirmed, closed, not yet imported, not excluded
    cur.execute("""
        SELECT t.id, t.group_id, t.device_label, t.started_at, t.returned_at, 'trip' AS src
          FROM phone_trips t
         WHERE t.confirmed = true AND t.returned_at IS NOT NULL AND t.duration_sec > 0
           AND NOT EXISTS (SELECT 1 FROM ph_steps s WHERE s.trip_id = t.id AND s.source = 'trip')
           AND t.id NOT IN (SELECT trip_id FROM ph_steps_excluded_trips)
    """)
    trips = cur.fetchall()
    # Places-layer legs (phone_place_trips) go through the SAME classifier below,
    # so driving legs (home_to_place / place_to_home) auto-skip and only genuine
    # walks import. Own id-space -> source='place_leg' (see migration 018).
    cur.execute("""
        SELECT t.id, t.group_id, t.device_label, t.started_at, t.returned_at, 'place_leg' AS src
          FROM phone_place_trips t
         WHERE t.returned_at IS NOT NULL AND t.duration_sec > 0
           AND NOT EXISTS (SELECT 1 FROM ph_steps s WHERE s.trip_id = t.id AND s.source = 'place_leg')
    """)
    trips += cur.fetchall()

    imported = sk_nopts = sk_phantom = sk_drive = sk_far = sk_user = 0
    for tr in trips:
        dev_ids = group_devices.get(tr['group_id'], [])
        if not dev_ids:
            sk_nopts += 1
            continue
        cur.execute("""SELECT lat::float AS lat, lon::float AS lon, accuracy_m, ts
                         FROM device_locations
                        WHERE device_id = ANY(%s) AND ts BETWEEN %s AND %s
                        ORDER BY ts ASC""", (dev_ids, tr['started_at'], tr['returned_at']))
        pts = cur.fetchall()
        if len(pts) < 3:
            sk_nopts += 1                       # no evidence -> don't guess
            continue

        clean_m = 0.0
        speeds = []
        run = max_run = 0
        prev = None
        for pt in pts:
            if prev is not None:
                dt = (pt['ts'] - prev['ts']).total_seconds()
                am = max(pt['accuracy_m'] if pt['accuracy_m'] is not None else 9999,
                         prev['accuracy_m'] if prev['accuracy_m'] is not None else 9999)
                if dt > 0 and am <= acc_gate:
                    kmh = haversine(prev['lat'], prev['lon'], pt['lat'], pt['lon']) / dt * 3.6
                    if kmh > glitch_kmh:
                        # GPS teleport glitch: the dot "jumped" an impossible distance between
                        # two adjacent pings (e.g. 124 m in 4 s = 112 km/h on a walk). Its
                        # distance is phantom → don't add it to clean_m, and it can't be part
                        # of a real fast-run → reset run. Kept in `speeds` so a genuinely
                        # sustained drive (many real fast segments) still trips the p85 test.
                        speeds.append(kmh)
                        run = 0
                    else:
                        clean_m += kmh / 3.6 * dt
                        speeds.append(kmh)
                        if kmh > drive_kmh:
                            run += 1
                            max_run = max(max_run, run)
                        else:
                            run = 0
            prev = pt

        if clean_m < phantom_min:
            sk_phantom += 1
            continue
        if clean_m / 1000.0 > maxkm:
            sk_far += 1
            continue
        # Drive if the trip is fast OVERALL (p85), OR it has a sustained fast-run AND its
        # overall pace isn't clearly walking. The p85 gate on the run rule stops a short
        # burst of GPS-noise fast segments on a genuine walk (p85 <= walk_ceiling) from
        # being mistaken for a car — a real moving drive has p85 > drive_kmh and is caught
        # by the first clause regardless. See the 2026-08-17 audit / trip 15845.
        p85 = pctile(speeds, 0.85)
        if p85 > drive_kmh or (max_run >= drive_run and p85 > walk_ceiling):
            sk_drive += 1
            continue
        uid = dev2user.get((tr['device_label'] or '').strip())
        if not uid:
            sk_user += 1
            continue
        steps = round(clean_m / 1000.0 * spk)
        try:
            cur.execute("INSERT INTO ph_steps (user_id, measured_at, steps, source, trip_id) "
                        "VALUES (%s, %s, %s, %s, %s)", (uid, tr['returned_at'], steps, tr['src'], tr['id']))
            imported += 1
        except psycopg2.Error as e:
            print(f'insert trip {tr["id"]} failed:', e)

    print(f"steps_from_trips: reconciled={reconciled} imported={imported} "
          f"skipped(nopts={sk_nopts} phantom={sk_phantom} drive={sk_drive} far={sk_far} nouser={sk_user}) "
          f"candidates={len(trips)} "
          f"cfg(spk={spk} acc<={acc_gate}m phantom<{phantom_min}m drive>{drive_kmh}km/h(p85|run>={drive_run}&p85>{walk_ceiling}) glitch>{glitch_kmh}km/h cap={maxkm}km)")


if __name__ == '__main__':
    main()
