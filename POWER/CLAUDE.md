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
   last_state = {p1_w: 1240, p1_v: 230.4, p1_a: 5.38, p1_pf: 0.96, p1_kwh: 12345.6,
                 p2_w: 380, p2_v: 229.8, ..., total_w: 1710, total_kwh: 19259}
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

## DB schema additions (LXC 102)

### `power_consumption` — time-series of Shelly readings
```sql
CREATE TABLE power_consumption (
  ts        TIMESTAMPTZ PRIMARY KEY,
  p1_w      INT,           -- active power, watts
  p2_w      INT,
  p3_w      INT,
  total_w   INT,
  p1_a      NUMERIC(7,3),  -- current, amps
  p2_a      NUMERIC(7,3),
  p3_a      NUMERIC(7,3),
  p1_v      NUMERIC(5,1),  -- voltage, V
  p2_v      NUMERIC(5,1),
  p3_v      NUMERIC(5,1),
  p1_pf     NUMERIC(4,3),  -- power factor, 0..1
  p2_pf     NUMERIC(4,3),
  p3_pf     NUMERIC(4,3),
  p1_kwh    NUMERIC(10,2), -- cumulative energy, kWh
  p2_kwh    NUMERIC(10,2),
  p3_kwh    NUMERIC(10,2)
);
CREATE INDEX power_consumption_ts ON power_consumption (ts DESC);
```

Written by the rule engine on every Shelly state change event (or downsampled to once per N seconds if events are noisy). Retention: **30 days, auto_clean**.

### `power_devices` — discovered or seeded device-to-phase map
```sql
CREATE TABLE power_devices (
  device_id          TEXT PRIMARY KEY REFERENCES devices(id),
  phase              SMALLINT,        -- 1, 2, 3, OR NULL for unknown / 3-phase
  is_three_phase     BOOLEAN DEFAULT FALSE,    -- TRUE for hob, AC1, AC2
  is_cyclic          BOOLEAN DEFAULT FALSE,    -- TRUE for washing machine, dishwasher, etc.
  samples_count      INT DEFAULT 0,
  mean_w             NUMERIC,         -- running mean from observed transitions
  stddev_w           NUMERIC,         -- running stddev (used to auto-classify cyclic)
  cycle_max_w        INT,             -- highest observed wattage during a cycle (cyclic only)
  cycle_typical_kwh  NUMERIC,         -- avg kWh per complete ON→OFF cycle (cyclic only)
  confidence         TEXT,            -- 'none' | 'low' | 'medium' | 'high'
  last_observed_at   TIMESTAMPTZ,
  source             TEXT,            -- 'auto_discovered' | 'manual_seed' | 'baseline_calibration'
  notes              TEXT
);
```

Static devices: phase + mean_w + stddev_w form the signature.
Cyclic devices: phase only (stable); mean_w and stddev_w are diagnostic; actual contribution attributed dynamically while ON.
3-phase devices: is_three_phase = TRUE, phase = NULL, mean_w = nominal total across all 3 phases.

Retention: **forever** (config-like data, low volume).

### `power_attribution` — computed per-timestamp breakdown
```sql
CREATE TABLE power_attribution (
  ts            TIMESTAMPTZ,
  device_id     TEXT,
  phase         SMALLINT,
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
  start_kwh_p1      NUMERIC,                    -- meter snapshot at period start
  start_kwh_p2      NUMERIC,
  start_kwh_p3      NUMERIC,
  end_kwh_p1        NUMERIC,                    -- meter snapshot at period end
  end_kwh_p2        NUMERIC,
  end_kwh_p3        NUMERIC,
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

- `virtual:phase_1_background`, `virtual:phase_2_background`, `virtual:phase_3_background` — residual / unknown load per phase (sum of all small + unmodeled draws). `last_state.w` updated by the Attribution rule.
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
  7. Compute Δp1, Δp2, Δp3 = (after - before)
  8. Threshold guard: if max|Δ| < 10 W → skip (below noise floor, untrackable)
  9. For ON events: phase = argmax(Δp1, Δp2, Δp3); measured_w = +largest_delta
     For OFF events: phase = argmin(Δp1, Δp2, Δp3); measured_w = -largest_delta
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
  '{"phase":1,"load_type":"cyclic","peak_w":120,"duty_cycle_pct":25,"notes":"kitchen, single-door"}'::jsonb
);
```

And a matching `power_devices` row:
```sql
INSERT INTO power_devices (device_id, phase, source, confidence, mean_w, notes)
VALUES (
  'manual_fridge',
  1,
  'manual_unmanaged',                                   -- NEW source value
  'high',                                                -- manual entries treated as high-confidence by definition
  30,                                                    -- time-averaged contribution (peak_w * duty_cycle / 100)
  'Phase 1, cycle ~25% — avg 30W, peak 120W'
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
- **Phase** (1 / 2 / 3 — required)
- **Load type** (always-on / cyclic / intermittent — required)
- **Always-on wattage** (W) — shown if load type is always-on
- **Peak wattage** (W) + **Duty cycle** (%) — shown if load type is cyclic
- **Notes** (optional)

Save creates the `devices` row + `power_devices` row in one transaction.

Edit existing manual devices inline (click row → edit panel).

### Phase residual after manual + auto entries

```
phase_observed_w   = e.g. 145 W (right now, while home_mode='abroad')

minus all known managed devices on this phase that are ON   (e.g. nothing, since user is away)
minus all manual always-on devices on this phase            (e.g. router 25 W + modem 15 W = 40 W)
minus all manual cyclic devices' time_avg_w on this phase   (e.g. fridge 30 W)
                                                              ─────
                                                              70 W subtracted

