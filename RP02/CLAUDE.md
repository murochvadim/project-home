# RP02 — Raspberry Pi Zero 2 W (camera / mic node)

A **second Raspberry Pi Zero 2 W** on the LAN (added 2026-08-10). Sibling of **RP01**
([../RP01/CLAUDE.md](../RP01/CLAUDE.md)) but a **different purpose**: RP01 = AdGuard DNS (network-critical);
**RP02 = the planned camera / mic (A/V) node** — a USB webcam + mic for a room view/stream. This follows the
RP01 decision *"keep RP01 DNS-only; put A/V on RP02."* Treated like an LXC / infra node (NOT `esp_boards`):
SSH-key managed, on Project Health, backed up.

## Identity / access
- **hostname `RP02`**, user **`rp02_project`**.
- **Ethernet-only, `192.168.1.232`** (`eth0`; MAC `50:91:e3:c4:7c:68`) via a **Waveshare ETH/USB HUB HAT**
  (USB → RTL8153 Ethernet). ⚠ **reserve `.232`** in the router DHCP (like RP01's `.217`).
- **Key-managed** (was password-only, `sshpass -p '13_aRp_77_Ud'` via LXC 104): the laptop's
  `~/.ssh/id_ed25519` (claude-code) **and** LXC-104's `root@Servers` key are in `rp02_project`'s
  `authorized_keys`. Reach it: `ssh -i ~/.ssh/id_ed25519 rp02_project@192.168.1.232` (or via LXC 104).

## ⚠ WiFi DISABLED (Ethernet-only) — ARP-flux fix
RP02 was dual-homed: `eth0` `.232` + `wlan0` `.233` **on the same `192.168.1.0/24`**. Linux's default ARP
behaviour let either interface answer for either IP → the ARP scanner filed **both MACs under one IP** and the
dashboard device list flip-flopped .232/.233. Fixed 2026-08-10:
- **WiFi off:** `nmcli radio wifi off` (persisted; `wlan0` DOWN, `.233` released).
- **ARP-flux guard (persisted):** `/etc/sysctl.d/99-arp-flux.conf` = `net.ipv4.conf.all.arp_ignore=1` +
  `arp_announce=2` (each interface answers only for its own IP) — so WiFi *could* be re-enabled cleanly
  (`sudo nmcli radio wifi on`) without the flux, but for a wired node keep it off.

## Hardware — the ETH/USB HUB HAT
Waveshare **ETH/USB HUB HAT** stacks on the Pi Zero's **40-pin header** (power + mount) **+ a USB bridge**
(the Ethernet/USB data — GPIO doesn't carry USB). ⚠ **Only the Ethernet (RTL8153) enumerates today** — the
HAT's **3 USB-A hub ports don't show in `lsusb` yet** (likely need the HAT's `PWRACT` power input, or a
pogo-pin/USB jumper — check the Waveshare wiki). **Sort this before the webcam** (the camera needs a working
USB port).

## Project Health integration (2026-08-10) — full RP01 treatment
Cloned from RP01's footprint, **minus the AdGuard tab** (DNS is RP01-only):
- **`svc-rp02` System-Status cell** — TCP:22 probe to `.232` (`server.js runHealthChecks` → `r.rp02`).
- **Monitor checkbox** (`mon-rp02` → `toggleRp02Monitor`, `dashboard_settings.health.node_monitoring.rp02`)
  — uncheck to pause the probe **+ drop from the sidebar badge** (for when the camera is intentionally off).
- **Live CPU temperature** — `rp02TempRead` SSHes `cat /sys/class/thermal/thermal_zone0/temp`; renders
  `Temp - NN°C`, green <70 / amber ≥70 / red ≥80. (RP02 idle ~47 °C — lots of headroom.)
- **Sidebar badge** — counted (`r.rp02?.ok` in `alerts-monitor.js`); paused → `null` auto-drops.
- **Backup** — `backup_jobs` **id 11** (`rp02_project@192.168.1.232:/home/rp02_project` → QNAP
  `Claude_Data/RaspberryPi_RP02/`, storage 6, retention 4, daily) via LXC-104's `backup-script.sh`
  (per-job `source_host`). ⚠ backs up **only the home dir** — widen as camera recordings/config arrive.

## Purpose — camera / mic node (PLANNED, not built)
A USB **Logitech webcam + mic** for a **light MJPEG stream** (room view) + room-audio "listen." RP02 is the
right home (idle + cool, vs RP01's tight RAM). Next steps: (1) get the HAT's USB ports enumerating, (2) attach
the webcam+mic, (3) **µStreamer** MJPEG passthrough + a dashboard camera card, (4) room-audio stream. See the
"keep RP01 DNS-only" reasoning in [../RP01/CLAUDE.md](../RP01/CLAUDE.md).

## References
- Sibling / DNS node: [../RP01/CLAUDE.md](../RP01/CLAUDE.md)
- Memory: [[project_agent_raspberry_pi]]
