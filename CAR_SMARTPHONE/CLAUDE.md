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
- ⚠ **de-Googled = GPS-only.** No network-location provider without Google/microG (`location_providers_allowed
  = null`) → needs **sky view** for a fix; **won't locate indoors on a desk**. Fine for a car (outdoors/moving).
  Optional: install **microG UnifiedNlp + a WiFi-location backend** for indoor fixes (not needed for the car).
- Apps installed via `adb install` (staged on the laptop): OwnTracks (F-Droid), NetBird v0.5.0 (GitHub).

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
