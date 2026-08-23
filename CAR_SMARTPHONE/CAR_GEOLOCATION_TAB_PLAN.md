# Plan — "Car Geolocation" tab on Project General (PLAN, not built)

> **Status: PLANNED (2026-08-23) — plan only, awaiting go-ahead. Nothing built.**

Add a **"Car Geolocation"** tab to the **Project General** page, beside the existing Geolocation tab (which is
**renamed → "My Smartphone Geolocation"**). The new tab is a **car-focused** view — map + status + trips scoped
to the car phone. **No new page, no new LXC, no new service, no new endpoint** — it reuses the existing
geolocation APIs and filters to the car **client-side**.

## Why this is cheap (grounded in the actual code)
- Project General's tabs live in `BOILER/dashboard/public/project-general.html` (`showTab(name, btn)` +
  per-tab init). The **Geolocation rendering is INLINE** in that file (`geoOnTabShow()` at ~line 912) — Leaflet
  is already loaded (CDN, line 10). So the new tab is added in the **same file**, same pattern.
- The car is **already fully tracked** (OwnTracks → broker 107 → ingest 104 → `device_locations` 102). This tab
  is **display-only** — it just reads existing data. Fits the architecture rule (dashboard = static + UI).
- Car identity (live, verified): device_id **`owntracks_owntracks_phone_car`**, group_id **`car`**,
  name **`Car (Pixel 2 XL)`**.

## Changes — all in `public/project-general.html` (one file, UI-only)
1. **Tab bar** (line 180-182):
   - Rename the button LABEL only: **"Geolocation" → "My Smartphone Geolocation"**. ⚠ Keep the internal name
     `geolocation`, panel id `tab-geolocation`, and `geoOnTabShow()` unchanged (label text is the only edit →
     zero risk). **DECIDED (a): this tab keeps showing ALL tracked devices** (Fold 5 + car); the car simply also
     has its own dedicated tab. No `geoOnTabShow()` logic change.
   - Add a new button beside it: `Car Geolocation` → `showTab('car-geo', this); carOnTabShow();`
2. **Hash deep-link handler (line 595-596)** — the DOMContentLoaded block has HARDCODED lines
   `if (hash === 'geolocation') …` / `if (hash === 'weather') …`. **Add** `if (hash === 'car-geo' && typeof
   carOnTabShow === 'function') carOnTabShow();` so `project-general.html#car-geo` opens the tab directly. (Found
   by reading the code — not a guess.)
3. **New panel `#tab-car-geo`** — a car-scoped clone of the geolocation panel: a **status card** + a **Leaflet
   map div** (`id="car-map"`) + a **trips list** (`id="car-trips"`), suffixed ids so nothing collides.
   **Skip the global Settings section** (center/radius/knobs are global — they stay on the My Smartphone tab).
   Events/trail are optional add-ons.
4. **New `carOnTabShow()` + slim `car*` loaders** (inline JS, mirrors the `geo*` set but scoped to the car).
   ⚠ Real work, ~100-150 lines: the geo tab uses a **module-level `_geoMap` + `_geoPollTimer`** and separate
   loaders (`geoInitMap / geoReloadStatus / geoReloadTrail / geoReloadTrips`). The car tab needs its **own
   `_carMap` + `_carPollTimer`** and its own slim loaders:
   - `carReloadStatus`: `GET /api/geolocation/status` → pick the entry where `group_id`/name is the car → render
     **home-parking / away**, **last-seen**, **battery %** (verified `/status` returns `battery_pct` + the
     home/away class + a NetBird match, and the peer `car` matches "Car (Pixel 2 XL)").
   - `carReloadTrail`: `GET /api/geolocation/locations?device_id=owntracks_owntracks_phone_car` → marker + trail
     on `_carMap` (its own Leaflet instance on `#car-map`).
   - `carReloadTrips`: `GET /api/geolocation/trips` → **filter client-side to `group_id='car'`** → car trips.
   - Own poll timer (10 s, same cadence), started on tab show.

## "My Smartphone Geolocation" tab — DECIDED (a) label-only rename
✅ **(a) chosen (2026-08-23):** rename the button label only; the tab **keeps showing all tracked devices**
(Fold 5 + car). Zero logic change to `geoOnTabShow()`. The car also appears there and on its own Car tab.

