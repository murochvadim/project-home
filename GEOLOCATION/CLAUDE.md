# Geolocation Agent

Phone movement tracking via **OwnTracks MQTT only**. The HA Companion ingest path was removed completely on 2026-06-03 after persistent WiFi-DB poisoning of `device_tracker.fold_5_vadim` caused the dual-source contention bug that erased real trips (trip 295 sliver-tail incident — see history at the bottom of this file).

## Architecture (current — HA-free)

```
phone (OwnTracks app)
   │ MQTT publish on owntracks/<user>/<device>
   ▼
LXC 107 mosquitto broker
   │ subscribed by
   ▼
LXC 104  owntracks-ingest.service  (long-running paho-mqtt daemon)
   │ on every location message:
   │   1. low-accuracy filter (acc > 100 m → drop)
   │   2. anti-teleport pure-GPS guard
   │      (prev inside-radius AND new > 5 km AND age_sec < 30 → drop)
   │   3. teleport filter (implied_speed > 100 m/s → drop)
   │   4. stale-ts guard (age_sec ≤ 0 → skip)
   │   5. dedup vs last ping (< 25 m AND < 60 s → skip insert)
   │   6. INSERT device_locations row
   │   7. STATE MACHINE:
   │      - is_home (dist_home ≤ 40 m):
   │          * provisional → DELETE (jitter, no event)
   │          * confirmed   → emit geofence:home + close_trip
   │      - else (outside radius):
   │          * no open trip          → _open_provisional
   │          * provisional (not confirmed):
   │              - should_commit(trip, now, cfg, dev):
   │                  if age ≥ hard_cap (300 s)       → commit (hard_cap)
   │                  if age ≥ time_fallback (60 s)   → commit (time_fallback)
   │                  else                            → wait
   │              - commit → _commit_away_atomic
   │                (UPDATE confirmed + INSERT geofence:away in one tx,
   │                 backdated ts = trip.started_at)
   │      - heartbeat (every 270 s while away, suppressed during provisional /
   │        commit-this-pass) — re-emits the current state for rule subscribers
   ▼
LXC 102 PostgreSQL
   - device_locations (30 d auto_clean)
   - device_events (30 d auto_clean) — rules subscribe
   - phone_trips (forever)
```

## File locations

| Artifact | Path | Note |
|---|---|---|
| Ingest daemon | [scripts/owntracks_ingest.py](../scripts/owntracks_ingest.py) | repo source of truth |
| Deployed copy | `root@192.168.1.227:/opt/owntracks_ingest.py` | LXC 104, long-running service |
| Systemd unit | `owntracks-ingest.service` on LXC 104 | enabled, active |
| Trip janitor | [scripts/geo_trip_janitor.py](../scripts/geo_trip_janitor.py) → `/opt/geo_trip_janitor.py` | LXC 104, cron `*/5`; deletes GPS bounce-storm fake trips (see below) |
| Env file | `/etc/owntracks-ingest.env` on LXC 104 | `MQTT_USER`, `OWNTRACKS_MQTT_PASS`, `DB_PASS` (HA_TOKEN no longer used) |
| Dashboard surface | [BOILER/dashboard/public/project-general.html](../BOILER/dashboard/public/project-general.html) Geolocation tab | Settings card + map + events + recent trips |
| Server endpoints | `/api/geolocation/*` in [BOILER/dashboard/server.js](../BOILER/dashboard/server.js) | settings, status, locations, events, trips |
| Settings row | `dashboard_settings.geolocation` JSONB | singleton |

## Settings (`dashboard_settings.geolocation`)

