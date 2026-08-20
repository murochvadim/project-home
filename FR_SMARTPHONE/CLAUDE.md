# FR_SMARTPHONE — Galaxy A71 → de-Googled LineageOS face-recognition camera node

> Renamed from CUSTOM_SMARTPHONE (2026-08-20). Purpose: a de-Googled Galaxy A71 as an
> **entrance face-recognition CAMERA**; the recognition itself runs on an **LXC**, not the phone.

**Status: PLANNED — starting the flash tomorrow.** Repurpose an old Samsung Galaxy A71
into a **Google-free Android device** running LineageOS, to use as a full sensor/camera/
touch **edge node** in the home-automation project (wall panel, IP camera, sensor→MQTT,
Termux scripts, etc.).

## The device (verified)
- **Model: `SM-A715F`** — global Galaxy A71 4G (Snapdragon 730), codename **`a71`**.
- Currently on **Android 13 / One UI 5.1** = the **latest stock firmware** → the correct
  base for LineageOS 21 (no stock update needed first).
- 6.7″ Super AMOLED, **NFC**, Bluetooth 5.0, USB-C, quad camera — good panel/sensor hardware.

## Why this model is a GO (checked 2026-08-19)
- **Bootloader unlockable** — the global `SM-A715F` allows OEM unlock (only US/carrier
  variants like `A716U` are permanently locked → those would be impossible).
- **Official LineageOS 21 (Android 14)** exists for `a71` — full official wiki + signed
  builds (not a sketchy abandoned ROM). `/e/OS` (de-Googled) also exists as a fallback.
- **Recommended ROM:** LineageOS 21 **without Google apps** = current, official, and
  effectively de-Googled — ideal for a local-only utility device.

## Tools
- **`adb` / `fastboot`** — ✅ already installed on the laptop (winget `Google.PlatformTools`).
- **Odin** (Windows GUI, Samsung flashing) + **Samsung USB driver** — to flash the recovery
  (download when we start). Heimdall (CLI) is an alternative but needs a Zadig driver swap.
- **LineageOS build + recovery** for `a71` — from the official source below.

## Trusted download sources
- Install guide: https://wiki.lineageos.org/devices/a71/install/
- Official builds + recovery: https://download.lineageos.org/devices/a71
- Device info / known issues (check before flashing): https://wiki.lineageos.org/devices/a71/

