// Shared "log the morning-exercise routine" helper.
//
// The exercise DEFINITIONS live globally in dashboard_settings.medical.exercises
// ({ enabled, schedule:{time_hm}, items:[{id,name,reps,cal_per_rep,muscles[],other,include}] }).
// Logging a routine = read those, take the include-✓ items, compute the TOTAL
// calories (Σ reps × cal_per_rep) + the DISTINCT muscles worked (preset keys +
// any non-empty "other" text), and write one ph_exercise_log row.
//
// Used by BOTH the dashboard "✓ Done" button (routes-personal-health.js) and the
// reminders "Clear" button (routes-reminders.js) so the totals math never drifts.

async function loadExerciseCfg(db) {
  try {
    const r = await db.query("SELECT value FROM dashboard_settings WHERE key = 'medical.exercises'");
    const v = r.rows.length ? r.rows[0].value : null;
    return (v && typeof v === 'object') ? v : {};
  } catch (e) { return {}; }
}

// Compute the routine totals from a config object (no DB write). Returns
// { total_calories, muscles:[...], exercises:[...] } over the include-✓ items.
function computeRoutine(cfg) {
  const items = Array.isArray(cfg && cfg.items) ? cfg.items : [];
  const included = items.filter(it => it && it.include !== false);
  let total = 0;
  const muscleSet = new Set();
  const snapshot = [];
  for (const it of included) {
    const reps = Number(it.reps) || 0;
    const cpr  = Number(it.cal_per_rep) || 0;
    const cal  = Math.round(reps * cpr * 100) / 100;   // 2dp, avoid float noise
    total += cal;
    const muscles = Array.isArray(it.muscles) ? it.muscles.filter(Boolean) : [];
    muscles.forEach(m => muscleSet.add(String(m)));
    const other = (it.other == null ? '' : String(it.other)).trim();
    if (other) muscleSet.add(other);
    snapshot.push({ name: it.name || '', reps, cal_per_rep: cpr, calories: cal,
                    muscles, other });
  }
  return {
    total_calories: Math.round(total * 100) / 100,
    muscles: Array.from(muscleSet),
    exercises: snapshot,
  };
}

// Read the config + write one ph_exercise_log row for the profile. Returns the
// inserted row (id, measured_at, total_calories, muscles, exercises).
async function logExerciseRoutine(db, profileId) {
  const cfg = await loadExerciseCfg(db);
  const { total_calories, muscles, exercises } = computeRoutine(cfg);
  const r = await db.query(
    `INSERT INTO ph_exercise_log (profile_id, total_calories, muscles, exercises)
     VALUES ($1, $2, $3::jsonb, $4::jsonb)
     RETURNING id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS measured_at,
               total_calories, muscles, exercises`,
    [profileId, total_calories, JSON.stringify(muscles), JSON.stringify(exercises)]);
  return r.rows[0];
}

module.exports = { logExerciseRoutine, computeRoutine, loadExerciseCfg };
