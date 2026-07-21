# KAZIR_15_NETWORK — Second-Site Network Infrastructure at Efraim Kazir 15

> **Status (2026-07-12):** a **network-presence monitor is BUILT + LIVE** — via a completely different, simpler approach than the NetBird/UniFi/camera plan documented below. **The user rejected NetBird.** See the ✅ BUILT section immediately below. Everything after it (NetBird gateway + UniFi API + Provision cameras) is **deferred / superseded for transport** — kept only as reference for possible future richer monitoring; the live KZ15 integration today is the ESP32 board.

## ✅ BUILT (2026-07-12) — ESP32 + W5500 network-presence monitor

A **dual-homed ESP32 board** bridges the KZ15 building network into the project **without NetBird** — the user's apartment is *inside* the KZ15 building, so the board sits in the apartment with both networks physically present:

- **Hardware:** ESP32-WROOM-32 + **WIZnet W5500** SPI Ethernet (VSPI: MOSI 23 / MISO 19 / SCLK 18 / CS 5 / INT 4 / RST 2, 3.3 V).
- **Dual-homed:** **WiFi → home** (`192.168.1.167`, MQTT uplink to broker `192.168.1.189`) + **W5500 Ethernet → KZ15 building LAN**. KZ15 turned out to be **`192.168.1.0/24` — the SAME subnet as home** (gw `.1`), but it's a *separate physical network*, so it's fine: the board reaches KZ15 over Ethernet and home over WiFi. No subnet change, no NetBird. Proven by data (0 of the KZ15 devices exist in home `net_devices`).
- **v8 (2026-07-21) — phantom-MAC fix.** v7 stored an **uninitialised stack buffer as the MAC** (junk `01:00:00:00:64:00`, rotating IPs) whenever a host answered ICMP but had **no ARP entry** (a routed / proxy-ARP responder, e.g. the gateway answering for absent IPs): `pingProbe` returned `reply || mac` and the caller ran `s_has_mac[o]=true; memcpy(s_mac[o],mac,6)` **unconditionally** even when `resolveMac()` failed and `mac[6]` was never filled. v8 threads a `mac_ok` out-param through `pingProbe` and records the MAC **only when the ARP cache actually resolved it** — an ICMP-only responder is reported up with **no MAC** (never forged). The ingest COALESCEs MACs, so existing junk rows must be cleared once (`UPDATE kazir15_hosts SET mac=NULL WHERE mac='01:00:00:00:64:00'` or DELETE) — they don't regenerate after v8.
- **✅ OTA WORKS (fixed v9, confirmed v11, 2026-07-21) — the board is on `v11`.** It was broken because the board is **dual-homed on the SAME `192.168.1.0/24`** (WiFi `.167` + W5500 ETH `.139`). **The real root cause (proven by packet capture): the board's ArduinoOTA CONNECT-BACK to the OTA host egressed the ETH interface (EK15) instead of WiFi**, so it never reached the host and OTA died at the invitation ("No response", zero OTA events). *Inbound* was always fine — a tcpdump showed the board received the SYN and RST'd it correctly over WiFi; it was the board's **outbound** OTA TCP that took the wrong interface. **Why:** lwIP PREPENDS netifs and `ip4_route()` returns the FIRST list entry matching a destination's subnet = the LAST-added netif. WiFi was brought up first, ETH second → ETH at the head → won the shared-subnet route. **Fix (v9): bring ETH up BEFORE WiFi in `setup()`** so WiFi is added last → wins the route → connect-back egresses WiFi. (v8's `esp_netif_set_default_netif` alone did NOT work — the default netif is only consulted for off-link destinations, never for an on-link subnet.) `preferWifiDefaultRoute()` is kept as belt-and-suspenders. The EK15 scan is unaffected — `esp_ping` pins to ETH via `cfg.interface`. **Confirmed working from the dashboard OTA button, the Windows host, AND LXC 104** — the board OTA-reflashed itself to v11 and rebooted each way, while dual-homed. ⚠ ESP OTA is occasionally flaky mid-transfer (`OTA error 4` at the final verify) — just retry; the 2nd attempt lands. So **OTA is the normal update path now — no USB needed.** (v8-only-USB claim was WRONG — the routing direction was misdiagnosed until the packet capture.)
- **Phantom-MAC fixed LIVE at the ingest (2026-07-21) — no board flash needed.** `scripts/kazir15_ingest.py` `_clean_mac()` drops any **multicast/broadcast MAC (I/G bit set on the first octet)** before storing, so the v7-forged junk (`01:00:00:00:64:00`) never reaches the DB (deployed to `/opt/kazir15_ingest.py` on LXC 104 + `systemctl restart kazir15-ingest`; existing junk cleared with `UPDATE kazir15_hosts SET mac=NULL WHERE mac='01:00:00:00:64:00'`). The v8 firmware fixes it at the source too, but the ingest filter makes it correct regardless of firmware.
- **Discovery = ARP-aware sweep (`Net_Scan.ino` v8).** For each IP in the KZ15 /24 it sends an ICMP via **`esp_ping`** (which *forces an ARP resolution* on the way) and marks the host **up if it replied OR resolved in the lwIP ARP cache** — so **power-save devices (the KZ15 Deco APs) that answer ARP but ignore ping are still caught**. This mirrors the home `arp_scan.py` L2 approach. `esp_ping` is **pinned to the ETH interface** (`cfg.interface`) so every probe goes to KZ15, not the same-subnet home WiFi. **⚠ Do NOT use raw `etharp_request` + `LOCK_TCPIP_CORE` from the loop task** — that DEADLOCKED the board mid-sweep (the abandoned v6); `esp_ping` (own task) + a cache *read* is the safe pattern.
- **Board = esp_boards subsystem** (`id='kazir_15'`, Project Boards tab, OTA, schema, `scan_now`/`eth_info` actions, `Network Monitor` action-group card in `esp-boards.js`). No BLE → OTA works normally. Params: `scan_interval_sec` (300) / `ping_timeout_ms` (300, = ARP reply wait) / `hosts_per_tick` (4).
- **Firmware source:** `C:\Users\muroc\Arduino_Projects\Kazir_15\` (`Kazir_15.ino` + `Main.h` + `Esp_Base.ino` + `Net_Scan.ino`). **NOT in the repo** (bakes WiFi/MQTT/OTA creds). Deploy = USB (or OTA once running). Sketch prints `==== Kazir_15  v<N>  (built …) ====` at boot.

### Data flow + storage (all separate from the home inventory)
```
board → mur/home/esp/kazir_15/{status,event}  (MQTT, broker LXC 107)
  /status → rule engine → esp_boards.last_status  (eth link/ip/gw, host counts, scan progress)
  /event kind:"scan" → kazir15-ingest.service (LXC 104, scripts/kazir15_ingest.py)
        → kazir15_hosts (LXC 102): mark-subnet-down + upsert up-hosts + 30-min stale prune
routes-kazir15.js → GET /api/kazir15/hosts (+ kazir15_names join) + /status, POST /api/kazir15/name
Kazir 15 page (kazir-15.html + js/kazir-15.js, LAST sidebar entry, all 21 pages)
```
- **DB (LXC 102):** `kazir15_hosts` (ip PK, mac, up, subnet, first/last_seen, last_scan_at) + `kazir15_names` (mac PK → user name). Both retention=forever, in Health DB-Volumes group **"Kazir 15"**.
- **Ingest (LXC 104):** `kazir15-ingest.service` (sibling of `owntracks-ingest`), MQTT user `esp_boards`, env `/etc/kazir15-ingest.env`. Reuses the shared `esp_boards` broker user.
- **Page features:** connected-device list with **15-min online grace** (a device seen in the last 15 min shows "connected" even if it missed the latest sweep — masks Deco power-save flicker, same idea as the home scanner's `ONLINE_GRACE_MIN`); **per-MAC device naming** (inline edit, saved by MAC so it survives IP change / prune; `_kzEditing` gates the auto-refresh so typing isn't clobbered); **Scan Now** (fires the board's `scan_now`); board summary card (eth link/ip/gw, host counts).

### Scope + known limits
- v1 = **read-only presence + reachability** ("who's connected on KZ15" + up/down). **No traffic/bandwidth** (lives in the switches/controller, not on the wire) and **no device control** — those would need per-device APIs.
- Very-stubborn responders can be missed for long stretches (e.g. a Deco silent > 30 min gets pruned). Mitigation if needed: raise `ping_timeout_ms`, or a firmware retry (probe each host 2–3×). The loop-task WDT is disabled, so a *future* firmware hang wouldn't self-recover (v7 doesn't hang).
- Deploy commit: `d8e11c2` (dashboard + ingest + backend; firmware separate).

---

## (DEFERRED / SUPERSEDED) Original NetBird + UniFi + cameras plan
> The sections below were the original 2026-05-24 scope. **NetBird was rejected** for the presence monitor above. These remain as reference IF richer monitoring (UniFi AP telemetry, camera feeds) is ever wanted — but they are NOT the current implementation.

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
