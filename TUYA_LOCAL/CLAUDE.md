# Tuya Local Migration — eliminate the HA Tuya cloud dependency

**Status: Phase 1 EXECUTED 2026-08-06 — 22 of 45 switch-like local Tuya devices now dispatch on/off
LOCALLY (cloud-independent); 15 are FIRMWARE-LOCKED (stay on HA cloud); rest deferred.** This folder is the
design doc / index for moving **all** Tuya devices to local control so the HA Tuya *cloud* integration (and its
recurring **IoT Core** subscription) can be dropped. Live planning notes in the scratch plan file
`.claude/plans/focun-on-privacy-people-dazzling-seal.md`.

## Phase 1 outcome (2026-08-06) — what actually happened
- **Mechanism (verified end-to-end, incl. the Dressroom pilot):** a local Tuya device with a
  `dps_config.<ch>.dps_on/dps_off` **recipe** dispatches on/off over local TCP (`tinytuya set_multiple_values`)
  with NO cloud. The **rule engine already** rewrites `turn_on/off`→`set_dps` (`_resolve_local_dps`); the
  **device agent** now resolves the recipe locally in `_handle_command` (`_resolve_local_recipe` +
  `self._dps_onoff` cache built in `_load_devices`); the **dashboard `/toggle`** publishes to
  `mur/home/device/<id>/command` for any local device **with a recipe** (else keeps the HA path).
- **Recipes derived + written by** `scripts/tuya_local_phase1_derive.py` (dry-run → `--commit`; per-channel
  boolean validation; skips ch 7/8, DPS 41 decoy, cloud_authoritative_dps; single→DPS 1, light→DPS 20; flags
  ambiguous for manual). 36 auto-written; then the 15 firmware-locked ones had their recipes **removed** (revert
  to `dps_config={}` → HA path) once found unreachable.
- **✅ 22 devices are now local** (cloud-immune): most single lights + Corridor, Entrance Monitor, My Room
  Stereo, RemoteXY, Tv Wall, Dressroom, Star Projector-style.
- **❌ 15 multi-gang wall switches are FIRMWARE-LOCKED** — correct key (cloud-confirmed) + open port 6668 +
  ping OK, yet the local Tuya handshake fails `Err 914/901` on every version and they don't broadcast. Two
  hardware types only: `jzQA5vi0nxwAK1Hd` (3-gang ×9) + `igrmQHvAQLDY6uzc` (2-gang ×6). Opened one → module is
  **`TYWE3S` = ESP8266** (not BK7231) → flashable with **ESPHome/Tasmota** (tuya-convert OTA long-shot on 2020
  patched fw, else serial via the exposed TYWE3S pins VCC/GND/TXD0/RXD0/GPIO0/EN). Until flashed they stay on the
  **HA cloud** path (work as before). **Full flashing reference (chip, device list + ids, OTA + serial steps,
  wiring, ESPHome/MQTT re-integration, safety): [`TUYA_LOCAL/FLASHING.md`](FLASHING.md).**
- **Cloud state note:** the HA Tuya integration OAuth (Smart Life login) is separate from the **developer IoT
  Core** API (`adapters/tuya_config.py` `tinytuya.Cloud`). During this work the gateway-poll API returned "No
  permissions" but the **developer device-details + commands APIs still worked** (fetched keys, controlled the 15
  via cloud) — so the 15 are NOT lost on Oct-6 as long as the HA Smart Life login is re-authable. A developer-cloud
  control fallback was prototyped in the agent then **reverted** (user chose not to lean on the cloud).
- **Deferred (not touched):** 6 MANUAL devices (8-Gang mode/cloud-auth, Boiler Valve+Switch [safety], Table lamp
  DPS-mismatch, Pentagon DPS 1-vs-20, Smart Toilet multi-bool) + Star Projector (no local ip/key in DB).

