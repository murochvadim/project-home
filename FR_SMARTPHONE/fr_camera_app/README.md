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
**Scaffold (2026-08-22)** — builds + installs + launches. The feature code is filled in next
(in-flight): request CAMERA permission → CameraX front-cam preview → NanoHTTPD MJPEG server on `:8080`
(go2rtc pulls `phone_entrance_cam`) → Paho MQTT client → status UI reacts to the FR result.
