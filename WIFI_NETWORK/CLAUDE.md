# WIFI_NETWORK — Apartment WiFi Visualization

Dashboard-only agent (no LXC service). Visualizes WiFi signal coverage, mesh distribution, and interference across the apartment using the existing fleet of ESP boards as fixed-position signal probes. Each board piggybacks RSSI + BSSID + SSID on its existing `/status` MQTT payload — no new hardware, no new infrastructure.

Surface: **new tab "WiFi" on existing Project Network page** (`BOILER/dashboard/public/network.html`). Sibling of the existing ARP scan + port view that already live on that page.

## Why it works on existing infrastructure

The project already has:
- ESP boards in **known fixed positions** (each registered in `room_device_placements` with a room + coordinates)
- MQTT bus on LXC 107 + `esp_boards` registry on LXC 102
- Rule engine on LXC 105 that projects ESP `/status` fields into `devices.last_state`
- Dashboard apartment layout that already renders devices per room

So we get fixed-location WiFi signal probes "for free" — each board IS already a probe; we just need it to report RSSI.

## Mesh setup assumption

User's apartment uses a **TP-Link Deco mesh** (multiple physical units, single SSID e.g. `Oikos Living`, each unit has its own BSSID per band). Boards associate with whichever Deco gives them the strongest signal — so each board's reported BSSID tells us **which physical Deco unit is serving that room**.

## Phase 1 — Baseline: RSSI per board

### Sketch-side (1 board edit = 3 lines)

Wherever the board's existing publish-status function builds its JSON payload, add:

```cpp
doc["rssi"]  = WiFi.RSSI();        // dBm, negative number
doc["ssid"]  = WiFi.SSID();        // mesh SSID
doc["bssid"] = WiFi.BSSIDstr();    // unique per Deco unit per band
```

Portable across ESP8266 and ESP32 — same API on both. No new libraries, no new MQTT topics. Goes out on the same `mur/home/esp/<id>/status` topic every board already uses.

### Server-side (rule engine)

Extend `_ESP_STATUS_DPS_FIELDS` in `RULES/rule_engine.py` to include `rssi`, `ssid`, `bssid`. Same pattern as `pump_state`, `door_relay`, etc. — fields get projected into `devices.last_state` and an event is fired so subscribed rules see updates.

### Deco BSSID → name mapping

Stored as a single row in `dashboard_settings`, key `network.deco_units`, value:

```json
{
  "AA:BB:CC:11:22:33": { "name": "Living Room Deco", "band": "5G" },
  "AA:BB:CC:11:22:34": { "name": "Living Room Deco", "band": "2.4G" },
  "AA:BB:CC:55:66:77": { "name": "Bedroom Deco",     "band": "5G" },
  ...
}
```

Discovered once: walk around with laptop, do `netsh wlan show interfaces` next to each Deco unit, record the BSSID that returns ~-30 dBm. Or get the list directly from the Deco app.

### Dashboard chip per room

Each room layout gains a small chip:

```
📶 -58 dBm · Living Room Deco
```

Colour: green ≥ -55 dBm, yellow -55..-70, red < -70.

## Phase 2 — Coverage zones (Deco serves which rooms)

Render the apartment layout with each room **filled by the colour assigned to its Deco**:

- All rooms served by Living Room Deco = blue tint
- All rooms served by Bedroom Deco = green tint
- Rooms with no probe (no board in them) = grey hatched

Brightness modulated by RSSI (deeper = better signal). Instantly shows mesh service boundaries.

Diagnostic patterns this exposes:

| Pattern | What it tells you |
|---|---|
| Multiple rooms all on ONE Deco at low RSSI | Other Decos are dead, or sticky-client problem |
| Each Deco serves nearby rooms at strong RSSI | Mesh is working as designed |
| Adjacent rooms on different Decos | Roaming threshold healthy here |
| One room flips between BSSIDs each scan | Borderline coverage — possible packet drops |

## Phase 3 — RSSI heatmap interpolation

Boards are at known coordinates; interpolate signal between them across the apartment grid (**inverse-distance weighting** — simple sum of (RSSI / dist²) / sum of (1 / dist²) over each grid cell). Result: estimated RSSI at every point of the apartment, not just where boards live. Rooms without probes get a continuous best-guess colour. Like a weather map for WiFi.

Implementation lives in dashboard JS; same 1m grid that the apartment layout already uses.

## Phase 4 — Per-band split (2.4 GHz vs 5 GHz)

Add a periodic `WiFi.scanNetworks()` task on each board (every 5-10 min, not every status — scan disrupts WiFi for ~3 s). Publish results to a separate topic `mur/home/esp/<id>/wifi_scan` with the list of visible APs filtered to the user's home SSID, per band.

