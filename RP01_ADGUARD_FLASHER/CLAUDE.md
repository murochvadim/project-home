# RP01_ADGUARD_FLASHER — Raspberry Pi Zero 2 W (AdGuard DNS + Tuya flashing station)

> Module folder renamed `RP01/` → `RP01_ADGUARD_FLASHER/` on 2026-08-29 (both roles now real —
> AdGuard live + tuya-convert installed). ⚠ **The node identity stays `rp01`** — `svc-rp01`,
> `dashboard_settings.health.node_monitoring.rp01`, `backup_jobs` id 10, the hostname, and the
> dashboard `rp01`/AdGuard env are all UNCHANGED. Only the docs/folder name changed.

A dedicated **Raspberry Pi Zero 2 W** (hostname `RP01`, user `rp01_project`, eth0 `192.168.1.217`). Two roles:
a **local flashing station** to de‑cloud Tuya devices (open firmware over MQTT), and the **AdGuard Home DNS**
server for the whole LAN. Its sibling **RP02** (the camera/mic node) has its own doc:
[../RP02_PTZ_CAMERA/CLAUDE.md](../RP02_PTZ_CAMERA/CLAUDE.md).

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
The Pi is flashed, on the LAN, and I have passwordless key access. *(At the time: no flash tooling —
**tuya-convert has since been installed 2026-08-29, see "Flash tools INSTALLED" below.**)* ✅ **Re-audited clean 2026-08-08:** only the OS + my `claude-code` SSH key +
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

## Camera purpose — GoPro HERO3+ Black Edition (POSSIBLE, not built — investigated 2026-08-08)
The Pi can drive a **GoPro HERO3+ Black Edition** as a project camera. What was established:
- **USB = file transfer ONLY.** Over USB the Hero 3/3+ enumerates as a **WPD/MTP** device (SD-card access +
  charging) — **no camera control over USB** on this generation. (Detected on the laptop as `HERO3+ Black
  Edition` WPD / `E:` drive + a `Camera DFU Device`.) So the USB cable can copy media off it, not operate it.
- **Wi-Fi = full control.** The Hero 3+ has a reverse-engineered **HTTP API**:
  `http://10.5.5.9/camera/<CMD>?t=<pwd>&p=<param>` → start/stop record, photo, mode, power, status, + a live
  preview stream. It's plain **HTTP GET → NO install needed** for a basic test (`curl`); the Python lib
  **`goprocam`** (KonradIT/gopro-py-api, legacy Hero-3 mode) is only for a fuller integration.
- **⭐ The dual-homed Pi is the natural bridge:** `wlan0` joins the **GoPro's own Wi-Fi AP** while `eth0` stays on
  the home LAN → the Pi controls the camera AND stays reachable / can relay to the project (MQTT/dashboard).
  Connect: `nmcli device wifi connect <GoPro-SSID> password <pwd> ifname wlan0`, then `curl http://10.5.5.9/...`.
  ⚠ Using `wlan0` for the GoPro **conflicts with the flashing-AP role** — pick per use.
- **Credentials:** the **SSID** shows in the Wi-Fi list once the GoPro Wi-Fi is on (side button, blue blink); the
  **password** = whatever was set via the GoPro app, or reset on-camera (Settings → **Wi-Fi RESET** → default
  `goprohero`). ⚠ NOT readable over the USB/`E:` file connection. Next step is a quick Wi-Fi control test once the
  SSID+password are supplied.

