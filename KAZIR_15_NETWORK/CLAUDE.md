# KAZIR_15_NETWORK — Second-Site Network Infrastructure at Efraim Kazir 15

> **Status:** scoping / design phase. Hardware not yet purchased; no gateway peer installed; no APIs polled yet. This doc captures the architecture + APIs documented + integration plan so the build can be picked up when the user is ready.

## Purpose

Bridge a **second physical site** ("Efraim Kazir 15" — a separate building with its own internet, router, and LAN) into the project's existing automation + monitoring stack via NetBird VPN, and ingest the network-infrastructure data that lives only at that site:

1. **12× UniFi Access Points** — health, client count, bandwidth, signal stats
2. **Provision-ISR NVR + 17× Provision-ISR Cam 2** — camera online/offline status, motion events, on-demand live view, snapshots
3. **General LAN reachability** — anything else at that site (router admin UI, future devices) becomes reachable from anywhere via the NetBird tunnel

Out of scope for this module: continuous 24/7 camera recording (already handled by the on-site Provision NVR — we monitor it, not replace it).

## Site overview

| Property | Value |
|---|---|
| Location | Efraim Kazir 15 (separate building, distinct from primary residence) |
| Internet router | Building-provided consumer router (vendor/model TBD) |
| LAN subnet | **TBD** — MUST be different from home's `192.168.1.0/24` to avoid NetBird route collision; user to verify on first visit |
| UniFi Controller | **TBD location** — possibly UDM/UDR (router + controller combo), CloudKey, or self-hosted on a PC; user to confirm |
| Provision NVR | Confirmed present (user-owned, manages all 17 cameras + records 24/7) |
| Internet upload speed | TBD — affects how many simultaneous live camera streams over NetBird are comfortable. Israeli norm: 100 Mbps up on fiber plans |
| Existing always-on devices | TBD — useful to know if any can host NetBird without buying new hardware (Synology/QNAP NAS, UDM Pro, etc.) |

## Gateway hardware decision (open)

Need an always-on Linux-capable device at EK15 to host the NetBird gateway peer + advertise the EK15 LAN subnet to the NetBird mesh. Three viable options:

| Option | Hardware | OS | Cost | Stack parity with home (Proxmox + LXCs) |
|---|---|---|---|---|
| **A. Pi 5 + Debian + Docker** | Raspberry Pi 5 8GB + 64GB microSD or SSD | Raspberry Pi OS Lite / Debian 12 | ~$80 (Pi5 + accessories) | Different — Docker instead of LXCs |
| **B. Pi 5 + Pimox** | Raspberry Pi 5 8GB | Pimox (community ARM port of Proxmox VE) | ~$80 | Close — Proxmox UI, but unofficial, less update support |
| **C. x86 mini PC + Proxmox** | Refurbished thin client OR new Beelink N100 | Proxmox VE 9.x (official) | $60-180 | **Full parity** — same Proxmox stack as home |

**Recommendation: Option C (x86 mini PC + official Proxmox).** Reasons:
- Matches the home stack exactly (LXC tooling, backup story via QNAP NFS, future LXC migration)
- Official Proxmox VE support (security updates, predictable behavior)
- Easier remote recovery (well-trodden path; Pimox bugs would require physical presence at EK15)
- Cost difference vs Pi is small ($30-100) for significant operational simplicity

Specific picks (from POWER/CLAUDE.md research conversation):
- **Cheap:** Dell Wyse 5070 used (~$60-100)
- **Sweet spot:** Beelink Mini S12 Pro N100 new (~$130-180)
- **Used + powerful:** Lenovo ThinkCentre M720q Tiny (~$120-200)

**Final hardware choice: TBD by user at purchase time.**

## NetBird gateway peer setup

Same pattern as the planned LXC 108 at home (per `NETBIRD/CLAUDE.md` self-host plan), but as a CLIENT only — NetBird management plane stays at `app.netbird.io` (hosted free tier) until/unless self-host is built later.

```
Gateway box at Efraim Kazir 15
└── (Proxmox or Debian — see hardware decision above)
    └── LXC or Docker container running NetBird Linux client
        └── netbird up (signed in to same account as home/laptop/phone peers)
        └── Network route advertised: <ek15-lan-subnet>/24
        └── Route approved in app.netbird.io admin
```

