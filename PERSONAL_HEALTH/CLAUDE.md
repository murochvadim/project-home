# Personal Health

A **Personal Health Record** — a per-person body-metrics tracker. **Not a standalone agent**: it lives as the **Personal Health tab on the Medical page** (`medical.html`), reusing the Medical sidebar entry. Dashboard-only; no LXC service, no `agents`-table row.

## Status — minimum first step (2026-06-25)
Shipped: **per-person profile + weight log → BMI**. Each person has a profile (name, sex, date-of-birth, height); weights are logged over time; **BMI, age, BMI-category, and ideal-weight range are computed in the front-end** from those rows (never stored — so they can't go stale if height/DOB are corrected).

**Deferred to later steps** (designed, not built): waist circumference + waist-to-height ratio, activity level → BMR/TDEE, body-fat % estimate, resting HR / blood pressure vitals, **progress charts** (Chart.js is already loaded on the page), and **goals & achievements** (target weight, step goals, etc.). The original scope also included **Daily Steps / Walking Distance** — also a later step.

## File Locations

| Artifact | Path |
|----------|------|
| Dashboard tab (UI) | `BOILER/dashboard/public/medical.html` → `#tab-personal-health` (tab button calls `phInit()`) |
| Front-end logic | `BOILER/dashboard/public/js/personal-health.js` (`?v=N`) |
| Backend endpoints | `BOILER/dashboard/routes-personal-health.js` (own module; wired into `server.js` via one `require()` line — past the architecture-guard hook) |
| DB setup migration | `PERSONAL_HEALTH/migrations/setup.sql` |
| Docs | this file + a note in `MEDICAL/CLAUDE.md` |

## Tables (LXC 102, `home_data`)
- **`ph_profiles`** — one row per person: `id, name, sex ('male'|'female'), date_of_birth, height_cm, created_at`. Retention: forever.
- **`ph_measurements`** — weight log: `id, profile_id (FK → ph_profiles ON DELETE CASCADE), measured_at (date), weight_kg, created_at`. Indexed `(profile_id, measured_at DESC)`. Retention: forever (`auto_clean=false`).

Both registered in `retention_policies`. (Not yet added to the Health → DB-Volumes view — a follow-up if desired.)

## Endpoints (`routes-personal-health.js`)
- `GET /api/personal-health/profiles` — list (+ each person's latest weight)
- `POST /api/personal-health/profiles` `{name, sex, date_of_birth, height_cm}`
- `PATCH /api/personal-health/profiles/:id` — edit any field
- `DELETE /api/personal-health/profiles/:id` — cascades the person's measurements
- `GET /api/personal-health/measurements?profile_id=` — weight log, newest first
- `POST /api/personal-health/measurements` `{profile_id, measured_at?, weight_kg}`
- `DELETE /api/personal-health/measurements/:id`

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