## ⚠️ Before starting (do these first)
1. **Back up everything on the phone** — flashing **erases it completely** (photos, apps, messages).
2. On the phone: Settings → About → tap **Build number** 7× → **Developer options** → turn ON:
   - **OEM unlocking**  ← if greyed out, we are BLOCKED (can't continue)
   - **USB debugging**

## Flash procedure (the actual steps)
| # | Step | Who |
|---|------|-----|
| 1 | **Unlock bootloader:** power off → hold **Vol-Up + Vol-Down + plug USB** (Download Mode) → hold **Vol-Up** to confirm → **phone WIPES + Knox trips permanently** | you (buttons) |
| 2 | Phone reboots; do a minimal setup, skip Google | you |
| 3 | Re-enable **OEM unlocking + USB debugging** (the wipe reset them) | you |
| 4 | **Flash LineageOS recovery** with **Odin**: Download Mode → load `recovery.img` in the **AP** slot → Start | you click Odin, Claude guides each click |
| 5 | Immediately boot recovery: hold **Vol-Up + Power** on the reboot | you (buttons) |
| 6 | LineageOS recovery → **Factory reset → Format data** | you (volume keys) |
| 7 | Recovery → Apply update → **from ADB** → Claude runs **`adb sideload lineage-21…-a71.zip`** | Claude (laptop) |
| 8 | Reboot → first boot into clean LineageOS, set up de-Googled | you + Claude guiding |

**Who does what:** Claude runs all the laptop/CLI parts (downloads, `adb sideload`, guidance);
YOU do the physical buttons and the **Odin** clicks (step 4 — the one part Claude can't click).

## Know before you go
- **Erases the whole phone** — back up first.
- **Knox trips permanently** — Samsung Pay / Secure Folder die forever (fine for a utility device).
- Every boot afterward shows a small "bootloader unlocked" warning (cosmetic).

## What you get afterward (the payoff)
A full **Google-free Android** with **all hardware working** (camera, mic, GPS, NFC, BT/WiFi,
light/proximity/accelerometer/gyro sensors), that you can put **any software** on:
- Any **APK** via **F-Droid** / direct file (no Play Store) · `adb install` from the laptop
- **Termux** = a real Linux terminal → run **Python/Node, an MQTT client, cron jobs** on-device
- Kiosk browser, IP-camera app, sensor→MQTT app, automation apps

### Planned project uses for the node
- **Wall panel** → kiosk browser on the Balcony Smart-Tablet PWA
- **IP camera** → feed into the go2rtc stack (entrance/room)
- **Sensor→MQTT** → light sensor drives lighting rules; motion/battery to MQTT
- **Termux bridge** → a small local Python script (e.g. a BLE health-sensor gateway)

> Note: Android doesn't auto-publish sensors — you install a small app / Termux script that
> reads a sensor and sends it to MQTT. Easy, but it's a step.

## Primary use-case: entrance face-recognition → door unlock
Replace / augment the current Hi-Link TX-510 FR module (`face_01`) with the phone as the
entrance camera.

**Round-trip (face → door):**
1. Face appears → the phone **shows "Recognizing…"** on its own screen locally (instant feedback, the
   moment it detects *a* face — no wait for the LXC).
2. Phone sends the frame/stream **over Ethernet → the LXC** (go2rtc / RTSP).
3. LXC face-recognition **matches the face against the faces DB** → gets the **name** + the
   **allowed-to-enter** flag.
4. LXC **replies to the phone** (MQTT) → the screen updates to **"Welcome, &lt;name&gt;"** (allowed) or
   **"Not allowed"** (denied).
5. If allowed → the LXC also fires `face_identified {name}` → the existing corridor / RemoteXY
   **door-unlock chain opens the door** (same path the TX-510 uses today).

So the phone is **both the camera AND a small status screen** — it reacts to the LXC's MQTT replies.

- **Architecture — DECIDED = A (2026-08-20):** the phone is **ONLY the camera** (IP-cam app → RTSP →
  go2rtc); **face recognition runs on an LXC** (CPU-only is plenty for periodic entrance FR — the
  Proxmox host also has spare CPU + an unused GPU if ever needed) → publishes `face_identified` → MQTT.
  Chosen over on-device (B) for accuracy, central enrollment/DB, reliability, and reuse of the existing
  go2rtc/MQTT/door stack. (Alt B = fully on-device FR, frames never leave the phone — rejected: A71 is
  mid-range and it doesn't reuse the stack.)
- ⚠️ **Engine must be non-Chinese** ([[feedback_no_chinese_tools]]): use `dlib`/`face_recognition`
  (US) or **CompreFace** (Exadel) — **NOT InsightFace / ArcFace** (Chinese-origin).
- **Which camera:** **FRONT (32 MP)** if mounted as a door face-panel (person faces the screen,
  like the TX-510 now); **REAR (64 MP + 123° ultra-wide)** if hidden in a corner watching a wider
  area. → decide by mounting.
- **Network:** WiFi + a **DHCP reservation** (fixed IP so the project always finds it), OR wired via
  a **USB-C hub with Ethernet + PD charging passthrough** (most reliable for an always-on node).
  Always **LAN-only — never cloud**.
- **Better than the TX-510?** Yes as a *recognizer* (camera, compute, modern models, easy photo
  enrollment, more faces). **But two caveats for a LOCK:** (1) a plain 2D phone cam has **no
  liveness** → a printed photo can fool it → add a liveness check or pair with a 2nd factor
  (e.g. only unlock while you're also detected home); (2) needs **plugged-in + app-kept-alive**
  reliability vs the appliance-like module.

- **Faces DB (you manage):** a small table `face → name → allowed(yes/no)` + a **management screen** to
  capture a face and **give it a name**, flip the **"allowed to enter"** toggle per person, and (later)
  see a **recognition log** (who was recognized, when, allowed/denied). The FR engine (CompreFace) holds
  the face embeddings; the **name + allowed flag + log live in our own DB**.

**Components to build:**
1. **LXC FR service** — pulls frames from go2rtc, recognizes, checks the faces DB, replies to the phone
   (MQTT) + fires `face_identified` for the door chain when allowed.
2. **Faces table + management UI** — add/name a face, per-person allowed toggle, recognition log.
3. **Phone panel app** — camera stream + shows **Recognizing / Welcome / Denied**, driven by the LXC's
   MQTT replies.

**Open decisions:** which LXC hosts the FR service · front-vs-rear camera · liveness / anti-spoof
approach for the lock · retire the TX-510 or run both.