**NetBird peer budget on hosted free tier (max 5):**
- Currently used: laptop (`newasus`) + phone = **2 peers**
- + home gateway peer (planned, not installed) = 3
- + EK15 gateway peer (this module) = **4 peers**
- Still within free tier; 1 peer left

**Subnet collision check (critical):** if EK15 uses `192.168.1.0/24` like the home LAN, NetBird CANNOT route both — they'd be ambiguous. One of them must change. Easiest: change EK15's router LAN to something like `192.168.50.0/24` on first visit. Single setting in the building router's admin UI.

## UniFi monitoring (12 APs)

### API surface
UniFi Controller exposes a **REST API** (officially "unofficial" but stable, used by HA + every UniFi monitoring tool). HTTPS on port 8443 (self-hosted) or 443 (UDM).

**Authentication:** POST to `/api/login` with credentials → returns session cookie used for subsequent calls. Recommended: create a dedicated **local "service" user with read-only Site role** in UniFi Controller for the API consumer (less risk than reusing admin creds).

**Key endpoints (for monitoring 12 APs):**

```
GET  /api/login                                  → session cookie
GET  /api/s/<site>/stat/device                   → ALL devices (APs/switches/gateway) with per-device telemetry
GET  /api/s/<site>/stat/device/<mac>             → one device's full stats
GET  /api/s/<site>/stat/sta                      → all currently-connected wireless clients
GET  /api/s/<site>/stat/health                   → controller-wide health summary
GET  /api/s/<site>/stat/sysinfo                  → controller version, uptime
POST /api/s/<site>/cmd/devmgr  {cmd:"restart",mac:"..."}     → reboot an AP remotely
POST /api/s/<site>/cmd/stamgr  {cmd:"kick-sta",mac:"..."}    → kick a wireless client
```

**Per-AP telemetry from `stat/device`:**
- `name`, `mac`, `ip`, `model`, `state` (1=connected, 0=offline), `uptime`, `last_seen`
- `num_sta` (current client count), per-network breakdown
- `radio_table[]` — per-radio: channel, tx_power, channel utilization %, noise floor dBm
- `vap_table[]` — per-SSID: clients on this AP, bytes_tx/rx
- `tx_bytes`, `rx_bytes`, total bytes
- `system-stats`: cpu %, mem %, loadavg
- `temperature` (some models)
- `upgradable`, `firmware_version`

**Volume:** 12 APs × 80-ish fields each = ~10 KB JSON per poll. Trivial.

### Integration architecture
HA's built-in **UniFi Network integration** consumes this API and exposes each AP as a HA device with ~20 entities. Existing pattern in the project:

```
UniFi Controller (LAN at EK15, port 8443)
       │
       │ HTTPS (REST) — reachable from home via NetBird mesh
       ▼
HA on LXC 101 (Home) — UniFi integration polls every ~30 s
       │
       │ HA WebSocket
       ▼
device-agent on LXC 103 (Home) — HA_DIRECT_DEVICES bridges entities → devices table
       │
       ▼
devices table on LXC 102 — one row per UniFi AP, multi-channel DPS shape
       │
       ▼
Dashboard "Project Network" page — new "UniFi" tab next to ARP / Ports tabs
```

### Dashboard surface
New "UniFi" tab on Project Network page (`BOILER/dashboard/public/network.html`). One card per AP:

```
┌──────────────────────────────────────────┐
│  AP Living Room                  ● Online │
│  Model: U6-Pro    Firmware: 6.6.74        │
│  Clients: 5   |   Channel: 36 (5GHz)      │
│  Utilization: 12%   Noise: -94 dBm         │
│  TX: 4.2 GB    RX: 1.8 GB                  │
│  Uptime: 23 days                            │
│  [Reboot AP]  [View clients]               │
└──────────────────────────────────────────┘
```

12 cards in a responsive grid. Sort/filter by status / model / client count / signal quality. Health summary at the top: "12/12 online, 47 total clients, total throughput 8.4 Mbps."

### Optional: per-AP history table
For long-term trends (client count, traffic) per AP:
```sql
CREATE TABLE unifi_ap_history (
  ts            TIMESTAMPTZ,
  ap_mac        TEXT,
  num_sta       INT,
  cpu_pct       NUMERIC(4,1),
  mem_pct       NUMERIC(4,1),
  channel_util  NUMERIC(4,1),
  tx_bytes      BIGINT,
  rx_bytes      BIGINT,
  PRIMARY KEY (ts, ap_mac)
);
```
Retention: 30 days. Written by a small ingest rule on heartbeat (every 60s polls + inserts deltas).