## Why
The Tuya **IoT Core** subscription (Tuya IoT Platform, project "Project Home") is a **once-per-account free
trial** that keeps expiring (extended to **2026-10-06**). When it lapses, the HA **Tuya cloud** integration
fails auth ("Authentication expired") and every cloud-dependent Tuya path breaks (AWAY button, boiler valve
state visibility, water valves, IR remotes…). The paid Tuya editions are **enterprise-priced (~$55k)** — not
an option for a home. Goal: make Tuya work WITHOUT the cloud so the subscription becomes irrelevant.

## Key finding (code-verified + live DB, NOT guessed)
- **STATE is already ~fully local.** During the 2026-08-05 cloud outage, `protocol='local'` devices read as
  **60 `local_poll` + 5 `tcp_push`, only 1 `ha_api`** (Multi-Mode Gateway). The `ha_api` labels seen while the
  cloud is UP are just HA winning the source-priority race (`ha_api`=4 > `local_poll`=2, `DEVICE/CLAUDE.md`).
  `last_source` is a STATE label only — it never affects command routing.
- **The real gap is COMMAND dispatch.** A plain `turn_on`/`turn_off` for a local Tuya device reaches the device
  agent `_handle_command` (`DEVICE/agent/device_agent.py:519-611`), which does: (1) `set_dps` → local TCP
  (bypasses HA); (2) `turn_on/off` **only if** `device_id ∈ LOCAL_CONTROL_IDS` (today ONLY the Corridor Switch,
  `:61-63`) → local TCP; (3) **otherwise → `_resolve_entity` → `requests.post(HA/api/services/...)` →
  HA→Tuya-cloud** (`:573-606`). So most local Tuya CONTROL depends on HA today.
- The **local write path is fully cloud-independent**: `adapters/tuya.py` `set_state` →
  `tinytuya.Device(...).set_multiple_values(dps)` (`:934-947`), reachable via `POST /api/devices/:id/dps`
  (`server.js:7809`) and via rule `dps_config.<ch>.dps_on/dps_off` (Star Projector pattern, `_resolve_local_dps`
  `rule_engine.py:2044-2059`).
- **local_key bootstrap is the only remaining cloud touch:** keys fetched once via `tinytuya.Cloud`
  (`adapters/tuya_cloud.py`, creds `TUYA_API_KEY`/`SECRET` in the agent env). **All current devices already have
  a `local_key`** → local control needs NO cloud once keys are stored.

## Command entry points (all traced in code — this is the load-bearing part)
| Source | Today | Fix |
|---|---|---|
| **Rule engine** | `_dispatch_command` (`rule_engine.py:1994-2000`) ALREADY resolves `dps_config.<ch>.dps_on/off` → `set_dps` → publishes to agent | **Data only** (populate `dps_on/off`) — no rule-engine code change |
| **Dashboard toggle** `POST /api/devices/:id/toggle` (`server.js:7689`) | resolves HA entity via template + **`callHA()` DIRECTLY (`:7770-7798`) — BYPASSES the agent → HA→Tuya-cloud** | **server.js change REQUIRED:** publish to `mur/home/device/<id>/command` instead of `callHA` (mirrors `/dps` `:7809`) |
| **Dashboard** `POST /api/devices/:id/dps` (`:7809-7824`) | already publishes `set_dps` to the agent (local) | ✔ nothing |
| **Voice** (`VOICE/`) | no direct device-toggle dispatch (HA-intent / rule-mediated) | verify; low surface |

