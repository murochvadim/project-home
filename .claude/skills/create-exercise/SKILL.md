---
description: Research a named exercise and add it to the Morning Exercises routine (muscles, calories, age/weight-tailored suggested reps)
user-invocable: true
---

# /create-exercise — Add an exercise to the Morning Exercises routine

You are adding one exercise to the **Medical → Personal Health → Morning Exercises** routine.
The routine definitions live GLOBALLY in `dashboard_settings.medical.exercises`:
`{enabled, schedule:{time_hm}, items:[{id,name,kind,suggested_sets,suggested,sets,reps|hold_sec,cal_per_rep|cal_per_sec,muscles[],other,include}]}`.
Both **Suggested** (`suggested_sets`×`suggested`) and **Real** (`sets`×`reps`/`hold_sec`) are a full **sets × count**.
Calories logged come from the **Real** side: `reps×sets×cal_per_rep` (or `hold_sec×sets×cal_per_sec`); `suggested*` are reference-only.

The dashboard runs on the Windows host at `http://127.0.0.1:3000`. The muscle preset list +
front/back body map live in `BOILER/dashboard/public/js/personal-health.js`
(`MUSCLE_LIST`, `PH_MUSCLES`; `MUSCLE_LABEL` is derived). The Settings form/list are in
`BOILER/dashboard/public/medical.html` (Settings tab).

Follow these steps. Confirm before writing anything.

## Step 1 — Input
The user gives the exercise **name** (optionally a description/Hebrew note). If not given, ask.

## Step 2 — Resolve the person (for age + weight tailoring)
The household has profiles in `ph_profiles`. Default to the primary user unless told otherwise.
Get age + latest weight (run via LXC 104 → psql 102):
```
ssh root@192.168.1.227 "PGPASSWORD='' psql -h 192.168.1.219 -U postgres -d home_data -P pager=off -c \
\"SELECT p.id,p.name,p.sex,date_part('year',age(p.date_of_birth))::int AS age,
  (SELECT weight_kg FROM ph_measurements m WHERE m.profile_id=p.id ORDER BY measured_at DESC LIMIT 1) AS weight_kg
  FROM ph_profiles p WHERE p.name='Vadim';\""
```

## Step 3 — Research the exercise
Use WebSearch if unsure. Determine:
- **Muscles worked** → map each to a preset key in `MUSCLE_LIST` (canonical list lives in personal-health.js):
  chest · shoulders · biceps · forearms · abs · obliques · obliques_int · transverse · quads · hipflexors ·
  upperback · lowerback · triceps · glutes · hamstrings · calves · trapezius · suboccipital · scm · scalp · fullbody.
- **Type** (`kind`): `reps` (rep-based) or `hold` (TIMED — isometric holds like plank/hollow AND duration
  activities like running-in-place or a massage; the "count" is **seconds**).
- **Suggested = `suggested_sets` × `suggested`** (the recommendation, shown green): pick BOTH for the person's
  **age** (older → fewer / shorter). `suggested` = reps (or hold seconds) per set. Reference, not medical advice.
- **Real = `sets` × `reps`/`hold_sec`** (what the user actually does — ASK; default to the suggested values).
  Calories come from this side.
- **Calories**:
  - `reps`: `cal_per_rep = round(base70_per_rep × weight_kg / 70, 2)`; logged = `reps × sets × cal_per_rep`.
  - `hold`: `cal_per_sec = round(MET × 3.5 × weight_kg / 200 / 60, 2)` (cal/min = MET×3.5×weight/200, ÷60 → per-sec).
    MET guide: ~3.5–4 isometric core (≈0.09 @90 kg) · ~8 vigorous cardio (≈0.21) · ~2 light / massage (≈0.05).
    Logged = `hold_sec × sets × cal_per_sec`.
- **Hebrew summary** (`desc_he`): a short 1-2 sentence description in **Hebrew** of what the exercise does +
  which muscles it works (shown as a hover popup on the exercise row).

## Step 4 — Add any missing muscles (only if needed)
If a worked muscle is NOT already a key in `MUSCLE_LIST`:
1. Add `{ key:'<key>', label:'<Label>' }` to `MUSCLE_LIST` in `personal-health.js`.
2. Add a `{ key:'<key>', svg:'<shape(s)>' }` entry to `PH_MUSCLES` (front body ≈x100, back ≈x300 = front+200;
   ellipses/paths positioned over the relevant region; selected muscles render highlighted).
3. Bump the `js/personal-health.js?v=N` cache-bust in `medical.html`.
4. `node --check public/js/personal-health.js`.
Most common exercises only use existing muscles — skip this step if so.

## Step 5 — Confirm
Show the user a table: name · Type · **Suggested (`sets×count`)** · cal/rep-or-sec · muscles. Ask to proceed.
Ask the **Real** = how many sets × how much you actually do — default to the suggested `sets × count` if not given.

## Step 6 — Write it (append, never overwrite)
Read current config, append the new item, POST it back (preserves existing items):
```
curl -s http://127.0.0.1:3000/api/dashboard-settings/medical.exercises    # read {value:{...}}
# build new items = existing.items + the new item, then:
curl -s -X POST http://127.0.0.1:3000/api/dashboard-settings/medical.exercises \
  -H 'Content-Type: application/json' -d '{"value":{ ...full object with appended item... }}'
```
Item shape (reps): `{"id":"ex_<slug>","name":"<Name>","kind":"reps","suggested_sets":N,"suggested":N,"sets":N,"reps":N,"cal_per_rep":N,"muscles":["..."],"other":"","include":true,"desc_he":"..."}`.
Item shape (hold): `{"id":"ex_<slug>","name":"<Name>","kind":"hold","suggested_sets":N,"suggested":Nsec,"sets":N,"hold_sec":N,"cal_per_sec":N,"muscles":["..."],"other":"","include":true,"desc_he":"..."}`.
(`suggested_sets`×`suggested` = the recommendation [renders green]; `sets`×`reps`/`hold_sec` = real [drives calories]; the list flags the **Real red** when it deviates from the suggestion in count OR sets.)
Use a unique id (e.g. `ex_<name-slug>`). (Adding/editing exercises via the API needs NO restart;
only changing `lib-exercise-log.js` itself requires `pm2 delete boiler-dashboard && pm2 start ecosystem.config.js`.)

## Step 7 — Finish
Tell the user to **hard-refresh** the Medical page; they can adjust **Real** (their actual sets × count) and the
muscles on **Settings → 🏋️ Morning Exercises** / the Muscle Map. If muscles were added (Step 4), the
cache-bust bump means the hard-refresh is required.

## Notes
- No dashboard restart needed (config via the dashboard-settings API; muscle-list edits are static JS + cache-bust).
- Per-rep calories are weight-tailored to the resolved person; if multiple people use the routine, pick the
  primary user (the routine is one shared list).
- Keep the muscle map honest: only assign a muscle if the exercise actually works it.
