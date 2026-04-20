---
description: Re-score every room's AI observability using rubric v2.0 (strict subtractive) based on 30 days of live data. Starts from 10, subtracts for each gap, rounds DOWN — pessimistic by design. Shows side-by-side diff (old vs proposed), asks user which rooms to accept, rotates + writes only after per-room approval.
---

# /review-rooms-score — Rooms Scoreboard Re-run

Re-evaluates every room's AI observability score using **30 days of live data** and writes results to the `rooms` table **only after user confirms each room**. Skill is DB-only (no code changes, no pm2 restart). User views results via `📊 Scoreboard` button in the Room Information card on the Rooms page.

## When to run

- After adding / removing / moving sensors
- After defining new zones or editing existing ones
- After placing new lights with controller links
- After migrating a sensor from `cloud` → `local` protocol
- Roughly every 30–60 days as a health-check even without changes

## Safety guarantees

- **Nothing is written before user approval.** Analysis is read-only until the approval prompt.
- **Per-room approval.** User can accept only specific rooms, reject others — no all-or-nothing.
- **Rotate is atomic with write.** Current `ai_score_new → ai_score_old` only happens when writing the fresh new score, so rejecting a room leaves its previous state intact.
- **Dry-run mode.** Pass `--dry` to skip the approval prompt and stop after showing the diff table.

## Flow

### Step 1 — Read-only data gather

For each room, query (via postgres-lxc MCP — all SELECT queries, zero writes):

```sql
-- Rooms + their layouts
SELECT r.name,
       ds.value::jsonb AS layout
FROM rooms r
LEFT JOIN dashboard_settings ds
  ON ds.key = 'room_layouts.' || lower(replace(r.name, ' ', '-'))
ORDER BY r.name;

-- Sensor placements per room
SELECT p.slug, d.name, d.protocol, d.last_source,
       EXTRACT(EPOCH FROM (now() - d.last_seen))/60 AS min_since_seen,
       (p.params->>'enabled')::text AS enabled,
       jsonb_object_keys(d.dps_labels) AS labeled_keys
FROM room_device_placements p
JOIN devices d ON d.id = p.device_id
WHERE p.device_type IN ('presence','motion')
ORDER BY p.slug;

-- Light placements per room
SELECT slug, COUNT(*) AS n_lights
FROM room_device_placements
WHERE device_type = 'light'
GROUP BY slug;

-- 30-day sensor activity per device (event count, first/last event)
SELECT device_id,
       COUNT(*) AS event_count_30d,
       MIN(ts) AS first_event,
       MAX(ts) AS last_event
FROM device_events
WHERE ts > now() - interval '30 days'
GROUP BY device_id;

-- Motion amplitude stats (for mmWave sensors — stuck detection)
SELECT de.device_id,
       COUNT(*) AS n_samples,
       AVG((de.dps->>'107')::float) AS avg_amplitude,
       MAX((de.dps->>'107')::float) AS max_amplitude
FROM device_events de
JOIN devices d ON d.id = de.device_id
WHERE d.product_name IN ('MTD086存在传感器WIFI', 'Human presence sensor')
  AND de.ts > now() - interval '30 days'
  AND de.dps ? '107'
GROUP BY de.device_id;

-- Battery trend per sensor (slope of battery % over 30 days)
SELECT de.device_id,
       MIN((de.dps->>'battery')::int) AS min_battery,
       MAX((de.dps->>'battery')::int) AS max_battery,
       (MAX((de.dps->>'battery')::int) - MIN((de.dps->>'battery')::int)) AS battery_drop
FROM device_events de
JOIN devices d ON d.id = de.device_id
WHERE d.vendor = 'Aeotec'
  AND de.ts > now() - interval '30 days'
  AND de.dps ? 'battery'
GROUP BY de.device_id;

-- Current scoreboard state (to diff against)
SELECT name, ai_score_old, ai_score_old_at, ai_score_old_reason,
       ai_score_new, ai_score_new_at, ai_score_new_reason
FROM rooms
ORDER BY name;
```

### Step 2 — Apply rubric v2.1 (hardware-class ceiling + subtractive gaps)

**Philosophy:** Max score is tied to *real AI capabilities*, not structural checkboxes. A room of binary sensors and no lights cannot score 10, no matter how many zones/doors/labels it has. Score 10 is reserved for rooms where AI can answer every spatial question: who, how many, exactly where, doing what.

