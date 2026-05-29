# POWER — Home Power Consumption Picture

> **Status:** scoping / design phase. Hardware (Shelly 3EM) is in place and already integrated in HA on LXC 101. No DB rows, no ingest, no dashboard page, no rules — all to be built. This doc is the spec.

## Purpose

Build a **device-level consumption picture** of the apartment using the existing Shelly 3EM 3-phase meter as ground truth, the existing rule engine as the orchestrator, and the existing device-state knowledge to auto-discover which device is on which phase + how much it draws.

The goal is NOT just "see how much power the home uses" (any energy monitor gives that). The goal is **"see how much each device contributes to the total in real time, without per-socket meters or fancy ML"** — by combining:

1. Per-phase live consumption from Shelly
2. Device-to-phase mapping (some known, most auto-discovered)
3. Device on/off states from the existing rule engine + HA + devices table

Plus voltage / current / power-factor monitoring per phase, phase-imbalance detection, and voltage-quality alerts.

## Hardware

### Shelly 3EM (Gen 1, WiFi-only)
- 3-phase split-core CT-clamp energy meter
- Installed in the apartment's electrical panel (already in place)
- Already integrated in HA on LXC 101 (Shelly integration, uses CoIoT under the hood for fast push)
- **Local-only mode recommended** — disable Shelly Cloud, all data stays on LAN. (Optional — HA works either way.)
- Reports per phase: voltage, current, active power, power factor, total energy (kWh)
- Plus total active power (sum of all 3 phases)
- Update cadence via HA: ~1-2 s per state change

### API surface (for reference / fallbacks)
Shelly Gen 1 exposes three usable APIs. Project consumes via HA only. Others are documented for emergency / debug:
- **HTTP REST** — `GET http://<shelly-ip>/status` (full JSON), `GET /emeter/{0,1,2}` (per-phase)
- **MQTT native** — `shellies/shellyem3-<id>/emeter/{0,1,2}/{power,voltage,current,pf,total}` (one value per topic)
- **CoIoT (CoAP/UDP)** — proprietary push, consumed by HA's Shelly integration

