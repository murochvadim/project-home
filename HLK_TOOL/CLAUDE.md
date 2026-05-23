# HLK_TOOL — HLK Radar Sensor Calibration Bench

> **Status:** scaffold phase. **Sketch compiles** (2026-05-23) at `Arduino_Projects/HLK_Tool_Claude/`. Hardware not yet purchased; LD2420 byte-level UART protocol carries `⚠ TODO verify` markers that need validation against the real sensor before first calibration. DB + dashboard Calibration sub-tab still to be built.
>
> **Scope:** **calibration only.** A bench / portable rig used to find the right trigger + hold thresholds for an HLK radar sensor, write them to the **sensor's own NVM**, and then **release the sensor** to its production board.
>
> Out of scope: rule integration, room placement, scenario design, production deployment. Those happen elsewhere (on whatever board the calibrated sensor is moved to afterwards). HLK_TOOL does not know or care what the sensor ends up doing.
>
> **HLK family scope:** first model implemented = **LD2420**. Other gate-based models (LD2410, LD2412) plug in as model configs — see "Supported HLK models" below.

## Purpose

Bench tool for **calibrating** HLK mmWave radar sensors before they're deployed.

Workflow:

1. User physically places the calibration rig (ESP32-WROOM-32 + LD2420 on test cable) **at the intended installation location**, at the intended height and orientation — calibrating from a desk gives the wrong thresholds because multipath / walls / furniture vary by location.
2. User opens the rig's tab on the Project Boards page → Calibration sub-tab.
3. User fills the session form: profile name, intended detection range, mounting height, sensitivity intent.
4. Dashboard writes geometry-derived starting thresholds to the LD2420 via UART config commands (over MQTT to the ESP32, then ESP32 → UART → sensor).
5. Interactive session: the user walks / sits / leaves; the dashboard captures live per-gate energy frames and **solves the per-gate trigger + hold thresholds** against ground truth.
6. Solved thresholds are written to the LD2420's **own NVM** via the sensor's persist-config UART command. Those values survive power loss and stay with the sensor.
7. User disconnects the LD2420 from the calibration rig and connects it to its production board (a different ESP, or directly via the OT2 binary pin to a GPIO). The sensor outputs presence using the calibrated thresholds — **no further involvement from HLK_TOOL**.
8. The calibration profile is saved in the DB under a user-chosen label so the user can re-apply the same thresholds to another sensor or re-flash after a factory-reset.

This does what the Hi-Link vendor config tool **cannot**: auto-solves the 30 per-gate thresholds against the actual environment instead of leaving the user to guess + re-check manually.

**The calibration rig itself is reusable** — one ESP32-WROOM-32 calibrates many sensors over time. Each session = one named profile saved in the DB.

## Supported HLK models

**Architectural assumption:** the gate-based HLK family (LD2410 / LD2412 / LD2420, including B / C revisions) shares the same overall schema — gate energies + per-gate trigger/hold thresholds + presence + distance. Across that family, **only the following differ:**

1. **Gate count** (9, 14, or 15)
2. **UART parameter byte layout** (the protocol frame structure varies in the config commands, but the shape stays "send a config command, get an ack")
3. **Maybe communication pins** (depends on board wiring choice, not the sensor itself)

So the toolkit uses **ONE schema, ONE UI, ONE solver**, parameterized by a small per-model config block. Adding LD2410 / LD2412 support after LD2420 = adding ~30 lines of model config (gate count + protocol byte map), not building a parallel UI.

**LD2450 is the exception** — it's a multi-target tracker (outputs X/Y/speed for up to 3 targets, no per-gate energies). If/when LD2450 is added, it needs its own dedicated calibration handler. For now: out of scope.

| Model | Status | Gates | Notes |
|---|---|---|---|
| **LD2420** | **first impl** (this spec) | 15 (1–15) | 24 GHz, ~6 m, energy-stream + trigger/hold thresholds |
| LD2410 | future, easy follow-on | 9 (0–8) | Same architecture, fewer gates, slightly different protocol bytes |
| LD2410B | future, easy follow-on | 9 (0–8) | LD2410 + Bluetooth pairing (BLE config alongside UART — optional) |
| LD2412 | future, easy follow-on | 14 (0–13) | Newer firmware, same architecture |
| LD2450 | future, **separate handler** | n/a — multi-target tracker | Different protocol entirely (X/Y/speed targets). Out of scope until needed. |
| LD6001 / LD7901 / LD303 / LD8001H | exploratory | varies | Different frequency bands. Add only if a real use case appears. |