| Key | Default | Purpose |
|---|---|---|
| `center.{lat,lon}` | apartment GPS | reference for radius checks |
| `home_radius_m` | 40 | inside radius defines "at home" |
| `retention_days` | 3 | device_locations auto-clean horizon |
| `tracked_devices` | `[{device_id, name, group_id, source:'owntracks_mqtt', mqtt_topic}]` | list of OwnTracks devices to ingest |
| `dedup_radius_m` | 25 | ping-vs-last spatial dedup threshold |
| `dedup_window_sec` | 60 | ping-vs-last temporal dedup threshold |
| `low_accuracy_filter_m` | 100 | drop pings with acc > N |
| `outside_accuracy_threshold_m` | 35 | trail outlier filter — hides outdoor pings with poor accuracy from map render |
| `stale_alert_hours` | 1 | "stale" chip threshold |
| `geofence_events` | true | master switch for emitting home/away events |
| `geofence_heartbeat_sec` | 270 | re-emit current state every N seconds while away |
| `geofence_use_state_machine` | true | master switch for provisional→confirmed flow |
| `geofence_time_fallback_sec` | 60 | commit threshold after first outside ping |
| `geofence_hard_cap_sec` | 300 | defensive ceiling — should never fire in normal use |

**Removed in 2026-06-03 cleanup**: `ha_ingest_enabled`, `sensor_veto_enabled`, `sensor_veto_still_debounce_sec`, `geofence_wifi_min_age_sec`, plus per-device `ha_entity` / `wifi_entity` / `battery_entity` / `activity_entity` / `android_auto_entity` / `wifi_home_ssid` fields.

## State machine

Two gates, both pure-time (no HA sensor reads):

1. `hard_cap` (default 300 s) — ultimate fail-safe
2. `time_fallback` (default 60 s) — normal commit

```python
def should_commit(trip, ping_ts, cfg, dev):
    age = (ping_ts - trip['started_at']).total_seconds()
    if age >= cfg['geofence_hard_cap_sec']:      return True, 'hard_cap'
    if age >= cfg['geofence_time_fallback_sec']: return True, 'time_fallback'
    return False, None
```

Tradeoff vs the removed WiFi-confirmed path: commits now take 60 s minimum instead of ~10 s. Worth it — the WiFi path required reading `sensor.sm_f946b_wi_fi_connection` from HA, and we wanted zero HA dependency.

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET    | `/api/geolocation/settings`      | return current settings (defaults merged) |
| POST   | `/api/geolocation/settings`      | replace settings (allow-list filtered) |
| GET    | `/api/geolocation/status`        | per-group last-position summary + connection chips |
| GET    | `/api/geolocation/locations`     | trail polyline pings for a `since` window — applies `_flagOutliers`. **Returns the NEWEST `limit` rows** (inner `ORDER BY ts DESC LIMIT`, outer `ORDER BY ts ASC`) since 2026-06-06. Before that it used a bare `ORDER BY ts ASC LIMIT 5000` = the *oldest* N, which silently dropped recent pings on any window exceeding the limit (7d/30d and the 'Last trip' fetch missed the latest journey). ASC output is required by `_flagOutliers` (it compares consecutive fixes). |
| GET    | `/api/geolocation/events`        | recent geofence events |
| GET    | `/api/geolocation/trips`         | recent confirmed trips (multi-select source for the dashboard delete button) |
| DELETE | `/api/geolocation/trips`         | body `{ids:[…]}` — multi-row delete |
| POST   | `/api/geolocation/clear-all`     | wipes device_locations + device_events for tracked phones |

**Removed in 2026-06-03 cleanup**: `GET /api/geolocation/sensor-states`, `POST /api/geolocation/run-ingest`.

## Trail outlier filter

Server-side in `_flagOutliers` on `/api/geolocation/locations` (since 2026-06-01):

1. **Stuck-source** — bit-identical consecutive lat/lon from same source (catches frozen cached fixes)
2. **5-point median** — flags pings > max(3×neighbor-spread, 30m) from the local median (catches isolated jumps)
3. **Outdoor low-accuracy cap** — flags pings outside the home radius with `accuracy_m > outside_accuracy_threshold_m`

Outliers stay in DB for diagnostics; client renders only non-outliers.

## Map trail display modes (`project-general.html`, since 2026-06-06)

The Map · trail Window dropdown is `Last trip` (default) / `1h` / `24h` / `7d` / `30d`.

**"Last trip"** shows the most recent **leave-home → arrive-home** excursion, so the drawn track is the *whole journey and ENDS at home, regardless of how long it lasted* — instead of a rolling time-window that ends at "now" and truncates long trips. This was the user-reported problem ("the track should finish only when I come back home, no matter how long").

