---
description: Research a named exercise and add it to the Morning Exercises routine (muscles, calories, age/weight-tailored suggested reps)
user-invocable: true
---

# /create-exercise — Add an exercise to the Morning Exercises routine

You are adding one exercise to the **Medical → Personal Health → Morning Exercises** routine.
The routine definitions live GLOBALLY in `dashboard_settings.medical.exercises`:
`{enabled, schedule:{time_hm}, items:[{id,name,suggested,reps,cal_per_rep,muscles[],other,include}]}`.
Calories logged = `reps × cal_per_rep`; `suggested` is a reference; `reps` is what the user really does.

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
- **Muscles worked** → map each to a preset key in `MUSCLE_LIST`:
  chest · shoulders · biceps · forearms · abs · obliques · quads · hipflexors ·
  upperback · lowerback · triceps · glutes · hamstrings · calves · fullbody.
- **Calories per rep**: find the per-rep burn for a ~70 kg adult, then **scale to the person's weight**:
  `cal_per_rep = round(base70 × weight_kg / 70, 2)`.
- **Suggested reps**: pick a sensible daily count for the person's **age** (use age-band norms; older →
  fewer). This is a reference, not medical advice.
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
Show the user a table: name · suggested · reps · cal_per_rep · muscles. Ask to proceed.
For `reps`, ask "how many do you actually do?" — default to `suggested` if they don't say.

## Step 6 — Write it (append, never overwrite)
Read current config, append the new item, POST it back (preserves existing items):
```
curl -s http://127.0.0.1:3000/api/dashboard-settings/medical.exercises    # read {value:{...}}
# build new items = existing.items + the new item, then:
curl -s -X POST http://127.0.0.1:3000/api/dashboard-settings/medical.exercises \
  -H 'Content-Type: application/json' -d '{"value":{ ...full object with appended item... }}'
```
Item shape: `{"id":"ex_<slug>","name":"<Name>","suggested":N,"reps":N,"cal_per_rep":N,"muscles":["..."],"other":"","include":true,"desc_he":"<short Hebrew summary>"}`.
Use a unique id (e.g. `ex_<name-slug>`).

## Step 7 — Finish
Tell the user to **hard-refresh** the Medical page; they can adjust **Reps** (their real count) and the
muscles on **Settings → 🏋️ Morning Exercises** / the Muscle Map. If muscles were added (Step 4), the
cache-bust bump means the hard-refresh is required.

## Notes
- No dashboard restart needed (config via the dashboard-settings API; muscle-list edits are static JS + cache-bust).
- Per-rep calories are weight-tailored to the resolved person; if multiple people use the routine, pick the
  primary user (the routine is one shared list).
- Keep the muscle map honest: only assign a muscle if the exercise actually works it.
