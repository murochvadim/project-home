# XIAO Vision AI Camera — Streaming Module

Dashboard-less agent (no LXC service yet). Tracks the XIAO Vision AI Camera bundle and its integration with the home automation project.

## Hardware

| Part | Chip | Role |
|---|---|---|
| Grove Vision AI V2 | Himax WiseEye2 (Cortex-M55 + Ethos-U55 NPU) | Camera + on-device AI inference. OV5647 sensor is wired to **this** board. |
| XIAO ESP32-C3 | ESP32-C3 (RISC-V) | WiFi/BLE host. Talks to Grove module over **I2C** (default `0x62`). |
| OV5647 | Sony image sensor | Connected to Grove module via ribbon cable. |
| 3D enclosure | — | Holds all three. Both boards' USB-C ports are externally accessible. |

## USB enumeration — IMPORTANT

| USB-C port on... | Enumerates as | What it talks to |
|---|---|---|
| **Grove Vision AI V2 board** | `USB-Enhanced-SERIAL CH343` (VID `1A86` PID `55D3`) | Himax chip (for SenseCraft AI flashing/preview) |
| **XIAO ESP32-C3 board** | C3 native USB-CDC (VID `303A`) — typical | C3 chip (for Arduino IDE uploads) |

Earlier mistakes (logged in [memory](../../.claude/projects/c--Users-muroc-project-home/memory/project_xiao_vision_ai_camera.md)):
- We initially assumed CH343 was on the C3 (it's not — it's on the Grove module). Tried flashing ESP32 firmware via CH343 and got "Invalid head of packet (0x06 / 0x1F)" because we were sending Espressif boot-sync packets to a Himax chip.
- ESP32-C3 **cannot** use `esp_camera.h` — no LCD_CAM peripheral on C3. The Arduino `CameraWebServer` example doesn't compile for C3. Don't try.

## Three usage paths

### Path 1 — USB-direct via SenseCraft AI (no code)
- Plug **Grove module's USB-C** into laptop only.
- Open https://sensecraft.seeed.cc/ai/#/model in **Chrome/Edge** (Firefox lacks WebSerial).
- Connect → COM port (CH343).
- Models auto-load; click **Preview Invoke** on the right side → live OV5647 video + detection boxes.
- Used 2026-05-21 for first-light validation. Works.

### Path 2 — WiFi MJPEG stream (current focus)
- Sketch: `C:\Users\muroc\Arduino_Projects\XIAO_VisionAI_Stream\XIAO_VisionAI_Stream.ino`
- C3 calls `AI.invoke(1, false, true)` over I2C, decodes base64 JPEG from `AI.last_image()`, serves over HTTP as `multipart/x-mixed-replace`.
- Endpoints: `GET /` (HTML viewer with `<img src=/stream>`), `GET /stream` (MJPEG).
- Expected throughput: ≈ 5 fps QVGA (I2C bandwidth is the ceiling, not C3 CPU).
- Library: `Seeed Arduino SSCMA` v1.0.3 (auto-installs ArduinoJson v7.4.3). Installed via arduino-cli on 2026-05-21.
- Board settings: `XIAO_ESP32C3` + USB CDC On Boot = Enabled.
- Upload via: the **C3's USB-C port** (NOT the Grove module's CH343).

### Path 3 — WiFi + MQTT detection events (planned, when user is home)
- Same sketch base, adds: read `AI.boxes()` + `AI.classes()` after each invoke, publish as JSON to `mur/home/esp/visionai/event` on LXC 107 broker (`192.168.1.189`).
- Fits the existing rule engine pattern — see [project ESP rule integration](../../.claude/projects/c--Users-muroc-project-head/memory/project_esp_rule_integration.md).
- Needs:
  - LXC 107 `mosquitto` user/password for a new client (provision `visionai_camera` MQTT user, scope to `mur/home/esp/visionai/#`)
  - Register a row in `esp_boards` so the dashboard's Project Boards page picks it up
  - Optionally a `devices` row + `dps_labels` (e.g. `last_class`, `last_confidence`) so rules can `@VisionAI`-chip it

## Current status (2026-05-21)

- **Path 1**: ✅ Verified live preview in SenseCraft AI via Grove module's USB.
- **Path 2**: 🟡 Sketch deployed, WiFi + HTTP server confirmed working (`HTTP server started on port 80`, `IP: 10.93.2.58`). But `/stream` returns no frames — `AI.invoke()` returns `rc=3` (timeout). The I2C link works (`AI.begin()` succeeds at boot) but inference never completes.
- **Path 3**: ⏳ Not started.

User is currently OFF the project network (IP `10.93.2.58` is some external WiFi, not the home `192.168.1.0/24`), so any MQTT or LXC-side work has to wait.

## Next steps when back home (2026-05-22+)

1. **Resolve the `invoke rc=3` (timeout)** for Path 2:
   - First, power-cycle the Grove module: unplug the Grove cable between C3 and AI V2, wait 3 s, re-plug. Refresh `/stream`, watch Serial Monitor.
   - If still timeout, re-deploy a model via SenseCraft AI (Face Detection or Person Detection is a known-good baseline). Use the Grove module's USB-C; force re-deploy even if SenseCraft says the model is current.
   - If still timeout, suspect the SSCMA library's default I2C timeout — there may be a `setTimeout()` or longer-timeout overload of `invoke()`. Check Seeed_Arduino_SSCMA source.
2. **Confirm Path 2 end-to-end**: load `http://<c3-ip>/` on phone or laptop, see live MJPEG.
3. **Add Path 3 (MQTT)**:
   - On LXC 107: `mosquitto_passwd -b /etc/mosquitto/passwd visionai_camera <pass>`, add ACL line `topic readwrite mur/home/esp/visionai/#`, reload.
   - In sketch: include `PubSubClient.h`, connect to broker, publish JSON with `boxes` + `classes` after each invoke.
   - Optionally project status to `devices.last_state` like the existing ESP integrations.
4. **Project Boards integration**:
   - Add `esp_boards` row with `id='visionai'`, declare schema with `actions` (none needed initially — pure publisher) + `parameters` (e.g. `inference_interval_sec`).
   - Or simpler: just a `devices` row with `protocol='esp'`, `dps_labels` for the inference output fields.

## File locations

| What | Where |
|---|---|
| Sketch | `C:\Users\muroc\Arduino_Projects\XIAO_VisionAI_Stream\XIAO_VisionAI_Stream.ino` |
| This doc | `c:\Users\muroc\project_home\XIAO_STREAMING\CLAUDE.md` |
| Library install (auto) | `C:\Users\muroc\Documents\Arduino\libraries\Seeed_Arduino_SSCMA\` |
| Memory entry (hardware details) | `.claude/projects/c--Users-muroc-project-home/memory/project_xiao_vision_ai_camera.md` |

## References

- [Seeed product page](https://www.seeedstudio.com/XIAO-Vision-AI-Camera-p-6450.html)
- [Grove Vision AI V2 wiki](https://wiki.seeedstudio.com/grove_vision_ai_v2a/)
- [SSCMA library examples](https://wiki.seeedstudio.com/grove_vision_ai_v2_demo/)
- [Intelligent IP Camera tutorial (S3 only — does NOT apply to this C3 bundle)](https://wiki.seeedstudio.com/grove_vision_ai_v2_webcamera/)
