# ROBOT_TONYBOT — Hiwonder servo robot with overhead-camera localization

**Goal:** a **Tonybot Hiwonder** humanoid (Hiwonder board = a *dumb servo controller*, driven over **RS-232/TTL
serial**) that moves **point-to-point inside the Living Room**. Localization is done by an **overhead ceiling
camera** that tracks the robot's position and steers it to waypoints — the robot itself carries only a small
compute board (the heavy vision runs stationary, on this subsystem's LXC). Started 2026-08-09.

## ⭐ Dedicated LXC — **LXC 111 "robot"** (`192.168.1.249`)
All robot processes live here (one-subsystem-per-LXC, like every other agent). **Decision was investigated, not
guessed** (`root@192.168.1.101`): host = Ryzen 9 8945HS, 16 threads, 61 GB RAM, ~2% load; all 10 existing LXCs
use ~2.25 GB RAM total; GPU (Radeon 780M `/dev/dri/renderD128`) unused. A dedicated LXC wins on **crash isolation**
(a DIY vision loop crashing must not touch the media LXC's TV/casting), **clean GPU access** (bind-mount `/dev/dri`
for VAAPI decode later — a VM couldn't without stealing it), avoiding a **later migration**, and architecture fit.
- **Provisioned:** Debian 12, unprivileged, **2 cores / 4 GB / 512 MB swap / 16 GB rootfs (local-zfs)**,
  `nesting=1`, `onboot=1`, bridge `vmbr0`, gw `192.168.1.1`. Hostname `robot`.
- **IP `192.168.1.249` (static in the LXC net0).** ⚠ The whole `192.168.1.0/24` is DHCP-saturated and IoT devices
  don't answer ping, so ".249" was verified free via **ARP-scan + net_devices + kernel neigh** (not ping alone).
  **The user is adding a router DHCP reservation for it** (same as the camera `.10` and RP01 `.217`).
- **SSH:** the laptop's `~/.ssh/id_ed25519` (**claude-code**) is authorized → `ssh root@192.168.1.249`.
- **Not yet on Project Health** — a TCP:22 probe + badge cell (like RP01) is an easy follow-up.

## Camera — e-con Systems **RouteCAM** (ONVIF IP camera, `192.168.1.10`)
GigE/PoE industrial cam running as a standard **ONVIF** camera. **DHCP-reserved at `.10`.** Anonymous (no login).
- **RTSP source:** `rtsp://192.168.1.10:5005/routecam` (RTSP on **:5005**, ONVIF SOAP on **:8000**).
- **⚠ Actual codec = HEVC (H.265) 1080p @ 60 fps** — verified by `ffprobe` on the live stream. Its **ONVIF
  GetProfiles misreports `H264 / 30fps`** — do not trust the ONVIF metadata; the wire is H.265/60.
- **PoE:** the Aruba **JL806A switch is NOT PoE** → the camera needs a **PoE injector** at the ceiling (hardware).
- **Lens FOV UNVERIFIED:** whether the M12 lens covers the full **9.5 × 6 m** Living Room (ceiling 2.9 m) or needs
  a wide/fisheye swap. Check by *looking at the Robot-tab card* once it's ceiling-mounted.

## go2rtc relay (the processing-ready hub) — **BUILT 2026-08-09**
Browsers can't play RTSP, and hitting the camera's RTSP from every consumer risks its session cap. So
**`go2rtc`** (single Go binary, v1.9.14) on LXC 111 pulls the camera **once** and fans it out. Repo source:
`ROBOT_TONYBOT/go2rtc.yaml` + `go2rtc.service`; binary `/opt/go2rtc/go2rtc` (NOT repo-tracked). Uses the LXC's
**ffmpeg** (5.1.9) to transcode H.265→MJPEG (required — not passthrough).
- **RTSP republish** `rtsp://192.168.1.249:8554/routecam` → the **vision/processing** pipeline reads this
  (`cv2.VideoCapture(...)`), one camera pull, no re-encode. *(Verified with ffprobe: hevc 1920×1080.)*
- **MJPEG** `http://192.168.1.249:1984/api/stream.mjpeg?src=routecam` + single frame `…/api/frame.jpeg?src=routecam`
  → the dashboard card. ⚠ **Continuous MJPEG from H.265 needs an explicit transcode branch** in `go2rtc.yaml`
  (`- ffmpeg:routecam#video=mjpeg` as a 2nd source of `routecam`) — without it `stream.mjpeg` returns 200 then errors
  `codecs not matched: H265 => JPEG` (single `frame.jpeg` works without it, which masked the bug). The branch is
  lazy: it only spins up for MJPEG consumers; RTSP consumers still get native H.265.
- **Deploy/update:** edit the repo `go2rtc.yaml`, `scp` to `/opt/go2rtc/`, `systemctl restart go2rtc`.
  Service: `systemctl {status,restart} go2rtc`; streams API `curl http://192.168.1.249:1984/api/streams`.

## Dashboard — **Living Room → "Robot" tab** (BUILT 2026-08-09)
A **Robot** tab on `living-room.html` (after IRobot), a **two-card row** (`align-items:stretch` → equal height):
- **Camera card** (compact): a live **`<img>` MJPEG** feed from the go2rtc relay. `js/living-room.js` `showTab`
  gained a `robot` branch + `startRobotCam()`/`stopRobotCam()` — the `<img>.src` is set only while the tab is open
  (leaving drops the MJPEG session so the camera isn't pulled needlessly); connecting/online/offline on a status
  dot; **onerror retries ~4× 1.5 s** (the H.265→MJPEG transcode takes ~1-2 s to spin up) before showing offline.
- **Camera Settings card** (live, ONVIF imaging): data-driven **sliders** (Brightness/Contrast/Saturation/Sharpness,
  0-255) + **dropdowns** (WDR OFF/ON, Exposure AUTO/MANUAL, White-balance AUTO/MANUAL). Loaded on tab open, each
  change **applies to the camera in real time**. Because the MJPEG feed buffers, a change **reconnects the stream
  700 ms later** so the effect shows immediately.
- Backend **`routes-robotcam.js`** (own module, one `require()` past the architecture hook, like `routes-cast.js`):
  `GET /api/robotcam/settings` (values + ranges) + `POST` (schema-ordered `SetImagingSettings`), a thin ONVIF proxy
  to `192.168.1.10:8000/onvif/imaging_service`. ⚠ **The camera's ONVIF ENCODER config is broken** (misreports
  H264/30 vs the real H265/60, empty `GetVideoEncoderConfigurations`) — so resolution/codec/fps are NOT settable
  here; only the **imaging** service works (read+write, **anonymous**, verified). Cache-bust `living-room.js` → `v=65`.

## Architecture (overhead-camera localization — the chosen approach)
- **Ceiling camera + a small ArUco/AprilTag marker on the robot's head** → a stationary service on LXC 111 computes
  the robot's **X/Y/heading**, then steers it to waypoints, correcting every frame (a legged biped drifts, so the
  loop MUST close on vision — no dead-reckoning). **Floor/wall tags NOT needed** — a one-time checkerboard (or
  clicking the room corners once) calibrates pixels→metres; only a small marker on the robot is permanent (or go
  fully marker-less: detect the robot by shape/colour + shoulder dots for heading).
- Robot side: a small board (Pi-class) relays waypoint/steer commands (WiFi/MQTT) to the **Hiwonder servo board
  over RS-232/TTL** — ⚠ confirm the board's serial level (true ±12V RS-232 needs a MAX3232 / USB-RS232 adapter;
  many "RS-232"-labelled Hiwonder boards are actually 3.3/5V TTL = direct).

## Phases
1. ✅ **Stream relay + viewing card** (this) — camera is live + processing-ready.
2. **Localization service** (LXC 111): OpenCV reads `rtsp://192.168.1.249:8554/routecam`, ArUco pose → robot X/Y/θ.
   (VAAPI HEVC decode via a `/dev/dri` bind-mount if CPU decode is too heavy.)
3. **Navigation/waypoint engine** + command dispatch to the robot.
4. **Robot-side serial control** to the Hiwonder board.

See [[project_agent_tonybot_robot]].
