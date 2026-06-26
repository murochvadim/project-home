# Personal Health

A **Personal Health Record** — a per-person body-metrics tracker. **Not a standalone agent**: it lives as the **Personal Health tab on the Medical page** (`medical.html`), reusing the Medical sidebar entry. Dashboard-only; no LXC service, no `agents`-table row.

## Status (2026-06-25)
**Shipped:** per-person **profile + weight log → BMI**, and a per-person **medications list** with a safety **ℹ️ Info window**.

**People come from the canonical `household_users` table** — the person dropdown is populated from `GET /api/household-users` (the Privacy → Settings → Users list, a real table since 2026-06-25 — REPLACED the old `dashboard_settings.privacy.users` JSON blob, which was deleted). No people are created here; each household member gets a body profile + logs. `ph_profiles.user_id` FKs to `household_users(id)` (resolution still also works by name during transition). If the list is empty the tab points the user to Privacy → Settings → Users.

**Profile** (slow-changing, per person): name, sex, date-of-birth, height, **allergies**, **conditions** (the last two feed the future cross-check). **Weight log** (time-series). **BMI / age / BMI-category / ideal-weight** are computed in the front-end (never stored — can't go stale when height/DOB are corrected).

**Medications** (per person): each pill **row** shows `name · dose · schedule` + Info/Edit/Stop/Del — the **basic info (name/dose/schedule/notes) is edited on the row**, exactly like a normal list. The **ℹ️ Info button** opens a window holding the **extra/safety info** (purpose, ingredients, drug_class, avoid_with, contraindications, side_effects, warnings, prescriber, started) with its **own edit** (`✎ Edit info`). The **schedule model** supports `daily` / `weekly` / `every_n_months` (e.g. 6 = half-year) / `every_n_days` / `once` / `as_needed`, with `times` (HH:MM, comma-sep), `dow`, `interval_n`, `next_due` — built so a **future reminder watcher** can compute each pill's next-due time.

**Future med-safety cross-check (designed, schema is ready):** flag when a med's **`avoid_with`** / **`contraindications`** / **`ingredients`** conflict with the person's **`allergies` + `conditions`** or their **other active meds**. All the data is captured now; the flag itself is a later step. The UI is worded as a **record / reminder aid — not medical advice**.

**Deferred:** waist + waist-to-height, activity → BMR/TDEE, body-fat %, vitals (HR/BP), **progress charts** (Chart.js already loaded on the page), **goals & achievements**, and the **reminder watcher**. (**Daily steps shipped 2026-06-25** — manual + walking-trip import; see "Daily steps" below.) (`manufacturer` / `mechanism` were considered for meds and dropped — reference-only, not needed for the cross-check.)

## File Locations

| Artifact | Path |
|----------|------|
| Dashboard tab (UI) | `BOILER/dashboard/public/medical.html` → `#tab-personal-health` (tab button calls `phInit()`) |
| Front-end logic | `BOILER/dashboard/public/js/personal-health.js` (`?v=N`) |
| Backend endpoints | `BOILER/dashboard/routes-personal-health.js` (own module; wired into `server.js` via one `require()` line — past the architecture-guard hook) |
| DB setup migration | `PERSONAL_HEALTH/migrations/setup.sql` |
| Docs | this file + a note in `MEDICAL/CLAUDE.md` |

## Tables (LXC 102, `home_data`)
- **`ph_profiles`** — one row per person: `id, name, sex ('male'|'female'), date_of_birth, height_cm, allergies, conditions, weight_sched, bp_sched, created_at, user_id`. **`user_id` FK → `household_users(id)` ON DELETE CASCADE** (the canonical member identity; backfilled by name 2026-06-25, `ph_profiles.name` kept for transition). **`weight_sched` / `bp_sched`** (JSONB, added 2026-06-26, migration `012_measure_schedule.sql`) — per-person **measure reminder schedule** for the Weight + BP cards: `{freq, interval_n}` or NULL=Off. `freq ∈ daily | weekly | every_n_days | every_n_months` (same options as meds **minus** weekday / day-of-month / time, per user); `interval_n` only for the `every_n_*` freqs. Capture-only today; a **future LXC-104 reminder watcher** will read these + the person's last weight/BP `measured_at` and flag "overdue" when nothing's logged within the window (no `next_due` stored — derived from the last reading). Retention: forever.
- **`ph_measurements`** — weight log: `id, profile_id (FK → ph_profiles ON DELETE CASCADE), measured_at (timestamptz, stamped server-side on Save — same style as BP, no manual date), weight_kg, created_at`. Indexed `(profile_id, measured_at DESC)`. Retention: forever (`auto_clean=false`).
- **`ph_medications`** — pills: `id, profile_id (FK ON DELETE CASCADE), name, dose, freq, interval_n, times, dow, next_due, notes, purpose, ingredients, drug_class, avoid_with, contraindications, side_effects, warnings, prescriber_id (→ medical_contacts), started_at, active, created_at`. Indexed `(profile_id)`. Retention: forever.
- **`ph_steps`** — daily step entries: `id, user_id (FK → household_users ON DELETE CASCADE — NOT profile_id; keyed by the person so walking-trip imports match), measured_at (timestamptz), steps (int), source ('manual'|'trip'), trip_id (bigint, phone_trips.id when source='trip'), created_at`. Indexed `(user_id, measured_at DESC)` + **partial UNIQUE `(trip_id) WHERE trip_id IS NOT NULL`** (a trip imported once). Migration `010_steps.sql`. Retention: forever.

All 3 registered in `retention_policies` **and** in the Health → DB-Volumes view. DATE columns are returned as `YYYY-MM-DD` strings (`to_char`) to dodge the pg DATE timezone off-by-one.

## Endpoints (`routes-personal-health.js`, all under `/api/personal-health/`)
- **Profiles**: `GET /profiles` (+ each person's latest weight; returns `weight_sched` + `bp_sched`) · `POST /profiles` · `PATCH /profiles/:id` · `DELETE /profiles/:id` (cascades) — fields `{name, sex, date_of_birth, height_cm, allergies, conditions, weight_sched, bp_sched}`. The two `*_sched` fields are the measure-reminder schedule (JSONB `{freq, interval_n}`/null), PATCHed on-change by the dropdown on the Weight / BP cards (`phSchedChange` in `personal-health.js`).
- **Measurements**: `GET /measurements?profile_id=` (newest first) · `POST /measurements` `{profile_id, weight_kg}` (measured_at stamped server-side on Save) · `DELETE /measurements/:id`.
- **Medications**: `GET /medications?profile_id=` · `POST /medications` · `PATCH /medications/:id` · `DELETE /medications/:id` — all `ph_medications` fields. The basic Add/Edit form sets name/dose/schedule/notes; the Info window's `✎ Edit info` PATCHes only the safety fields.
- **Steps**: `GET /steps?user_id=` (→ `{today_total, today_trip, today_manual, today_trip_count}`, Asia/Jerusalem day) · `POST /steps` `{user_id, steps}` (manual, server-stamped, source='manual'). Keyed by `household_users.id`, not `profile_id`.

## Daily steps (manual + walking-trip import)
A **👟 Daily steps** card in the same grid row as Log weight / Log blood pressure: a number input + **Save** (server-stamped) and a live **"Today: N steps (M from K walking trips)"** line, fed by `GET /steps`. Keyed by the selected person's `household_users.id` (so manual + trip entries share a key).

**Auto-import from walking trips** — `scripts/steps_from_trips.py` on **LXC 104**, cron `*/15`. For each confirmed, closed `phone_trips` row that looks like **walking** — average speed (`path_length_m/duration_sec`) within the configured window **and** distance ≤ cap — mapped to a member by `device_label → household_users`, not already imported (`trip_id`), it inserts a `ph_steps` row (`steps = round(km × steps_per_km)`, `source='trip'`, `measured_at = trip.returned_at`). Idempotent (partial-unique `trip_id` + NOT-EXISTS guard); first run backfills all qualifying past trips. **Speed — not distance — is the walk/drive discriminator** (real data: walks 3–7 km/h, car 14–21 km/h); distance is only a sanity cap. (Currently only Vadim's phone produces trips; Maya gets trip-steps once her phone is OwnTracks-tracked.)

**Phantom-trip defenses (2026-06-26):** (1) **import filter** — only trips with `max_dist_m > min_trip_dist_m` (default 250 m, the same line the geo janitor + Recent-trips view use) are imported, so a stationary-GPS night ghost (~130 m) is never counted as steps; (2) **reconcile each run** — before importing, `DELETE FROM ph_steps WHERE source='trip' AND NOT EXISTS (… phone_trips …)` drops any step row whose trip the `geo_trip_janitor` (LXC 104, `*/5`) later deleted as a phantom. So `ph_steps` trip rows stay in sync with the authoritative `phone_trips` set. Caught 2 real orphans (night ghosts at ~02:00 local) on first run. The watcher reads `phone_trips` directly (no display-filter); reconcile is what aligns it to the janitor's deletions.

**Timezone (2026-06-26):** all three history lists + the "✓ saved" status (weight / BP / steps) render `measured_at` via `to_char(measured_at AT TIME ZONE 'Asia/Jerusalem', …)` — the pg session is `Etc/UTC`, so the bare `to_char` showed times 3 h behind local (e.g. a 09:59 trip read 06:59) while the "Today" total — which already converted — was right. The 6 `GET`/`POST` renders in `routes-personal-health.js` now convert. Stored instants are true UTC (OwnTracks `tst` epoch; manual saves = `now()`); only the **display** was wrong. The `+Add`/Edit round-trip is symmetric: `_histTs` builds a UTC ISO from the local date+time, display converts back. (Tests tab renders `tested_at` browser-side via `new Date(iso).toLocaleDateString` — different method, also correct.)

**Medical → Settings tab** edits the thresholds, stored in `dashboard_settings.medical.steps`: `steps_per_km` (def 1300), `walk_min_kmh` / `walk_max_kmh` (def 2 / 9), `walk_max_km` cap (def 30), **`history_limit`** (def 10 — the N below). Read by the watcher each run. (Manual + trip steps both add to the daily total — by design; if the manual number comes from a phone pedometer it already includes the walks, so that's a deliberate double-count the user accepts.)

**History modal (view / edit / remove — all three cards, 2026-06-26):** a **🕓 icon** on each of **Log weight**, **Log blood pressure**, **👟 Daily steps** opens a shared modal (`#ph-hist-modal`, JS `HIST`/`phHistory`/`phHist*` in `personal-health.js`) listing the **last N entries** (N = `history_limit`) for the selected person, each with inline **Edit** + **✕ remove**, plus a **"+ Add"** form that accepts a **chosen timestamp** (date + time, default now → ISO) for backdating / re-adding. **Trip-derived step entries are fully editable** (the km→steps calc isn't always right; the importer never overwrites an existing row, so an edit sticks) **and removable** — deleting a trip entry inserts its `trip_id` into **`ph_steps_excluded_trips`** so `steps_from_trips.py` won't re-import it (`AND t.id NOT IN (SELECT trip_id FROM ph_steps_excluded_trips)`). Backing endpoints (all in `routes-personal-health.js`): weight `GET /measurements?…&limit=` + `PATCH /measurements/:id` + `DELETE`; BP `GET /bp?profile_id=&limit=` + `PATCH /bp/:id` + `DELETE`; steps `GET /steps/list?user_id=&limit=` + `PATCH /steps/:id` + `DELETE /steps/:id` (the delete adds the trip exclusion). All three `POST`s accept an optional `measured_at` (ISO) for the timestamped add. New table **`ph_steps_excluded_trips`** (`trip_id PK, excluded_at`) — migration `011_steps_excluded.sql`.

## Computed metrics (front-end, `personal-health.js`)
- **Age** = years from `date_of_birth`
- **BMI** = `weight_kg / (height_cm/100)²`; **category** color-coded (Underweight `#e67e22` / Normal `#2e7d32` / Overweight `#e67e22` / Obese `#c0392b`)
- **Ideal weight** range = BMI 18.5–24.9 mapped to kg for the person's height

## Deploy notes
- HTML/JS are static → cache-bust + hard-refresh.
- `routes-personal-health.js` is a backend route module → needs a **dashboard restart** (`pm2 delete boiler-dashboard && pm2 start ecosystem.config.js`) to register the routes.
- The migration runs on LXC 102 via LXC 104 (`psql -h 192.168.1.219`).

## Extending
Add the deferred metrics by extending `ph_measurements` (waist_cm, resting_hr, bp_*) + `ph_profiles` (activity_level, target_weight_kg), then the front-end derivations (BMR/TDEE/body-fat) + a Chart.js progress card + a goals card. Steps/distance would be a sibling table `ph_activity_log`.
