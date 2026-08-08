# Raspberry Pi Zero 2 W — Tuya Flashing Station

A dedicated **Raspberry Pi Zero 2 W** used as a **local flashing station** on the LAN to de‑cloud
Tuya devices — running open firmware over MQTT into this project instead of the Tuya cloud.

## Why this exists
Two flashing jobs need a Linux box with an **AP‑capable Wi‑Fi adapter** (the Windows dashboard laptop
**cannot** run these tools):

| Target device | Chip | Open firmware | Flash tool |
|---|---|---|---|
| **WR3E IR remote hub** (MOES Wi‑Fi+IR+RF, IR‑only wanted) | **Realtek RTL8710BN** | **OpenBeken** | **tuya‑cloudcutter** (OTA) or serial (TX/RX pads) |
| **15 firmware‑locked wall switches** (TUYA_LOCAL Phase 1) | **TYWE3S = ESP8266** | **ESPHome / Tasmota** | **tuya‑convert** (OTA, low odds) or serial |

⚠ **Different tools per chip:** `tuya-cloudcutter` for the Realtek IR board, `tuya-convert` for the
ESP8266 switches (cloudcutter does **not** apply to the ESP8266 switches). Same Pi runs both.
See [`TUYA_LOCAL/FLASHING.md`](../TUYA_LOCAL/FLASHING.md) for the switch flashing detail and
[[project_tuya_local_phase1]].

## Hardware
- **Raspberry Pi Zero 2 W** (Cortex‑A53 quad, **512 MB RAM**) — built‑in Wi‑Fi is the **fake AP**
  during flashing.
- **USB/HAT Ethernet board** attached (the Zero 2 W has no native Ethernet) — provides internet +
  SSH management while Wi‑Fi is busy being the AP. Common chip: Realtek RTL8152/8153 (plug‑and‑play
  on Raspberry Pi OS → enumerates as `eth0`).
- microSD card (8 GB+).
- **Roles during flashing:** `eth0` = internet + SSH · `wlan0` = the flashing AP (kept unconfigured).

## Network model
- Manage the Pi over **Ethernet** only. **Leave Wi‑Fi unconfigured** so `wlan0` is free to become the
  flashing AP (nothing to tear down first).
- ⚠ 512 MB RAM is tight for cloudcutter's Docker → expect it slow; `tuya-convert` is light.

---

## Step 1 — Install Linux (Raspberry Pi OS) — DONE (documented)
The Pi is **not** connected to the laptop to install the OS. Linux is written to the **microSD card**
on the laptop, the card goes into the Pi, then the Pi is reached over the **network (Ethernet)**.

### 1a. Card into the laptop
1. Remove the **microSD** from the Pi.
2. Insert it in the laptop via a **microSD→SD adapter** (built‑in SD slot) or a **USB microSD reader**.

