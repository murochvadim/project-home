# RP02_PTZ_CAMERA — Raspberry Pi Zero 2 W → Kazir 15 PTZ camera relay + LPR

The **second Raspberry Pi Zero 2 W** (added 2026-08-10, hostname `rp02`), **renamed RP02 → RP02_PTZ_CAMERA on
2026-08-24** and **dedicated** to the **Kazir 15 building PTZ camera**. Its job: relay the UNV PTZ camera at
KZ15 (`192.168.1.99`) into the project **without any Chinese cloud** (go2rtc + NetBird), and feed a
**license-plate log of cars entering/leaving the building** into the project DB + a dashboard.

> **The physical node identity stays `rp02`** — `svc-rp02` health cell, `dashboard_settings.health.node_monitoring.rp02`,
> `backup_jobs` id 11, hostname `rp02`, user `rp02_project`, IPs `.232`/`.233`. Only the **module folder + role**
> changed (RP02/ → RP02_PTZ_CAMERA/). The dashboard/orchestrator/backup code all still key on `rp02`.

## ⚠ Compute reality — Pi Zero 2 W = FORWARDER ONLY (this drives the whole architecture)
A **Pi Zero 2 W (512 MB, 4×A53)** **cannot** run real-time video ANPR. So RP02's role is strictly:
- **go2rtc** — pull the camera's RTSP locally, re-serve as MJPEG/WebRTC (relay). ✅ fine on a Zero 2 W.
- **NetBird peer** — its own `100.x` address → remote viewing without touching the colliding `192.168.1.0/24`,
  and **no vendor cloud**. ✅ fine.
- **Forward plate EVENTS** — receive plate text from **the camera's on-device ANPR** and push to the project. ✅ fine.

**Plate RECOGNITION itself must therefore run EITHER on the camera (on-device ANPR) OR on a home LXC** — NOT on
RP02. This is the fork the plan below hinges on (Phase 0).

---

## Identity / access  *(unchanged — still the `rp02` node)*
- **hostname `rp02`**, user **`rp02_project`**.
- **Ethernet `192.168.1.232` (primary / management path)** (`eth0`; MAC `50:91:e3:c4:7c:68`) via a **Waveshare
  ETH/USB HUB HAT** — plus **WiFi `192.168.1.233`** (`wlan0`, ON; both coexist via the ARP-flux fix below).
  ⚠ **reserve `.232`** in the router DHCP.
- **Key-managed**: the laptop's `~/.ssh/id_ed25519` **and** LXC-104's `root@Servers` key are in
  `authorized_keys`. Reach it: `ssh -i ~/.ssh/id_ed25519 rp02_project@192.168.1.232` (or via LXC 104).

## WiFi + Ethernet both active — ARP-flux fix
Dual-homed `eth0 .232` **and** `wlan0 .233` on the same `192.168.1.0/24`. Persisted ARP guard so both coexist:
`/etc/sysctl.d/99-arp-flux.conf` = `net.ipv4.conf.all.arp_ignore=1` + `arp_announce=2`. **Ethernet `.232` is the
management path** (`svc-rp02` probes it). Wired-only later: `sudo nmcli radio wifi off` (ARP guard keeps it clean).

## Hardware — the ETH/USB HUB HAT
Waveshare **ETH/USB HUB HAT** on the 40-pin header + a USB bridge. ⚠ **Only the Ethernet (RTL8153) enumerates
today** — the HAT's **3 USB-A hub ports don't show in `lsusb` yet** (likely need the HAT's `PWRACT` power input or
a USB jumper — check the Waveshare wiki). Not blocking for the PTZ camera (the camera is a **network** device over
Ethernet/RTSP, not USB), but needed if a local USB mic/webcam is ever added.

## Project Health integration (2026-08-10) — full RP01 treatment  *(unchanged)*
- **`svc-rp02` cell** — TCP:22 probe to `.232` (`server.js runHealthChecks` → `r.rp02`).
- **Monitor checkbox** (`mon-rp02` → `toggleRp02Monitor`, `dashboard_settings.health.node_monitoring.rp02`).
- **Live CPU temperature** — `rp02TempRead` (idle ~47 °C).
- **Sidebar badge** — counted (`r.rp02?.ok`); paused → auto-drops.
- **Backup** — `backup_jobs` **id 11** (`rp02_project@192.168.1.232:/home/rp02_project` → QNAP
  `Claude_Data/RaspberryPi_RP02/`, retention 4, daily). ⚠ widen when camera config/recordings arrive.

---

## PLAN — Kazir 15 building car monitor (license-plate capture → project DB)  *(scoped 2026-08-24, not built)*

**Goal:** the UNV PTZ camera at KZ15 (`192.168.1.99`, MAC `6c:f1:7e:21:88:f3`, named **"Uniview Cam .99"** in
`kazir15_names`) reads plates of cars in/out of the building. Capture **plate + direction (in/out) + time +
image**, relay safely (no Chinese cloud), store in the project DB, monitor on a dashboard.