## Inventory by fate (live DB, 2026-08-05)
| Group | Devices | Local? | Path |
|---|---|---|---|
| **WiFi `protocol='local'`** (~66) | 8 Gang, all room switches/lights, mmWave presence, SCS blinds, Star Projector, gas sensor, WF96C… | **YES (state already local)** | **Phase 1** (command routing) |
| **cloud WiFi mmWave** `hps` | Bedroom Presence, My Room presence | **YES** | **Phase 2** (have local_key; never onboarded) |
| **cloud WiFi breaker** `tdq` | Emerg Light Entrance (state shows `switch_1`) | **Likely YES** | **Phase 2** (probe) |
| **cloud** `kg` | 4 Buttons Device | **Probe** | **Phase 2** (mains → local; battery scene remote → cloud) |
| **gateway Zigbee sub-devices** | Boidem Light, General/Guy Siren, Guy Room Curtain, Tami 4 | **YES w/ work** | **Phase 3** (behind Multi-Mode Gateway .252) |
| **cloud battery** `cobj`/`mcs` | CO Alarm, Smart Life Sensor (`"2":84`=batt) | **NO via WiFi** | **Phase 4** (Zigbee re-pair or keep cloud) |
| **cloud IR hubs** `wnykq` (battery) | Balcony Remote 1/2, Living Room Remote_0, Maya Bedroom Remote | **NO by design** | **Phase 4** (Err 901 permanent — local IR blaster) |
| **8-Gang AWAY DPS 8** | 1 datapoint | **NO by design** | **Phase 4** (integer mode-DP, cloud-only) |
| **valve** (Sub-GHz RF) | Water Valve A/B/C/D | **NO via Tuya** | **Phase 4** (433 MHz behind HCG-003, HA-Tuya only) |
| (Home Connect appliances) | Dishwasher/Hob/Hood/Microwave/Oven/Washer | n/a | BSH, **not Tuya** — ignore |

## Phase 1 — local command dispatch for all WiFi local Tuya  *(CORE — software only, biggest win)*
**On/off DPS is DERIVABLE (MEASURED — of 45 local switches/lights/breakers/heaters):** 23 **multi-gang**
(`channel_config` → DPS = channel key `{"1":true}`) + 9 **single-boolean** (one boolean DPS in `last_state`,
e.g. `{"switch_1":true}`) = **32 auto**; **~8 multi/zero-boolean** need per-device power-DPS ID (Tuya spec /
`dps_labels`). Changes:
1. **Helper script (one-time):** write `dps_config.<ch>.dps_on/dps_off` for every local device — auto for the 32
   clear ones, **flag the ~8 ambiguous for manual review** (validate before commit). Exclude `cloud_authoritative_dps`.
2. **Device agent** `_handle_command` (`:519-611`): generalize the local fast-path (today the one-device
   `LOCAL_CONTROL_IDS` allowlist `:61-63`,`:561-571`) — for a `protocol='local'` device resolve
   `dps_config.<ch>.dps_on/off` → `tuya_local.set_state()` BEFORE the `_resolve_entity`/HA fallback. HA stays fallback.
3. **Dashboard `server.js`:** route the toggle endpoint to the agent (publish to `mur/home/device/<id>/command`),
   not `callHA`.
4. **Exclude** `cloud_authoritative_dps` (8-Gang DPS 8) — stays HA/cloud (device limitation).
- **Deploy:** helper (DB) → `scp device_agent.py` + `systemctl restart device-agent` → `pm2 delete/start` dashboard.
- **Risk mitigation:** roll out per-device; validate each derived DPS against the device's real datapoint; **test with
  HA Tuya disabled** so a bad map can't be masked by the HA fallback.

## Phase 2 — onboard the cloud WiFi Tuya devices  *(easy)*
Bedroom Presence, My Room presence (`hps`), Emerg Light Entrance (`tdq`), 4 Buttons Device (`kg`). Each has a
`local_key`. Per device: **probe** the LAN IP with `tinytuya` (answers on 6668? `version` 3.3/3.4/3.5), then
`UPDATE devices SET protocol='local', version=<v>, local_ip=<ip>` (IP via UDP rediscovery `tuya.py:466-483` / ARP) +
`systemctl restart device-agent`. 4 Buttons Err 901 ⇒ battery scene remote → Phase 4.

## Phase 3 — gateway Zigbee sub-devices → local  *(Boidem, 2 sirens, Guy Curtain, Tami 4)*
- **A (recommended): re-pair to Zigbee2MQTT** (LXC 107) — fully local via Z2M, drop the Tuya gateway/cloud path;
  add a device row per the `/add-device` zigbee flow. Simpler + robust.
