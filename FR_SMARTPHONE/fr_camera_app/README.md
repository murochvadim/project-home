# FR Camera — Android app (LineageOS A71 entrance camera node)

The de-Googled A71's own app: **front-camera capture → MJPEG stream (for go2rtc) → the phone as a
status panel** ("Recognizing… / Welcome, &lt;name&gt; / Not allowed", driven by MQTT from the FR LXC).
Architecture A — the phone is ONLY the camera + status screen; recognition runs on LXC 112.
See [../CLAUDE.md](../CLAUDE.md) + [../FR_BACKEND_PLAN.md](../FR_BACKEND_PLAN.md).

## ✅ Offline build toolchain (installed on the laptop 2026-08-22 — works with NO internet)
Built + proven offline so it can be developed **in-flight**:
- **JDK 17** → `C:\android-dev\jdk-17.0.13+11` (set as `JAVA_HOME`)
- **Android SDK** → `C:\android-dev\sdk` (`platforms;android-35`, `build-tools;35.0.0`, `platform-tools`)
- **Gradle 8.7** (via the wrapper) + **every dependency cached** in `~/.gradle` (AGP 8.6, Kotlin 2.0,
  CameraX 1.3.4, Paho MQTT 1.2.5, NanoHTTPD 2.3.1, coroutines) — `gradlew --offline` verified green.
- `local.properties` (gitignored) points at the SDK: `sdk.dir=C:\\android-dev\\sdk`.

## Build (offline — the in-flight command)
```powershell
$env:JAVA_HOME = "C:\android-dev\jdk-17.0.13+11"
cd FR_SMARTPHONE\fr_camera_app
.\gradlew.bat assembleDebug --offline --console=plain
```

## Deploy to the phone
- **Over USB** (works offline, in-flight): plug in, USB-debugging authorized, then
  `C:\android-dev\sdk\platform-tools\adb.exe -s R58N92XXF3E install -r app\build\outputs\apk\debug\app-debug.apk`
- **Over WiFi** (at home): `adb connect 192.168.1.25:37825` then the same `install`.

Phone = LineageOS 23.2, `SM-A715F`, serial `R58N92XXF3E`, static IP `192.168.1.25`. App id `com.muroch.frcamera`.

## Status
**✅ Feature 1 DONE (2026-08-25) — front camera → MJPEG stream on `:8080`.** CAMERA permission → CameraX
front cam (`ImageAnalysis` RGBA frames) → each frame rotated upright → JPEG → served by `MjpegServer.kt`
(NanoHTTPD) at `http://<ip>:8080/` as `multipart/x-mixed-replace` + a local `PreviewView`. Verified live over
USB (`adb forward tcp:8080`): ~25 fps of real JPEG frames; live preview on the phone screen. **⚠ CameraX is
bound to the activity lifecycle, so frames only flow while the app is FOREGROUND** — a foreground Service /
keep-alive is a later hardening step (the activity has `keepScreenOn` + `stay_on_while_plugged_in`).
**✅ UI states DONE (2026-08-25)** — one screen, four states in `FaceFrameView.setState()`:
`IDLE` 🟢 (Hello Visitor + face-oval + swipe-up chevrons) · `ALLOWED` 🟢 ("Welcome, {name}!" / "Opening the
door…") · `DENIED` 🟠 ("Welcome, {name}" / "The owner will open the door for you.") · `UNKNOWN` 🔵 ("Please
wait…"). Sentences are settable fields on `FaceFrameView`. **Test trigger over USB** (LXC 112 drives the same
`setState` over MQTT later): `adb shell am broadcast -a com.muroch.frcamera.STATE --es state allowed --es name Vadim`
(states: `idle`|`allowed`|`denied`|`unknown`). Verified all four on-device.
**✅ Kiosk behaviour DONE (2026-08-25)** — **immersive fullscreen** (status + nav bars hidden) + **LXC-driven
wake/sleep**. ⚠ **The phone does NOT decide activity itself** (no idle timer, no tap-to-wake): the **LXC** owns
presence — it sends `state=black`/`sleep`/`off` (no presence) → the phone covers the screen with black (`#000000`
+ brightness ~0 → near-zero power on AMOLED), and any real state (`idle`/`allowed`/`denied`/`unknown`) → the phone
`wake()`s and shows it. **The camera + MJPEG stream keep running under the black cover** (the FR backend still gets
frames). Starts BLACK on launch. Verified over USB (mean brightness 76 lit → ~0 black → 76 woken).
**✅ Paho MQTT client DONE (2026-08-25)** — `MqttClient.kt` connects to the home broker (**LXC 107**,
`192.168.1.189:1883`, user **`esp_boards`** — reused, NO broker change), subscribes to **`mur/home/esp/fr_entrance/state`**,
and hands each message to the SAME `applyState()` the adb test broadcast uses. Payload: JSON
`{"state":"allowed","name":"Vadim"}` (or a plain `"black"`); auto-reconnect + re-subscribe. Broker creds in
**`Secrets.kt` (gitignored)** — copy `Secrets.kt.example`, paste `ESP_BOARDS_MQTT_PASS` from `BOILER/dashboard/.env`.
**Verified live** end-to-end (phone→broker over a `adb reverse` + TCP-proxy tunnel; published `allowed`/`black`/`denied`
→ the phone woke/slept/showed each). `MQTT_HOST` = `192.168.1.189` for the entrance (home WiFi); `127.0.0.1` + the
tunnel is only for USB testing. While the phone is away from home the connect fails + auto-retries (harmless).
**✅ Always-on / kiosk hardening DONE (2026-08-25)** — the phone becomes a tamper-proof, self-healing appliance:
- **Keep-alive foreground service** (`FrCameraService`) — Android won't kill a foreground service, so the app's
  process (camera + MJPEG + MQTT) **runs always**. Holds a **CPU wake lock + a high-perf WiFi lock**, posts an
  `IMPORTANCE_MIN` ongoing notification, `START_STICKY`. Verified live: `isForeground=true`, type `SPECIAL_USE`
  (`0x40000000`), locks held.