**Why RP02:** it's on the LAN, idle+cool, a NetBird peer, and the relay job fits a Zero 2 W. KZ15's camera net is
a separate physical `192.168.1.0/24` (same subnet as home → not directly routable remotely); RP02 relays the
**stream/events**, sidestepping the subnet collision (you reach *the Pi*, not `.99`). Same go2rtc pattern as the
**Robot** (`ROBOT_TONYBOT`) and **Balcony** cameras. ⚠ RP02 must sit **on the KZ15 network** to reach `.99`
(wired to the KZ15 switch or KZ15 WiFi) — today it's on the home LAN.

### Phase 0 — the question that decides the architecture (VERIFY, don't guess)
**Does this UNV camera do ANPR/LPR on-device?** (Many UNV models: Smart → "License Plate Recognition".)
- **YES → camera recognizes plates** → it pushes plate *text* + direction (ONVIF metadata / HTTP push). RP02 only
  **forwards events** → the Pi Zero is enough, fully local. ✅ cheapest + cleanest.
- **NO → we must run LPR on the video** → needs real compute → move recognition to a **home LXC** (pull the
  stream over NetBird) since RP02 can't. Bigger build + continuous ~2-4 Mbps stream home.

**Phase-0 tasks (from a device ON the KZ15 network):** (1) camera **model number** + whether **LPR** exists in
its menu; (2) is the shot **aimed at the entrance lane**, covering **both directions**?; (3) the **RTSP URL**
(UNV usually `rtsp://admin:Admin123%40@192.168.1.99:554/media/video1` — `@` in the pw MUST be `%40`).

### Phase 1 — RP02 relay (go2rtc + NetBird), placed on the KZ15 network
- Move/attach RP02 to the KZ15 LAN so it can reach `192.168.1.99`.
- **go2rtc** (`/opt/go2rtc/`, systemd) pulls the camera RTSP → serves MJPEG/WebRTC locally.
- Confirm RP02's **NetBird peer** is up (its `100.x`), so the stream is reachable remotely without the subnet clash.

### Phase 2 — License-plate recognition (respects the **no-Chinese-services** rule)
- **Best:** camera's **on-device ANPR** (local, no cloud) → ingest plate text.
- **If we run it:** self-hosted open engine on a **home LXC** — **CodeProject.AI + LPR**, **Frigate + LPR**, or
  **openalpr** (all local Docker, no Chinese cloud), tuned for **Israeli plate format**. (No Chinese ANPR cloud/SDK.)
- Trigger on **motion / line-crossing** so we OCR only when a car passes.

### Phase 3 — Direction (in/out) + data model
- **Direction:** camera ANPR direction field (if built-in), OR a line-crossing rule w/ direction, OR motion-vector
  tracking. Decided by the camera's actual view (Phase 0).
- **DB (LXC 102):** `kz15_car_events` — `id, plate_text, direction ('in'|'out'|'unknown'), confidence,
  captured_at, image_path, raw jsonb`. Plate + full-frame **images on QNAP** (like journal media). Retention TBD.
- Optional **`kz15_known_plates`** (residents) → flag resident vs stranger.

### Phase 4 — Dashboard
A **"Cars / Plates"** tab on the **Kazir 15** page: live event log (plate · time · in/out · thumbnail), search
by plate, in/out counts per day, currently-inside estimate, optional watchlist/alerts. Thin
`routes-kazir15cam.js` (relay/proxy + events endpoint); RP02 pushes events over NetBird/MQTT (reusing the
`kazir_15` transport).

### Phase 5 — Refinement
Recognition accuracy, direction logic, PTZ presets aimed at the lane, night/IR handling.

### Honest caveats
- **Zero 2 W can't do video ANPR** — the whole thing depends on the camera's on-device ANPR; else recognition
  moves to a home LXC.
- **Accuracy** depends on angle/speed/lighting/IR — a PTZ cam not purpose-aimed at the lane may read poorly.
- **Privacy/legal** — logging every plate entering your building; be deliberate about retention + access.

### What's needed to start (Phase 0), from a phone on the KZ15 network
1. Camera **model** + whether **License Plate Recognition** is in its menu.
2. Is the shot **aimed at the entrance lane** + covers **both directions**?
3. The **RTSP URL**.
4. Physically place **RP02 on the KZ15 network**.

## References
- Building-network monitor + the camera's presence row: [../KAZIR_15_NETWORK/CLAUDE.md](../KAZIR_15_NETWORK/CLAUDE.md)
- go2rtc relay pattern siblings: [../ROBOT_TONYBOT/CLAUDE.md](../ROBOT_TONYBOT/CLAUDE.md) · [../BALCONY/CLAUDE.md](../BALCONY/CLAUDE.md)
- Sibling / DNS node: [../RP01/CLAUDE.md](../RP01/CLAUDE.md) · infra node [../RP03/CLAUDE.md](../RP03/CLAUDE.md)
- Memory: [[project_agent_raspberry_pi]]