```
--- Step 2a: compute max_achievable ceiling (based on hardware class) ---
max_achievable = 6
+1 if room has at least 1 mmWave stationary-capable sensor
+1 if room has lights placed with working controller link
+1 if room has a multi-target tracker (LD2450 / Aqara FP2 / ceiling ToF)
+1 if room has individual-ID capability (BLE tag scanner / camera + face recognition)

  → Current house hardware caps every room at 8 (no FP2/LD2450/BLE yet).
  → A room without lights caps at 7.
  → A room without mmWave caps at 7 or lower.
  → 10 requires multi-target tracking AND individual ID.

--- Step 2b: subtract for structural gaps ---

Sensor coverage penalty is AREA-SCALED — coverage redundancy matters more in
large rooms than tiny ones:
  room > 30 m², < 3 sensors         → −3  (severely under-covered)
  15 m² < room ≤ 30 m², < 3         → −2  (sparse)
  5 m² < room ≤ 15 m², < 3          → −1  (small room, single sensor adequate)
  room ≤ 5 m², < 3                  → −0.5 (tiny; no redundancy needed)
For sub-rooms use the sub-area in m² instead of whole-room area.

Device-quality penalties:
−2    any sensor on cloud-fallback with ONLY DPS 1 emitted (severe AI gap — no distance/amplitude)
−1.5  any sensor offline OR event_count_30d = 0 (dead)
−0.5  mmWave avg_amplitude < 10 over 30d (stuck-zero trend)
−0.5  Aeotec battery_drop > 30% in 30d
−0.5  missing DPS labels on any enabled sensor
−1    primary sensor for the area is disabled

Spatial model penalties:
−1    no zones defined with meaningful activity names (where zones expected)
−1    any named zone with no sensor cone reaching it (blind zone)
−0.5  any zone name has a typo
−0.5  room adjacency not modeled (0 doors/archways with leads_to)

Usage penalty:
−0.5  room had 0 rule triggers in last 30d

NOTE: "no mmWave" and "no lights placed" are NOT listed as structural penalties here
because they are already reflected in `max_achievable` (Step 2a). Double-penalizing
them would be dishonest.

Clamp to [0, max_achievable]. Round DOWN.

--- Hard floor ---
score = 0  if room has no own layout AND no zone representation in any other drawn room

--- Sub-room handling ---
Sub-rooms (Kitchen/Dining Room/Corridor/Entrance inside Living Room) compute
their own max_achievable + gaps using sensors+lights specifically scoped to
their zone cluster. Cap: sub-room score ≤ parent room's score.
```

### Step 2c — Compute per-capability ratings (shown in modal, diagnostic only)

For each room, compute the 7 capability ratings (0–10) using current hardware state:

```
Capability              Rating logic
─────────────────────────────────────────────────────────────────────────────
Presence yes/no         4 if 0 sensors, 6 if 1, 8 if 2, 9 if 3+, +1 if mmWave
Which zone              0 if no zones defined, 4 if 1-2 zones, 6 if 3+,
                        +2 if multi-sensor overlap resolving zones
People count            0 if no sensors, 5 with binary sensors only,
                        9 if FP2/LD2450 present, 10 if multiple trackers
2D position             3 if 1 sensor, 5-6 if multi-mmWave with distance,
                        9 if LD2450/FP2, 10 with dense 2D tracking
Individual ID           0 without BLE/camera, 7 with BLE tags, 10 with face rec
Activity classification 1 if PIR only, 3 if mmWave binary, 4 if amplitude,
                        9 if camera+pose
Light state control     0 if no lights placed, 9 if placed with controller,
                        10 if all lights working fully
```

These are displayed in the Scoreboard modal per room as a diagnostic table so
the user sees exactly *which* capabilities are weak and what hardware would
improve them. They do NOT directly determine the overall score — the overall
score is computed by Step 2a+2b (ceiling - gaps).

### Step 3 — Present diff table (no writes yet)

Format for every room, whether it changed or not:

```
[#]  Room                 Old   Proposed   Delta   Reason
─────────────────────────────────────────────────────────────────
[1]  Living Room           9       10       +1     Lights placed + "Dinning" typo fixed; 4 rules triggered in 30d
[2]  Balcony               7        7       ±0     No change — coverage, lights, zones identical since baseline
[3]  Guy Room              6        5       −1     Sensor had 0 events in 30d (possible dead); battery 18%
[4]  Hallway               6        6       ±0     No change — still 2 PIRs, no zones
[5]  Laundry               6        6       ±0     No change
[6]  My BathRoom           6        7       +1     Lights placed + 2 rules triggered
[7]  My Room               5        7       +2     Migrated from cloud to local → full DPS telemetry
[8]  Kitchen               7        8       +1     Kitchen lights placed within zones
[9]  Entrance              6        6       ±0     No change
[10] Corridor              5        5       ±0     No change
[11] Dining Room           5        6       +1     "Dinning" typo fixed → "Dining Table"
[12] Bathroom              0        0       ±0     Still not drawn
[13] Bedroom               0        0       ±0     Still not drawn
[14] BedRoom Balcony       0        0       ±0     Still not drawn
[15] DressRoom             0        0       ±0     Still not drawn

Legend: green = improvement, orange = regression, grey = ±0 (no change)
```