Dashboard adds a toggle: **2.4 GHz / 5 GHz / both**. Two overlays you can switch between. Useful because:

- 2.4 GHz penetrates walls; 5 GHz dies through concrete
- IoT devices that only support 2.4 GHz care which rooms still have it
- Per-band Deco performance can differ — one band may be misconfigured

## Phase 5 — Channel congestion view

Same `WiFi.scanNetworks()` data, different visualization: aggregate across all boards to show **which channels are being used in your area, by your APs AND neighbours**. A bar chart per channel (1, 6, 11 for 2.4 GHz; 36, 40, ..., 165 for 5 GHz) showing total power density (sum of RSSI of all APs on that channel).

Tells you immediately:

- Whether your Decos are on crowded channels
- Whether a neighbour just moved in and is squatting on your channel
- Best channel for manual override in Deco app

## Phase 6 — Roaming events log

When a board's BSSID changes between status messages, log a row in a new table `wifi_roaming_events`:

```sql
CREATE TABLE wifi_roaming_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  device_id TEXT NOT NULL,
  from_bssid MACADDR,
  to_bssid MACADDR,
  from_rssi SMALLINT,
  to_rssi SMALLINT,
  room TEXT  -- looked up at write time
);
```

Retention: 30 days. Dashboard shows:

- Total roams in last 24 h
- Rooms that roam most often (= borderline coverage)
- "Heat map of roaming" — overlay on apartment layout

Add row to `retention_policies` seed and to the `/api/health/db-volumes` table list, per the project's existing pattern.

## Phase 7 — Real throughput (not just RSSI)

RSSI = "how loud the AP sounds at the receiver". Doesn't tell you about retries, interference, packet loss, channel utilization. The thing users actually care about is **usable bandwidth**.

Add a simple HTTP download benchmark: each board, every N hours, fetches a fixed ~512 KB file from a small endpoint on LXC 103, times it, publishes Mbps. Store in `wifi_throughput_log` table. Dashboard shows Mbps per room over time.

Tradeoff: every test consumes some WiFi bandwidth + slightly stresses the board. Run no more than every 6 h per board, ideally during sleep hours.

## Phase 8 — Walking survey

Script on the user's laptop that polls `netsh wlan show interfaces` every 1 s while the user walks through the apartment. Each room press a key to label it. Output: dense RSSI samples per room from a moving probe at human height, complementing the fixed-position board data.

Pure laptop script, no new infrastructure. Could even be a single PowerShell script in `scripts/wifi_walk_survey.ps1`.

## Phase 9 — Neighbour SSID census

The `WiFi.scanNetworks()` results from Phase 4 already include neighbour SSIDs. List them per room with signal level:

- Identifies the wall the neighbour's router sits against
- Detects new APs (someone moved in → re-evaluate channel choice)
- Spots rogue APs

Privacy note: this is passively-broadcast info, anyone with a phone can see it. Not a privacy violation. Just be thoughtful about how visibly you display neighbour SSIDs in the dashboard — maybe mask all but first 3 chars by default.

## Build order recommendation

1. **Phase 1** — baseline RSSI, Deco mapping, per-room chip. ~30 min when home.
2. **Phase 2** — coverage zones (Deco-colour fill). High visual impact, low effort given Phase 1 is done.
3. **Phase 3** — heatmap interpolation. Prettiest. Dashboard-side only — no new sketch work.
4. **Phase 5** — channel congestion (needs Phase 4 scan data). Most actionable for performance.
5. **Phase 4** — per-band split (the data backing 5).
6. **Phase 6** — roaming events. Diagnostic gold once Phase 1 is live.
7. **Phase 7-9** — refinements as the visualization needs grow.

Phases 1-3 should land same evening when user is home. The rest is iterative.

## Tables / settings introduced

| Table or key | Type | Purpose |
|---|---|---|
| `dashboard_settings.network.deco_units` | JSONB | BSSID → Deco name mapping |
| `devices.last_state.rssi/ssid/bssid` (existing column) | JSONB sub-keys | Per-board WiFi state, written by rule engine |
| `wifi_roaming_events` (Phase 6) | new table | History of BSSID transitions |
| `wifi_throughput_log` (Phase 7) | new table | History of measured Mbps |
| `retention_policies` rows (Phase 6+7) | existing table | 30 days / 90 days respectively |

## Dashboard touchpoints (when implementing)