## Audited against the live code (2026-08-23 — not guessed)
- `showTab(name, btn)` sets `tab-${name}` active → panel MUST be `id="tab-car-geo"`, button `showTab('car-geo',…)`.
- The hash deep-link block (line 595-596) is hardcoded per-tab → **must add a `car-geo` line** (change #2).
- `geoOnTabShow()` (line 912) = `geoInitMap` + `geoLoadSettings` + status/trail/events/trips + a 10 s poll, on a
  **module-level `_geoMap`** → the car tab needs its **own `_carMap` + poll timer + slim loaders** (can't share).
- `/api/geolocation/status` (server.js 3780) returns per-device **last ping (ts/lat/lon/accuracy/`battery_pct`)**,
  a home/away classification (12-fix bounce-aware), and a **NetBird peer match** on the device name — the peer
  `car` matches "Car (Pixel 2 XL)" via its `includes("car")` check. So all status-card fields are available.
- `/api/geolocation/locations?device_id=X` supports the car's device_id; `/trips` returns all trips (filter to
  `group_id='car'` client-side). **No endpoint change needed.**
- Leaflet is loaded on the page (CDN, line 10). Car map reuses the same OSM tile layer.
- **Full-scope additions (verified):**
  - server.js's MQTT client publishes as **`rule_engine`** (`MQTT_RULE_PASS`, line 189/238). The LXC-107 ACL
    grants owntracks only to **`owntracks_phone`** (`readwrite owntracks/#`) — **`rule_engine` has NO owntracks
    write** → Locate-now needs the ACL grant above, else mosquitto silently drops the publish.
  - **`GET/POST /api/dashboard-settings/:key`** exist (server.js 8129 / 8325) → car settings (battery-sleep %,
    away-alert) store with no new endpoint.
  - OwnTracks already **subscribes to `owntracks/owntracks_phone/car/cmd`** (seen in its connect log), but needs
    **`cmd:true`** to act on `reportLocation`. My deployed `car.otrc` did not set it → add it.

## Car Geolocation tab — content (FULL scope, decided 2026-08-23)
**Read view:** status card (home-parking/away · last-seen · battery% · online/NetBird) + car-only map
(position + trail) + car trips.

**Settings & Controls card** (on the Car tab):
- **📍 Locate now** (LIVE) — button → publish OwnTracks `{"_type":"cmd","action":"reportLocation"}` to
  **`owntracks/owntracks_phone/car/cmd`** → phone reports its GPS immediately. ⚠ **Two prerequisites (verified):**
  1. **Broker ACL grant** — `rule_engine` (server.js's MQTT user) currently **cannot write `owntracks/#`** (only
     `owntracks_phone` can). Add `user rule_engine` → `topic write owntracks/owntracks_phone/+/cmd` to the LXC-107
     ACL (a one-line grant, like the project's other ACL adds), or the publish is **silently dropped**.
  2. **OwnTracks `cmd: true`** — the phone must have Remote Commands enabled (it already *subscribes* to the cmd
     topic, but ignores commands unless `cmd:true`). → re-import `car.otrc` with `cmd:true` (or toggle it on-phone).
- **Battery-sleep threshold %** (SAVED now, INERT until wired) — a number input; stored in `dashboard_settings`
  (car key) via the existing **`POST /api/dashboard-settings/:key`**. Does nothing until the phone-side automation
  app (deferred) reads it over MQTT.
- **Away-parking alert** toggle + notify-target (SAVED now, INERT) — stored the same way; does nothing until the
  alert rule (deferred) is built.
- ⚠ **NOT on this card: the global geofence settings** (center / **40 m radius** / geofence knobs). Those are the
  ONE shared setting used by BOTH the phone and the car — editing them here would move the phone's home too. They
  stay on the My Smartphone / shared side. (A car-only parking radius would need the per-device-geofence code change.)

**Later (not even saved yet):** data-SIM usage, dashcam feed. See `CAR_SMARTPHONE/CLAUDE.md` deferred list.

## Server/broker touch (Full scope — small, honest list)
- ❌ No new LXC · ❌ no new service · ❌ no new page.
- **Read view + Settings storage:** zero server change — reuses `/api/geolocation/*` (client-filtered) +
  the existing generic `/api/dashboard-settings/:key`.
- **Locate-now needs TWO small changes** (not "zero"): (1) a **one-line LXC-107 ACL grant** to `rule_engine`
  (`write owntracks/owntracks_phone/+/cmd`); (2) a thin **`POST /api/geolocation/car/locate`** (or reuse an
  existing publish path) in server.js that publishes the reportLocation cmd — a thin control like the existing
  device-toggle / corridor-sim MQTT publishes, NOT business logic. Plus the on-phone `cmd:true` config toggle.
- If you'd rather keep server.js/broker 100% untouched, **drop Locate-now** and the rest is pure client-side.

## Verify (after build)
1. Project General shows **My Smartphone Geolocation** + **Car Geolocation** tabs; existing Geolocation behavior
   intact (no console errors, map/trips still work).
2. Car tab: map centers on the car, shows its trail + marker; status card shows home/away + battery + last-seen;
   trips list shows only the car's trips.
3. If (b) chosen: the My Smartphone tab no longer lists the car.
4. No server change deployed (pure dashboard-file edit; bump the cache-bust if a script version is touched).