Defer this until after Phase 1 (basic monitoring is live) — only useful if user wants long-term charts.

## Provision NVR + cameras monitoring (17 cameras)

User confirmed: **NVR is on-site at EK15, recording 24/7.** Our integration treats the NVR as the primary endpoint, not individual cameras. Recording stays local (no bandwidth load over NetBird); only metadata + on-demand live view crosses the tunnel.

### API surfaces on the Provision NVR
Three standard protocols, all supported by Provision NVRs (Hisilicon-based hardware, Hikvision ISAPI compatible on most newer firmware):

#### A. ONVIF (industry standard)
- **Use for:** device discovery, capabilities, motion/intrusion/line-cross **events**, PTZ control, snapshots
- **Connection:** `http://<nvr-ip>:80/onvif/device_service` (port varies — ONVIF discovery finds it)
- **Auth:** ONVIF user with appropriate role (separate from web admin)
- **Libraries:** `onvif-zeep` (Python), `node-onvif`
- **HA integration:** built-in `onvif` integration — adds each camera as a HA entity, subscribes to events

#### B. RTSP (live video streams)
- **Use for:** on-demand live view in dashboard
- **URL pattern from NVR (Provision-typical):**
  - `rtsp://<user>:<pass>@<nvr-ip>:554/ch01/0` — channel 1, main stream
  - `rtsp://<user>:<pass>@<nvr-ip>:554/ch01/1` — channel 1, sub-stream (lower bitrate)
- **Bandwidth per stream:** main ≈ 4 Mbps @ 1080p H.264 (2 Mbps with H.265), sub ≈ 1 Mbps
- **Consumed by:** dashboard's `<video>` element via MediaMTX/HLS proxy, OR HA `generic` camera platform, OR VLC

#### C. ISAPI HTTP (Hikvision-compatible API on most newer Provision NVRs)
- **Use for:** snapshots, recording control, search, channel listing, system info
- **Endpoint examples:**
  ```
  GET /ISAPI/System/deviceInfo                                    → NVR identity
  GET /ISAPI/ContentMgmt/InputProxy/channels                      → channel list
  GET /ISAPI/Streaming/channels/<ch>01/picture                    → snapshot
  POST /ISAPI/ContentMgmt/record/control/manual/start/tracks/<ch> → trigger manual recording
  GET /ISAPI/ContentMgmt/search                                   → search recorded clips
  ```
- **Auth:** Digest authentication with NVR admin user
- **Library:** `hikvisionapi` (Python) — works against most Provision NVRs

**Verify ISAPI is enabled** in NVR's Network → Advanced settings before relying on it. Some Provision firmwares need it explicitly enabled.

### Bandwidth math + recording strategy

| Scenario | Bandwidth load over NetBird |
|---|---|
| Snapshot per camera every 5 min | 17 × 100 KB / 5 min = ~5 KB/s total. Trivial. |
| Event-driven snapshot on motion | Spiky but tiny total volume. |
| ONVIF event subscription (alarms) | <1 KB per event. Trivial. |
| 1 camera live (RTSP main stream) | 4 Mbps |
| 4 cameras live simultaneously | 16 Mbps |
| All 17 live simultaneously | **68 Mbps** — borderline on a 100 Mbps fiber upload at EK15 |
| 24/7 recording of all 17 cameras | NOT done over NetBird. Recording stays local on the NVR. We only pull a clip on demand. |

**Design rule: live RTSP is on-demand only.** Dashboard tile per camera shows a snapshot (refreshed every 30-60 s). When user clicks a tile, it switches to live RTSP for that ONE camera. Reduces idle bandwidth to ~5 KB/s; only spikes when actively watching.

### Integration architecture

