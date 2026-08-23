# Car Cam — on-demand forward-camera snapshot app (LineageOS car tracker phone)

The car phone's snapshot app (`com.muroch.carcam`). A foreground service holds an MQTT connection and, on
command, captures **one** JPEG and uploads it — **camera OFF between shots** (low power for a parked car).

## Flow (BUILT + working 2026-08-23)
`Dashboard 📷 Snapshot` → `POST /api/car/snapshot` (server.js `routes-car-snapshot.js`) → publishes
**`mur/home/esp/car_camera/command {"action":"snapshot"}`** → the phone's `CarCamService`:
1. captures 1 JPEG via **CameraX** (`ImageCapture`, rear/"forward" camera, no preview),
2. **releases the camera** (off),
3. uploads it to the **media agent** `POST http://192.168.1.138:8767/api/media/upload`
   (`file` + `relativePath=latest.jpg` + `targetPath=Car Snapshots`) → `/mnt/media/Car Snapshots/latest.jpg`,
4. publishes an ack on `mur/home/esp/car_camera/status`.
The dashboard shows it from the media agent at `:8766/api/media/stream/Car Snapshots/latest.jpg`.

**MQTT:** user **`esp_boards`** (already reads `mur/home/esp/+/#`); the dashboard's `rule_engine` already writes
it — **no new broker user or ACL grant.** Broker `192.168.1.189:1883`.

## Build + install (offline toolchain at `C:\android-dev`)
```powershell
$env:JAVA_HOME="C:\android-dev\jdk-17.0.13+11"
cd CAR_SMARTPHONE\car_cam_app
.\gradlew.bat assembleDebug
# install over wireless adb (phone at 192.168.1.234:5555):
C:\android-dev\sdk\platform-tools\adb.exe -s 192.168.1.234:5555 install -r app\build\outputs\apk\debug\app-debug.apk
```
⚠ **`Secrets.kt` is gitignored** (holds the `esp_boards` MQTT password). To build elsewhere: copy
`Secrets.kt.example` → `Secrets.kt` and paste `ESP_BOARDS_MQTT_PASS` from `BOILER/dashboard/.env`.

## Test without the dashboard
```
mosquitto_pub -h 192.168.1.189 -u esp_boards -P '<pass>' -t mur/home/esp/car_camera/command -m '{"action":"snapshot"}'
```
then `ls /mnt/media/Car Snapshots/latest.jpg` on LXC 100, and watch `adb logcat -s CarCam`.

## Known follow-ups
- **Keep-alive:** the service must stay alive + auto-start (BootReceiver added) — needs a battery-optimization
  exemption on the phone for a permanent car device.
- **Camera choice:** currently `DEFAULT_BACK_CAMERA` (rear = "forward" when the screen faces the driver) — make
  configurable if the mount differs.
- **Underground garage = dark image** (inherent); **needs the phone online** (WiFi/NetBird/data SIM).
- History: currently overwrites `latest.jpg`; a timestamped 2nd upload could keep history.

Built on the FR camera app's Gradle scaffold (`FR_SMARTPHONE/fr_camera_app`) — same offline toolchain.