- **B: gateway-aware local control** in `adapters/tuya.py` — persist `node_id→device_id` in the unused `gateway_id`
  column (so `_bootstrap_gateway` `:160-224` stops calling the cloud), add gateway-aware `set_state`
  (`tinytuya.Device(dev_id, parent=<gw>, cid=node_id)` with the **gateway's** local_key), and **fix the two-gateway
  selection bug** (`tuya.py:139` picks only the first `device_type='gateway'` — there are two: Multi-Mode .252 +
  Sub-GHz .211). More code; keeps Tuya-app pairing.

## Phase 4 — hardware / integration holdouts  *(can't go local via Tuya WiFi)*
- **IR remotes (4× `wnykq` battery):** no local TCP by design (Err 901). Replace with a **local IR blaster** — an
  **ESP32 IR blaster in the `esp_boards` framework** (on-brand; re-learn codes like the Mangal RF) or a **Broadlink
  RM4** (local via HA). Or keep on cloud.
- **Water valves A–D (Sub-GHz 433 MHz):** not local via Tuya. **Capture + replay the HCT-636 433 MHz RF with a CC1101**
  board (the project already does this — `balcony_bridge` Mangal/fan) or re-pair as **Zigbee** valves. Or keep on cloud.
- **CO Alarm + Smart Life Sensor (battery `cobj`/`mcs`):** no local WiFi TCP. Re-pair to **Z2M** if Zigbee; else keep
  cloud (safety/contact sensors, low command need).
- **8-Gang AWAY (DPS 8):** genuine cloud-only integer mode-DP. Options: (a) wire AWAY to a **spare local relay
  channel** + re-map Mode Buttons; (b) drive AWAY via a **virtual/dashboard** mode (Home State Simulator already
  does); (c) keep cloud for just this DP.

## Bootstrap caveat (to FULLY drop the subscription)
Local control + state need no cloud once keys are stored (already true). The cloud is still needed only to fetch a
`local_key` for a **new/re-paired** device and the **gateway node-map bootstrap** (removed by Phase 3-B). After
Phases 1–3, keep the free IoT Core trial only for **occasional onboarding**, or extract keys with LocalTuya —
day-to-day operation is fully cloud-independent.

## Recommended sequencing
1. **Phase 1** (core — daily control survives any Tuya-cloud outage; pure software).
2. **Phase 2** (onboard 3–4 cloud WiFi devices).
3. **Phase 3-A** (Z2M re-pair the 5 gateway sub-devices).
4. **Phase 4** as appetite/budget allows (hardware) — until then those specific devices keep a residual cloud need.

## Verify (per phase)
- **Phase 1:** with the HA Tuya integration **disabled**, toggle every local Tuya device from the dashboard AND fire a
  rule → all actuate locally; `last_source` stays `local_poll`/`tcp_push`; `device_events` shows the change.
- **Overall success:** disable the HA Tuya integration for a day → everything except the Phase-4 holdouts keeps working.

## Key files / hooks (for the build)
- `DEVICE/agent/device_agent.py` — `LOCAL_CONTROL_IDS` (`:61-63`), `_handle_command` (`:519-611`), `_resolve_entity`.
- `DEVICE/agent/adapters/tuya.py` — `set_state` (`:934-947`), gateway (`:160-279`, `:811-915`), key refresh (`:522-537`).
- `RULES/rule_engine.py` — `_dispatch_command` (`:1986-2002`), `_resolve_local_dps` (`:2044-2059`).
- `BOILER/dashboard/server.js` — `/api/devices/:id/toggle` (`:7689`), `/api/devices/:id/dps` (`:7809`).
- Related memory: `incident_tuya_integration_freeze`, `incident_mode_buttons_away_latch`, `project_tuya_ir_hubs`,
  `project_agent_water_valve`, `project_set_dps_endpoint`, `incident_tuya_local_key_rotation`,
  `project_device_adapters_canonical_path`.