```
17 Provision cameras → Provision NVR (LAN at EK15)
                              │
                              ├── ONVIF events (motion, line-cross, intrusion)
                              ├── RTSP streams (on demand)
                              └── ISAPI HTTP (snapshots, recordings, search)
                              │
                              │ All reachable from home via NetBird mesh
                              ▼
HA on LXC 101 — onvif integration polls events + snapshots
       │
       │ HA WebSocket
       ▼
device-agent on LXC 103 — HA_DIRECT_DEVICES bridges 17 cameras → devices table
       │
       ▼
devices table — 17 rows (one per camera), device_type='camera', protocol='ha_api'
       │
       ▼
Dashboard "Cameras" page (new) — grid of 17 snapshot tiles + on-demand live view
```

### Dashboard surface
New top-level "Cameras" page (sidebar). Two cards:

**Card 1 — NVR Status**
```
┌──────────────────────────────────────────┐
│  Provision NVR @ Efraim Kazir 15  ● Online │
│  Firmware: 1.2.34   Channels: 17/17 active │
│  Storage: 8 of 12 TB used (recording 24/7) │
│  Last event: motion ch07, 2 min ago         │
└──────────────────────────────────────────┘
```

**Card 2 — Cameras grid**
17 tiles in a responsive grid. Each tile:
- Snapshot (auto-refresh every 30-60 s when tab is foreground; pause when tab not visible)
- Online/offline badge
- Last motion timestamp
- Click → fullscreen live RTSP via MediaMTX/HLS proxy

**Optional anomaly rules:**
- `kazir15:camera_offline` — camera offline > 5 min
- `kazir15:nvr_storage_low` — NVR storage > 90% full
- `kazir15:motion_event` (informational, only published to MQTT; not an alert)

### DB additions

Optional small history table for camera events (useful for forensics):
```sql
CREATE TABLE camera_events (
  ts          TIMESTAMPTZ,
  camera_id   TEXT,
  event_type  TEXT,           -- 'motion', 'line_cross', 'intrusion', 'video_loss'
  snapshot_path TEXT,         -- if we save a frame at event time
  PRIMARY KEY (ts, camera_id)
);
```
Retention: 30 days. Written by a `kazir15:camera_event_log` rule subscribing to ONVIF events via HA.

Snapshots themselves NOT stored long-term — too much volume. Only event frames if explicitly captured.

## Integration with existing project

Reuses everything that's already in place:

| Existing component | Reused for |
|---|---|
| **NetBird VPN** (per `NETBIRD/CLAUDE.md`) | Transport bridge to EK15 LAN |
| **HA on LXC 101** | UniFi + ONVIF integrations |
| **device-agent on LXC 103** — `HA_DIRECT_DEVICES` pattern | Bridging HA entities → devices table for all 12 APs + 17 cameras |
| **devices table on LXC 102** | Per-AP rows + per-camera rows |
| **Rule engine on LXC 105** | Camera-offline / NVR-storage-low / UniFi-AP-offline alerts |
| **system_alerts table + sidebar Status badge** | Surfacing the new alerts |
| **Project Network page (existing)** | Adding UniFi tab |
| **New top-level Cameras page** | Camera grid + NVR card |

**No new LXC, no new ingest service.** Just adds 29 new devices (12 APs + 17 cameras) routed through the existing HA → device_agent path.

## Setup steps

| # | What | Where | Status |
|---|---|---|---|
| 1 | Buy gateway hardware (Pi 5 OR x86 mini PC) | — | ⏳ user decision pending |
| 2 | Install OS (Debian/Pimox/Proxmox) | gateway box | ⏳ |
| 3 | Take box to Efraim Kazir 15, plug into LAN | EK15 | ⏳ |
| 4 | Verify EK15 LAN subnet ≠ home subnet (change router if collision) | EK15 router | ⏳ |
| 5 | Install NetBird client + advertise EK15 subnet | gateway box | ⏳ |
| 6 | Approve route in `app.netbird.io` | web | ⏳ |
| 7 | Verify home → EK15 LAN reachability (`ping <unifi-controller-ip>` from LXC 103) | home | ⏳ |
| 8 | Create dedicated UniFi service user (read-only Site role) | UniFi Controller | ⏳ |
| 9 | Add UniFi integration to HA on LXC 101 | HA UI | ⏳ |
| 10 | Add `HA_DIRECT_DEVICES` entries for 12 APs + INSERT 12 `devices` rows | repo + LXC 103 | ⏳ |
| 11 | Verify per-AP DPS values landing in `devices.last_state` | dashboard | ⏳ |
| 12 | Enable ONVIF on Provision NVR + create ONVIF user | NVR UI | ⏳ |
| 13 | Add ONVIF integration to HA for the NVR (auto-discovers 17 cameras) | HA UI | ⏳ |
| 14 | Add `HA_DIRECT_DEVICES` entries for 17 cameras + INSERT 17 `devices` rows | repo + LXC 103 | ⏳ |
| 15 | CREATE `camera_events` + `unifi_ap_history` tables + retention policies | LXC 102 | ⏳ |
| 16 | Build UniFi tab on Project Network page | dashboard | ⏳ |
| 17 | Build new Cameras page on dashboard | dashboard | ⏳ |
| 18 | Configure MediaMTX (or similar) on LXC X for RTSP→HLS transcoding (for browser-friendly live view) | new LXC OR home Proxmox | ⏳ |
| 19 | Wire camera-offline / NVR-storage-low / UniFi-AP-offline alert rules | LXC 105 | ⏳ |

