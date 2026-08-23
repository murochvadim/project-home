# CAR_SMARTPHONE — Pixel 2 XL → de-Googled LineageOS car GPS-tracker node

> Renamed from SPARE_SMARTPHONE (2026-08-23) — this phone became the **car tracker**.

A **Google Pixel 2 XL** (de-Googled LineageOS) living in the car as a **GPS tracker**: it reports its
location into the project's existing geolocation stack and shows up as **"Car (Pixel 2 XL)"** on the map.
Reaches the home broker over **home WiFi** when parked and over **NetBird** when away.

**Status (2026-08-23): ✅ LIVE — tracker + NetBird working.** Camera / battery-sleep / data-SIM = deferred (below).

## Device
- **Pixel 2 XL**, codename **`taimen`**, unlocked **G011C** variant. Serial **`712KPED1259460`**.
- **Hardware WiFi MAC `b4:f7:a1:e4:bd:04`** (MAC randomization turned OFF for "Home" so this is stable).

## OS — LineageOS **20** (Android 13), NOT 22  ⚠ important
- Running **`lineage-20.0-20231005`** (Android 13), de-Googled. **Deliberately downgraded from LineageOS 22.2.**
- **Why:** LineageOS **22.x has a WiFi regression on taimen** (appeared ~build `20260611`, still broken through
  `20260806`). Symptom: WiFi won't enable — the **WCN3990 firmware crashes** (`icnss: PD service down … Root PD
  crashed` in kernel log). **Confirmed it's the ROM, not hardware:** WiFi works on stock Android 11 AND on
  LineageOS 20; our own firmware flashed correctly. Forum-confirmed fix = run a build predating the regression.
- **LineageOS 20 is EOL** for taimen (last build Oct 2023 — no more updates) and only lives on **archive.org**
  (`https://archive.org/download/lineage-20.0-20231005-nightly-taimen-signed/`). Runs on the same Android-11
  firmware base already flashed — install = flash its `boot.img` recovery + `adb sideload` the zip (see
  [[project-pixel-flash]] for the taimen flash mechanics; done from the mini-PC's fastboot).
- **Reversible:** when LineageOS fixes the 22.x WiFi bug, can flash back up to 22.

## Network identity
- **Home LAN: `192.168.1.234`** — a **DHCP reservation** on hardware MAC `b4:f7:a1:e4:bd:04`.
- **NetBird: `100.102.113.116`** / **`car.netbird.cloud`** — peer name **`car`** (renamed from the default
  `lineage_taimen`), joined via **SSO login** (the mobile app uses login, not a setup key — "invalid key format"
  if you try a setup key). 4th peer, still 1 user on the tenant.

## Tracker (OwnTracks → existing geolocation stack — VERIFIED working)
- **OwnTracks** (F-Droid) publishes as device **`car`** to topic **`owntracks/owntracks_phone/car`**, **reusing
  the `owntracks_phone` MQTT user** (ACL `readwrite owntracks/#` on LXC 107 — no new broker user/ACL).
  Broker **`192.168.1.189:1883`**, monitoring = **significant** (report on location change). Config file
  `car.otrc`; **⚠ the `owntracks:///config?inline=` intent needs STANDARD base64** (URL-safe base64 → "import
  not accepted"), then a manual accept-import on the phone.
- The **existing `owntracks-ingest.service` (LXC 104)** ingests it with **no code change** (`owntracks/+/+`),
  auto-registers the `devices` row `owntracks_owntracks_phone_car`, writes `device_locations`, runs the trip
  state machine. Registered in `dashboard_settings.geolocation.tracked_devices` (group `car`) so it shows on the
  Geolocation map (the map's `/api/geolocation/status` only lists `tracked_devices`).
- **Home fence = the GLOBAL 40 m** (`home_radius_m`) — same as the phone; the ingest geofence is one global
  center, not per-device. "Home parking" = within 40 m of the apartment.
- ⚠ **de-Googled = GPS-only + the underground-garage limit.** No network-location provider without
  Google/microG (`location_providers_allowed = null`) → needs **sky view** for a fix; won't locate indoors on a
  desk. **⚠ GPS does NOT work in the home parking (it's -2 floors underground)** — inherent to GPS, not a
  de-Google quirk (even Google phones only *fake* a position there via WiFi/cell). Consequences:
  - **While parked at -2 the car has NO live fix** — the map shows the last surface fix as **"stale"**. Fine —
    it's parked at home.
  - **When it drives up and surfaces, GPS locks within ~1 min** → it reports the trip + fires the away alert. So
    the tracker's real job (catch it when it moves) works, just with a short surface-lock delay.
  - **Home WiFi won't reach -2** → the phone needs the **data SIM** to stay online while parked underground;
    **without the SIM it's fully offline** (can't even report last-known / NetBird offline) until it drives out.
  - Optional: **microG UnifiedNlp + a WiFi/cell backend** *might* give a parked fix if the garage has signal —
    not required to track trips.
- Apps installed via `adb install` (staged on the laptop): OwnTracks (F-Droid), NetBird v0.5.0 (GitHub).

## Dashboard — "Car Geolocation" tab (BUILT 2026-08-23)
A **Car Geolocation** tab on **Project General** (beside a renamed **"My Smartphone Geolocation"** tab —
label-only rename, that tab still shows all devices). All in `public/project-general.html` (inline, own
`_carMap` + `car*` loaders, filtered to `device_id='car'` / group `car`); reuses `/api/geolocation/{status,
locations,trips}` client-side + `/api/dashboard-settings/car.settings` — **no new page, no new LXC**. Shows:
car status (home-parking/away · battery% · last-seen · NetBird), a car-only map + trail, car trips, and a
**Settings & Controls** card:
- **📍 Locate now** → `POST /api/geolocation/car/locate` (module `routes-carlocate.js`) → publishes
  `owntracks/owntracks_phone/car/cmd {"_type":"cmd","action":"reportLocation"}`. Required a **LXC-107 ACL grant**
  (`user rule_engine` → `topic write owntracks/owntracks_phone/+/cmd`; server.js's MQTT user couldn't write it).
  ⚠ **How Locate-now works — two conditions for it to actually return a position** (verified 2026-08-23: the
  publish succeeds `{ok:true}` but nothing updated because both were unmet):
  1. **`cmd:true` on the phone** (OwnTracks → Preferences → Advanced → Remote commands) — without it the phone
     *receives* the command but ignores it. **This is the main gate; not yet enabled.**
  2. **The phone must have a GPS fix** (sky view) to report a *fresh* position → **Locate-now returns nothing new
     while parked in the -2 garage** (no GPS underground, see the GPS-only limit above); it works when the car is
     outdoors/surfaced. On success a new ping lands and the status flips from "stale" to a fresh home/away.
- **Battery-sleep threshold %** + **away-parking alert** toggle — saved to `dashboard_settings.car.settings`,
  **inert until** the phone automation app / alert rule are built (deferred).
- Global geofence settings are intentionally NOT here (shared with the phone). Plan:
  [CAR_GEOLOCATION_TAB_PLAN.md](CAR_GEOLOCATION_TAB_PLAN.md).
- **📷 Car camera snapshot (BUILT 2026-08-23)** — a "📷 Car camera" card on the Car tab: a **Snapshot** button
  + a live image. The phone runs **`car_cam_app`** (`com.muroch.carcam`, CameraX foreground service) that
  subscribes to `mur/home/esp/car_camera/command`, captures **one JPEG on command** (camera OFF between shots —
  low power for a parked car), and uploads it to the media agent (`Car Snapshots/latest.jpg`). Dashboard:
  `routes-car-snapshot.js` publishes the command; the `<img>` loads it from the media agent
  `:8766/api/media/stream`. **No new broker user/ACL** (phone = `esp_boards` reads `mur/home/esp/+/#`; dashboard
  `rule_engine` already writes it). Verified end-to-end. **⚠ Black-frame fix (2026-08-23):** headless CameraX
  captured a black frame because ImageCapture alone never streams the sensor (AE/AWB don't converge) — fixed by
  binding a throwaway `Preview` (dummy `SurfaceTexture`) + a 1.5 s exposure-settle delay before the shot (frame
  went 204 KB→~2 MB). **⚠ Keep-alive fix (2026-08-23):** the MQTT connection dropped every ~90 s once the screen
  went off (WiFi power-save + Doze) so snapshot commands were missed — fixed with a partial `WakeLock` +
  `WIFI_MODE_FULL_HIGH_PERF` WifiLock (held for the service life), `MqttCallbackExtended.connectComplete`
  re-subscribing on every reconnect (clean session), keepalive 60→30 s, and a Doze whitelist granted via
  `adb … dumpsys deviceidle whitelist +com.muroch.carcam` (⚠ re-grant on a fresh install). Verified: 150 s
  screen-off idle → 0 drops. **The app does NOT need to be on-screen** — it's a foreground *service* (persistent
  notification) with `foregroundServiceType="camera"`, so it captures with the app closed / screen off, as long
  as the service is alive. Follow-ups: auto-start-on-boot verification, camera-lens choice. See
  [CAR_CAMERA_SNAPSHOT_PLAN.md](CAR_CAMERA_SNAPSHOT_PLAN.md) + [car_cam_app/README.md](car_cam_app/README.md).

## Deferred / planned (was the CAR_TRACKER plan)
- **Data SIM** — Rami Levy **12 GB / 36 mo, Pelephone, nano** (₪128) → cellular so it reports **away from home**
  across all Israel. Not inserted yet. (⚠ this phone's own WiFi is fine, but the tracker only reaches the broker
  off-home via NetBird over cellular.) With WiFi-at-home + cellular-only-away, 12 GB lasts easily.
- **Alert when it leaves home parking** — a NEW rule (via `/create-rule`) on the car's `geofence:away` event →
  Notifications / Pixoo. No existing away-alert rule (the stack only records trips today).
- **Battery-sleep at a dashboard-set %** — an on-phone automation app (MacroDroid/Automate, F-Droid, MQTT) that,
  when **unplugged AND battery ≤ threshold**, kills GPS/data so it dozes; threshold pushed via MQTT from the
  dashboard. Planned.
- **Dashcam** — ⚠ **dual-camera simultaneous recording is IMPOSSIBLE on the Pixel 2 XL** (concurrent camera only
  on Pixel 6+). Single-camera dashcam-**while-driving** (powered — no battery conflict) is the viable option;
  video stored locally, synced on home WiFi (can't go over the SIM). Undecided.

## Recap of the whole build
Flashed taimen → (LOS 22.2, WiFi dead) → diagnosed the 22.x WCN regression → **downgraded to LOS 20 (WiFi
works)** → OwnTracks + NetBird installed → `car` reporting on the map → DHCP reservation + NetBird peer `car`.
Sibling of [FR_SMARTPHONE](../FR_SMARTPHONE/CLAUDE.md) (the A71 entrance-camera phone).