## AdGuard Home — IoT egress DNS monitor + sinkhole (✅ BUILT on RP01 2026-08-10)
Runs **AdGuard Home v0.107.78** (single ARM binary, ~40–60 MB — fine on 424 MB) on the Pi as the
network-wide DNS server: the **first layer for seeing + blocking Chinese IoT phone-home**, the natural
complement to [[project_tuya_local_phase1]] (local control **+** blocked cloud). Every device (Wi-Fi or
wired) that uses the Pi for DNS shows in the query log with exactly which domains it reaches, and Tuya/
vendor-cloud domains get sinkholed. Chosen over Pi-hole (lighter single binary + built-in DoH) / NextDNS
(no cloud dep). Surface = a **Project Health → AdGuard tab** (per-device egress, top blocked/queried, query
log, 24h stats) + an **`svc-adguard` System-tab cell + sidebar badge** (shares RP01's Monitor-checkbox pause).

**What's installed (on RP01):** `/opt/AdGuardHome` + systemd `AdGuardHome` (enabled, survives reboot).
**DNS on `0.0.0.0:53`**, **admin UI on `:8080`** (`http://192.168.1.217:8080`, user `admin` — password in
the dashboard `.env` `ADGUARD_PASS`, also in the AGH config). Upstream = **encrypted DoH — Quad9 *secured*
`dns.quad9.net` PRIMARY + Cloudflare *security* `security.cloudflare-dns.com` as BACKUP/fallback** (hardened
2026-08-18, see below; was the *unsecured* `dns10.quad9.net` until then); **query log + statistics both 90
days**; client IPs **not anonymized** (LAN-only →
per-device attribution). Configured headlessly via the install API (`POST /control/install/configure`), not
the web wizard. ⚠ binds `0.0.0.0:53` incl. `wlan0` — if a future flashing-AP session needs `wlan0:53`, stop
AGH first (they'd conflict on that one port).
**Protection stack (managed in the AGH admin, NOT repo — ~775k rules total):** 6 blocklists —
**AdGuard DNS filter** (~177k, ads/trackers) + **OISD Big** (~270k, ads/trackers) + **Perflyst SmartTV**
(~162, TV telemetry) + **Phishing Army Extended** (~156k, phishing/scam) + **URLhaus** (abuse.ch malware) +
**HaGeZi Threat Intelligence Feeds — Mini** (~171k malware/phishing/scam/cryptojacking/C2, `adblock/tif.mini.txt`,
auto-updates daily; added 2026-08-18) — plus **Safe Browsing ON** (`safebrowsing_enabled`, real-time cloud threat
lookup, ~0 RAM). AGH's own DHCP is OFF. ⚠ RAM is TIGHT (**RSS ~142 MB, ~160 MB free** after TIF-Mini) — the Zero 2 W
is a one-heavy-job box; **keep it DNS-only, do NOT add camera/audio** (put A/V on **RP02** —
[../RP02_PTZ_CAMERA/CLAUDE.md](../RP02_PTZ_CAMERA/CLAUDE.md) — or another Pi). **Do NOT upgrade TIF-Mini → full TIF** (~200k+ more rules
would erase the headroom + start heavy swap — measured, not guessed). Lever if RAM tightens: OISD Big → OISD Small (~40 MB).

**⚠ Threat-protection hardening (2026-08-18, applied LIVE via the AGH API — no repo file, no service restart, `NRestarts=0`):**
(1) **Upstream: unsecured Quad9 `dns10` (9.9.9.10, no filtering/DNSSEC) → SECURED Quad9 `dns.quad9.net` (9.9.9.9)** as
PRIMARY — now blocks malware at the *resolver* on top of the blocklists (proven: `www.internetbadguys.com` resolves on
8.8.8.8 but returns **NXDOMAIN** via the Pi, while AGH's own lists report `NotFilteredNotFound` → the block is the
upstream). (2) Added **Cloudflare `security.cloudflare-dns.com` (1.1.1.2) as BACKUP** — set as **`fallback_dns`, NOT a
co-equal `upstream_dns`**. ⚠ **why fallback, not load-balance:** co-equal upstreams make AGH send each query to
*whichever* server, so a domain only ONE provider blocks (e.g. Quad9 blocks the Cisco test domain, Cloudflare doesn't)
slips through when the query lands on the other — *weakening* upstream blocking. `fallback_dns` = Quad9 does ALL normal
work (deterministic blocking) and Cloudflare only takes over when Quad9 errors/times-out — fixing the intermittent DoH
`unexpected EOF` that transiently failed a list-update, WITHOUT the weakening. (3) Added **HaGeZi TIF-Mini** blocklist.
Bootstrap set to secured IPs `9.9.9.9 / 149.112.112.9 / 1.1.1.2 / 1.0.0.2 (+IPv6)`. Rollback JSON snapshots in the
session scratchpad (`adguard_dns_info_backup.json` = original dns10; `_pre_cloudflare.json` = Quad9-only). ⚠ all these
tools are **non-Chinese by design** (Quad9 Swiss/US, Cloudflare US, lists Western, Pi UK, SanDisk US) — see
[[feedback_no_chinese_tools]].

**✅ Whole-LAN cutover (2026-08-18):** the **Technicolor gateway `192.168.1.1`** (the DHCP+DNS server — Deco units are
AP/bridge, don't hand out DHCP) → **LAN → DHCP Settings → DNS Server = `192.168.1.217`** (single value, no public
secondary — a public 2nd DNS would let devices bypass filtering). After a router reboot, **90+ clients flow through**
(TVs/IoT/ESP/robots all visible by `.lan` hostname), 18% block rate on real traffic (Samsung/Netflix/Amazon-Minerva
telemetry, ad networks, a live HaGeZi-TIF threat). ⚠ **AUDITED-SAFE blast radius:** every LXC + the PVE host is
**static-DNS on `192.168.1.1`** (`pct config` = static IP, resolv.conf static; verified live) — they do **NOT** flip to
the Pi, so the core stack (agents/DB/MQTT/rule-engine/media/email/backups) is **independent of RP01** — a Pi outage only
costs *consumer/IoT* DNS, never the servers. Only **DHCP clients** flip (laptop/phones/TVs/WiFi-IoT). **Verify HA (VM
101) separately** — its DNS is inside HAOS (SSH closed); if DHCP it'd flip to the Pi (AGH won't block its cloud domains,
but it'd add a Pi dependency). **Blind spot:** any device with its own Private-DNS/DoH (the Fold 5) bypasses regardless
— that's per-device, not the router. **Revert = that one field back to `192.168.1.1`.** **⚡ Power:** RP01 is
USB-powered *by the router*, router is on a **UPS** → survives mains cuts; the Pi only reboots *with* the router (when
there's no internet anyway), so shared power is fine (`throttled=0x0`, no undervoltage).

**✅ Step 3 DONE (2026-08-18) — query log + stats moved to the 16 GB USB stick (spares the SD from continuous logging):**
SanDisk `/dev/sda1` reformatted **FAT32 → ext4** (label `ADGUARD`, journaling matters since the Pi loses power on router
reboots), fstab-mounted at **`/mnt/adguard-data`** by UUID with **`nofail`** (so a dead/missing stick can NEVER block
DNS — AGH just falls back to logging on the mountpoint dir on SD). Set **`querylog.dir_path` + `statistics.dir_path` =
`/mnt/adguard-data`** in `AdGuardHome.yaml`. ⚠ the change needs **stop AGH → cp existing `querylog.json*`+`stats.db` →
`sed` the two `dir_path: ""` → start** (AGH rewrites the yaml on shutdown, so a hot edit is lost; ~5–8 s DNS blip, mostly
invisible via device caches). ⚠ **`mkfs.ext4`/`blkid` live in `/sbin` — not in the non-root PATH; use `sudo /sbin/…`;**
and after `mkfs` **`lsblk` returns the STALE FAT32 UUID from cache** → read the real one with `sudo /sbin/blkid -o value
-s UUID /dev/sda1` before writing fstab. AGH buffers the query log in RAM (~1000 entries) and only flushes to disk in
chunks, so `querylog.json` appears on the stick after enough traffic — `stats.db` is written continuously (open-fd
confirmed). `filters/` + `sessions.db` stay on SD (fine). USB does NOT help RAM (that's the real ceiling) — it only
spares the SD card. **Optional follow-up:** nightly `rsync` `/mnt/adguard-data` → QNAP for >90-day archive. ⚠ **NEVER put
AGH's LIVE data dir on QNAP/NFS** — it would couple the whole-LAN DNS resolver to network-storage availability + SQLite-
over-NFS corruption; QNAP is for *archive/backup* only, not the live write path.
Future headroom items (need RAM): a DoH *server* for the house (encrypted DNS + home filtering on the go via
NetBird; free cert = self-signed or Let's Encrypt+free domain), a log-based threat-hunter (runs on an LXC, not
RP01), a link-reputation checker (dashboard).
  - ✅ **A first consumer shipped 2026-09-05:** the WhatsApp agent screens links in incoming
    messages via `check_host` (see [WHATSAPP/CLAUDE.md](../WHATSAPP/CLAUDE.md) "Link check").
    Measured: LXC 114 → AdGuard **0.52 s**; one call per NEW domain (1 h cache), so the Pi is
    untroubled. A dashboard-side link checker is still unbuilt.

**Dashboard wiring (laptop):** `BOILER/dashboard/routes-adguard.js` (own module, one `require('./routes-adguard')(app)`
line — proxies AGH's API with Basic-auth from `ADGUARD_URL/USER/PASS` env, past the architecture guard) →
`GET /api/adguard/summary` + `/querylog`. Tab + `svc-adguard` cell in `public/health.html` + `js/health.js`
(`adguardOnTabShow()`); badge in `alerts-monitor.js`. **All DNS logic lives on the Pi; the dashboard only
displays it** (Pi down → tab shows "unavailable", cell red).

**⚠ TOPOLOGY CORRECTION (live Aruba SNMP FDB re-check 2026-08-10 — the 2026-08-08 assumption was WRONG):**
the **Aruba Instant On 1960 SWITCH `192.168.1.215` IS in the path of ALL traffic.** FDB walk (community
`public`): **Technicolor gateway on Aruba port 1/1**, and **all 6 TP-Link Deco units are WIRED into the Aruba**
(ports 1/13/1/14/1/15/1/17 = Ethernet backhaul, NOT wireless). So every device — incl. Wi-Fi IoT — egresses
`device → Deco AP → Aruba → uplink 1/1 → Technicolor → internet` (switch has learned 144 MACs). The old
"Wi-Fi IoT never traverses the switch" claim is retracted. The Aruba still can't DPI/log-domains/block-per-device
itself (Instant On) — it can only mirror/count/ACL.

**Honest blind spot (Wi-Fi + wired alike):** a device that hardcodes DNS (8.8.8.8) / uses DoH / dials a raw IP
walks past AGH. **Corrected escalation (cheaper than a Firewalla):** because all traffic crosses Aruba **port
1/1**, a **SPAN mirror of 1/1 → a sniffer box** (Zeek/ntopng on a spare LXC) catches even the bypassers at the
packet level, **using existing hardware**. A **Firewalla** is only needed for *inline per-device BLOCKING* of
raw-IP egress. Order: AGH (name+block) → Aruba mirror→sniffer (deep watch) → Firewalla (inline block, last).

**Phase 2 — LAN cutover (user action, NOT yet done):** point the LAN's DNS at `192.168.1.217` via the
Technicolor DHCP (or the Deco app). Recommend **AGH primary + a fallback DNS** (Technicolor self / `1.1.1.1`)
so a Pi outage doesn't kill LAN name resolution. Test one device first, then whole-LAN.
⚠ **A DNS server that dies takes the LAN's internet with it** — why it lives on the always-on Pi. Shares the
Pi with the future flashing-AP role (`wlan0`); confirm before a flash. See [[project_agent_raspberry_pi]].

## OS upgrade + ⚠ chromium kernel-deadlock (2026-08-08)
Ran the first `apt full-upgrade` (image was the June build, never upgraded — 155 pending). **Now fully up to
date: kernel 6.18.34 → 6.18.39, 0 pending, dpkg clean.** But it hit a real incident worth remembering:
- **⚠⚠ Unpacking `chromium` DEADLOCKED the kernel.** On the Pi Zero 2 W (512 MB RAM), dpkg unpacking the huge
  chromium package thrashed swap so hard it tripped a **kernel hung-task / mutex deadlock** — `dmesg`:
  `task dpkg-deb blocked on a mutex likely owned by task dpkg`, with dpkg spinning (state R, 99% CPU, **0 disk
  writes, 0 iowait**) and dpkg-deb stuck **uninterruptible (`D`)**. It sat wedged ~30 min; a `D`-state process
  **can't be killed** — only a reboot clears it.
- **Recovery that worked:** (1) **verify the reboot is safe FIRST** — the kernel pkgs were still the old `ii`
  version and `/boot/firmware/*.img` untouched (chromium is userspace, unpacked *before* the kernel pkgs), so
  the running kernel/boot were never at risk. (2) Reboot via **`sync; echo b > /proc/sysrq-trigger`** (the
  reliable way to reboot a wedged box; ⚠ the reboot SSH will HANG on the dead connection — use a keepalive /
  short timeout and just poll for the box to come back). (3) `dpkg --purge --force-all chromium*` (delete-only,
  no heavy unpack) → `dpkg --configure -a` → `apt-get -f install -y` → **clean**. (4) Resume `full-upgrade` for
  the rest (kernel + EEPROM) — completed rc=0, reboot into 6.18.39. Post-reboot chromium reinstalled fine via
  `-f install` (the hang was a **transient** memory-pressure event, not deterministic).
- **Aftermath: removed chromium + firefox** (`apt purge` + `autoremove --purge`, 6 pkgs, ~700 MB reclaimed) —
  useless on a headless SSH-managed node AND the exact thing that deadlocked. The desktop GUI itself is still
  installed (only the browsers were stripped).
- **Lessons:** on a 512 MB Pi, a single huge-package unpack (chromium) can hang the kernel under swap pressure →
  keep browsers/heavy desktop pkgs off it; if a future unpack wedges, verify kernel/boot untouched → reboot →
  purge the offender → resume. EEPROM note: the Zero 2 W boots from SD (no SPI EEPROM), so `rpi-eeprom` updates
  are inert on this model.

## ✅ Flash tools INSTALLED — tuya-convert (2026-08-29, scope narrowed to the 15 switches)
Per user, flashing scope is now the **15 firmware-locked ESP8266/`TYWE3S` wall switches ONLY** — the WR3E
IR hub (and therefore **tuya-cloudcutter + Docker**) was **dropped**. So only **tuya-convert** was installed:
```bash
git clone --depth 1 https://github.com/ct-Open-Source/tuya-convert && cd tuya-convert && ./install_prereq.sh
```
**Verified live:** `~/tuya-convert/` present (`start_flash.sh`); apt prereqs installed (**hostapd `/sbin`,
dnsmasq `/sbin`, mosquitto `/sbin`, screen**); Python deps (**paho-mqtt 2.1.0, tornado 6.5.8,
pycryptodomex 3.23.0, sslpsk 1.0.0**) all import OK; **`wlan0` AP mode supported**; **AdGuard stayed
`active`** throughout (the pulled-in dnsmasq can't grab `:53` while AGH holds it — harmless; tuya-convert
manages those services itself only at flash time); 9.1 G free.
⚠ **PEP 668 gotcha (Debian trixie):** `install_prereq.sh`'s `pip install --user` **failed** with
`externally-managed-environment`. Completed the Python deps with
`sudo python3 -m pip install --break-system-packages --upgrade paho-mqtt tornado pycryptodomex
git+https://github.com/drbild/sslpsk.git` — **sslpsk built cleanly** (the OpenSSL-3.5 build fear didn't
materialise). Install logs kept at `~/tuya-convert-install.log` + `~/tc-pip.log`.
⚠ **`esptool` NOT yet installed** — only needed for the SERIAL fallback (`pip install --break-system-packages
esptool` or `apt install esptool` when that stage is reached).

## Next steps (flash sessions — NOT yet done)
- **Step 3 — Verify `wlan0` supports AP mode** (`iw list | grep -A10 'Supported interface modes'` → must list `AP`) — ✅ done (AP supported).
- **Step 4 — Flash sessions:** cloudcutter (IR board) + tuya‑convert (switches); serial via TX/RX pads is
  the reliable fallback (needs only a ~$2 USB‑TTL adapter — not the Pi).
- **Step 5 — Re‑integrate:** OpenBeken (IR) + ESPHome (switches) → MQTT on **LXC 107** → device‑agent / rules.

## ⚠ Flashing WHILE AdGuard is live — can RP01 do both? (procedure, 2026-08-29)
**Yes, but NOT concurrently — you time-share the two roles** (or side-step the conflict with serial).
RP01 now serves LAN DNS for 90+ DHCP clients, so a flash session can't just barge in. Three hard
constraints:
1. **Port 53 collision (the blocker):** a tuya-convert / cloudcutter AP flash runs its **own dnsmasq on
   `:53`** on `wlan0` to hijack the target's DNS; AdGuard already binds **`0.0.0.0:53` on every
   interface** (incl. `wlan0`). They fight for that port → **AdGuard must be stopped for an AP flash.**
2. **Stopping AdGuard = LAN DNS outage** for all DHCP clients (phones/TVs/IoT) for the session. The
   LXCs + PVE host are static-DNS on `192.168.1.1`, so the **core stack is unaffected** — only consumer/
   IoT DNS drops.
3. **RAM:** ~424 MB usable, AdGuard ~142 MB RSS (~160 MB free). **cloudcutter runs in Docker** →
   stacking it on top thrashes swap = the exact condition that once **deadlocked this Pi's kernel** (the
   chromium incident). `tuya-convert` is lighter but still tight.

### ✅ Option A — Serial flash (RECOMMENDED — zero conflict, AdGuard stays UP)
Flash via the board's **TX/RX pads + a ~$2 USB-TTL adapter** (not the Pi's AP at all): no dnsmasq, no
port-53 clash, **no DNS downtime, AdGuard keeps running the whole time**, and no Docker/RAM pressure. For
the locked **TYWE3S/ESP8266 switches** serial is usually *more* reliable than the OTA route anyway (their
cloud-cutter OTA odds are low). This is the clean way to truly run both roles at once.

### 🔘 Stop/Start button (dashboard — built 2026-08-29)
**Project Health → AdGuard tab** has a **⏻ Stop AdGuard / ▶ Start AdGuard** toggle (top-right of the
header card) so you don't have to SSH in for a flash session. It runs `sudo systemctl stop|start
AdGuardHome` on RP01 over **`node-ssh`** (dashboard `routes-adguard.js`: `GET /api/adguard/service` =
`is-active`, `POST /api/adguard/service {action:start|stop|restart}`; SSHes `rp01_project@192.168.1.217`
with the dashboard's `~/.ssh/id_ed25519` — `rp01_project` already has passwordless-sudo, **no RP01 change
needed**). **Stop** confirms first (warns LAN DNS pauses for DHCP clients; LXCs/servers on `.1`
unaffected), shows an amber "flasher mode" banner, and **auto-pauses RP01 monitoring**
(`health.node_monitoring.rp01=false`) so `svc-adguard` doesn't false-alarm red; **Start** reverses both.
⚠ reading state uses SSH `is-active` (not AGH's HTTP API) because a stopped AGH's `:8080` is down.
Verified live: GET=active, POST restart self-recovered, bad action rejected. ⚠ the button only stops the
service — for a full **AP** flash you STILL repoint the router DHCP DNS (Step 1 below); for a **serial**
flash you don't even need to stop it.

### Option B — AP flash, time-shared with AdGuard (one Pi, brief planned DNS interruption)
Flash sessions are short, one-off jobs; take AdGuard offline just for the window.
1. **Repoint LAN DNS off RP01 first** (so clients keep resolving): Technicolor gateway `192.168.1.1` →
   LAN → DHCP → DNS Server back to **`192.168.1.1`** (or `1.1.1.1`). Give it a few minutes / renew leases.
2. **Stop AdGuard so it frees `:53` + RAM:** the dashboard **⏻ Stop AdGuard** button (above), or
   `sudo systemctl stop AdGuardHome`.
3. **Disconnect `wlan0` from the router** so it's free to become the flashing AP (leave `eth0` = mgmt/SSH).
4. **Install the flash tools if not present** (see "Next steps" above — `tuya-convert` and/or
   `tuya-cloudcutter`+`docker.io`), then run the flash (cloudcutter for the RTL8710 IR board,
   tuya-convert for the ESP8266 switches).
5. **Restore when done:** `sudo systemctl start AdGuardHome` → re-point the router's DHCP DNS back to
   **`192.168.1.217`** → verify `svc-adguard` cell green + a test device resolves via the Pi.
⚠ If cloudcutter's Docker makes the 424 MB box thrash, prefer serial (Option A) — don't fight the RAM.

### Option C — dedicate a different box
**RP03** is spare (purpose TBD) but **WiFi-only / no Ethernet**, so it can't be the dual-homed AP flasher
(needs `eth0` for internet+SSH *while* `wlan0` is the AP) without adding a USB-Ethernet HAT like RP01/RP02
have. So today RP01 (time-shared or serial) is the path; a HAT'd RP03 would be the way to fully separate
the roles later.

**Naming note:** because RP01 keeps a real (if occasional) flashing role, `RP01_ADGUARD` would undersell
it — `RP01_ADGUARD_FLASHER` (or leaving it `RP01`) fits better. Decide when a rename is actually wanted.

## References
- Tuya WR3E datasheet (RTL8710BN): https://developer.tuya.com/en/docs/iot/wr3e-module-datasheet?id=K9elwlqbfosbc
- OpenBeken (Realtek + IR + MQTT): https://github.com/openshwprojects/OpenBK7231T_App
- tuya‑cloudcutter (OTA): https://github.com/tuya-cloudcutter/tuya-cloudcutter
- tuya‑convert (ESP8266 OTA): https://github.com/ct-Open-Source/tuya-convert
- Switch flashing detail: [`TUYA_LOCAL/FLASHING.md`](../TUYA_LOCAL/FLASHING.md)