**Per-model config block** (added to dashboard JS when each model is implemented):

```js
const HLK_MODELS = {
  LD2420: { gates: 15, gate_size_m: 0.7, fov_h_deg: 60, fov_v_deg: 30,
            protocol: 'ld2420_v1', ... },
  LD2410: { gates: 9,  gate_size_m: 0.75, fov_h_deg: 100, fov_v_deg: 30,
            protocol: 'ld2410_v1', ... },
  // etc.
};
```

The same Calibration sub-tab, the same solver, the same energy-bar visualization — all parameterized by the entry above.

**Per-model artifacts** (filled in as each model is implemented):

- `Arduino_Projects/HLK_<MODEL>_Claude/` — model-specific sketch (UART protocol bytes differ per model, so each gets its own sketch — but each sketch is small and structurally identical)
- Each board in `esp_boards` carries `sensor_model` so the dashboard picks the right `HLK_MODELS[...]` entry

**Device selector in the dashboard** = the **existing Project Boards top tab bar**. Each physical HLK sensor instance is its own `esp_boards` row → its own tab. No new selector widget needed in the page itself.

## Hardware

### HLK-LD2420 (sensor — first model)
- 24 GHz FMCW radar, Hi-Link
- Range: ~6 m, divided into **15 distance gates** (matches the Hi-Link vendor tool's exposed range; underlying firmware uses 0–15 but gate 0 is suppressed because it picks up the sensor housing — **verify gate-index convention at sketch time**)
- Each gate ~0.7 m wide
- UART: 256000 baud default, 3.3 V TTL (configurable baud)
- GPIO **OT2** pin: binary HIGH/LOW presence output (no protocol needed for the simplest use)
- FOV: ~60° horizontal × ~30° vertical *(TBD verify against datasheet at build time)*
- Detects presence via **energy per gate** with **Schmitt-trigger hysteresis** — energy above `trigger_threshold_gN` → gate N fires, energy below `hold_threshold_gN` (< trigger) → gate N releases. Anti-flicker by design.
- Runtime-configurable: 15 trigger thresholds, 15 hold thresholds, max gate, unmanned delay (post-detection hold time)

### Calibration rig — **ESP32-WROOM-32 + LD2420 on test cable**
- **Single shared rig** — one ESP32 calibrates many sensors over its lifetime
- Sensor on a short test cable (4-pin: VCC, GND, UART RX, UART TX), easily plugged/unplugged for the next sensor
- **Board type: ESP32-WROOM-32** (locked 2026-05-23)
- Why ESP32 over ESP8266:
  - **2+ free hardware UARTs** — one dedicated to the LD2420 data stream, debug serial stays on USB; ESP8266 has only one hardware UART + a software-serial workaround that drops bytes at 256000 baud during continuous 10 Hz energy streaming
  - More flash / RAM headroom for the calibration sample buffer
  - Dual-core lets the WiFi/MQTT stack run independently of the UART parser — no missed frames during MQTT publishes
- UART to LD2420 — pins **TBD per sketch design** (typically GPIO 16/17 for UART2)
- WiFi + MQTT to LXC 107 broker (so the dashboard can drive the rig from anywhere on the LAN — the user mounts the rig at the installation location and runs the session from a laptop/phone)
- Power: USB (5 V) — rig is bench-portable, not permanent
- OTA: port **3232** (ESP32) via the dashboard's `espota.py` spawn — picked automatically because `sketch_name` will contain `"ESP32"`

### Tools available to the user already
- Hi-Link Windows config tool over USB-UART (one-shot bench config, no API)
- This project: runtime config + auto-calibration via dashboard

## Board (sketch + esp_boards integration)

### Sketch folder
`C:\Users\muroc\Arduino_Projects\HLK_LD2420_Claude\` — parallel to `Face_Recognition_Claude\`. **Name confirmed with user at creation time** (per [feedback memory: use user-chosen names verbatim](../.claude/projects/c--Users-muroc-project-home/memory/feedback_user_chosen_names.md)).

### Board identity
- `board_id`: `hlk_<model>_<location>` (e.g. `hlk_ld2420_bedroom`, `hlk_ld2410_corridor`) — **TBD per placement**
- `sensor_model`: published in `board_schema` (e.g. `"LD2420"`, `"LD2410"`, `"LD2450"`) — dashboard uses this to pick the right Params + Calibration handler
- `sketch_name`: must contain `"ESP32"` so dashboard OTA picks port 3232 (the dashboard's `sketch_name` substring match drives port selection: contains "ESP8266" → port 8266, contains "ESP32" → port 3232)
- `sketch_version`: starts at `v1`
- Shared `esp_boards` MQTT user + shared `ESP_OTA_PASSWORD` (env-fallback path, same as every other board)

### MQTT topics
- `mur/home/esp/<board>/availability` — LWT online/offline
- `mur/home/esp/<board>/status` — periodic + on-change status
- `mur/home/esp/<board>/event` — transitions (e.g. `presence_started`, `presence_ended`)
- `mur/home/esp/<board>/schema` — retained, params + actions self-declaration
- `mur/home/esp/<board>/config` — incoming, parameter writes
- `mur/home/esp/<board>/command` — incoming, action dispatch

### Status fields (projected into `devices.last_state` via `_ESP_STATUS_DPS_FIELDS` in rule engine)
- `presence` (bool) — primary state
- `distance_cm` (int) — target distance
- `gate_energy` (int[15]) — raw per-gate energy values streamed from the device (~10 Hz in energy report mode, lower-rate or omitted in minimal mode)
- `last_state_ts`
- Mirror of currently-applied thresholds (so the dashboard can show ground-truth-from-device vs last-written-from-dashboard) — **TBD whether to mirror in status or query separately**

### Parameters (board_schema) — mirrors the Hi-Link vendor tool 1:1
Total: **32 parameters** (15 trigger + 15 hold + max_gate + unmanned_delay), plus `report_mode` for calibration lifecycle.

- `max_gate` (int, 1–15) — furthest gate to consider for detection
- `trigger_threshold_g1` … `trigger_threshold_g15` (int) — rising-edge energy threshold per gate; energy must exceed this to start detecting at gate N
- `hold_threshold_g1` … `hold_threshold_g15` (int) — falling-edge release threshold per gate; energy must drop below this to release detection at gate N. Must satisfy `hold < trigger` per gate; the dashboard's Params tab + Calibration solver both enforce this invariant.
- `unmanned_delay` (int seconds) — hold time after last detection before output goes clear
- `report_mode` (enum: `minimal` | `energy`) — `energy` streams per-gate energy frames at ~10 Hz for calibration; `minimal` emits only presence + distance for normal operation. Switching modes is part of the calibration session lifecycle.

### Actions (board_schema)
- `restart`
- `factory_reset` (caution — wipes calibration; emits warning before publishing)
- `enter_config_mode` / `exit_config_mode` — used internally by parameter writes; surfaced for manual recovery
- `start_report_mode_energy` / `start_report_mode_minimal` — surface energy streaming for the calibration session

## Database

### Reused
- `esp_boards` — single row for the calibration rig (e.g. `hlk_calibrator_01`)

**Not used** by HLK_TOOL (these belong to the production-deployment side, out of scope here):
- `devices` — the LD2420 being calibrated isn't a project device yet
- `room_device_placements` — no room placement during calibration
- Rule engine — no rule integration in calibration scope

### New table: `hlk_calibration_profiles`
*(Generic name — same table serves LD2420 + future LD2410 / LD2412 etc. The `sensor_model` field on each row records which model was calibrated.)*

Holds calibration sessions. Each row = one named profile from one session. The user can re-apply / re-solve any historical profile to whichever sensor is currently on the rig.

Schema sketch (final shape **TBD** at implementation time):
- `id PK`
- `name TEXT NOT NULL` — user-chosen label (e.g. *"Balcony Auto-Light"*, *"Bedroom Doorway"*) — uniqueness optional; same name + later `created_at` = a new version of the same profile
- `sensor_model TEXT NOT NULL` — `"LD2420"`, `"LD2410"`, etc.
- `created_at TIMESTAMPTZ`
- `solved_at TIMESTAMPTZ`
- `requirements JSONB` — user-specified form inputs (min/max distance, mounting height, sensitivity intent, dwell-still toggle, free-text notes)
- `samples JSONB` — captured energy frames tagged by phase (baseline / positive sweeps / negative samples)
- `thresholds JSONB` — solved per-gate trigger + hold thresholds
- `verify_passed BOOL`
- `verify_iterations INT`
- `notes TEXT`
- `is_active BOOL` — exactly one active profile across the whole table (= "this is what's currently flashed to the sensor on the rig right now")

**Retention policy:** forever (low-volume, config-like data). Sample JSON ~50–200 KB per session; expected lifetime volume small (a few profiles per real-world sensor, occasional re-calibration).

## Dashboard page

### Location
Project Boards page → per-board tab → new **Calibration** sub-tab, alongside the existing Status / Params / Simulation sub-tabs.

### Calibration sub-tab — sections

**1. Session setup form (all direct input)**

- **Profile name** (text, required) — user-chosen label e.g. *"Balcony Auto-Light"*, *"Bedroom Doorway"*
- **Notes** (text, optional) — free text the user wants to keep with the profile (intended installation location, mounting context, anything they'd want to remember next time)
- **Target detection range:** `min_distance_m` and `max_distance_m` — these directly determine `min_gate` and `max_gate` (gate index = distance ÷ 0.7 m)
- **Mounting height** (m above floor, as it will be in production) — used for vertical-FOV sanity warning
- **Sensitivity intent** — slider 1..10, drives initial threshold magnitudes (higher = lower thresholds = more sensitive)
- **Dwell-still calibration?** — checkbox (default ON): include a "sit still 30 s breathing" phase so stationary detection is calibrated too. Skip for motion-only intent to save ~3 min.

**2. Pre-compute results (live as form is filled)**
- Sensor → zone distances (nearest / farthest in m)
- Derived gate range (`min_gate`..`max_gate`)
- Geometric warnings (zone outside FOV / beyond gate 15 / mounting height misaligned)
- Per-gate initial-threshold table (trigger + hold)

**3. Apply initial config**
- "Write to sensor" button → publishes to `mur/home/esp/<board>/config` with the geometric-derived values
- Confirmation shows what changed from the previous configuration

**4. Auto-calibration session UI**
- Phase indicator (Baseline / Positive Sweeps / Negative Samples / Solving / Verifying)
- Instructions for the user (e.g. *"Leave the room and stay outside 30 s"*, *"Walk slowly from sofa toward sensor and back"*)
- Live energy bar chart — one bar per gate (count from `HLK_MODELS[sensor_model].gates`), each bar overlaid with its current trigger + hold threshold lines, updating with each MQTT frame at ~10 Hz
- Threshold overlay on the bars — user sees current threshold line vs live energy
- Sample-count + time-remaining per phase
- Solver output: per-gate threshold deltas with reasoning
- Iteration counter + verify pass/fail badge

**5. History**
Past sessions for this placement. Each row: timestamp, requirements summary, verify pass/fail, thresholds delta vs current active, "Replay" / "Re-solve" / "Activate" buttons.

## Calibration algorithm

### Phase 1 — Geometric pre-compute (instant, from form inputs — no rooms.html needed)
1. Read `min_distance_m`, `max_distance_m`, `mounting_height_m`, `sensitivity_intent` (1..10) from the form.
2. `min_gate = max(1, floor(min_distance_m / 0.7))`
3. `max_gate = min(15, ceil(max_distance_m / 0.7))`
4. For each gate `G` ∈ 1..15:
   - If `min_gate ≤ G ≤ max_gate` → in-zone; initial `trigger_threshold_gN` = `f(sensitivity_intent, G)` (closer gates need higher absolute trigger thresholds because returns are naturally stronger)
   - Else → out-of-zone; threshold set high enough that this gate effectively never triggers
   - `hold_threshold_gN = trigger_threshold_gN × 0.7` (anti-flicker margin)
5. **Mounting-height check:** if `max_distance_m × tan(vertical_FOV_half_angle) > mounting_height_m`, warn that a standing person at max distance may be above the beam.
6. Write the resulting 30 thresholds + max_gate + unmanned_delay to the LD2420 via `/config` MQTT publish.

### Phase 2 — Baseline (room empty, ~30 s)
- User clicks "I'm out of the room" → page records energy frames for 30 s.
- Compute per-gate ambient mean + max.
- Sets the noise floor.

### Phase 3 — Positive sweeps (interactive, ~2–3 min)
- Page instructs: "Walk slowly across the target zone", "Sit at <zone-corner>", "Stand at <zone-center>", "Sit still 30 s breathing normally" (the dwell-still phase exercises the breathing/micro-motion energy that the LD2420 picks up even without gross movement).
- For each instruction, records energy peaks per gate.
- Samples tagged as *should detect*.

### Phase 4 — Negative samples (interactive, ~1 min)
- Page instructs: "Leave the room and stand at <known-outside-position> for 30 s".
- Records frames as *should not detect*.

### Phase 5 — Solver
For each gate `G` ∈ 1..15:
- `pos_samples` = energy at gate `G` during positive sweeps (when target was in zone)
- `neg_samples` = energy at gate `G` during baseline + negative samples (when target was outside / room empty)
- `trigger_threshold` = value that maximises separation: `> max(neg_samples) + margin` AND `≤ min(pos_samples) − margin`
- `hold_threshold` = `trigger_threshold × 0.7` (anti-flicker margin), tightened if observed energy in pos_samples has high variance
- If `min(pos) ≤ max(neg)`: gate is **ambiguous** → emit warning, suggest user re-tag samples or relax requirements (e.g. *"Gate 5 detects you both in zone and through the wall behind the sensor — physical separation insufficient, consider lowering max_gate or relocating sensor"*)
- Invariant enforced: `hold < trigger` per gate, always.

### Phase 6 — Verify
- User repeats positive sweeps + negative samples (~1 min total).
- Page checks: does the LD2420's live `presence` output match the expected truth?
- **Pass** = match rate ≥ N% (**TBD** — likely 90%+)
- **Fail** = adjust thresholds (widen margin on misbehaving gates) + re-verify. Capped at K iterations (**TBD** — likely 3).

### Stop conditions
- Verify passes → write solved thresholds to the **LD2420's own NVM** via the sensor's persist-config UART command (so the values survive after the sensor is unplugged from the rig), then save the full session row in `hlk_calibration_profiles`, mark `is_active=true`, deactivate previous profile.
- Verify fails after K iterations → save partial session row (no NVM write), surface which specific gates couldn't converge with a diagnostic explanation.

### After calibration completes
- The dashboard tells the user: *"Calibration written to sensor NVM. You can now disconnect the LD2420 from the rig and move it to its production board."*
- The LD2420 retains the thresholds across power cycles. It outputs presence on the OT2 pin + streams distance/presence over UART according to the calibrated thresholds.
- The user can later reconnect the same sensor (or a different one) to the rig and either run a new calibration session or re-apply a saved profile.

## Integration with the existing project

HLK_TOOL is **deliberately decoupled** from the rest of the apartment automation — it's a bench tool, not a deployed agent. The only project surfaces it touches:

### Project Boards page
- One new board tab for the calibration rig (e.g. `hlk_calibrator_01`).
- Status sub-tab — Connection + System cards (standard pattern, conditionally rendered from `/status`).
- Params sub-tab — auto-renders 15 trigger + 15 hold sliders + max_gate + unmanned_delay from `board_schema`. **Calibration sub-tab is the primary path**; Params is for manual override or post-calibration inspection.
- Simulation sub-tab — `[start_report_mode_energy]` / `[start_report_mode_minimal]` action buttons.
- **New Calibration sub-tab** (the main feature of HLK_TOOL).

### Health / Watchdog (LXC 104)
- The calibration rig naturally falls under the existing `group_health_watchdog` (protocol=`esp`, source=`mqtt`). No new watchdog code. If the rig is offline because no one is calibrating, that's expected — there's no false alarm because the watchdog only alerts when *other* esp/mqtt devices are fresh while one specific one is stale, and the rig is normally the only `hlk_calibrator_*` device.

### Out of scope (handled elsewhere, on whatever production board the calibrated sensor moves to)
- `devices` registry rows for the calibrated sensor
- `room_device_placements` placement on rooms.html
- Rule engine integration (`Home Activity`, `People Home`, lighting rules, etc.)
- Apartment-scene serializer entries
- Any scenario / automation logic

## Locked decisions (answered 2026-05-23)

1. **First use case: a sensor intended for the Balcony.** What the sensor does after calibration is out of scope for HLK_TOOL. The calibration session captures intended detection range + mounting height; the user takes the calibrated sensor and wires it into whatever board / rule runs the actual scenario.
2. **Geometry source: direct input on the Calibration page.** No rooms.html / placement coupling. Form takes profile name + min/max distance + mounting height + sensitivity intent + dwell-still toggle + free-text notes.
3. **Calibration session structure: single combined session** covering motion + stationary in one ~8 min pass. The "dwell-still" phase is a toggle so users can skip it for motion-only intent.
4. **Build order: sketch + dashboard page first, hardware when user is back.** Both can be developed against synthetic MQTT data; bring-up + first real calibration happen when the LD2420 + ESP32 arrive.
5. **Calibration rig board: ESP32-WROOM-32** (classic). One shared rig calibrates many sensors over its lifetime.
6. **Expected fleet: 1–5 HLK sensors total** — small enough that no cross-sensor coordination logic is needed in HLK_TOOL.
7. **Profile policy: single `is_active=true` row at any time** (= what's currently flashed to the sensor on the rig). History kept for re-apply / re-solve.

## TODO

Order of work (per locked Q4 — sketch + page first, hardware later):

- [x] **Scaffold sketch** at [`Arduino_Projects/HLK_Tool_Claude/`](../../Arduino_Projects/HLK_Tool_Claude) (2026-05-23) — ESP32-WROOM-32 board config, UART2 to LD2420, MQTT + `board_schema` publishing, energy-mode + minimal-mode report-switch action, persist-to-NVM placeholder. Four files: `Main.h` (config + globals), `HLK_Tool_Claude.ino` (setup/loop/WiFi/MQTT/OTA), `Esp_Base.ino` (schema + dispatcher), `LD2420_Protocol.ino` (UART protocol layer). Compiles clean.
- [x] **Update root CLAUDE.md** Project Modules table with HLK_TOOL entry (done 2026-05-23, ahead of original schedule — sketch existing was the trigger to surface it).
- [ ] **Verify LD2420 byte-level protocol** against real hardware — 16 `⚠ TODO verify` markers across `LD2420_Protocol.ino` + `Main.h` cover: parameter IDs (`LD2420_PARAM_*`), ack-frame `cmd_echo` convention, report-frame layout in energy mode (offsets for presence / distance / per-gate energies), report-mode switch mechanism, save-to-flash command word, reboot + factory-reset command words. Cross-check against ESPHome's `ld2420.cpp::parse_radar_data_frame_` and/or captured serial output from the real sensor.
- [ ] DB migration: `hlk_calibration_profiles` table + retention policy seed (forever, low-volume)
- [ ] Dashboard: Calibration sub-tab on Project Boards page — Session setup form, Pre-compute panel, live energy bar chart (via browser WebSocket to mosquitto 9001), session UI, solver, NVM-write step, history list with re-apply / re-solve
- [ ] Bench test against synthetic MQTT data (no hardware needed yet — the rig sketch publishes from on-device, so the dashboard work and protocol verification can proceed in parallel)
- [ ] **User orders** LD2420 + ESP32-WROOM-32 + test cable
- [ ] Flash sketch on the rig; first real calibration session
- [ ] Document Lessons Learned section here
- [ ] (later) Add LD2410 / LD2412 model configs to `HLK_MODELS` map as new sensors arrive

## File / location index

| Artifact | Path |
|---|---|
| This doc | `HLK_TOOL/CLAUDE.md` |
| Sketch (LD2420) | `Arduino_Projects/HLK_LD2420_Claude/` (NOT under `HLK_TOOL/` — sketches live in the Arduino workspace per project convention, same as `Face_Recognition_Claude/`). One sketch per HLK model. |
| Dashboard tab | `BOILER/dashboard/public/esp-boards.html` + `BOILER/dashboard/public/js/esp-boards.js` (Calibration sub-tab is added to the existing Project Boards page) |
| Dashboard endpoints | `BOILER/dashboard/server.js` — new `/api/hlk/*` routes (calibration session lifecycle, sample storage, solver, threshold writes) |
| DB migration | `BOILER/dashboard/migrations/<date>_hlk_calibration_profiles.sql` (or inline in `ensureSchema()` per existing convention) |
| Rule engine integration | none required for first sensor — uses generic `protocol='esp'` path |

---

**Update protocol:** keep this doc current as decisions land. New design questions → add to Open Questions. Resolved questions → fold into the appropriate spec section. After first sensor is calibrated → add a "Lessons Learned" section before the file index.
