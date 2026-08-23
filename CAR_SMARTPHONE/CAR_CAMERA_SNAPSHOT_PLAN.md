# Plan — 📷 Car camera snapshot ("where's my car") (PLAN, not built)

> **Status: PLANNED (2026-08-23) — plan only, no build. A deferred feature of the Car Geolocation tab.**

A **📷 Snapshot** button on the **Car Geolocation** tab that grabs **one still** from the car phone's forward
camera so you can *see* where the car is (surroundings/landmarks), not just a map dot.

## The one architectural decision that drives everything: ON-DEMAND capture
A parked car phone is battery-managed and often unplugged (see `CLAUDE.md`). A continuous IP-camera app (IP
Webcam etc.) keeps the **camera powered 24/7** → it would **drain the battery and overheat in a parked car**.
So the design MUST be **capture-only-on-request, camera OFF between shots**:
- ✅ **On-demand capture** (recommended) — the phone captures a single frame when asked, then the camera goes
  back to sleep. Near-zero idle power. Right for a parked, battery-managed device.
- ❌ **Continuous IP-cam** (IP Webcam / MJPEG stream) — simple but keeps the camera hot; **rejected** for a
  parked car (only OK when the car is running/powered).

## Components
1. **Phone app — a small on-demand snapshot service.** No such app on the car phone yet (it only runs OwnTracks
   + NetBird). Best route = **extend/share the FR-phone camera app** (`FR_SMARTPHONE/fr_camera_app`, CameraX) or
   a slim sibling: it **subscribes to an MQTT command topic** and, on command, opens the camera → captures ONE
   JPEG → releases the camera → uploads the frame. Foreground service + auto-start so it survives reboots.
   Consistent with the project's MQTT-command pattern (like Locate-now).
   - Trigger topic (proposal): `owntracks/…`-style or a dedicated `mur/home/car/camera/cmd` → `{"action":"snapshot"}`.
   - Camera: **forward-facing** (whichever lens faces out when mounted) — a config on the phone.
2. **Trigger — dashboard button.** A **📷 Snapshot** button on the Car tab → a thin publish (like
   `routes-carlocate.js`) publishes the snapshot command over MQTT. Needs the matching **LXC-107 ACL grant** for
   `rule_engine` to write the camera cmd topic (same pattern as the Locate-now `…/cmd` grant).
3. **Delivery — reuse the media agent.** The phone POSTs the JPEG to the **existing media agent upload**
   (`:8767/api/media/upload` on LXC 100 — already used by Daily-Journal attachments) into a `Car Snapshots`
   folder, OR a tiny dedicated "latest snapshot" store. The dashboard then shows the latest image.
   - Alternative (no upload): the app serves the last frame at `http://<phone>:8080/shot.jpg`; the dashboard
     proxies it. Simpler, but the app has to hold the frame + be reachable at request time.
4. **Dashboard display.** A small **thumbnail** on the Car tab (+ timestamp) with click-to-enlarge; the Snapshot
   button requests a fresh one and swaps the thumbnail when it lands.

## Connectivity (reuses what's there)
- Phone reachable at **`192.168.1.234`** (home LAN) or **`car.netbird.cloud` / `100.102.113.116`** (NetBird,
  works home + away). The command goes over MQTT (broker 107, which the phone reaches via WiFi/NetBird/SIM); the
  image upload goes to LXC 100. So it works wherever the phone is online.

## ⚠ Honest caveats (same physics as the GPS/garage note)
- **Underground garage = a dark, useless picture** — the forward camera just sees a dark concrete garage. The
  snapshot is valuable when the car is **out / street-parked** (surroundings visible).
- **Connectivity** — needs the phone online: home WiFi / NetBird / the **data SIM** when away. Underground needs
  the SIM (home WiFi won't reach -2).
- **Mounting** — the phone must be positioned so the forward camera sees the road/surroundings, not the dash.
- **Camera app must stay alive** — foreground service + battery-optimization exemption (same keep-alive concern
  as any always-on phone app), but idle power stays low because the camera is off between shots.

## Reuse / dependencies
- **FR_SMARTPHONE camera app** (`fr_camera_app`, CameraX + the offline build toolchain at `C:\android-dev`) —
  the natural base; a car build could share most of it (swap MJPEG-stream for on-demand-snapshot).
- **MQTT-command pattern** (`routes-carlocate.js` + the LXC-107 ACL grant) — copy for the camera cmd.
- **Media agent upload** (`:8767/api/media/upload`, LXC 100) — for delivery.

## Scope / build order (when approved)
1. Phone app: on-demand snapshot service (extend fr_camera_app) — captures 1 JPEG on MQTT cmd, uploads, camera off.
2. Broker: ACL grant for the camera cmd topic (like Locate-now).
3. Dashboard: `routes-car-snapshot.js` (publish cmd) + a thumbnail/enlarge on the Car tab.
4. Verify end-to-end outdoors (dark-garage limit acknowledged).

## Audited against the live code (2026-08-23 — verified, not guessed)
- **FR camera app** is real + CameraX-based (`fr_camera_app/app/build.gradle`: CameraX 1.3.4; README: MJPEG +
  Paho MQTT + NanoHTTPD) → "extend it, swap the MJPEG stream for on-demand snapshot" is accurate.
- **Upload endpoint** is real: `scripts/ingest_service.py:264` `@app.route('/api/media/upload', ['POST'])`,
  accepts `relativePath`/`targetPath` (→ a `Car Snapshots` folder), on the ingest service **`:8767`** (LXC 100).
- **Thin-publish template** `routes-carlocate.js` exists; the LXC-107 `rule_engine → write …/cmd` grant persists.
- **Build toolchain** present (`C:\android-dev\{sdk,jdk-17}`), FR app builds offline.
- ⚠ **Gap the audit caught (both sides of the MQTT cmd need ACL, not just one):** the plan named only the
  dashboard's *write* grant. The **phone camera app also needs an MQTT user with *read* on the cmd topic** to
  receive the snapshot command. Simplest: name the topic under an existing broadly-read tree (e.g.
  `mur/home/esp/car_camera/command`, which the `esp_boards` user already reads via `mur/home/esp/+/#`), or add a
  narrow read grant for the app's user. Decide the topic + subscriber user at build time.

## Explicitly NOT in this plan
❌ No new LXC · ❌ no continuous streaming/recording · ❌ not built. Real work = **a phone app** (the biggest
piece) + a thin publish endpoint + a bit of dashboard UI. Overlaps heavily with the FR-phone camera stack.
