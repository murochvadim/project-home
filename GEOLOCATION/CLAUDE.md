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
   │   1. low-accuracy filter (acc > low_accuracy_filter_m → drop)
   │   2. teleport-from-home HARD rule, NO time constraint
   │      (prev within NEAR_HOME_M=max(radius,300 m) AND new > 5 km → drop).
   │      Widened 2026-06-18 from "prev inside the 40 m radius": the recurring
   │      ~155 m home-multipath cluster sat just outside the radius, became
   │      `last`, and disqualified the rule — letting a 115 km Jerusalem-area
   │      cache replay through (fake trips 7279/7358). Now `last` stays pinned
   │      near home through the whole glitch, so every far ping is dropped.
   │   3. teleport filter (implied_speed > MAX_SPEED_MS=50 m/s ≈ 180 km/h → drop;
   │      can't go lower — Israel Railways express ≈ 160 km/h is legit)
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
   - device_locations (90 d auto_clean since 2026-07-04)
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
| Places cron | [scripts/geo_places.py](../scripts/geo_places.py) → `/opt/geo_places.py` | LXC 104, cron `*/2`; the **Places layer** — dwell→named anchor + legs + stays. Additive; NEVER touches ingest / phone_trips (see below) |
| Places tables | `phone_places` / `phone_place_trips` / `geo_place_state` on LXC 102 | Stays / anchor-to-anchor legs / per-group cursor+state. Migration [GEOLOCATION/migrations/001_places.sql](migrations/001_places.sql) |
| Env file | `/etc/owntracks-ingest.env` on LXC 104 | `MQTT_USER`, `OWNTRACKS_MQTT_PASS`, `DB_PASS` (HA_TOKEN no longer used) |
| Dashboard surface | [BOILER/dashboard/public/project-general.html](../BOILER/dashboard/public/project-general.html) Geolocation tab | Settings card + map + events + recent trips |
| Server endpoints | `/api/geolocation/*` in [BOILER/dashboard/server.js](../BOILER/dashboard/server.js) | settings, status, locations, events, trips |
| Settings row | `dashboard_settings.geolocation` JSONB | singleton |

## Settings (`dashboard_settings.geolocation`)

| Key | Default | Purpose |
|---|---|---|
| `center.{lat,lon}` | apartment GPS | reference for radius checks |
| `home_radius_m` | 40 | inside radius defines "at home" |
| `retention_days` | 3 | ⚠ **STALE / UNWIRED** — no code reads this key. `device_locations` cleanup is governed ONLY by `retention_policies.keep_days` (set to **90 d** on 2026-07-04) via the orchestrator `run_retention`. |
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
| `places_enabled` | false | **Places layer** master switch (opt-in; read by geo_places.py) |
| `place_dwell_min` | 20 | dwell minutes → create a named place + record the leg that got you there |
| `place_min_dist_m` | 500 | a dwell must be at least this far from home to count as a place |
| `place_radius_m` | 120 | place membership + re-arrival radius (bigger than Home's 40 m so returning to a base is reliably detected) |

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

**How it works:** the 20 A/B/C/D scenarios publish synthetic OwnTracks MQTT messages to the production broker over ~90 sec; the live daemon processes them through the actual filter chain; the script then queries DB to verify outcomes. Time control is via `tst` field forward-dating (a "60-second time_fallback" assertion completes in ~2 sec wall-clock). **The 5 P (Places) scenarios test a DIFFERENT component** — `geo_places.py`, the away-base cron — which reads `device_locations` rather than MQTT. A far away-base journey can't go through the daemon (its anti-teleport-from-home guard rejects it by design), so P scenarios insert a controlled `device_locations` stream directly and call `geo_places.process_group` on the sandbox group (with `reverse_geocode` monkeypatched → hermetic, no Nominatim call), asserting `phone_places` (Stays) + `phone_place_trips` (legs). They run in ~2 sec total. `cleanup()` also wipes `phone_places`/`phone_place_trips`/`geo_place_state` for the sandbox group. **The 6 J (Janitor) scenarios test the phantom cleaner** `geo_trip_janitor.py` by importing the DEPLOYED `/opt/geo_trip_janitor.py` and running its real functions: J1–J4 insert a sandbox `phone_trips` row + pings and call `classify_trip` (rules 1–3, J2 = negative control); **J5–J6 test the Places-layer far-teleport rule (rule 4)** — J5 inserts a sandbox `Home→ghost(teleport)→realplace` chain and calls `clean_place_phantoms(..., only_group=<sandbox>)`, asserting the ghost anchor + its teleport leg are DELETED while the real leg is RE-STITCHED to Home and the real place survives (this test would have caught the ratio-version regression that deleted real leg #160); J6 is the negative control (a real 20 km `Home→place` drive is kept). `clean_place_phantoms` gained an `only_group` param purely so the test can scope it to the sandbox group and never touch real phone data (production passes `None` = all groups).

**Test isolation:** all pings use sandbox `device_id='owntracks_test_filtertest'` (not in `tracked_devices`). Production phone data is never touched. Try/finally cleanup wipes every sandbox row at end (also runs at start to clear leftover from a crashed prior run).

**Cross-system safety verified before shipping:**
- Wildcard rules (`Home Activity`, `People Home`) gate on `device_type IN (presence, motion, switch, door_sensor)`. Test device is `phone` → wildcards see the event then early-return. No real rule action fires.
- No rule has `triggers` matching the sandbox device_id.
- MQTT topic `owntracks/+/+` is consumed only by the daemon.

**Scenarios (31 total, ~90 sec runtime):**

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
| P1 | Places | Home→place→Home = 1 Stay + home_to_place + place_to_home |
| P2 | Places | Multi-anchor chain Home→A→B→A→Home = 2 Stays + 4 legs (the headline behavior) |
| P3 | Places | Mid-stay jitter ping (167 m out) absorbed by the departure debounce — no spurious loop leg, stay not truncated |
| P4 | Places | Home excursion with no dwell → 0 places, 0 legs (dropped; phone_trips owns that trip) |
| P5 | Places | Out-and-back to the same anchor → a `place_loop` leg |
| J1 | Janitor | Rule 3 sparse-track ~1 km ghost (282 m/fix) → deleted |
| J2 | Janitor | Real dense ~1 km trip (26 m/fix) → kept (negative control) |
| J3 | Janitor | Rule 1 close-phantom (clean_max ≤ 250 m) → deleted |
| J4 | Janitor | Rule 2 far-teleport (30 km, empty band) → deleted |
| J5 | Janitor | Rule 4 Places teleport `Home→ghost→realplace`: ghost + teleport leg deleted, real leg re-stitched to Home, real place kept |
| J6 | Janitor | Rule 4 negative control — real 20 km `Home→place` drive kept |

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

## Phantom-trip janitor (`scripts/geo_trip_janitor.py`, 2026-06-08, distance-only 2026-06-09, + accuracy gate 2026-06-10, + far-teleport rule 2026-06-18, + sparse-track rule 2026-07-24, + Places far-teleport rule 2026-07-26)

Separate cleanup pass on LXC 104 (cron `*/5`, log `/var/log/geo-trip-janitor.log`).
**It NEVER touches the trip-detection algorithm in `owntracks_ingest.py` — it only `DELETE`s already-closed fake `phone_trips` rows (+ their geofence markers).** Two independent fake-trip rules:
It deletes fake trips caused by a **single FIXED GPS-multipath phantom ~154 m SW of
home** — the phone sits physically at home while its GPS periodically reports a
"ghost" coordinate ~154 m away (with *good* ~20 m accuracy, so accuracy filters miss
it), crossing the 40 m radius and tripping the state machine's `time_fallback`
commit. Proven 2026-06-09 from 4 days of pings: 700+ pings cluster at one spot; the
dense cluster never exceeds ~167 m.

- **The rule — distance + accuracy gate:** a confirmed short trip
  (`duration < 1 h`, closed within 48 h) is a phantom when its **clean max distance ≤ `real_trip_min_far_m` (default 250 m)** → delete it. *Clean max* = the farthest home-distance reached on a ping whose **accuracy ≤ `phantom_accuracy_gate_m` (default 50 m)** — a far reading with junk accuracy is multipath, not movement, so it can't define the trip's reach. Originally distance-only on the stored `max_dist_m` (every fake ≤156 m, every real ≥324 m — a 168 m empty buffer), but **trip #2344 (2026-06-10)** broke that: a ghost ping was flung to **268 m at 73 m accuracy** — over the 250 m line — so the fake showed. The janitor now **re-queries the trip's pings** and drops junk-accuracy readings before measuring reach (#2344's clean reach = 153 m → deleted).
- **Why it's strictly safe (proof):** `clean_max ≤ stored_max` always (max over a subset of pings). So every trip the old distance-only rule deleted is STILL deleted, and the ONLY new deletions are trips that crossed 250 m *solely* via low-accuracy pings — i.e. never credibly left ~250 m. Real >250 m trips reach their distance on GOOD-accuracy pings outdoors → `clean_max > 250` → kept (verified live: real #2398, 686 m, 76-of-77 good pings → kept). **Fallback:** a trip with NO good-accuracy pings (e.g. `device_locations` aged out — older trips log `0/0 pings`) falls back to the stored `max_dist_m`, so it is never deleted on empty evidence. **No crossing count, no dwell math.**
- **RULE 2 — far teleport (2026-06-18, "forever fix"):** catches the OTHER fake class — a cache-replay to a fixed FAR coordinate (observed ~115 km SE, Jerusalem area — fake trips 7279/7358) that teleports out and back with NO path between. The close-phantom rule misses these (they're >250 m AND >1 h), and the ingest speed cap can't (115 km / 38 min ≈ 180 km/h, on the Israel-Railways-express axis). Signal = **CONTINUITY**, distance- and launch-agnostic: a real journey to X km has fixes at intermediate distances; a teleport has good fixes ONLY near home and at X. So a trip whose good-accuracy reach `> teleport_far_m` (default **20 km**) but has **ZERO good pings in the band `[teleport_inner_m, reach-teleport_inner_m]`** (default inner **1500 m**) is a teleport → delete. **Applies at ANY duration** (the query no longer filters `duration < 1 h` — that filter only gates Rule 1). **Safe for real far trips:** even a trip silent on the way OUT still has return-leg fixes in the band; only one silent BOTH ways over tens of km (implausible, and returning to the exact origin) would trip it — and with no ping evidence at all it falls back to keep. Verified 2026-06-18 dry-run: 4 current real trips (276–1079 m) all kept, 0 deletions.
- **RULE 3 — sparse track (2026-07-24, `PHANTOM_FIX_SPACING_M`):** catches a NEW **fixed GPS ghost ~1 km SW of home** (~32.166/34.889) making nightly phantom `Home→Home` trips — the phone teleports out-and-back to it while physically home (proven: trip 14780 = three ~1037 m ghost fixes, then 54–65 m HOME fixes, then six more ~1 km fixes, then the 9 m return). It lives in the **gap between Rules 1 & 2**: too far for close-phantom (≤250 m), too near for teleport (>20 km; the empty-band test can't even form a band below ~3 km), and the continuity signal is **polluted by home GPS scatter** (which reaches 300–400 m at a ~1 km reach). Robust, distance-/duration-agnostic signal = **TRACK DENSITY = `path_length_m / outside_pings`** (metres of path per outside fix): a real moving phone drops a fix every **~25–45 m** (OwnTracks publishes on displacement), but a phantom's path_length is mostly imaginary teleport distance so its fixes are **282–944 m apart** — a clean **7× gap, zero overlap** over all 10 recent trips. Rule: reached `> real_trip_min_far_m` (250) AND `outside_pings>0` AND `path_length_m/outside_pings > phantom_fix_spacing_m` (**150**, tunable in `dashboard_settings.geolocation`) → delete. **Uses ONLY stored columns** (`max_dist_m`/`path_length_m`/`outside_pings`) — no ping re-fetch (unlike Rules 1/2). **⚠ First attempt was a "mid-trip home return" rule (near fix sandwiched between far fixes); `--dry-run` KILLED it — it false-flagged a REAL 328 m walk (14954) and MISSED the sparse phantoms (too few good pings to form the sandwich). The mandatory dry-run before deploy is why track-density won.** Dry-run-verified: deletes the 6 phantoms (14779–14865, 282–944 m/fix), keeps all 4 real trips (25–41 m/fix). Rules 1 & 2 unchanged; `owntracks_ingest.py` untouched. Secondary root cause (NOT fixed — would touch the state machine): the tight **40 m `home_radius`** lets home scatter (50–65 m) keep a trip "open" so it spans long home periods punctuated by ghost pings.
- **RULE 4 — Places far-teleport (2026-07-26, `clean_place_phantoms`, absolute-path + re-stitch):** the FIRST janitor rule that touches the **Places layer** — Rules 1-3 act on `phone_trips` (Home-trips) ONLY, so `phone_place_trips`/`phone_places` (from `geo_places.py`) had **no phantom cleaner**. A GPS cache-replay that parks the phone at a far ghost long enough for `geo_places` to build an anchor makes a bogus place + legs — e.g. a **115 km `الجيزة, الأردن`** stay reached on a **12 m path** (2026-07-25, anchor #64). **TELEPORT signal = an ABSOLUTE tiny path** (`PLACE_TELEPORT_MAX_PATH_M`): a `home_to_place`/`place_to_home` leg with `max_dist_m > teleport_far_m` (20 km) **AND** `path_length_m < place_teleport_max_path_m` (**default 1000 m**) — you can't be 20+ km away having *moved a few metres*. **⚠ v1 (same day) used a `path < 0.5×max_dist` RATIO — WRONG:** leg #160 (`ghost → Ashdod`) was a **real ~20 km drive** whose mislabeled ghost origin inflated its stored `max_dist` to 128 km, so the ratio flagged it and DELETED it — losing the real arrival into Ashdod (leg #160's pings were ALL in Israel, lon 34.6–34.7, good accuracy 4–10 m — a genuine smooth drive; الجيزة was a *longitude* glitch, same lat / lon shifted east to Jordan). An absolute path floor can NEVER flag a real drive (20 km of path is real travel regardless of a mislabeled origin distance). The **phantom anchor** = a teleport leg's place endpoint; delete the anchor + the teleport legs, but a REAL leg that only *referenced* the ghost is **RE-STITCHED to Home** — its ghost endpoint → Home (`from/to_place_id=NULL` + `origin/dest_name='Home'`, `kind` fixed), and `max_dist`/`path` **recomputed from Home** over the leg's real pings (`_recompute_leg_from_home`, falls back to stored if no pings) — so `ghost → Ashdod` becomes the real `Home → Ashdod`. FK is `ON DELETE SET NULL`, so legs are re-stitched/deleted BEFORE the anchor. `--dry-run` supported; tunable `place_teleport_max_path_m` in `dashboard_settings.geolocation`; **sandbox-verified** (fake home→ghost→realplace ⇒ ghost + teleport-leg deleted, real leg re-stitched `Home→realplace`, real place kept). The original الجيزة #64/#159/#160 was cleaned by v1 BEFORE the ratio→absolute fix, so Ashdod #65 was kept but its inbound leg lost — left as-is per user. Rules 1-3 + `geo_places.py`/`owntracks_ingest.py` untouched.
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

## Places layer — dynamic away-bases (2026-07-03)

The Home trip algorithm only knows ONE anchor (Home): a trip opens when you leave
the Home circle and closes when you re-enter it, staying open the whole time
you're away. The **Places layer** adds *secondary anchors* so a stay in another
town / abroad is broken into meaningful pieces. **It is a SEPARATE, ADDITIVE,
opt-in layer — `owntracks_ingest.py`, the Home state machine, `phone_trips`, the
janitor, and `_flagOutliers` are NOT touched** (same discipline as the janitor).

**How it runs:** `scripts/geo_places.py` → `/opt/geo_places.py`, cron `*/2` on
LXC 104. It only READS the already-cleaned `device_locations` stream and writes
the three new tables. Does nothing unless `places_enabled = true`. Incremental via
a per-group `geo_place_state.last_ts` cursor; first enabled run seeds the cursor
to the newest ping (tracks **forward only**, never backfills history into fake
places). Reverse-geocodes place names via Nominatim (verified reachable from LXC
104; one call per place, User-Agent set, graceful fallback).

**Model — a chain of anchors + the legs between them.** An *anchor* = Home **plus**
every spot the phone dwells at `≥ place_dwell_min` within `place_radius_m` and
`> place_min_dist_m` from Home (auto-named). Two row kinds, merged into the same
Recent trips list:
- **Stay** (`phone_places` row) — `📍 Stay · <name> · <duration>`; `left_at` NULL
  while you're still there ("still here").
- **Leg** (`phone_place_trips` row) — recorded as a COMPLETED row on ARRIVAL at an
  anchor: `home_to_place` / `place_to_place` / `place_loop` / `place_to_home`.
  `max_dist_m` measured from the leg's **origin** anchor. **`Home→Home` excursions
  are dropped** — `phone_trips` already owns those (no duplication).

A journey's anchors persist until you return Home (which clears them), so coming
back through an earlier anchor (Beach → Haifa) closes a leg there **without** a new
Stay row. Example `Home → Haifa (stay) → Beach (stay) → Haifa → Home` yields exactly
6 rows. Robust by design: dwell + `place_min_dist_m` means the ~154 m home phantom
and single-ping far-teleport replays can't spawn a place.

**Dashboard.** Merged into the existing **Recent trips** card (no separate card):
`GET /api/geolocation/trips` now UNIONs `phone_trips` (rendered `Home → Home`) +
`phone_place_trips` + `phone_places`, adds a **Route** column and a `row_type`
tag, and **DIMS** an umbrella Home trip when place rows fall inside its span (the
umbrella can't be removed — it's the untouched algorithm — so it just steps back
visually, tagged `(umbrella)`). The Home-phantom filter stays scoped to `home`
rows only. `DELETE /api/geolocation/trips` routes composite ids
(`home:` / `leg:` / `stay:`) to the right table (plain ints still = home, back-compat).
Settings live in a **📍 Away places** block on the Geolocation Settings card.

**Tables** (LXC 102, retention forever; the two data tables 🔒 protected):
- `phone_places` — `id, group_id, name, lat, lon, radius_m, arrived_at, left_at, created_at`
- `phone_place_trips` — `id, group_id, device_label, kind, origin_name, dest_name, from_place_id, to_place_id, started_at, returned_at, duration_sec, max_dist_m, path_length_m, outside_pings, created_at`; partial unique index `uq_phone_place_trips_open_per_group` (unused today — legs are always inserted complete)
- `geo_place_state` — `group_id PK, last_ts, state JSONB, updated_at`

**Log:** `/var/log/geo-places.log` on LXC 104. **Deploy:** `scp scripts/geo_places.py
root@192.168.1.227:/opt/geo_places.py` (config via dashboard settings — no restart).

## Future considerations (NOT scoped)

- Multi-phone support is already wired via `group_id` — just add another entry to `tracked_devices`.
- Phase-2 rules that consume `phone_trips` for derived signals (step-counting, daily-distance summaries, etc.) can land any time; the OwnTracks-only data is sufficient.
- If commit latency matters in the future, the WiFi-confirm path could be re-added against an MQTT-direct WiFi sensor source (not HA REST) — same algorithmic shape, different data source. Not planned now.

## Times follow 🧳 Travel (2026-09-02)

Every timestamp on **Project General → Geolocation** and **→ Car Geolocation** renders in
`activeTzFor('geolocation')` — the travel timezone when **Geolocation is ticked** in Privacy →
Settings → 🧳 Travel, otherwise `Asia/Jerusalem`. Presentation only: `device_locations` /
`phone_trips` / `phone_place_trips` and the ingest daemon are untouched, and the server formats no
geolocation dates (it returns raw timestamps; all formatting is client-side).

- Helpers in `project-general.html`: `geoTz()` · `geoFmt(ts)` (tables) · `geoFmtShort(ts)` (map
  tooltips) · `geoTzNote()` (an amber `times: New York` next to the **Map · trail** heading whenever
  the zone is not Israel — without it you cannot tell whether 19:29 means Israel or New York).
- ⚠ `activeTzFor()` is **sync over a preloaded cache**, so both `geoOnTabShow()` and `carOnTabShow()`
  are `async` and `await loadTravelSettings()` **before** the first paint; `travel-tz.js` also
  self-preloads, which would otherwise mask the miss as a rare first-render-only bug.
- **Two defects fixed on the way:** the map trail tooltips printed the **raw UTC string**
  (`2026-09-02T00:25:22.000Z · accuracy 9.0 m`), and the **Car** tab's `fmtT` had **no timezone at
  all** — browser-local, which only looked right because the dashboard laptop is on Israel time.
- Verified against the database: leg 8464 = `02.09 00:43` Israel = `01.09 17:43` New York.