Every row shows a reason — **never silent**. `±0` rows say "no change" explicitly.

### Step 4 — Per-room approval prompt

After the table, prompt the user:

```
Approve changes? Options:
  • "all"            — accept all rows (writes everything, including ±0 which just refreshes the new-column timestamp)
  • "1,3,7"          — accept only specific room numbers (comma-separated)
  • "changed"        — accept only rows with non-zero delta (shortcut)
  • "cancel" / "no"  — write nothing, exit
```

Interpret the response:
- `all` → write all 15
- `changed` → filter `proposed != old`, write those only
- Comma-list → write only those row numbers
- `cancel` / `no` / empty → no writes, report "0 rooms updated"

### Step 5 — Writes (only happens after approval)

For each approved room, per-room atomic flip + write via existing endpoints:

```bash
# Skip rotation per-room if ai_score_new is NULL (first-run — baseline stays as old)
# Otherwise rotate that room specifically then write the fresh new.

curl -X POST http://127.0.0.1:3000/api/rooms/scoreboard/rotate
# (Server-side: only rotates rows where ai_score_new IS NOT NULL — safe to call globally.
#  Even on first run this is a no-op.)

# Then per approved room:
curl -X PATCH http://127.0.0.1:3000/api/rooms/<NAME>/score \
     -H 'Content-Type: application/json' \
     -d '{"score": 7, "reason": "Migrated from cloud to local — full DPS telemetry"}'
```

Write reason text ≤ 150 chars, delta-focused ("what changed / what improved").

### Step 6 — Final summary

After all writes complete, print:

```
✓ Updated 7 rooms: Living Room, My Room, My BathRoom, Kitchen, Dining Room, Guy Room, Balcony
  Skipped (user rejected): 0
  Unchanged (±0, not written): 8

Rubric: v1.1
Data window: 30 days (2026-03-21 → 2026-04-20)
```

## Dry-run mode

If user invokes `/review-rooms-score --dry`:
- Do Steps 1–3 normally
- **Skip Step 4 prompt, skip Step 5 writes**
- Print "DRY-RUN: no writes performed. Run without --dry to apply."

Use dry-run for: previewing proposed changes, rubric tuning, reviewing after big hardware additions without committing yet.

## Flip semantics summary

| Run # | Before run | After approved run |
|-------|------------|---------------------|
| 1 (current state) | `old=X, new=NULL` | `old=X (unchanged), new=Y (fresh)` |
| 2+ | `old=X, new=Y` | `old=Y (rotated), new=Z (fresh)` |

The `old` slot always holds the score being compared against; `new` always holds the most recent computation. Rejected rooms stay frozen (no rotate, no write).

## Notes

- Skill never restarts any service or edits code
- All writes go through the dashboard API (which goes to PostgreSQL on LXC 102)
- Rubric is versioned (`v1.1`) inside this file; skill prompt must reference it verbatim per run
- First run ever: `rotate` is a no-op; only `new` gets filled; baseline (`old` from 2026-04-20 Phase 1) preserved
- Subsequent runs: per-approved-room rotation moves that room's previous `new` → `old`

## Rubric version log

- **v1** (2026-04-20) — initial. Additive bonuses + penalties with [0,10] clamp. Room with no layout = 0.
- **v1.1** (2026-04-20) — sub-room handling (Kitchen/Dining Room/Corridor/Entrance scored via Living Room parent coverage); 30-day signal additions.
- **v2.0** (2026-04-20) — **subtractive rubric**: start from 10, subtract for gaps, round DOWN. Pessimistic by design. Ceiling of 10 reserved for rooms with zero gaps. Sub-rooms capped by parent. Replaces additive bonuses which were allowing rooms to hit ceiling despite missing lights / zones / sensors.
- **v2.1** (2026-04-20) — **hardware-class ceiling**: max_achievable tied to actual AI capabilities (mmWave, lights, multi-target tracker, individual ID). Current house hardware caps every room at 8 — reaching 10 requires FP2/LD2450 + BLE/camera additions. Adds per-capability diagnostic table (presence/zone/count/2D/ID/activity/lights) shown in modal so user sees exactly what's weak.
