# RP03 — Raspberry Pi Zero 2 W (infra node)

A **third Raspberry Pi Zero 2 W** on the LAN (added 2026-08-16). Sibling of **RP01**
([../RP01/CLAUDE.md](../RP01/CLAUDE.md)) and **RP02** ([../RP02/CLAUDE.md](../RP02/CLAUDE.md)).
Treated like an LXC / infra node (NOT `esp_boards`): SSH-key-managed, on Project Health.
**Purpose = TBD** — brought online + wired into monitoring first; the role gets scoped later.

## Identity / access
- **hostname `rp03`** (mDNS `rp03.local`), user **`rp03_project`** (matches RP01/RP02 naming).
- **WiFi `192.168.1.169`** — the Pi Zero 2 W's **onboard WiFi** (`wlan0`, MAC `2c:cf:67:ca:26:f1`,
  Raspberry Pi Trading prefix). **No Ethernet HAT** (unlike RP02), so **no ARP-flux issue** — single-homed.
- **DHCP reservation set** for `.169` (user did this 2026-08-16) — so it stays put despite `.169` being a
  historically churny lease. Reach it: `ssh rp03_project@192.168.1.169`.
- ⚠ **SSH-key auth for the laptop is not confirmed yet.** The dashboard's live **CPU-temp** read SSHes as
  `rp03_project` with the laptop's `~/.ssh/id_ed25519` — until that key is in RP03's `authorized_keys`
  the temp cell shows blank (the TCP:22 up/down probe still works). Append the laptop key (and LXC-104's
  `root@Servers` key, as on RP02) to enable temp + a future backup.

## Project Health integration (2026-08-16) — full RP01/RP02 treatment
Cloned from RP01/RP02's footprint, **minus the AdGuard tab** (DNS is RP01-only):
- **`svc-rp03` System-Status cell** — TCP:22 probe to `.169` (`server.js runHealthChecks` → `r.rp03`).
- **Monitor checkbox** (`mon-rp03` → `toggleRp03Monitor`, `dashboard_settings.health.node_monitoring.rp03`)
  — uncheck to pause the probe **+ drop it from the sidebar Status badge** (for when the Pi is off on purpose).
- **Live CPU temperature** — `rp03TempRead` SSHes `cat /sys/class/thermal/thermal_zone0/temp`; renders
  `Temp - NN°C`, green <70 / amber ≥70 / red ≥80 (blank until the laptop SSH key is authorized — see above).
- **Sidebar badge** — counted (`r.rp03?.ok` in `alerts-monitor.js`); paused → `null` auto-drops.

## Follow-ups (not done yet)
- **Authorize the laptop + LXC-104 SSH keys** on `rp03_project` → unlocks the temp read.
- **Backup job** — add a `backup_jobs` row (next free id, `rp03_project@192.168.1.169:/home/rp03_project`
  → QNAP `Claude_Data/RaspberryPi_RP03/`, retention 4, daily) once key auth works — same shape as RP01
  (id 10) / RP02 (id 11).
- **Scope the purpose** — then document it here.

## References
- Sibling infra nodes: [../RP01/CLAUDE.md](../RP01/CLAUDE.md) · [../RP02/CLAUDE.md](../RP02/CLAUDE.md)
- Memory: [[project_agent_raspberry_pi]]
