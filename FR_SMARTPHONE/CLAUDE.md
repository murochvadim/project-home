# FR_SMARTPHONE — Galaxy A71 → de-Googled LineageOS face-recognition camera node

> Renamed from CUSTOM_SMARTPHONE (2026-08-20). Purpose: a de-Googled Galaxy A71 as an
> **entrance face-recognition CAMERA**; the recognition itself runs on an **LXC**, not the phone.

**Status: ✅ LineageOS 23.2 (20260805) INSTALLED + RUNNING on the A71 (2026-08-22).** Booted to setup,
online on WiFi at **static IP `192.168.1.25`** (the LAN `192.168.1.0/24` DHCP pool is saturated, so the phone
kept "failing to obtain IP" — a static IP was the fix; **AdGuard/DNS was NOT the cause**, its DHCP is off).
The de-Googled edge node is READY; only the FR-camera software layer remains (below).

### How it was finally flashed (the winning method — full blow-by-blow in memory `project-fr-smartphone-flash`)
Knox/RMM cleared on its own (the wait worked — no combination firmware needed). Then a 2-day fight ended in a
clean `Install completed with status 0` via these four keys:
1. **Use the OFFICIAL LineageOS a71 `recovery.img` + `vbmeta.img`** (flags=3), pulled live from
   `https://download.lineageos.org/api/v2/devices/a71/builds`. ⚠ The previously-staged `flashdir/recovery.tar`
   was the WRONG file (STOCK recovery) — the ROOT cause of every `Error verifying vbmeta image: invalid vbmeta
   header (6)` failure. Also disable BOTH `vbmeta` AND `vbmeta_samsung`.
2. **Boot recovery from software, NO physical combo** = flash a **FULL-SIZE (508 KB) stock `misc.bin`** with
   ONLY the first 32 bytes overwritten to `boot-recovery\0…` (a truncated 4 KB misc → `SECURE CHECK FAIL: misc`).
3. **⭐ CHARGE THE PHONE TO 100% BEFORE FLASHING** — a low/flat battery caused ALL the USB chaos (hard session
   wedges, `Cannot allocate memory (12)`, the 64 MB recovery cutting off at 46%, adb dropping). At 100% the
   USB was rock-solid and the 1.2 GB sideload ran clean. Also `echo 2000 > /sys/module/usbcore/parameters/usbfs_memory_mb`.
4. Boot → LineageOS recovery main menu → **Apply update → Apply from ADB** (2 button taps; the main menu shows
   a **fastbootd** `18d1:4ee0` interface — only "Apply from ADB" flips USB to the adb `sideload` state) →
   `adb sideload /root/los_rom.zip` (run as a detached job so an SSH blip can't kill it) → status 0 → Reboot.
Thor + all images still staged on the Proxmox host `192.168.1.101` (`/root/Thor-Linux`, `/root/losrec/`,
`/root/los_rom.zip`) if a re-flash is ever needed.

### NEXT: the FR-camera software layer (the actual goal)
1. **Finish LineageOS setup** on the phone — **skip the Google sign-in** (it's de-Googled), set locale/WiFi.
2. **Install F-Droid** (the open app store), then an **IP-camera app** (e.g. *IP Webcam* / *Droidcam* /
   *libcamera-based streamer*) that serves an **MJPEG or RTSP** stream on the LAN. The phone is at the fixed
   `192.168.1.25`, so the stream URL is stable (e.g. `http://192.168.1.25:8080/video`).
3. **Keep-alive:** disable battery optimization / screen-off for the camera app, set it to auto-start, mount
   the phone at the entrance on permanent USB power.
4. **FR backend** (planned LXC ~112, `dlib`/`face_recognition` — NOT InsightFace per [[feedback_no_chinese_tools]]):
   pull the phone's stream, run recognition, publish `face_identified` → the existing door-unlock chain. Full
   plan in [FR_BACKEND_PLAN.md](FR_BACKEND_PLAN.md).

### Flashing tool DECISION (2026-08-20): Thor on the Proxmox host, NOT Windows
- **Windows has no viable open-source flasher**: Thor-Windows has **no USB handler** ("supported platforms:
  Unix"); Heimdall Windows binaries are gone. Odin is closed-source (rejected for the trust/vision reasons).
- **Chosen: Thor (open-source, `Samsung-Loki/Thor`) on the Debian Proxmox host** (`192.168.1.101`) — native
  USB, x86_64, self-contained binary (no .NET needed). Driven over SSH in a `tmux` session. Phone plugs into
  the mini-PC's USB. ⚠ **NOT via WSL** — Thor explicitly refuses WSL and Samsung flashing re-enumerates USB
  mid-flash (usbipd drops it). ⚠ Linux grabs the download-mode port with `cdc_acm` — `modprobe -r cdc_acm`
  (safe, used-by 0) before `connect`.
- **The a71 restores STOCK recovery on every full Android boot** (its stock ROM's install-recovery). So the
  ONLY way to reach the freshly-flashed LineageOS recovery is to boot recovery WITHOUT booting Android — the
  `adb reboot recovery` "race" always loses (overwrite beats adbd). Once RMM clears, boot recovery via the
  key combo **UNPLUGGED** (Samsung routes the recovery combo to Download when USB is attached).

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
- **FR service host — DECIDED = a NEW dedicated LXC (2026-08-20, ~LXC 112 "fr").** Matches the project's
  one-subsystem-one-LXC convention (Email→110, Privacy→109, Robot→111). Especially since the non-Chinese
  engine **CompreFace** is a **Docker stack** (api + core + ui + its own postgres) → it wants a **privileged
  + nesting LXC of its own** (same shape as Privacy/109), NOT squeezed onto the busy device-agent (103) or
  rule-engine (105). Specs: Debian, ~2 cores / 4 GB, Docker. Pulls frames from go2rtc, publishes
  `face_identified` → the existing corridor/RemoteXY door chain (no new door logic). **Faces metadata**
  (name · allowed flag · recognition log) lives in the **main Postgres (LXC 102)** like everything else;
  CompreFace keeps the face *embeddings* in its own Docker DB on this LXC. (A lighter `dlib`/`face_recognition`
  Python service on the same LXC is the alternative if CompreFace is overkill.) **Build order:** flash phone
  → phone as RTSP camera → THEN stand up LXC 112.
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

**Open decisions:** front-vs-rear camera · liveness / anti-spoof approach for the lock · retire the
TX-510 or run both · CompreFace vs a lighter `dlib` service on LXC 112. *(FR host = a new dedicated
LXC ~112 — DECIDED 2026-08-20, see above.)*