Docs: [shelly-api-docs.shelly.cloud/gen1/#shelly3em](https://shelly-api-docs.shelly.cloud/gen1/#shelly3em)

## Architecture

```
Shelly 3EM (LAN, ~192.168.1.x)
       │ CoIoT (UDP) — ~1-2s push
       ▼
HA on LXC 101 (Shelly integration)
       │ HA state updates per entity (~15 entities: V/A/W/PF/kWh × 3 phases + totals)
       ▼
device-agent on LXC 103 (HA WebSocket adapter)
       │ HA_DIRECT_DEVICES entry maps all 15 HA entities → ONE devices row
       │ projects values into devices.last_state as flat DPS keys
       ▼
LXC 102 devices table:
   id = 'shelly_3em_main', protocol = 'ha_api', device_type = 'power_meter'
   last_state = {r_w: 1240, r_v: 230.4, r_a: 5.38, r_pf: 0.96, r_kwh: 12345.6,
                 s_w: 380, s_v: 229.8, ..., t_w: 90, t_v: 231.1, ..., total_w: 1710, total_kwh: 19259}
   (R / S / T = European 3-phase convention = HA sensor naming = electrician convention.
    Kept consistent through HA → DPS keys → DB columns → virtual devices → dashboard.)
       │
       ├──► Dashboard reads last_state directly for the "3-phase live status" card
       │
       ├──► Rule engine on LXC 105 subscribes to events
       │      ├──► writes time-series rows to power_consumption
       │      ├──► runs Phase Discovery rule (delta-based phase mapping)
       │      ├──► runs Attribution rule (computes per-device contribution)
       │      └──► runs Voltage Quality + Phase Imbalance alert rules
       │
       └──► Dashboard's "Power" page renders:
              - 3-phase live status card
              - Per-phase stacked attribution bar
              - Daily kWh chart
              - Discovery status table
              - Anomaly alerts
```

**Reuses existing infrastructure:** no new LXC, no new ingest service, no new MQTT user.

## Devices the user already knows are 3-phase

These are wired across all 3 phases (balanced load by design). Auto-discovery skips them; they're attributed specially by summing per-phase deltas.

- **Hob** (electric induction stove)
- **AC 1** (split or central AC, 3-phase compressor)
- **AC 2** (second AC unit, 3-phase compressor)

All other devices are single-phase (one phase only), with phase assignment unknown until auto-discovery learns it.

### Devices that already have their own per-phase meter (better than Shelly-delta attribution)

Discovered during the 2026-05-28 HA audit: a SEPARATE 3-phase smart-breaker exposes its own per-phase consumption for the bedroom AC. When a device has its own meter, we attribute it **directly from that meter** instead of computing deltas off the apartment-wide Shelly. Cleaner signal, no contamination from other devices toggling during the measurement window.

- **Bedroom AC** — `sensor.bedroom_ac_breaker_phase_{a,b,c}_{voltage,current,power}` + `sensor.bedroom_ac_breaker_total_energy`. Breaker-side phase letters A/B/C don't have a guaranteed mapping to Shelly's R/S/T at the panel — verify by correlating live readings when the AC is running (the phase the AC actually loads on the breaker will match exactly one of Shelly's R/S/T deltas; the other two should be near-zero). During the 2026-05-28 audit only `phase_a_voltage` was non-zero (238.5 V — closest to Shelly's T at 238.4 V) but with the AC OFF that's circumstantial; pin the mapping at first observed AC startup.

Pattern for future per-device meters: add to a small `power_devices` flag like `has_own_meter=TRUE` + store the entity IDs in `dps_config.own_meter`. The Attribution rule reads that meter directly and DOES NOT touch the residual bucket for this device.

## DB schema additions (LXC 102)

### `power_consumption` — time-series of Shelly readings
```sql
CREATE TABLE power_consumption (
  ts        TIMESTAMPTZ PRIMARY KEY,
  r_w       INT,           -- active power, watts  (Phase R / L1)
  s_w       INT,           --                       (Phase S / L2)
  t_w       INT,           --                       (Phase T / L3)
  total_w   INT,           -- computed: r_w + s_w + t_w  (no native HA entity for total)
  r_a       NUMERIC(7,3),  -- current, amps
  s_a       NUMERIC(7,3),
  t_a       NUMERIC(7,3),
  r_v       NUMERIC(5,1),  -- voltage, V
  s_v       NUMERIC(5,1),
  t_v       NUMERIC(5,1),
  r_pf      NUMERIC(4,3),  -- power factor, 0..1
  s_pf      NUMERIC(4,3),
  t_pf      NUMERIC(4,3),
  r_kwh     NUMERIC(10,2), -- cumulative energy, kWh
  s_kwh     NUMERIC(10,2),
  t_kwh     NUMERIC(10,2)
);
CREATE INDEX power_consumption_ts ON power_consumption (ts DESC);
```

R/S/T match the HA sensor names (`sensor.r_voltage`, `sensor.s_power`, …) so the `HA_DIRECT_DEVICES` entries map straight across with no rename. Same letters used everywhere downstream — column names, DPS keys, virtual device ids, dashboard labels.

Written by the rule engine on every Shelly state change event (or downsampled to once per N seconds if events are noisy). Retention: **30 days, auto_clean**.

### `power_devices` — registered devices + power signatures + live state
```sql
CREATE TABLE power_devices (
  device_id          TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  phase              CHAR(1),         -- 'R', 'S', 'T', OR NULL for 3-phase
  is_three_phase     BOOLEAN DEFAULT FALSE,
  is_cyclic          BOOLEAN DEFAULT FALSE,    -- legacy column, kept for forward-compat (always FALSE since 2026-05-29 cyclic drop)
  samples_count      INT DEFAULT 0,
  mean_w             NUMERIC,         -- always_on: sum of expected powers (contributes to LCD baseline). auto: NULL.
  stddev_w           NUMERIC,         -- reserved for P3 — running stddev of observed live wattage
  cycle_max_w        INT,             -- reserved for P3 (legacy from cyclic spec)
  cycle_typical_kwh  NUMERIC,         -- reserved for P3 (legacy from cyclic spec)
  confidence         TEXT,            -- 'none' | 'low' | 'medium' | 'high'
  last_observed_at   TIMESTAMPTZ,     -- written by future P3 on each detected state change
  source             TEXT,            -- 'manual_unmanaged' | 'manual_linked' | 'auto_pending' | 'auto_custom' | 'auto_discovered'
  notes              TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  display_name       TEXT,            -- (since 2026-05-28) optional override for the device's display name in the registry
  config             JSONB DEFAULT '{}'::jsonb,  -- (since 2026-05-28) user-supplied power signature + behavior + room
  live               JSONB DEFAULT '{"on":false}'::jsonb  -- (since 2026-05-29) what the rule currently sees (P3 writes here)
);
```

**Behavior** (a value of `config.behavior`):
- **`always_on`** — constant load, always subtracted from the apartment-wide total. `mean_w` is set to the sum of expected powers.
- **`auto`** — rule detects ON/OFF from Shelly per-phase deltas; contributes ONLY while detected ON. `mean_w` stays `NULL` so the always-on baseline calc excludes them.

**Identity** (encoded in `source` + the `device_id` shape):
- **Linked** (`source='manual_linked'` for always_on, `'auto_pending'` for auto) — `power_devices.device_id` = an existing real device's id. The real `devices` row is left untouched.
- **Custom** (`source='manual_unmanaged'` for always_on, `'auto_custom'` for auto) — a virtual `devices` row is created with `id = manual_<slug>` or `auto_<slug>` so unmanaged loads (router, dishwasher) get a home.

**`config` JSONB shape** (single-phase):
```json
{ "behavior": "auto", "room": "Kitchen", "expected_w": 150, "max_w": 2000 }
```

**`config` JSONB shape** (3-phase):
```json
{ "behavior": "auto", "room": "Living Room",
  "r_expected_w": 1000, "s_expected_w": 1000, "t_expected_w": 2000,
  "r_max_w": 1500, "s_max_w": 1800, "t_max_w": 2500 }
```

**`max_w` semantics** — variable-power devices (dishwasher = 150 W pump + 1950 W during heating) put their peak in `max_w`. The P3 discovery rule matches a Shelly delta to a device when the delta falls inside `[expected_w × 0.5, max_w × 1.2]`. Simple devices (microwave) leave `max_w` = `expected_w` and behave as point-match.

**`live` JSONB shape** — written by the future P3 rule on every detected state change. Single-phase:
```json
{ "on": true, "w": 187, "ts": "2026-05-29T08:30:00Z" }
```

3-phase:
```json
{ "on": true, "r_w": 1100, "s_w": 950, "t_w": 1850, "ts": "..." }
```

Default `{"on": false}` for newly-registered rows. P2 dashboard reads it for the Live W + Last seen columns.

Retention: **forever** (config-like data, low volume).

### `power_attribution` — computed per-timestamp breakdown
```sql
CREATE TABLE power_attribution (
  ts            TIMESTAMPTZ,
  device_id     TEXT,
  phase         CHAR(1),         -- 'R' / 'S' / 'T' OR NULL for 3-phase devices
  attributed_w  INT,
  PRIMARY KEY (ts, device_id)
);
CREATE INDEX power_attribution_ts ON power_attribution (ts DESC);
```

Written by the Attribution rule on each Shelly reading (or downsampled). For the dashboard's "stacked bar by device" + "per-device daily kWh." Retention: **30 days, auto_clean** — derived from raw data + power_devices, can be rebuilt.

### `power_billing_periods` — billing cycle history + bill reconciliation
```sql
CREATE TABLE power_billing_periods (
  id                BIGSERIAL PRIMARY KEY,
  start_ts          TIMESTAMPTZ NOT NULL,
  end_ts            TIMESTAMPTZ,                -- NULL while current period is open
  start_kwh_r       NUMERIC,                    -- meter snapshot at period start
  start_kwh_s       NUMERIC,
  start_kwh_t       NUMERIC,
  end_kwh_r         NUMERIC,                    -- meter snapshot at period end
  end_kwh_s         NUMERIC,
  end_kwh_t         NUMERIC,
  period_kwh        NUMERIC,                    -- (end - start) summed across phases (computed at close)
  est_cost_ils      NUMERIC,                    -- our dashboard estimate using configured tariff
  bill_received_ils NUMERIC,                    -- actual IEC bill amount (user enters when bill arrives)
  bill_period_kwh   NUMERIC,                    -- kWh reported on actual IEC bill (sanity check)
  source            TEXT,                       -- 'auto_rolled' | 'manual_synced_with_bill'
  notes             TEXT
);
CREATE INDEX power_billing_periods_start ON power_billing_periods (start_ts DESC);
```

Written by the Power Billing Period Roll rule on heartbeat (60s). Captures the Shelly's cumulative kWh meter reading at each billing-cycle boundary. When the user receives their actual IEC bill, they enter `bill_received_ils` + `bill_period_kwh` via the dashboard — gives a feedback loop on whether our tariff config is accurate (estimate vs reality). Retention: **forever, low volume** (6 rows/year for a 2-month cycle).

### Virtual devices

Registered in the existing `devices` table (`device_type='virtual'`, `protocol='virtual'`) so they appear like any other device + rules can subscribe to them:

- `virtual:phase_r_background`, `virtual:phase_s_background`, `virtual:phase_t_background` — residual / unknown load per phase (sum of all small + unmodeled draws). `last_state.w` updated by the Attribution rule.
- `virtual:power_picture` — single aggregated state with `total_w`, `attributed_w`, `unknown_w`, `top_device_now`, etc. Dashboard convenience.

## Auto-discovery rule — "Power Phase Discovery"

Group: `power`. Triggers on every device event (wildcard, with fast early-return).

**Algorithm:**

```
On device state change (any device):
  1. Skip if device is in MULTI_PHASE_SET (hob, AC1, AC2) — handled by separate rule
  2. Skip if device is a power-meter device itself
  3. Capture event timestamp + device ON/OFF direction
  4. Check "clean transition" guard:
     - any OTHER device transitioned within ±5 s of this event? → skip, contaminated
  5. Find the Shelly reading just BEFORE this transition (max ts < event_ts in power_consumption)
  6. Wait for the next Shelly reading AFTER this transition (rule re-fires on next Shelly event)
  7. Compute Δr, Δs, Δt = (after - before)
  8. Threshold guard: if max|Δ| < 10 W → skip (below noise floor, untrackable)
  9. For ON events: phase = argmax(Δr, Δs, Δt); measured_w = +largest_delta
     For OFF events: phase = argmin(Δr, Δs, Δt); measured_w = -largest_delta
  10. Upsert power_devices(device_id, phase, samples_count++, running mean_w, running stddev_w, last_observed_at)
  11. After samples_count > N: auto-classify is_cyclic if stddev_w / mean_w > 0.4
  12. After samples_count > M (e.g. 5) with low variance: bump confidence 'low' → 'medium' → 'high'
```

**No deferred dispatch needed** — the rule naturally waits for the next Shelly reading (which arrives within 1-2 s anyway). Same pattern as your existing time-travel architecture: queries `power_consumption` table for the before-reading; the after-reading triggers the rule on its arrival.

**EWMA over many cycles:** running mean uses exponential weighted moving average, so the system catches gradual drift (compressor aging) but doesn't get wrecked by outliers.

## Static vs Cyclic device handling

**Static devices** (toaster, kettle, fridge compressor, LED light, water heater on full):
- Power signature is stable
- `mean_w` ≈ actual draw, `stddev_w` is low
- Contribution while ON = `mean_w` (constant)
- The Attribution rule just looks at `last_state` to know which static devices are ON, sums their `mean_w`

**Cyclic devices** (washing machine, dishwasher, dryer, oven, EV charger, variable-compressor AC):
- Power varies during operation (resistive heater cycles on/off, motor speeds change, etc.)
- Auto-classification: when `stddev_w / mean_w > 0.4` after enough samples → flip `is_cyclic = TRUE`
- Contribution while ON = phase's residual (after subtracting all static + 3-phase contributions on that phase)
- Edge case: two cyclic devices ON simultaneously on the same phase → can't separate; mark attribution as "split" in `power_attribution.notes` and don't try
- When the cyclic device turns OFF: log final `cycle_max_w` (highest observed during this cycle) + total kWh consumed during the cycle → updates `cycle_typical_kwh`

**3-phase devices** (hob, AC1, AC2):
- Separate rule "Power 3-Phase Attribution"
- When hob/AC1/AC2 state changes, all three phases' deltas summed and attributed proportionally to that device
- Doesn't go through `power_devices.phase` (which stays NULL)

## Manual / unmanaged devices (no HA state, not in the rule engine)

**The problem.** Plenty of devices in a real home consume meaningful power but have NO smart-control surface and NO state in `devices.last_state`:

- **Fridge** — cycles compressor 24/7, no smart entity. ~60-120W when on, 0W when off, duty cycle ~25%.
- **Wine fridge** — same shape. ~25-40W avg.
- **Routers / modems / mesh APs** — always on. ~15-30W each, three or four of them in a typical home.
- **Aquarium pump / heater** — always on.
- **Phone chargers, USB hubs, plug adapters** — small individually but cumulative.
- **TV/displays in standby** — small but always.
- **Hair dryer, vacuum, blender** — intermittent, user-triggered, no automation.

User reports observed ~350 W consumption while away (`home_mode='abroad'`) — that's all unmanaged. Without registering them, the entire 350 W sits in the `virtual:phase_<n>_background` bucket and the dashboard says "I have no idea what's going on" — exactly the situation the project is trying to fix.

**The solution — manual device registry that slots into the existing pattern.**

### Three categories of unmanaged device

| Category | Examples | Power signature | How attribution treats it |
|---|---|---|---|
| **Always-on (continuous)** | Routers, modems, fish-tank pump, fridge LED, smoke detectors | Constant wattage 24/7 | Subtract `continuous_w` from the phase residual continuously |
| **Cyclic (autonomous on/off)** | Fridge compressor, wine fridge, dehumidifier, water-circulation pump | Oscillates: peak_w when on, 0 when off, with rough duty cycle % | Subtract `time_avg_w = peak_w × duty_cycle_pct / 100` from the phase residual continuously. Approximate but stable over minutes. |
| **Intermittent (user-triggered)** | Hair dryer, vacuum, blender, microwave | High peak when used (sometimes 1500-2500 W) but rare | Don't auto-subtract. User can mark which device caused a phase spike retroactively via the dashboard; rare enough that automated handling isn't worth the complexity. |

### Storage pattern — leverage existing `devices` + `power_devices` tables

For each manual entry, insert one row into the existing `devices` table:

```sql
INSERT INTO devices (id, name, protocol, device_type, dps_labels, dps_config)
VALUES (
  'manual_fridge',
  'Fridge',
  'virtual',                                            -- new virtual peer
  'unmanaged_load',                                     -- NEW device_type value (alongside light, switch, presence, etc.)
  '{"nominal_w":"Nominal W","duty_cycle":"Duty Cycle %","time_avg_w":"Time-avg W"}'::jsonb,
  '{"phase":"R","load_type":"cyclic","peak_w":120,"duty_cycle_pct":25,"notes":"kitchen, single-door"}'::jsonb
);
```

And a matching `power_devices` row:
```sql
INSERT INTO power_devices (device_id, phase, source, confidence, mean_w, notes)
VALUES (
  'manual_fridge',
  'R',
  'manual_unmanaged',                                   -- NEW source value
  'high',                                                -- manual entries treated as high-confidence by definition
  30,                                                    -- time-averaged contribution (peak_w * duty_cycle / 100)
  'Phase R, cycle ~25% — avg 30W, peak 120W'
);
```

Naming convention: `manual_<slug>` for the `devices.id`. Lowercase snake_case slug. Examples: `manual_fridge`, `manual_wine_fridge`, `manual_router_main`, `manual_router_office`, `manual_aquarium_pump`.

### Why not just a free-text label?

Putting these in `devices` (instead of, say, a separate `manual_loads` table) means:
- They appear in the existing Device Agent's `devices.html` page like any other device
- The attribution rule needs zero special-case code — just treats them as static devices with their `mean_w` (or `time_avg_w` for cyclics)
- Rule sentences can reference them via `@Fridge` chip if you ever want a rule like "if fridge avg consumption changes by 30% → alert: door left open?"
- Future: if user upgrades the fridge to a smart-plug, just flip `protocol='local'` and `device_type='power_plug'` — same row stays

### Dashboard — manual entry UX

Card 4 (Discovery Status Table) gets a new "+ Add Unmanaged Device" button next to the auto-discovered entries.

Form fields:
- **Name** (required, free text — becomes both display name + the auto-generated slug for `devices.id`)
- **Phase** (R / S / T — required; matches HA + electrician convention)
- **Load type** (always-on / cyclic / intermittent — required)
- **Always-on wattage** (W) — shown if load type is always-on
- **Peak wattage** (W) + **Duty cycle** (%) — shown if load type is cyclic
- **Notes** (optional)

Save creates the `devices` row + `power_devices` row in one transaction.

Edit existing manual devices inline (click row → edit panel).

### Phase residual after manual + auto entries

```
phase_R_observed_w = e.g. 145 W (right now, while home_mode='abroad')

minus all known managed devices on R that are ON           (e.g. nothing, since user is away)
minus all manual always-on devices on R                    (e.g. router 25 W + modem 15 W = 40 W)
minus all manual cyclic devices' time_avg_w on R           (e.g. fridge 30 W)
                                                              ─────
                                                              70 W subtracted

phase_R_background_w = 145 − 70 = 75 W     ← still unattributed
```

If `phase_<x>_background_w` is still high (e.g. 75 W on phase R while everything known is OFF), the user has more unmanaged devices to register. Iterative process.

### Sanity check + alert: "still too much background"

New alert (variant of `power:phantom_load_spike`):
- **`power:unaccounted_background`** — when `virtual:phase_<r|s|t>_background > N W` sustained > 30 min AND `home_mode IN ('away','abroad')`
- Severity: `info` (it's a forensic prompt, not an emergency)
- Message: *"Phase N has X W of unaccounted load while you're away. Likely an unmanaged device that hasn't been registered yet."*
- Threshold N is tunable per phase via sentence (default 50 W per phase)

This is the productive feedback loop: every time the user finds and registers another unmanaged device, the background shrinks and the attribution becomes more accurate.

### Migration path when a manual device becomes smart later

If you eventually plug the fridge into a smart plug (Shelly Plug, Tuya plug, etc.):

1. The smart plug gets its own `devices` row when it joins HA / device_agent
2. Delete the `manual_fridge` row from `devices` (cascades to `power_devices`)
3. Auto-discovery takes over for the smart-plugged fridge — measures actual wattage on each ON/OFF transition, no estimate needed

No special migration code; just remove the manual entry when the device gains a smart surface.

## Tiny-draw devices (below Shelly's noise floor ~5-10 W)

Three layered strategies:

### A. Threshold filter in discovery rule
- Discovery rule skips attribution if `max|Δw| < 10 W` (settings-tunable knob)
- These devices stay "unknown phase" in `power_devices`
- Prevents noise-driven false phase assignments

### B. Per-phase "background load" virtual device
- After subtracting all known tracked devices from each phase's observed wattage, the residual = `virtual:phase_<r|s|t>_background`
- Updated by the Attribution rule on every cycle
- Visible on the dashboard as a forensic clue ("phase 1 has 80 W of always-on background load — what is it?")
- Captures all the small + always-on + unmodeled loads in aggregate

### C. Manual-seed pathway
- For known small devices whose nominal wattage is documented (router 12 W, modems 8 W, etc.) the user can manually insert into `power_devices` with `source='manual_seed'` + `confidence='high'`
- The Attribution rule treats manually-seeded devices same as auto-discovered for math purposes
- Reduces the size of the background bucket

### D. Hardware escalation (optional, future)
- For 1-3 truly important small devices that need individual tracking, add a Shelly Plug inline (~$15 each)
- Becomes its own `devices` row, its own discovery
- Use sparingly — only when the visibility justifies the hardware cost

## Voltage quality + phase imbalance rules

New rules in the `power` group, triggered by Shelly events:

### `power:voltage_low`
- Any phase voltage < 215 V sustained > 60 s
- Severity: `warn`
- Writes to `system_alerts`

### `power:voltage_high`
- Any phase voltage > 245 V sustained > 60 s
- Severity: `warn` (rare but worse for appliances — surge risk)

### `power:phase_imbalance`
- Ratio `(max_phase_w - min_phase_w) / max_phase_w` > 0.6 sustained > 10 min
- Severity: `info` (just informational — phase rebalancing is an electrician call, not urgent)
- Helpful for "we should move the dryer to phase 3 because phase 1 is always overloaded"

### `power:phantom_load_spike`
- `virtual:phase_<n>_background` > 500 W for > 5 min
- Severity: `warn`
- Means there's a significant load no rule can attribute — possibly a forgotten device or a misclassified state

### `power:device_state_mismatch`
- Known device claims ON (per `devices.last_state`) but its phase shows < 50 % of expected `mean_w`
- OR claims OFF but phase shows > 100 W more than the sum of other known-ON devices on that phase
- Severity: `warn`
- Catches: stuck switches, smart-plug failures, the user manually unplugging something, etc.

### `power:phase_lost:<R|S|T>`
- A phase's `current_a` average < 0.05 A AND `power_w` average < 5 W sustained for > 60 s (= last 6 power_consumption rows at the default 10 s ingest cadence)
- **Voltage is NOT a reliable signal** — the Shelly's voltage-sense leads are wired at the panel side of the breakers, so a phase whose downstream breaker is open / wire is cut still reads ~230 V on Shelly. The kit only knows the phase is gone via collapsed current + power + jittery PF. Verified empirically on 2026-05-28 by physically pulling Phase T: voltage stayed at 236.95 V while `t_a=0.01, t_w=0, t_pf=-0.02`.
- One alert per affected phase (`power:phase_lost:R`, `power:phase_lost:S`, `power:phase_lost:T`)
- Severity: `error` — losing a phase usually means a tripped main, broken neutral, or supply-side fault. Sidebar Status badge turns red.
- Auto-resolves the moment current returns
- **False-positive guard:** if no `power_devices` row has been registered on the affected phase AND no auto-discovered device has ever attributed load to it, the rule emits `severity: info` instead of `error` (the "phase has genuinely no load" case is indistinguishable from "phase is dead" until the user registers at least one device on each leg)
- Rendered as a prominent `⚠ LOST PHASE T` banner above Card 1 on the Project Power page (red, full-width)

All six alerts auto-resolve when the underlying condition clears (no manual ack needed).

## Dashboard — Project Power page

New sidebar entry under "General". Six cards:

### Card 1 — Shelly 3EM Live Status (top of page)

Three columns, one per phase, plus a "Total" column:

```
┌──────────────┬──────────────┬──────────────┬───────────────┐
│  Phase R     │  Phase S     │  Phase T     │  Total        │
├──────────────┼──────────────┼──────────────┼───────────────┤
│  Voltage     │  Voltage     │  Voltage     │  Total Power  │
│  231.8 V     │  237.1 V     │  238.4 V     │  2,617 W      │
│  Current     │  Current     │  Current     │  Apparent     │
│  10.79 A     │  0.66 A      │  1.24 A      │  ~2,820 VA    │
│  Power       │  Power       │  Power       │  Power factor │
│  2,459 W     │   30 W       │  128 W       │  0.93 (calc)  │
│  Power factor│  Power factor│  Power factor│  Frequency    │
│  0.98        │  0.19        │  0.43        │  50 Hz (Israel│
└──────────────┴──────────────┴──────────────┴───── grid std)┘

Phase imbalance: 95 % (high) ⚠     ← Phase R doing nearly all the work
Voltage quality: all 3 phases in nominal 220-240V band ✓
```

Note: HA exposes per-phase only — no `total_w` / apparent-power / system PF / frequency entities. Compute in software (`total_w = r_w + s_w + t_w`; weighted PF = `total_w / total_va`; frequency hardcoded 50 Hz for Israel residential grid).

Color coding:
- Voltage cells: green 220-240 V; amber 215-220 OR 240-245; red outside
- Power cells: green < 1000 W; amber 1000-3000 W; red > 3000 W per phase
- Power factor: green > 0.9; amber 0.8-0.9; red < 0.8 (informational only at home)
- Phase imbalance: green < 30 %; amber 30-60 %; red > 60 %

Data source: reads `devices.last_state` for `shelly_3em_main`. 5 s poll.

### Card 2 — Live Per-Phase Attribution
Three stacked horizontal bars (one per phase), segments colored per device. Each segment labeled with `device_name + N W (P%)`. Always shows the residual `Background` segment for unaccounted load.

### Card 3 — Daily / Weekly kWh Chart
Line chart, hourly buckets for 24 h or daily buckets for 7 d. Toggle: total / per-phase / per-device-category.

Categories (mapped via the existing `device_type` field):
- Heating (boiler, water_heater, electric heaters)
- Cooling (AC units)
- Kitchen (hob, oven, microwave, fridge, dishwasher)
- Laundry (washing machine, dryer)
- Lighting (light, light_strip)
- Electronics (computers, displays)
- Always-on (router, modems, switches, background)
- Other / unknown

### Card 4 — Discovery Status Table + Manual Device Registry
Table of `power_devices`: device name, phase, source (`auto_discovered` / `manual_seed` / `manual_unmanaged`), samples, mean_w (or "cyclic"), confidence. Sortable.

**Two action buttons at the top:**
- **+ Add Unmanaged Device** — opens form to register a manual device (fridge, router, etc.) — see "Manual / unmanaged devices" section for the form fields + load types.
- **+ Manual seed (known device)** — opens form to manually set phase + mean_w for an existing `devices` row that auto-discovery can't see (e.g. always-on smart device below noise floor).

**Per-row actions:**
- Edit (manual entries) — change wattage estimate or duty cycle if you observe drift
- Delete (manual entries only — auto-discovered entries are managed by the engine)
- Manual override (any row) — force phase + mean_w if auto-discovery is stuck

Highlights devices with `confidence='none'` or `'low'` to flag where attribution is shaky.

### Card 5 — Active Anomaly Alerts
Standard pattern (matches Project Health page): list of unresolved alerts where `alert_type LIKE 'power:%'`. Click an alert to expand for details.

### Card 6 — Cost + Billing Cycle

#### Settings sub-card (collapsed by default, editable)
- **Tariff type** — `flat` (single rate) or `taoz` (time-of-use peak/shoulder/off-peak)
- **Flat rate** — `₪ per kWh` (Israel residential standard ≈ 0.66 ₪/kWh as of 2026; updates yearly via IEC publication)
- **TAOZ rates** (if `type = taoz`) — peak / shoulder / off-peak rates + their hourly windows
- **Fixed monthly fee** — `₪` (IEC residential ≈ 12 ₪/month; appears on every bill regardless of consumption)
- **VAT %** — Israel standard 17%
- **Green energy levy** — usually 0 for standard residential; populate if applicable
- **Billing period length** — `months` (Israel residential default: **2**)
- **Billing cycle start day** — day-of-month the cycle starts per the user's IEC reading schedule (varies by customer; on the bill it's listed as "תאריך קריאה")
- **Current period start date** — auto-populated by the rollover rule; user can override once if needed to align with their actual IEC cycle

Stored as `dashboard_settings.power.tariff` + `dashboard_settings.power.billing`.

#### Current period sub-card
```
┌────────────────────────────────────────────────────────────┐
│  Current Billing Period                                     │
├────────────────────────────────────────────────────────────┤
│  2026-04-15 → 2026-06-15  (day 38 of 60, 63% elapsed)      │
│                                                             │
│  Consumption so far:       312 kWh                          │
│  Estimated cost so far:    ₪240.71  (incl. VAT + fixed fee)│
│  Projected period cost:    ₪382 (linear extrapolation)     │
│                                                             │
│  Per-phase split:                                           │
│    Phase R: 187 kWh  (60%)                                  │
│    Phase S:  98 kWh  (31%)                                  │
│    Phase T:  27 kWh   (9%)                                  │
└────────────────────────────────────────────────────────────┘
```

Color the "projected period cost" based on history — green if below avg of last 3 periods, amber within ±10%, red > 10% higher (helps spot a high-consumption period before the bill arrives).

#### Top consumers this period sub-card
Top 5 devices/categories by attributed kWh + ₪ cost this period. Lets the user see what's actually driving the bill.

#### History + reconciliation sub-card
Past billing periods table:

| Period | Days | kWh | Est. ₪ | Actual ₪ (IEC bill) | Diff |
|---|---|---|---|---|---|
| 2026-02-15 → 2026-04-15 | 60 | 645 | ₪498.16 | ₪487.00 (entered manually) | -2.2% ✓ |
| 2025-12-15 → 2026-02-15 | 62 | 712 | ₪549.84 | — | (no bill yet) |

**Bill reconciliation:** when the IEC bill arrives, user enters the bill total + reported kWh on the row. The dashboard:
- Shows estimate-vs-actual diff (validates the tariff config)
- If diff > 10% consistently across 2+ periods → flag the tariff settings for review (IEC may have updated rates)
- Optionally auto-suggest a corrected `flat_rate_ils_per_kwh` based on `bill_received_ils ÷ bill_period_kwh`

#### Solar export (future)
If/when PV panels are added, Shelly 3EM already reports `kwh_returned` (negative power = export to grid). The same data plumbing handles it; the cost card adds a "Net cost" row that nets credit against consumption per Israel's net-metering scheme. Not in scope today; baked into the schema so it lands naturally later.

## Rule engine integration

| Rule name | Group | Trigger | Output |
|---|---|---|---|
| **Power Ingest** | `power` | `shelly_3em_main` events | Inserts row into `power_consumption` |
| **Power Phase Discovery** | `power` | wildcard (any device event) | Updates `power_devices` (auto-discovers phase + signature for static + cyclic devices) |
| **Power 3-Phase Attribution** | `power` | hob / AC1 / AC2 events | Attributes their consumption across all 3 phases |
| **Power Attribution** | `power` | `shelly_3em_main` events | Computes per-device contribution, writes `power_attribution` + updates `virtual:power_picture` + `virtual:phase_<n>_background` |
| **Power Voltage Quality** | `power` | `shelly_3em_main` events + heartbeat | Emits `power:voltage_low` / `power:voltage_high` alerts |
| **Power Imbalance** | `power` | heartbeat (60 s) | Emits `power:phase_imbalance` alert when sustained imbalance detected |
| **Power Phantom Load** | `power` | heartbeat (60 s) | Emits `power:phantom_load_spike` when background bucket too high |
| **Power Device Mismatch** | `power` | wildcard (device events) | Emits `power:device_state_mismatch` |
| **Power Phase Loss** | `power` | heartbeat (60 s) | Reads last 60 s of `power_consumption`; emits `power:phase_lost:<R\|S\|T>` when avg current < 0.05 A AND avg power < 5 W for that phase. Demoted to severity=info when no devices are registered on the affected phase (can't distinguish "dead" from "no load"). |
| **Power Billing Period Roll** | `power` | heartbeat (60 s) | When `now() > current_period.start_ts + period_months`: close current `power_billing_periods` row (snapshot end-kWh + compute period_kwh + compute est_cost_ils) and open the next one (snapshot start-kWh, NULL end_ts). Idempotent — only acts on the period boundary. |
| **Power Unaccounted Background** | `power` | heartbeat (60 s) | When `virtual:phase_<n>_background > threshold_w` sustained > 30 min AND `home_mode IN ('away','abroad')`: emit `power:unaccounted_background` alert (severity info). Threshold per-phase, sentence-tunable. Prompts user to register more unmanaged devices. |

All rules sentence-tunable via Main Agent → Base Rule Settings — thresholds (`min_delta_w`, `voltage_low_v`, `voltage_high_v`, `imbalance_pct`, `phantom_load_w`, `mismatch_pct`, etc.) lifted out of Python and into authorable sentences.

## HA entity inventory (verified 2026-05-28)

Pre-build audit on `/api/states` enumerated the 15 sensors the Shelly integration exposes (the integration also surfaces `binary_sensor.shellyem3_e8db84d6909b_overpowering`, `button.shellyem3_e8db84d6909b_reboot`, and `switch.shellyem3_e8db84d6909b` — none consumed by this project). DPS keys for `HA_DIRECT_DEVICES` mapping:

| HA entity | DPS key | Unit | Live value (audit) |
|---|---|---|---|
| `sensor.r_voltage` | `r_v` | V | 231.84 |
| `sensor.r_current` | `r_a` | A | 10.79 |
| `sensor.r_power` | `r_w` | W | 2458.79 |
| `sensor.r_power_factor` | `r_pf` | — | 0.98 |
| `sensor.r_energy` | `r_kwh` | kWh | 18299.67 |
| `sensor.s_voltage` | `s_v` | V | 237.09 |
| `sensor.s_current` | `s_a` | A | 0.66 |
| `sensor.s_power` | `s_w` | W | 30.19 |
| `sensor.s_power_factor` | `s_pf` | — | 0.19 |
| `sensor.s_energy` | `s_kwh` | kWh | 8658.12 |
| `sensor.t_voltage` | `t_v` | V | 238.36 |
| `sensor.t_current` | `t_a` | A | 1.24 |
| `sensor.t_power` | `t_w` | W | 128.33 |
| `sensor.t_power_factor` | `t_pf` | — | 0.43 |
| `sensor.t_energy` | `t_kwh` | kWh | 6946.35 |

Computed in software (no HA entity):
- `total_w = r_w + s_w + t_w`
- `total_kwh = r_kwh + s_kwh + t_kwh`
- `apparent_va` per phase: `v * a` (rounded)
- System-wide power factor: `total_w / total_apparent_va`
- Frequency: hardcoded 50 Hz (Israel grid standard, not exposed by integration)

## Setup steps (when user is ready to build)

| # | What | Where | Status |
|---|---|---|---|
| 1 | Shelly 3EM physically installed in panel | Apartment | ✓ done |
| 2 | Shelly 3EM integrated in HA — 15 sensors exposed (R/S/T × V/A/W/PF/kWh) | HA on LXC 101 | ✓ verified 2026-05-28 (see entity inventory above) |
| 3 | Local-only mode (disable Shelly Cloud) | Shelly app | Optional — does not block project work |
| 4 | DHCP reservation for Shelly's local IP | Router | Recommended |
| 5 | INSERT `devices` row `shelly_3em_main` | LXC 102 | ⏳ |
| 6 | Update `HA_DIRECT_DEVICES` in `DEVICE/agent/adapters/ha_api.py` | Repo + deploy to LXC 103 | ⏳ |
| 7 | Restart `device-agent` on LXC 103 | LXC 103 | ⏳ |
| 8 | Verify Shelly DPS values landing in `devices.last_state` | Dashboard / `mosquitto_sub` | ⏳ |
| 9 | CREATE `power_consumption` / `power_devices` / `power_attribution` tables + retention policies | LXC 102 | ⏳ |
| 10 | Write Power Ingest rule (LXC 105) | RULES/rules/ | ⏳ |
| 11 | Write Power Phase Discovery rule | RULES/rules/ | ⏳ |
| 12 | Write remaining 8 power rules (incl. Power Billing Period Roll for P6 + Power Unaccounted Background for P5) | RULES/rules/ | ⏳ |
| 13 | Build Project Power page on dashboard | BOILER/dashboard/public/ | ⏳ |
| 14 | Add sidebar link + status badge wiring | BOILER/dashboard/public/sidebar | ⏳ |

## Phase rollout

| Phase | Effort | What ships |
|---|---|---|
| **P1 — Ingest + Live Status** | ~1 day | Steps 5-9 + Card 1 on dashboard. End state: live 3-phase numbers visible on Project Power page; raw `power_consumption` time-series populating. No attribution yet. |
| **P2 — Device Registry** (✓ done 2026-05-29) | unified `+ Add Device` form on the Project Power page → device picker (existing devices OR "Other custom" for unmanaged loads) + optional display-name override + Phase (R / S / T / R.S.T) + Room + Power. Behavior radio at the end: **always_on** (constant baseline) or **auto** (rule detects on/off from Shelly deltas). Single-phase rows take Expected + optional Max; R.S.T rows take per-phase Expected + Max so variable-power devices (dishwasher's heating peak) are recognized across their full range. Two new columns: **Live W** (red wattage when rule says ON, grey OFF default, always_on rows always render as ON) + **Last seen** (relative timestamp of the last state change). All rows editable; cyclic dropped as a behavior — devices that cycle just register as auto and the rule handles the cycling. |
| **P3 — Discovery Rule** | ~2 days | Power Phase Discovery rule on LXC 105. **Scope flipped 2026-05-29** — no longer learns unknown phase/power from scratch. Now the user registers each auto device up-front with phase + expected power + max power (via P2's unified form). The rule's job is purely **state recognition**: on every Shelly event, computes Δr/s/t since the previous `power_consumption` row; for each auto-registered device, checks if Δ on its registered phase falls inside `[expected_w × tol_low, max_w × tol_high]` (defaults 0.5 / 1.2, sentence-tunable). On match it flips `power_devices.live = {on:true, w:Δ (or per-phase), ts:NOW}`; on the reverse delta, flips to `{on:false, ts:NOW}`. 3-phase devices match when all three per-phase deltas hit. End state: Live W + Last seen columns light up in the registry on every detection; the LCD's ALWAYS-ON readout grows to include currently-detected auto contributions. |
| **P4 — Attribution** | ~1 day | Power Attribution rule + Card 2 (stacked bar) + Card 3 (daily kWh). Combines manual + auto-discovered entries. End state: per-device live + historical consumption visible. |
| **P5 — 3-Phase + Cyclic refinement** | ~1 day | Special rules for hob/AC1/AC2 and cyclic devices. End state: 3-phase appliances correctly attributed; washing machine / dishwasher / oven contribution dynamically tracked across cycle. |
| **P6 — Alerts** | ~1 day | 7 power-quality + anomaly rules (voltage_low/high, phase_imbalance, phantom_load_spike, device_state_mismatch, unaccounted_background, **phase_lost:R/S/T**) + Card 5 (alerts on Power page). End state: voltage / imbalance / phantom-load / device-mismatch / unaccounted-background / phase-loss monitoring live. The unaccounted-background alert drives the iterative loop back to P2 ("still 200 W I can't see → register more"). The phase-loss rule renders as a prominent `⚠ LOST PHASE X` banner above Card 1 — added 2026-05-28 after physically pulling Phase T proved voltage is not a reliable signal (V stays alive even with the breaker open; only current + power + PF collapse). |
| **P7 — Cost + Billing Cycle** | ~1-1.5 days | Tariff config + Israel 2-month billing cycle + `power_billing_periods` table + Power Billing Period Roll rule + Card 6 (settings + current period + top consumers + history with bill reconciliation). End state: live cost-so-far visible, projected period cost, ability to enter actual IEC bills for estimate-vs-reality feedback loop. |

Total: ~7-8 days spread over a few weeks. Each phase is independently shippable + commits separately. P1 alone is a useful win (live 3-phase numbers on dashboard) even without the rest.

**Why P2 (manual registry) comes before P3 (auto-discovery):** auto-discovery measures per-phase delta when smart devices toggle. If unmanaged cyclics (fridge compressor, wine fridge) cycle randomly during a smart device's transition window, they contaminate the measurement — the smart device gets credited for the fridge's 120 W. Registering manual cyclics first means their time-averaged contribution is already subtracted from each measurement → auto-discovery deltas are clean from sample #1. Also, P2 alone is useful: after P2 the dashboard's Card 4 lists all your known devices and you can see the registered baseline even before any auto-discovery runs.

## Integration with existing project

- **Reuses HA WebSocket adapter (`HA_DIRECT_DEVICES`)** — same pattern as Roomba / Aqara FP2 / Ring etc.
- **Reuses rule engine on LXC 105** — same group/trigger/depends_on architecture as every other rule group
- **Reuses sentence-driven knob pattern** — thresholds tunable via Main Agent → Base Rule Settings
- **Reuses `system_alerts` table** — power alerts surface on the existing sidebar Status badge
- **Reuses retention policy mechanism** — new tables added via the standard `retention_policies` row + Health page Vacuum / Clean buttons
- **No new LXC needed**
- **No new MQTT user needed** (HA-mediated path; if we ever switch to direct MQTT, would create `shelly_3em` Mosquitto user with `readwrite shellies/shellyem3-+/#` ACL — but not now)

## Open decisions

1. **Tariff structure** — locked: settings card supports both flat and TAOZ. Defaults: flat `0.66 ₪/kWh` (Israel residential standard ≈ 2026), fixed monthly fee `12 ₪`, VAT `17%`. User enters their actual rate from their last IEC bill at P6 build time.
2. **Billing cycle** — locked: Israel residential **2-month cycle**, configurable start day. User enters the cycle start day from their last IEC bill (it's the "תאריך קריאה" / reading date on the bill). The Power Billing Period Roll rule handles cycle rollover automatically thereafter.
3. **Cyclic-device auto-classification threshold** — `stddev_w / mean_w > 0.4`? Or stricter? Tune in P4 based on observed data.
4. **Discovery confidence promotion thresholds** — what triggers 'none' → 'low' → 'medium' → 'high'? Suggest: 1+ samples = low, 5+ with stddev/mean < 0.3 = medium, 20+ with stddev/mean < 0.2 = high. Tune in P2.
5. **Whether to skip Shelly Cloud entirely** — recommended but not required. User's choice.
6. **Solar future-proofing** — Shelly 3EM reports `kwh_returned` (negative power = export). When PV gets added later, the same data plumbing works; just need a dashboard mode that shows generation vs consumption separately. Not a blocker; baked into the data model already.

## File / location index

| Artifact | Path |
|---|---|
| This doc | `POWER/CLAUDE.md` |
| `ha_api.py` adapter (existing, edited) | `DEVICE/agent/adapters/ha_api.py` (canonical repo source) |
| Deployed adapter | `/opt/device-agent/adapters/ha_api.py` on LXC 103 |
| Power rules | `RULES/rules/power_*.py` (8 files when fully built) |
| Dashboard page | `BOILER/dashboard/public/power.html` + `BOILER/dashboard/public/js/power.js` |
| Dashboard endpoints | `BOILER/dashboard/server.js` — new `/api/power/*` routes (status / discovery / attribution / alerts / cost) |
| DB migration | `BOILER/dashboard/migrations/<date>_power_tables.sql` (or inline in `ensureSchema()` per existing convention) |
| Sentence-tunable knobs | parsed by `RULES/rule_engine.py::_parse_knob_sentences`, authored via Main Agent → Base Rule Settings |

---

**Update protocol:** keep this doc current as decisions land. New design questions → add to Open Decisions. Resolved decisions → fold into the appropriate spec section. After first phase ships → add a "Lessons Learned" section before the file index.