- **Auto-start on boot** (`BootReceiver`, `BOOT_COMPLETED` + `MY_PACKAGE_REPLACED`) — after a **power cut / reboot**
  the panel comes back **by itself** (starts the service → brings the kiosk to the front). Registered; not reboot-
  tested yet (phone remote).
- **Battery-optimization exemption** — app added to the Doze whitelist (`dumpsys deviceidle whitelist +pkg`), so
  Android never suspends it. `POST_NOTIFICATIONS` granted.
- **Kiosk lock (Lock Task Mode)** — code done + **dormant until provisioned** (verified: "not device-owner yet —
  kiosk inactive"). **To activate the tamper-proof kiosk (one-time, at home, over adb — de-Googled A71 has no
  accounts so it's allowed):** `adb shell dpm set-device-owner com.muroch.frcamera/.FrAdminReceiver`. Then the app
  auto-`startLockTask()`s on launch — pinned to the front, **no swipe-away / recents / home / other apps** (survives
  unauthorized touch). Undo: `adb shell dpm remove-active-admin com.muroch.frcamera/.FrAdminReceiver` or factory
  reset. `FrAdminReceiver` (DeviceAdminReceiver) + `res/xml/device_admin.xml` back it; installing is always safe
  (lock stays off until you run that command).
**✅ Face-enrollment screen DONE (2026-08-25)** — a learning-mode screen the dashboard's future **FR tab**
turns on (over MQTT), where a person enrols their face and watches the whole capture **on the phone**:
- **`enroll`** → the ready screen: blue oval + a **`Start FR`** button (no greeting — per request).
- **`Start FR` = the phone-side "I'm ready"** — tapping it **publishes `mur/home/esp/fr_entrance/enroll = ready`**
  (esp_boards user, no broker change) so **LXC 112** knows to begin; the button hides + shows "Center your face…".
- LXC 112 then drives the steps back over the state topic: **`enroll_guide`** ("Center your face in the frame")
  → **`enroll_trying`** ("Scanning…") → **`enroll_retry`** ("Trying again…") → **`enroll_done`** ("Recorded ✓" +
  `name`). **Name + permissions are set in the dashboard**, not on the phone.
- Verified live over USB (adb simulating LXC 112): all screens render; the `Start FR` tap published the ready
  signal + advanced to the guide step. Test any step: `adb shell am broadcast -a com.muroch.frcamera.STATE --es state enroll_done --es name Vadim`.
- **Also (2026-08-25):** the device-owner panel now **disables the lock screen** (`setKeyguardDisabled`) so it
  never shows a keyguard, and the kiosk **re-locks after an app update** (BootReceiver `MY_PACKAGE_REPLACED`).
- **Next:** **LXC 112** (the recogniser) to actually *publish* to the state topic — corridor-presence → `black`/`idle`,
  recognition → `allowed`/`denied`/`unknown` — plus a go2rtc `phone_entrance_cam` source. (⚠ a proper `fr` broker
  user + `mur/home/fr/#` topic can replace the reused `esp_boards`/esp-tree when LXC 112 is built — needs a
  broker-user add on LXC 107, i.e. explicit permission.)

**Scaffold (2026-08-22)** — builds + installs + launches (the base this was filled in on).