## Phase rollout

| Phase | Effort | What ships |
|---|---|---|
| **P1 — NetBird bridge** | ~1 day | Steps 1-7. End state: home LXCs can ping anything on EK15 LAN via NetBird tunnel. No app data flowing yet — just transport. |
| **P2 — UniFi monitoring** | ~1-2 days | Steps 8-11 + Step 16. End state: 12 APs visible on the Project Network page's new UniFi tab; per-AP health, clients, traffic all live. |
| **P3 — Cameras monitoring** | ~2 days | Steps 12-14 + Step 17. End state: 17 cameras visible on new Cameras page with snapshots + online status. Live RTSP view on click via MediaMTX. |
| **P4 — Camera events + alerts** | ~1 day | Steps 15 + 18 + 19. End state: ONVIF motion events logged to `camera_events`; alerts fire for offline cameras / NVR storage / offline APs. |
| **P5 — History + trend charts** (optional) | ~1 day | `unifi_ap_history` ingestion + per-AP trend charts (client count, traffic over time). Defer unless user wants forensics. |

Total: ~5-7 days spread over a few weeks. Each phase independently shippable.

## Open decisions

1. **Gateway hardware** — Pi 5 + Debian, Pi 5 + Pimox, OR x86 mini PC + Proxmox? Recommendation: x86 mini PC + Proxmox for stack parity. User to pick at purchase time.
2. **EK15 LAN subnet** — must not collide with home `192.168.1.0/24`. Confirm or change on first visit.
3. **UniFi Controller host** — UDM Pro? CloudKey? Self-hosted? Determines which IP/port the API lives on.
4. **EK15 internet upload speed** — affects multi-camera live view comfort.
5. **Existing always-on devices at EK15** — anything that could already host NetBird (Synology/QNAP NAS, UDM Pro with udm-boot, etc.) before buying new hardware?
6. **MediaMTX placement** — RTSP→HLS proxy for browser-friendly live view. Could run as LXC on EK15 gateway (closer to NVR, less tunnel hop) OR on home Proxmox (centralized). Defer to P3 build.
7. **Long-term snapshot storage** — keep only event-time frames? Keep one per camera per hour? Or no snapshot storage (always-fresh from NVR)? Defer to P4 build.

## File / location index

| Artifact | Path |
|---|---|
| This doc | `KAZIR_15_NETWORK/CLAUDE.md` |
| Existing transport layer | `NETBIRD/CLAUDE.md` + `NETBIRD/MOBILE/CLAUDE.md` |
| `ha_api.py` adapter (existing, edited for UniFi + ONVIF entries) | `DEVICE/agent/adapters/ha_api.py` |
| Deployed adapter | `/opt/device-agent/adapters/ha_api.py` on LXC 103 |
| Rules | `RULES/rules/kazir15_*.py` (alerts in P4) |
| Dashboard pages | `BOILER/dashboard/public/network.html` (UniFi tab) + `BOILER/dashboard/public/cameras.html` (new page) |
| Dashboard endpoints | `BOILER/dashboard/server.js` — new `/api/unifi/*`, `/api/cameras/*` routes |
| DB migrations | `BOILER/dashboard/migrations/<date>_kazir15_tables.sql` |

---

**Update protocol:** keep this doc current as decisions land. New design questions → add to Open Decisions. Resolved decisions → fold into the spec sections. After first phase ships → add a "Lessons Learned" section before the file index.
