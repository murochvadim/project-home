# Personal Health

A **Personal Health Record** — a per-person body-metrics tracker. **Not a standalone agent**: it lives as the **Personal Health tab on the Medical page** (`medical.html`), reusing the Medical sidebar entry. Dashboard-only; no LXC service, no `agents`-table row.

## Status (2026-06-25)
**Shipped:** per-person **profile + weight log → BMI**, and a per-person **medications list** with a safety **ℹ️ Info window**.

**People come from the existing household-users registry** — the person dropdown is populated from `dashboard_settings.privacy.users` (`[{name, smartphone}]`, the Privacy → Settings → Users list). No people are created here; each household member gets a body profile + logs attached **by name**. If that list is empty the tab points the user to Privacy → Settings → Users.

**Profile** (slow-changing, per person): name, sex, date-of-birth, height, **allergies**, **conditions** (the last two feed the future cross-check). **Weight log** (time-series). **BMI / age / BMI-category / ideal-weight** are computed in the front-end (never stored — can't go stale when height/DOB are corrected).

**Medications** (per person): each pill **row** shows `name · dose · schedule` + Info/Edit/Stop/Del — the **basic info (name/dose/schedule/notes) is edited on the row**, exactly like a normal list. The **ℹ️ Info button** opens a window holding the **extra/safety info** (purpose, ingredients, drug_class, avoid_with, contraindications, side_effects, warnings, prescriber, started) with its **own edit** (`✎ Edit info`). The **schedule model** supports `daily` / `weekly` / `every_n_months` (e.g. 6 = half-year) / `every_n_days` / `once` / `as_needed`, with `times` (HH:MM, comma-sep), `dow`, `interval_n`, `next_due` — built so a **future reminder watcher** can compute each pill's next-due time.

**Future med-safety cross-check (designed, schema is ready):** flag when a med's **`avoid_with`** / **`contraindications`** / **`ingredients`** conflict with the person's **`allergies` + `conditions`** or their **other active meds**. All the data is captured now; the flag itself is a later step. The UI is worded as a **record / reminder aid — not medical advice**.

**Deferred:** waist + waist-to-height, activity → BMR/TDEE, body-fat %, vitals (HR/BP), **progress charts** (Chart.js already loaded on the page), **goals & achievements**, **daily steps / walking distance**, and the **reminder watcher**. (`manufacturer` / `mechanism` were considered for meds and dropped — reference-only, not needed for the cross-check.)

## File Locations

| Artifact | Path |
|----------|------|
| Dashboard tab (UI) | `BOILER/dashboard/public/medical.html` → `#tab-personal-health` (tab button calls `phInit()`) |
| Front-end logic | `BOILER/dashboard/public/js/personal-health.js` (`?v=N`) |
| Backend endpoints | `BOILER/dashboard/routes-personal-health.js` (own module; wired into `server.js` via one `require()` line — past the architecture-guard hook) |
| DB setup migration | `PERSONAL_HEALTH/migrations/setup.sql` |
| Docs | this file + a note in `MEDICAL/CLAUDE.md` |

## Tables (LXC 102, `home_data`)
- **`ph_profiles`** — one row per person: `id, name, sex ('male'|'female'), date_of_birth, height_cm, allergies, conditions, created_at`. `name` matches a `privacy.users` member. Retention: forever.
- **`ph_measurements`** — weight log: `id, profile_id (FK → ph_profiles ON DELETE CASCADE), measured_at (date), weight_kg, created_at`. Indexed `(profile_id, measured_at DESC)`. Retention: forever (`auto_clean=false`).
- **`ph_medications`** — pills: `id, profile_id (FK ON DELETE CASCADE), name, dose, freq, interval_n, times, dow, next_due, notes, purpose, ingredients, drug_class, avoid_with, contraindications, side_effects, warnings, prescriber_id (→ medical_contacts), started_at, active, created_at`. Indexed `(profile_id)`. Retention: forever.

All 3 registered in `retention_policies` **and** in the Health → DB-Volumes view. DATE columns are returned as `YYYY-MM-DD` strings (`to_char`) to dodge the pg DATE timezone off-by-one.

## Endpoints (`routes-personal-health.js`, all under `/api/personal-health/`)
- **Profiles**: `GET /profiles` (+ each person's latest weight) · `POST /profiles` · `PATCH /profiles/:id` · `DELETE /profiles/:id` (cascades) — fields `{name, sex, date_of_birth, height_cm, allergies, conditions}`.
- **Measurements**: `GET /measurements?profile_id=` (newest first) · `POST /measurements` `{profile_id, measured_at?, weight_kg}` · `DELETE /measurements/:id`.
- **Medications**: `GET /medications?profile_id=` · `POST /medications` · `PATCH /medications/:id` · `DELETE /medications/:id` — all `ph_medications` fields. The basic Add/Edit form sets name/dose/schedule/notes; the Info window's `✎ Edit info` PATCHes only the safety fields.

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
