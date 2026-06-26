#!/usr/bin/env python3
"""Walking-trip -> Personal Health steps importer (LXC 104 cron).

For each confirmed, closed `phone_trips` row that looks like WALKING (average
speed within the configured window, distance within the cap), map it to a
household member by `device_label` and insert a `ph_steps` row
(source='trip', measured_at = the trip's returned_at, deduped by trip_id via the
partial unique index + a NOT EXISTS guard).

Thresholds come from `dashboard_settings.medical.steps` (edited in the Medical ->
Settings tab); falls back to defaults. Idempotent — safe on a */15 cron. First
run backfills all qualifying past trips; later runs are incremental.

Deploy: scp scripts/steps_from_trips.py root@192.168.1.227:/opt/steps_from_trips.py
Cron:   */15 * * * * /usr/bin/python3 /opt/steps_from_trips.py >> /var/log/steps-from-trips.log 2>&1
"""
import json
import psycopg2

DB = dict(host='192.168.1.219', dbname='home_data', user='postgres')
# min_trip_dist_m: a trip whose stored max distance-from-home is below this is treated
# as GPS noise / a phantom (same 250 m line the geo janitor + Recent-trips view use)
# and NOT counted as steps.
# jitter_pct: GPS path_length_m is the sum of every ping-to-ping hop, so GPS noise
# (a phone logging tiny zig-zags while you walk/pause) inflates it — typically ~25-30%
# vs the real walked distance. We trim that % off the logged path BEFORE judging speed
# AND counting steps, so a normal walk isn't misread as "too fast" and steps aren't
# overcounted. One coherent idea: "assume jitter_pct of the logged path is noise."
DEFAULTS = {'steps_per_km': 1300, 'walk_min_kmh': 2.0, 'walk_max_kmh': 9.0,
            'walk_max_km': 30.0, 'min_trip_dist_m': 250.0, 'jitter_pct': 25.0}


def main():
    conn = psycopg2.connect(**DB)
    conn.autocommit = True
    cur = conn.cursor()

    # --- config (Medical -> Settings) ---
    cfg = dict(DEFAULTS)
    try:
        cur.execute("SELECT value FROM dashboard_settings WHERE key = 'medical.steps'")
        row = cur.fetchone()
        if row and row[0]:
            v = row[0] if isinstance(row[0], dict) else json.loads(row[0])
            for k in DEFAULTS:
                if v.get(k) is not None:
                    cfg[k] = v[k]
    except Exception as e:
        print('config read failed, using defaults:', e)
    spk = float(cfg['steps_per_km'])
    vmin = float(cfg['walk_min_kmh'])
    vmax = float(cfg['walk_max_kmh'])
    maxkm = float(cfg['walk_max_km'])
    min_dist = float(cfg['min_trip_dist_m'])
    jfac = max(0.0, min(0.6, float(cfg['jitter_pct']) / 100.0))  # fraction of logged path treated as GPS noise

    # --- reconcile: drop trip-derived step rows whose trip no longer exists ---
    # The geo janitor (LXC 104, */5) DELETEs GPS-phantom trips from phone_trips
    # AFTER we may have imported them. Sync each run so steps never reference a
    # trip that the geolocation system has since judged fake.
    cur.execute("DELETE FROM ph_steps WHERE source = 'trip' "
                "AND NOT EXISTS (SELECT 1 FROM phone_trips t WHERE t.id = ph_steps.trip_id)")
    reconciled = cur.rowcount

    # --- device_label -> household_users.id ---
    cur.execute("SELECT id, device_label FROM household_users WHERE device_label IS NOT NULL")
    dev2user = {dl.strip(): uid for (uid, dl) in cur.fetchall() if dl and dl.strip()}

    # --- candidate trips not yet imported ---
    cur.execute("""
        SELECT t.id, t.device_label, t.path_length_m, t.duration_sec, t.returned_at
          FROM phone_trips t
         WHERE t.confirmed = true AND t.returned_at IS NOT NULL
           AND t.duration_sec > 0 AND t.path_length_m > 0
           AND COALESCE(t.max_dist_m, 0) > %s
           AND NOT EXISTS (SELECT 1 FROM ph_steps s WHERE s.trip_id = t.id)
           AND t.id NOT IN (SELECT trip_id FROM ph_steps_excluded_trips)
    """, (min_dist,))
    rows = cur.fetchall()

    imported = skipped_speed = skipped_user = 0
    for (tid, dl, plen, dur, ret) in rows:
        eff_m = plen * (1.0 - jfac)          # de-noised walked distance
        avg_kmh = (eff_m / dur) * 3.6        # speed judged on the de-noised distance
        km = eff_m / 1000.0
        if not (vmin <= avg_kmh <= vmax) or km > maxkm:
            skipped_speed += 1
            continue
        uid = dev2user.get((dl or '').strip())
        if not uid:
            skipped_user += 1
            continue
        steps = round(km * spk)              # steps also from the de-noised distance
        try:
            cur.execute(
                "INSERT INTO ph_steps (user_id, measured_at, steps, source, trip_id) "
                "VALUES (%s, %s, %s, 'trip', %s)", (uid, ret, steps, tid))
            imported += 1
        except psycopg2.Error as e:
            print(f'insert trip {tid} failed:', e)

    print(f'steps_from_trips: reconciled_orphans={reconciled} imported={imported} '
          f'skipped_speed={skipped_speed} skipped_no_user={skipped_user} candidates={len(rows)} '
          f'cfg(spk={spk} {vmin}-{vmax}km/h dist>{min_dist}m cap={maxkm}km jitter={jfac*100:.0f}%)')


if __name__ == '__main__':
    main()