**This is a READ-ONLY display feature — the ingest daemon, the geofence state machine, and `phone_trips` are NOT touched** (explicit user constraint: don't change the working trip algorithm). Implementation, all client-side:
- `_geoExtractLastTrip(merged, isOutside, dwellMs=5min)` — from the ASC ping list it finds the latest contiguous outside-home excursion: `arrival` = first inside ping after the last outside ping (or newest if still out); `departure` = the home boundary before the excursion, **absorbing inside dips shorter than `dwellMs` (5 min)** as GPS jitter so one journey isn't split. Returns the `[departure..arrival]` slice; `geoReloadTrail` + `geoFitToTrack` render only that.
- Trip mode fetches a wide window (`since=30d`, `&limit=10000`) and relies on the newest-N endpoint fix above so the recent excursion is actually in the result.
- Falls back to drawing nothing for a group with no excursion in the window.

Known bound: depends on pings existing in the last 30 days (retention) and ≤ 10000 of them in-window; a trip older than that or a >10000-ping window would clip. Fine for normal use.

## Rule integration

Rules listen on `device_events` with the standard signature:

```python
RULE = {
    'name': 'Greet on arrival',
    'group': 'home',
    'priority': 50,
    'triggers': ['owntracks_owntracks_phone_fold5'],
    'conditions': {},
}

def evaluate(event, state):
    if event.get('source') != 'owntracks_ingest':
        return []
    dps = event.get('dps') or {}
    if dps.get('kind') == 'geofence' and dps.get('event') == 'home':
        return [{ ... welcome action ... }]
    return []
```

## Removed (2026-06-03 — full HA cleanup)

Everything below this line **no longer exists** in the repo or LXC 104:

- `scripts/geolocation_ingest.py` — the HA Companion 30-s polling script
- `/opt/geolocation_ingest.py` on LXC 104
- `geolocation-ingest.service` + `geolocation-ingest.timer` systemd units
- `_safe_ha_state()` helper in owntracks_ingest.py
- `phone_appears_at_home()` sensor-veto helper in owntracks_ingest.py
- WiFi-DB-poisoning filter (HA-anchored variant — replaced by pure-GPS anti-teleport guard)
- `wifi_confirmed` commit path in `should_commit`
- `HA_TOKEN` env var read in owntracks_ingest.py
- `urllib.request` import (was only used for HA REST)
- Settings keys: `ha_ingest_enabled`, `sensor_veto_enabled`, `sensor_veto_still_debounce_sec`, `geofence_wifi_min_age_sec`
- Per-device fields: `ha_entity`, `wifi_entity`, `battery_entity`, `activity_entity`, `android_auto_entity`, `wifi_home_ssid`
- `/api/geolocation/sensor-states` endpoint
- `/api/geolocation/run-ingest` endpoint
- Dashboard UI: HA Companion ingest checkbox, Sensor entities HA table, Sensor veto controls + still-debounce input, WiFi-min-age input, "Run ingest now" button, sensor live-value cells in the Tracked devices table, `geoRenderVetoRows`/`geoCollectVetoRows`/`geoRunIngestNow`/`geoValueCell`/`geoCellEdit` JS functions, `_geoSensorStates` state var

## Filter test harness (since 2026-06-03)

Dashboard-triggered regression test for every filter + state-machine branch.

**Files:**
- Source: `scripts/test_geolocation_filters.py`
- Deployed: `/opt/test_geolocation_filters.py` on LXC 104
- Persistent log: `/var/log/test-geolocation-filters.log`
- Ephemeral progress JSON: `/tmp/geolocation-test-progress.json`

**How it works:** publishes 20 synthetic OwnTracks MQTT messages to the production broker over ~90 sec. The live daemon processes them through the actual filter chain. After each scenario the script queries DB to verify expected outcomes. Time control is via `tst` field forward-dating (a "60-second time_fallback" assertion completes in ~2 sec wall-clock).

**Test isolation:** all pings use sandbox `device_id='owntracks_test_filtertest'` (not in `tracked_devices`). Production phone data is never touched. Try/finally cleanup wipes every sandbox row at end (also runs at start to clear leftover from a crashed prior run).

**Cross-system safety verified before shipping:**
- Wildcard rules (`Home Activity`, `People Home`) gate on `device_type IN (presence, motion, switch, door_sensor)`. Test device is `phone` → wildcards see the event then early-return. No real rule action fires.
- No rule has `triggers` matching the sandbox device_id.
- MQTT topic `owntracks/+/+` is consumed only by the daemon.

**Scenarios (20 total, ~90 sec runtime):**

| ID | Category | What it tests |
|---|---|---|
| A1 | Fake | Anti-teleport-from-home (Jerusalem cache replay) |
| A2 | Fake | Low-accuracy filter (acc > 80 m) |
| A3 | Fake | Max-speed teleport (800 m/s extreme) |
| A4 | Fake | Stale-ts guard (`age_sec ≤ 0`) |
| A5 | Fake | Single outlier between stationary pings (no trip opens) |
| A6 | Fake | Dedup spatial+temporal (< 25 m + < 60 s) |
| B1 | True | Stationary at home (no trips) |
| B2 | True | Real outbound + commit with backdated ts |
| B3 | True | Real return + trip closes with stats |
| B4 | True | Quick errand (provisional deletes, no event) |
| B5 | True | Long round-trip |
| B6 | True | Flicker filter behavior on close |
| C1 | Walk | Walking out the door (3 m/s) |
| C2 | Walk | Radius-edge jitter (no events) |
| C3 | Walk | Short walk + return (60 s boundary) |
| C4 | Walk | Walk with 5-min GPS dropout |
| D1 | Car | City driving 25 m/s + red light |
| D2 | Car | Above-threshold speed (60 m/s drops) |
| D3 | Car | Just-under-threshold (43 m/s passes) |
| D4 | Car | Tunnel mid-trip (5-min gap) |

**Invocation:**
- **Dashboard UI** (preferred): Project General → Geolocation tab → Settings card → "▶ Run filter test" button. Live progress bar + pass/fail counts. End-of-run state shown inline.
- **SSH** (advanced): `ssh root@192.168.1.227 'python3 /opt/test_geolocation_filters.py'`. Flags: `--only A1,B2`, `--cleanup`, `--verbose`.

**Show/hide test data on UI** (per-browser preference, default unchecked, in localStorage `geo.showTestData`):
- Unchecked → Recent geofence events + Recent trips cards client-side filter out rows with `device_id='owntracks_test_filtertest'`. Map already gated by `tracked_devices` so test trail never renders.
- Checked → test rows visible during the ~90 sec run; vanish at cleanup.

**Endpoints:**
- `POST /api/geolocation/run-filter-test` — fires the script on LXC 104 via SSH. Returns 409 if a previous test is still running.
- `GET /api/geolocation/filter-test-status` — reads the progress JSON via SSH cat. Returns `{running:false, never_ran:true}` if no test has been run yet.
- `POST /api/geolocation/clear-test-data` — emergency cleanup (wipes sandbox rows). Surfaced via "✕ Clear test data" link next to the test button.

**Failure-mode visibility:** comment out the anti-teleport block in the daemon → run the suite → A1 fails with diagnostic showing the bogus Jerusalem row was inserted. Restore + re-run → A1 passes.

**Heartbeat + hard_cap tests are NOT in the default fast suite** (would require 270s + 300s real-time waits). Available behind `--slow` opt-in on the script (no dashboard surface for that mode — SSH only).

## History (why we got here)

| Date | Event |
|---|---|
| 2026-05-31 | Phase 1 scoped. Dual-ingest (HA Companion + OwnTracks) writing to one shared `phone_trips` row per `group_id`. |
| 2026-06-01 | Multiple fixes: trip flicker filter, ping-ts from payload not `NOW()`, sensor veto with age guards. |
| 2026-06-02 morning | Discovered 5 phantom trips (58-81 s, never left home) — GPS jitter slipping through. Added WiFi-confirmed state machine (provisional / confirmed) to defer `geofence:away` until WiFi sensor confirmed the exit. |
| 2026-06-02 evening | Discovered trip 295 was a 25-second tail of a real 35-min / 9 km trip — HA Companion's `device_tracker.fold_5_vadim` was reporting `state='home'` the whole time due to WiFi-DB poisoning. 294 prior provisional trips had been wrestled away by HA's false-home pings. |
| 2026-06-02 evening | Added `ha_ingest_enabled` master toggle to silence HA ingest path. Confirmed OwnTracks alone records correctly. |
| 2026-06-03 audit | Found Fix A (`hard_cap` was unreachable when veto blocked). Applied to both ingest scripts. |
| 2026-06-03 cleanup | User decision: **remove HA from geolocation completely**. This file documents the post-cleanup state. |
| 2026-06-08 | Fake trips #520/#542 (phone stationary at home, GPS oscillating to a ~150 m "ghost" spot, crossing the radius 21–26×). Per firm user constraint **did NOT touch the trip-detection algorithm** — added a separate deferred **bounce-storm janitor** instead (see below). |

## Phantom-trip janitor (`scripts/geo_trip_janitor.py`, 2026-06-08, distance-only 2026-06-09, + accuracy gate 2026-06-10)

Separate cleanup pass on LXC 104 (cron `*/5`, log `/var/log/geo-trip-janitor.log`).
It deletes fake trips caused by a **single FIXED GPS-multipath phantom ~154 m SW of
home** — the phone sits physically at home while its GPS periodically reports a
"ghost" coordinate ~154 m away (with *good* ~20 m accuracy, so accuracy filters miss
it), crossing the 40 m radius and tripping the state machine's `time_fallback`
commit. Proven 2026-06-09 from 4 days of pings: 700+ pings cluster at one spot; the
dense cluster never exceeds ~167 m.

- **The rule — distance + accuracy gate:** a confirmed short trip
  (`duration < 1 h`, closed within 48 h) is a phantom when its **clean max distance ≤ `real_trip_min_far_m` (default 250 m)** → delete it. *Clean max* = the farthest home-distance reached on a ping whose **accuracy ≤ `phantom_accuracy_gate_m` (default 50 m)** — a far reading with junk accuracy is multipath, not movement, so it can't define the trip's reach. Originally distance-only on the stored `max_dist_m` (every fake ≤156 m, every real ≥324 m — a 168 m empty buffer), but **trip #2344 (2026-06-10)** broke that: a ghost ping was flung to **268 m at 73 m accuracy** — over the 250 m line — so the fake showed. The janitor now **re-queries the trip's pings** and drops junk-accuracy readings before measuring reach (#2344's clean reach = 153 m → deleted).
- **Why it's strictly safe (proof):** `clean_max ≤ stored_max` always (max over a subset of pings). So every trip the old distance-only rule deleted is STILL deleted, and the ONLY new deletions are trips that crossed 250 m *solely* via low-accuracy pings — i.e. never credibly left ~250 m. Real >250 m trips reach their distance on GOOD-accuracy pings outdoors → `clean_max > 250` → kept (verified live: real #2398, 686 m, 76-of-77 good pings → kept). **Fallback:** a trip with NO good-accuracy pings (e.g. `device_locations` aged out — older trips log `0/0 pings`) falls back to the stored `max_dist_m`, so it is never deleted on empty evidence. **No crossing count, no dwell math.**
- **Why distance, not the old crossings/dwell (history — do NOT reintroduce):** the
  original 2026-06-08 version counted home↔outside crossings over a padded
  `±10/15 min` window plus a "real-trip guard" (`max_dist > 250` OR longest own-span
  outside-run ≥ 180 s). The **dwell half was fatally wrong** — a *sustained*
  phantom-sit parks the phone at the 154 m ghost for 190–360 s, clearing the 180 s
  bar, so it was mislabeled "real" and **28 fakes accumulated** (e.g. #1145/#1152).
  The crossings half also conflated a real trip's edge-jitter with bouncing (it once
  erased a real 681 m walk, #1075→reconstructed as #1102). Distance alone has none of
  these failure modes (phantom fixed + close; reals far), so the crossings + dwell
  logic — `count_crossings`, `longest_outside_run_sec`, `CROSSINGS_DELETE`,
  `MIN_PINGS`, `real_trip_min_dwell_sec` — was **deleted entirely** 2026-06-09.
- **Trip-detection algorithm (`owntracks_ingest.py`) still completely untouched** —
  pure cleanup; `real_trip_min_far_m` overridable via `dashboard_settings.geolocation`.
- **`--dry-run`** prints the per-trip `max_dist` + verdict without deleting.
- **ALSO removes the fake trip's geofence markers** (`geofence:away`/`home` rows in
  `device_events`), scoped to the deleted trip's OWN span `[started_at..returned_at]`
  — never touches a real away/home event outside it.
- **Caveat:** a future phantom that reaches >250 m on *good-accuracy* pings still
  wouldn't be caught (the accuracy gate only strips junk readings). That needs the
  **spike / out-and-back physics test** (a point far from both close neighbors = an
  impossible round-trip) — designed but not built, since the accuracy gate is
  lower-risk and provable on the data. Add it if a good-accuracy >250 m ghost appears.

### Companion display fixes (2026-06-08, server.js — DISPLAY only, ingest untouched)

The janitor cleans the trips table on its 5-min cron, but a fresh phantom must be
hidden INSTANTLY too. Both fixed in `BOILER/dashboard/server.js`.
**`GET /api/geolocation/trips` applies the simpler distance-only rule** — hide any
trip with `duration_sec < 3600 && max_dist_m ≤ real_trip_min_far_m (250)`, using the
stored `max_dist_m`. It does **NOT** include the janitor's accuracy gate: server.js is
UI-only, so the ping-requery clean-max logic lives ONLY in the LXC-104 janitor.
Consequence: a fresh ghost that peaks >250 m on a junk ping (like #2344) is NOT hidden
instantly — it shows for at most one cron tick (≤5 min) until the janitor deletes it,
then it's gone. Sub-250 m phantoms are still hidden instantly. (No ping re-query now → faster endpoint. The earlier
crossings+dwell version shared the janitor's dwell bug and showed sustained
phantoms.) The separate **map** ghost-ping filter (`_flagOutliers`, below) still
uses its own per-ping logic and was NOT changed — it operates on individual map
pings, not trips: it skips any OUTSIDE ping whose distance `> real_trip_min_far_m`
(a far excursion ping can't be a ~150 m ghost, so a real trip's far points are
never clipped).

- **Map** — `_flagOutliers` gained **Step 4 (bounce-storm cluster)**: an OUTSIDE
  ping whose **±10-MINUTE window** crosses the home boundary ≥ 4 times is flagged
  (hidden client-side). A TIME window, not a fixed ±4-ping count — the ping
  version missed the boundary ghost at the start of a sparse trail (no 4 pings
  *before* it), so the map drew a track to it; the time window uses the
  after-context within 10 min. The ghost cluster defeats Steps 1–3 because it
  alternates (not bit-identical-consecutive), is frequent (median spread
  inflates), and has good accuracy (under the 40 m cap).
- **Live status chip** — `/api/geolocation/status` now classifies off the last 12
  fixes, not just the newest. If they flap across the boundary ≥ 4 times it reports
  **home** off the newest INSIDE fix (`gps_unstable:true`) instead of letting one
  ghost ping show "away · 153 m". Verified: chip went `away·153m` → `home·19m`.
- **Trips list** — `/api/geolocation/trips` hides recent short (`<1 h`, last 48 h)
  trips whose `started_at−10m … returned_at+15m` window crosses the boundary ≥ 4
  times (≥ 6 pings), so an ongoing storm never flashes a fake trip in the
  Recent-trips card between the janitor's 5-min runs (immediate, vs the DB delete).

All three leave `device_locations`/`phone_trips` rows and the ingest/trip algorithm
untouched — they only change what the dashboard *draws*. Same 4-crossing fingerprint
as the janitor. Caveat: a crossing-based filter needs the ping history — clearing
`device_locations` (the Clear button) disables it until the trail refills.

## Future considerations (NOT scoped)

- Multi-phone support is already wired via `group_id` — just add another entry to `tracked_devices`.
- Phase-2 rules that consume `phone_trips` for derived signals (step-counting, daily-distance summaries, etc.) can land any time; the OwnTracks-only data is sufficient.
- If commit latency matters in the future, the WiFi-confirm path could be re-added against an MQTT-direct WiFi sensor source (not HA REST) — same algorithmic shape, different data source. Not planned now.