### 1b. Write the OS (Raspberry Pi Imager, on the laptop)
1. Install **Raspberry Pi Imager** from `raspberrypi.com/software`.
2. **Choose Device** → *Raspberry Pi Zero 2 W*.
3. **Choose OS** → *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (32‑bit)**.
   *(If tuya‑convert struggles on Bookworm's NetworkManager, use the **Legacy / Bullseye** Lite image.)*
4. **Choose Storage** → the SD card. ⚠ **verify it's the SD card, not C:** — writing erases it.
5. **Next → Edit Settings** (OS customisation):
   - **Hostname:** `flasher`
   - **Enable SSH** → password authentication
   - **Username + password** → *record them*
   - **Leave Wi‑Fi BLANK** (managed over Ethernet; keeps `wlan0` free for the AP)
   - Set timezone/locale → **Save**
6. **Yes** to apply → **Yes** to write → wait for **"Write Successful"** → eject.

### 1c. Boot the Pi
1. microSD → into the Pi Zero 2 W.
2. **Ethernet board → router** (network cable).
3. Power the **PWR** micro‑USB port (inner one). Wait ~1–2 min for first boot.

### 1d. Connect from the laptop (over the network, not a cable)
```bash
ssh <username>@flasher.local        # or the eth IP from the router's client list
# accept fingerprint (yes), enter password
```
Verify the Ethernet board + free Wi‑Fi:
```bash
ip a       # expect eth0 with a DHCP IP; wlan0 present but unconfigured
lsusb      # lists the Realtek/USB-Ethernet chip
sudo apt update && sudo apt full-upgrade -y && sudo reboot
```

---

## ✅ Provisioned + verified live (2026-08-08)
The Pi is flashed, on the LAN, and I have passwordless key access — **no flash tooling is set up**
(installs paused per user). ✅ **Re-audited clean 2026-08-08:** only the OS + my `claude-code` SSH key +
the pre-existing `iw`; the earlier `~/tuya-convert` source clone was **removed** (`rm -rf ~/tuya-convert`) —
home dir is default folders only, `authorized_keys` = 1 line (my key), **no Docker / hostapd / mosquitto /
dnsmasq**, no lingering processes, 8.9 G free. ⚠ The flashed image is the **Desktop** variant, **not Lite**
(has an X session; heavier on 512 MB — Lite is still the recommendation above for a rebuild).
- **Identity:** hostname `RP01`, user **`rp01_project`** (⚠ not `rp01` — that tripped up the first login).
- **Network (dual‑homed, as designed):** **`eth0` = 192.168.1.217** (USB **Realtek RTL8152** adapter, wired,
  internet OK — this is the **management path**) · **`wlan0` = 192.168.1.111** (Broadcom **BCM43430/1**
  brcmfmac, **AP mode CONFIRMED** via `iw list` → reserved for the flashing AP). ⚠ Wi‑Fi WAS configured in
  the imager (that's how it first came up) — before flashing, disconnect `wlan0` from the router so it's free.
- **OS:** Raspberry Pi OS / **Debian 13 "trixie"** (⚠ **NetworkManager** — the tuya‑convert AP gotcha applies),
  **armv7l** 32‑bit, **~424 MB RAM** (tight for cloudcutter Docker), **8.9 G free**.
- **Access:** the laptop's `~/.ssh/id_ed25519` (**claude-code**) is in `rp01_project`'s `authorized_keys` →
  `ssh -i ~/.ssh/id_ed25519 rp01_project@192.168.1.217`. Bootstrapped once via LXC‑104 `sshpass` (password
  auth), then key‑only. `iw` installed; `apt update` done. Nothing else changed.
- **Gotcha log:** `ssh` wasn't on the laptop's PowerShell PATH (fixed: added `C:\Windows\System32\OpenSSH` to
  User PATH). mDNS `flasher.local` never resolved — find the Pi by IP / MAC `2c:cf:67:ca:26:e5` instead.

## ✅ Infra‑node integration (2026-08-08) — treated as first‑class infrastructure like an LXC
Per user: the Pi is a **permanent, multi‑purpose** node (flashing now, camera/etc. later), so it's monitored +
backed up exactly like the LXCs / HA VM — **not** shoehorned into `esp_boards` (that's for microcontrollers).
- **Reserved IP:** `192.168.1.217` (eth0 MAC `00:e0:4c:36:15:13`) — DHCP‑reserved so the probe is stable even
  during a flash session (when `wlan0` becomes the AP, `eth0` stays up).
- **Monitoring (like an LXC):** dashboard **Project Health → System Status** row **`RP01 — Raspberry Pi`**
  (`svc-rp01`) via a **TCP:22 probe** to 192.168.1.217 (`server.js /api/health/status` → `r.rp01`,
  `health.html`/`health.js`), **and counted in the sidebar Status badge** (`alerts-monitor.js`) so a down Pi
  turns it red — same treatment as `lxc100`–`lxc106` + the HA VM. (LXCs have no separate reachability watchdog,
  so probe+badge IS the full "like an LXC" treatment.)
- **Backup (like the backup jobs):** `backup_jobs` **id 10 "Raspberry Pi RP01"** — `source_host
  rp01_project@192.168.1.217`, `source_path /home/rp01_project` → QNAP `Claude_Data/RaspberryPi_RP01/`
  (storage 6), daily (`max_age_hours 24`), keep 7. Runs from the **LXC‑104 backup orchestration**
  (`/opt/backup-script.sh`). ⚠ **The script was generalized** to honor a **per‑job `source_host`** (was
  hardcoded to the laptop) — empty `source_host` still defaults to the laptop, so jobs 4/5 are unchanged; the
  reachability check is now per‑job. **LXC‑104's root key (`root@Servers`) was authorized on the Pi** for the
  scp. Verified: job 10 = `ok` (30 KB), laptop jobs still `ok`.

## Next steps (not yet done — PAUSED per user)
- **Step 2 — Install the flash tools** (on the Pi):
  ```bash
  # tuya-convert (ESP8266 switches)
  git clone https://github.com/ct-Open-Source/tuya-convert && cd tuya-convert && ./install_prereq.sh
  # tuya-cloudcutter (RTL8710B WR3E IR board)
  cd ~ && sudo apt install -y docker.io git
  git clone https://github.com/tuya-cloudcutter/tuya-cloudcutter
  ```
- **Step 3 — Verify `wlan0` supports AP mode** (`iw list | grep -A10 'Supported interface modes'` → must list `AP`).
- **Step 4 — Flash sessions:** cloudcutter (IR board) + tuya‑convert (switches); serial via TX/RX pads is
  the reliable fallback (needs only a ~$2 USB‑TTL adapter — not the Pi).
- **Step 5 — Re‑integrate:** OpenBeken (IR) + ESPHome (switches) → MQTT on **LXC 107** → device‑agent / rules.

## References
- Tuya WR3E datasheet (RTL8710BN): https://developer.tuya.com/en/docs/iot/wr3e-module-datasheet?id=K9elwlqbfosbc
- OpenBeken (Realtek + IR + MQTT): https://github.com/openshwprojects/OpenBK7231T_App
- tuya‑cloudcutter (OTA): https://github.com/tuya-cloudcutter/tuya-cloudcutter
- tuya‑convert (ESP8266 OTA): https://github.com/ct-Open-Source/tuya-convert
- Switch flashing detail: [`TUYA_LOCAL/FLASHING.md`](../TUYA_LOCAL/FLASHING.md)