- New tab `WiFi` in `BOILER/dashboard/public/network.html` (sibling of ARP / Ports tabs)
- New routes:
  - `GET /api/wifi/status` — per-device RSSI/SSID/BSSID + Deco resolution + room
  - `GET /api/wifi/decos` — Deco mapping (paired with PATCH for editing)
  - `GET /api/wifi/heatmap` (Phase 3) — interpolated grid
  - `GET /api/wifi/scan` (Phase 4) — full scan results aggregated
  - `GET /api/wifi/channels` (Phase 5) — congestion bar data
  - `GET /api/wifi/roaming?days=N` (Phase 6) — roaming events
- JS module `BOILER/dashboard/public/js/wifi-network.js`
- Updates to alerts? Maybe — could raise `wifi:bad_coverage:<device_id>` when RSSI < -75 for > 1 h. Defer to Phase 6.

## What is NOT covered by this plan

- **Actual RF radiation exposure (μW/m²)** — needs a hardware RF meter. WiFi RSSI tells you about signal strength, not power density across the whole RF spectrum. If the goal becomes EMF exposure mapping rather than coverage, add a Cornet ED88TPlus / GQ EMF-390 to the project and instrument it separately.
- **Bluetooth signals** — different stack, separate plan if ever needed.
- **Wired LAN performance** — out of scope; the `net_devices` + `net_ports` ARP/SNMP scanners on LXC 104 already cover that.

## Deco direct integration — pull per-client WiFi data from the mesh (TODO — NEXT SESSION)

**Decision (2026-06-17):** the preferred RSSI/coverage source is the **TP-Link Deco mesh itself**, not (only) the ESP-board probes. Pull the connected-client list from the Deco via its reverse-engineered **local admin API** (the same one the Deco app + the community `ha-tplink-deco` integration use — log into the main Deco with the **Deco-app / TP-Link-ID password**, RSA+AES-encrypted requests). This covers **every WiFi client** (phones, TVs, all 12 WiFi presence sensors, ESP boards) with **no firmware edits** — far more probe points than the boards. (The WiFi presence sensors are all on WiFi at known room positions but **expose no RSSI of their own** — Tuya/HomeKit don't surface it — which is why the Deco side is the unlock.)

**Mesh inventory** (from `net_devices` — 6 units in **AP mode** behind the Technicolor gateway `192.168.1.1`):

| Unit | Model | IP | MAC |
|---|---|---|---|
| DECO Living Room | X50 | 192.168.1.117 | b4:b0:24:d8:a6:b0 |
| DECO Entrance | X50 | 192.168.1.121 | ac:84:c6:39:8e:98 |
| DECO Guy Room | X20 | 192.168.1.139 | 54:af:97:73:be:98 |
| DECO Balcony | X50 | 192.168.1.168 | b4:b0:24:d8:a6:a0 |
| DECO Hallway | X50 | 192.168.1.177 | b4:b0:24:d8:a6:a8 |
| DECO Laundry | M5 | 192.168.1.234 | d8:07:b6:ca:61:f8 |

Home SSID is **`Home`** (single SSID across all units; replaces the `Oikos Living` placeholder used elsewhere in this doc).

**What the Deco client list reliably gives:** per-client **which Deco unit + which band** → delivers the **Phase-2 coverage-zone map** for the whole apartment with zero ESP work (Deco unit names already map 1:1 to rooms). **Per-client RSSI in dBm is firmware-dependent** on X50/X20/M5 — it is NOT confirmed and must be verified with a live query before relying on it.

**Open items for next session:**
1. Get the **Deco app/admin password** from the user (logging into the router — explicit credential needed).
2. **Feasibility query** against ONE unit (the main controller in AP mode): dump the client-list JSON and check whether a signal/RSSI field is present.
3. If RSSI is present → feeds Phase 1/3 (per-room chip + heatmap) for ALL clients. If only unit+band → still delivers Phase 2 zones for free.
4. Implement as a **poller on an LXC** (104 timers or 103 — NOT the Windows dashboard, per the architecture rule) writing per-client `{deco_unit, band, rssi?}` to the DB; dashboard reads it.

## Status

Documentation only — no code written yet. **Next session: the Deco direct-integration feasibility test above (needs the Deco app password).** Build starts when the user is back on the home network and Phase 1 sketch edits + Deco mapping discovery are done. Related work: [XIAO_STREAMING/CLAUDE.md](../XIAO_STREAMING/CLAUDE.md) — same evening's other documentation task.

## References

- WiFi.RSSI / WiFi.BSSID / WiFi.scanNetworks API — built into Arduino-ESP32 and Arduino-ESP8266 cores, no library needed
- Inverse-distance-weighting interpolation — standard GIS technique, ~20 lines of JS
- Existing `esp_boards` framework conventions — root [CLAUDE.md](../CLAUDE.md) under "Rule engine on LXC 105 — ESP integration"
