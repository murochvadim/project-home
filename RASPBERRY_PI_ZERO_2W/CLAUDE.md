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

## Next steps (not yet done)
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