phase_background_w = 145 − 70 = 75 W       ← still unattributed
```

If `phase_background_w` is still high (e.g. 75 W on phase 1 while everything known is OFF), the user has more unmanaged devices to register. Iterative process.

### Sanity check + alert: "still too much background"

New alert (variant of `power:phantom_load_spike`):
- **`power:unaccounted_background`** — when `virtual:phase_<n>_background > N W` sustained > 30 min AND `home_mode IN ('away','abroad')`
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
- After subtracting all known tracked devices from each phase's observed wattage, the residual = `virtual:phase_<n>_background`
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

All five alerts auto-resolve when the underlying condition clears (no manual ack needed).

## Dashboard — Project Consumption page

New sidebar entry under "General". Six cards:

### Card 1 — Shelly 3EM Live Status (top of page)

Three columns, one per phase, plus a "Total" column:

```
┌──────────────┬──────────────┬──────────────┬───────────────┐
│  Phase 1     │  Phase 2     │  Phase 3     │  Total        │
├──────────────┼──────────────┼──────────────┼───────────────┤
│  Voltage     │  Voltage     │  Voltage     │  Total Power  │
│  230.4 V     │  229.8 V     │  231.1 V     │  1,710 W      │
│  Current     │  Current     │  Current     │  Apparent     │
│  5.38 A      │  1.65 A      │  0.39 A      │  1,842 VA     │
│  Power       │  Power       │  Power       │  Power factor │
│  1,240 W     │  380 W       │  90 W        │  0.93         │
│  Power factor│  Power factor│  Power factor│  Frequency    │
│  0.96        │  0.93        │  0.88        │  50.0 Hz      │
└──────────────┴──────────────┴──────────────┴───────────────┘

Phase imbalance: 72% (high) ⚠
Voltage quality: all phases in nominal 220-240V band ✓
```

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
│    Phase 1: 187 kWh  (60%)                                  │
│    Phase 2:  98 kWh  (31%)                                  │
│    Phase 3:  27 kWh   (9%)                                  │
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
| **Power Billing Period Roll** | `power` | heartbeat (60 s) | When `now() > current_period.start_ts + period_months`: close current `power_billing_periods` row (snapshot end-kWh + compute period_kwh + compute est_cost_ils) and open the next one (snapshot start-kWh, NULL end_ts). Idempotent — only acts on the period boundary. |
| **Power Unaccounted Background** | `power` | heartbeat (60 s) | When `virtual:phase_<n>_background > threshold_w` sustained > 30 min AND `home_mode IN ('away','abroad')`: emit `power:unaccounted_background` alert (severity info). Threshold per-phase, sentence-tunable. Prompts user to register more unmanaged devices. |

All rules sentence-tunable via Main Agent → Base Rule Settings — thresholds (`min_delta_w`, `voltage_low_v`, `voltage_high_v`, `imbalance_pct`, `phantom_load_w`, `mismatch_pct`, etc.) lifted out of Python and into authorable sentences.

## Setup steps (when user is ready to build)

| # | What | Where | Status |
|---|---|---|---|
| 1 | Shelly 3EM physically installed in panel | Apartment | ✓ done |
| 2 | Shelly 3EM integrated in HA | HA on LXC 101 | ✓ done (per user) |
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
| 13 | Build Project Consumption page on dashboard | BOILER/dashboard/public/ | ⏳ |
| 14 | Add sidebar link + status badge wiring | BOILER/dashboard/public/sidebar | ⏳ |

## Phase rollout

| Phase | Effort | What ships |
|---|---|---|
| **P1 — Ingest + Live Status** | ~1 day | Steps 5-9 + Card 1 on dashboard. End state: live 3-phase numbers visible on Project Consumption page; raw `power_consumption` time-series populating. No attribution yet. |
| **P2 — Manual Device Registry** | ~1 day | Card 4's "+ Add Unmanaged Device" form (always-on / cyclic / intermittent categories) + the `devices` row + `power_devices` row creation flow. User registers every known unmanaged device they're aware of (fridge, wine fridge, routers, modems, aquarium pump, etc.). End state: the always-on + cyclic baseline of the home is captured in `power_devices` BEFORE any auto-discovery starts. Iterative — user keeps registering devices as they realize they exist. |
| **P3 — Auto-Discovery Rule** | ~2 days | Power Phase Discovery rule on LXC 105 + the discovery-status portion of Card 4 (auto-discovered rows). Now starts with the manual baseline in place, so per-device delta measurements are clean (fridge cycles already subtracted via time-averaged contribution). End state: `power_devices` self-populating over the next week as smart devices toggle. |
| **P4 — Attribution** | ~1 day | Power Attribution rule + Card 2 (stacked bar) + Card 3 (daily kWh). Combines manual + auto-discovered entries. End state: per-device live + historical consumption visible. |
| **P5 — 3-Phase + Cyclic refinement** | ~1 day | Special rules for hob/AC1/AC2 and cyclic devices. End state: 3-phase appliances correctly attributed; washing machine / dishwasher / oven contribution dynamically tracked across cycle. |
| **P6 — Alerts** | ~1 day | 6 power-quality + anomaly rules (incl. unaccounted-background) + Card 5 (alerts on Power page). End state: voltage / imbalance / phantom-load / device-mismatch / unaccounted-background monitoring live. The unaccounted-background alert is what drives the iterative loop back to P2 ("still 200 W I can't see → register more"). |
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
