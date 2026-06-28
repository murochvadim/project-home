// Personal Health — Profiles + weight-log CRUD for the "Personal Health" tab on
// medical.html. Own module (wired into server.js via one require line) so server.js
// stays past the architecture-guard hook — same pattern as routes-medical-tests.js.
//
// Tables (LXC 102): ph_profiles + ph_measurements. BMI / age / ideal-weight are
// computed in the front-end from these rows. Minimum first step (weight + height +
// DOB + sex → BMI); waist / activity / vitals / charts / goals come later.
//
//   GET    /api/personal-health/profiles                 list (+ latest weight)
//   POST   /api/personal-health/profiles                 {name, sex, date_of_birth, height_cm}
//   PATCH  /api/personal-health/profiles/:id             any of the above
//   DELETE /api/personal-health/profiles/:id             cascades measurements
//   GET    /api/personal-health/measurements?profile_id= weight log, newest first
//   POST   /api/personal-health/measurements             {profile_id, weight_kg}  (measured_at stamped server-side)
//   DELETE /api/personal-health/measurements/:id

const { logExerciseRoutine } = require('./lib-exercise-log');

module.exports = (app, db) => {
  const err  = (res, e) => res.status(500).json({ error: (e && e.message) || String(e) });
  const trim = (s) => (s == null ? null : String(s).trim() || null);
  const num  = (v) => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);

  // ── Profiles ──────────────────────────────────────────────────────────────
  app.get('/api/personal-health/profiles', async (req, res) => {
    try {
      const r = await db.query(
        // to_char so DATE returns as 'YYYY-MM-DD' (a bare pg DATE serializes as a
        // timezone-shifted Date → off-by-one day in the browser).
        `SELECT p.id, p.name, p.user_id, p.sex, to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
                p.height_cm, p.allergies, p.conditions, p.weight_sched, p.bp_sched, p.body_sched, p.water_sched, p.created_at,
                (SELECT m.weight_kg FROM ph_measurements m WHERE m.profile_id = p.id
                  ORDER BY m.measured_at DESC, m.id DESC LIMIT 1) AS latest_weight_kg,
                (SELECT b.waist_cm FROM ph_body b WHERE b.profile_id = p.id
                  ORDER BY b.measured_at DESC, b.id DESC LIMIT 1) AS latest_waist_cm,
                (SELECT b.hip_cm FROM ph_body b WHERE b.profile_id = p.id
                  ORDER BY b.measured_at DESC, b.id DESC LIMIT 1) AS latest_hip_cm
           FROM ph_profiles p ORDER BY p.name`);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  app.post('/api/personal-health/profiles', async (req, res) => {
    try {
      const b = req.body || {};
      const name = trim(b.name);
      if (!name) return res.status(400).json({ error: 'name required' });
      const r = await db.query(
        // user_id stamped from the explicit body value, else resolved from the canonical
        // household_users table by name — so a profile is always FK-linked to its member.
        `INSERT INTO ph_profiles (name, sex, date_of_birth, height_cm, allergies, conditions, user_id)
         VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::int, (SELECT id FROM household_users WHERE name = $1)))
         RETURNING id`,
        [name, trim(b.sex), b.date_of_birth || null, num(b.height_cm), trim(b.allergies), trim(b.conditions), num(b.user_id)]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { err(res, e); }
  });

  app.patch('/api/personal-health/profiles/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      const add = (c, v) => { params.push(v); sets.push(`${c} = $${params.length}`); };
      if (b.name          !== undefined) add('name', trim(b.name));
      if (b.sex           !== undefined) add('sex', trim(b.sex));
      if (b.date_of_birth !== undefined) add('date_of_birth', b.date_of_birth || null);
      if (b.height_cm     !== undefined) add('height_cm', num(b.height_cm));
      if (b.allergies     !== undefined) add('allergies', trim(b.allergies));
      if (b.conditions    !== undefined) add('conditions', trim(b.conditions));
      // Measure schedule (Weight / BP) — JSONB {freq, interval_n} or null=Off.
      // node-pg JSON.stringifies the object; null clears it.
      if (b.weight_sched  !== undefined) add('weight_sched', b.weight_sched);
      if (b.bp_sched      !== undefined) add('bp_sched', b.bp_sched);
      if (b.body_sched    !== undefined) add('body_sched', b.body_sched);
      if (b.water_sched   !== undefined) add('water_sched', b.water_sched);
      if (!sets.length) return res.status(400).json({ error: 'no fields' });
      params.push(parseInt(req.params.id));
      await db.query(`UPDATE ph_profiles SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  app.delete('/api/personal-health/profiles/:id', async (req, res) => {
    try {
      await db.query('DELETE FROM ph_profiles WHERE id = $1', [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // ── Measurements (weight log) ───────────────────────────────────────────────
  app.get('/api/personal-health/measurements', async (req, res) => {
    try {
      const pid = parseInt(req.query.profile_id);
      if (!pid) return res.status(400).json({ error: 'profile_id required' });
      const lim = Math.min(parseInt(req.query.limit) || 200, 500);
      const r = await db.query(
        `SELECT id, profile_id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') AS measured_at,
                weight_kg, created_at
           FROM ph_measurements WHERE profile_id = $1
          ORDER BY measured_at DESC, id DESC LIMIT $2`, [pid, lim]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  app.post('/api/personal-health/measurements', async (req, res) => {
    try {
      const b = req.body || {};
      const pid = parseInt(b.profile_id);
      const w = num(b.weight_kg);
      if (!pid || w == null) return res.status(400).json({ error: 'profile_id and weight_kg required' });
      // measured_at defaults to now() but can be supplied (history "+ Add" with a
      // chosen timestamp / backdated re-add).
      const r = await db.query(
        `INSERT INTO ph_measurements (profile_id, weight_kg, measured_at)
         VALUES ($1, $2, COALESCE($3::timestamptz, now())) RETURNING id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') AS measured_at`,
        [pid, w, b.measured_at || null]);
      res.json({ ok: true, id: r.rows[0].id, measured_at: r.rows[0].measured_at });
    } catch (e) { err(res, e); }
  });

  app.delete('/api/personal-health/measurements/:id', async (req, res) => {
    try {
      await db.query('DELETE FROM ph_measurements WHERE id = $1', [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });
  app.patch('/api/personal-health/measurements/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      const add = (c, v) => { params.push(v); sets.push(`${c} = $${params.length}`); };
      if (b.weight_kg   !== undefined) add('weight_kg', num(b.weight_kg));
      if (b.measured_at !== undefined) add('measured_at', b.measured_at || null);
      if (!sets.length) return res.status(400).json({ error: 'no fields' });
      params.push(parseInt(req.params.id));
      await db.query(`UPDATE ph_measurements SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // ── Medications (pills list) ────────────────────────────────────────────────
  app.get('/api/personal-health/medications', async (req, res) => {
    try {
      const pid = parseInt(req.query.profile_id);
      if (!pid) return res.status(400).json({ error: 'profile_id required' });
      const r = await db.query(
        // to_char on next_due → 'YYYY-MM-DD' (avoid the pg DATE timezone off-by-one).
        `SELECT id, profile_id, name, dose, freq, interval_n, times, dow,
                to_char(next_due, 'YYYY-MM-DD') AS next_due, notes,
                purpose, ingredients, drug_class, avoid_with, contraindications,
                side_effects, warnings, prescriber_id,
                to_char(started_at, 'YYYY-MM-DD') AS started_at,
                to_char(special_date, 'YYYY-MM-DD') AS special_date, special_note,
                active, created_at
           FROM ph_medications WHERE profile_id = $1
          ORDER BY active DESC, name`, [pid]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  app.post('/api/personal-health/medications', async (req, res) => {
    try {
      const b = req.body || {};
      const pid = parseInt(b.profile_id);
      const name = trim(b.name);
      if (!pid || !name) return res.status(400).json({ error: 'profile_id and name required' });
      const r = await db.query(
        `INSERT INTO ph_medications (profile_id, name, dose, freq, interval_n, times, dow, next_due, notes,
           purpose, ingredients, drug_class, avoid_with, contraindications, side_effects, warnings,
           prescriber_id, started_at, active, special_date, special_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::date,$19,$20::date,$21) RETURNING id`,
        [pid, name, trim(b.dose), trim(b.freq), num(b.interval_n), trim(b.times),
         trim(b.dow), b.next_due || null, trim(b.notes),
         trim(b.purpose), trim(b.ingredients), trim(b.drug_class), trim(b.avoid_with),
         trim(b.contraindications), trim(b.side_effects), trim(b.warnings),
         num(b.prescriber_id), b.started_at || null, b.active !== false,
         b.special_date || null, trim(b.special_note)]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { err(res, e); }
  });

  app.patch('/api/personal-health/medications/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      const add = (c, v) => { params.push(v); sets.push(`${c} = $${params.length}`); };
      if (b.name       !== undefined) add('name', trim(b.name));
      if (b.dose       !== undefined) add('dose', trim(b.dose));
      if (b.freq       !== undefined) add('freq', trim(b.freq));
      if (b.interval_n !== undefined) add('interval_n', num(b.interval_n));
      if (b.times      !== undefined) add('times', trim(b.times));
      if (b.dow        !== undefined) add('dow', trim(b.dow));
      if (b.next_due          !== undefined) add('next_due', b.next_due || null);
      if (b.notes             !== undefined) add('notes', trim(b.notes));
      if (b.purpose           !== undefined) add('purpose', trim(b.purpose));
      if (b.ingredients       !== undefined) add('ingredients', trim(b.ingredients));
      if (b.drug_class        !== undefined) add('drug_class', trim(b.drug_class));
      if (b.avoid_with        !== undefined) add('avoid_with', trim(b.avoid_with));
      if (b.contraindications !== undefined) add('contraindications', trim(b.contraindications));
      if (b.side_effects      !== undefined) add('side_effects', trim(b.side_effects));
      if (b.warnings          !== undefined) add('warnings', trim(b.warnings));
      if (b.prescriber_id     !== undefined) add('prescriber_id', num(b.prescriber_id));
      if (b.started_at        !== undefined) add('started_at', b.started_at || null);
      if (b.special_date      !== undefined) add('special_date', b.special_date || null);
      if (b.special_note      !== undefined) add('special_note', trim(b.special_note));
      if (b.active            !== undefined) add('active', !!b.active);
      if (!sets.length) return res.status(400).json({ error: 'no fields' });
      params.push(parseInt(req.params.id));
      await db.query(`UPDATE ph_medications SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  app.delete('/api/personal-health/medications/:id', async (req, res) => {
    try {
      await db.query('DELETE FROM ph_medications WHERE id = $1', [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // ── Blood pressure — server-stamped on Save (timestamp overridable via the
  // history "+ Add"); GET list / PATCH / DELETE back the history modal.
  app.get('/api/personal-health/bp', async (req, res) => {
    try {
      const pid = parseInt(req.query.profile_id);
      if (!pid) return res.status(400).json({ error: 'profile_id required' });
      const lim = Math.min(parseInt(req.query.limit) || 200, 500);
      const r = await db.query(
        `SELECT id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS measured_at, systolic, diastolic, pulse
           FROM ph_bp WHERE profile_id = $1 ORDER BY measured_at DESC, id DESC LIMIT $2`, [pid, lim]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });
  app.post('/api/personal-health/bp', async (req, res) => {
    try {
      const b = req.body || {};
      const pid = parseInt(b.profile_id);
      if (!pid) return res.status(400).json({ error: 'profile_id required' });
      const sys = num(b.systolic), dia = num(b.diastolic), pulse = num(b.pulse);
      if (sys == null && dia == null && pulse == null) return res.status(400).json({ error: 'enter a reading' });
      const r = await db.query(
        `INSERT INTO ph_bp (profile_id, systolic, diastolic, pulse, measured_at)
         VALUES ($1,$2,$3,$4, COALESCE($5::timestamptz, now())) RETURNING id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') AS measured_at`,
        [pid, sys, dia, pulse, b.measured_at || null]);
      res.json({ ok: true, id: r.rows[0].id, measured_at: r.rows[0].measured_at });
    } catch (e) { err(res, e); }
  });
  app.patch('/api/personal-health/bp/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      const add = (c, v) => { params.push(v); sets.push(`${c} = $${params.length}`); };
      if (b.systolic    !== undefined) add('systolic', num(b.systolic));
      if (b.diastolic   !== undefined) add('diastolic', num(b.diastolic));
      if (b.pulse       !== undefined) add('pulse', num(b.pulse));
      if (b.measured_at !== undefined) add('measured_at', b.measured_at || null);
      if (!sets.length) return res.status(400).json({ error: 'no fields' });
      params.push(parseInt(req.params.id));
      await db.query(`UPDATE ph_bp SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });
  app.delete('/api/personal-health/bp/:id', async (req, res) => {
    try {
      await db.query('DELETE FROM ph_bp WHERE id = $1', [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // ── Body (waist & hip circumference, cm) — time-series like weight/BP. WHR
  // (waist ÷ hip) is COMPUTED here (2 dp), never stored. Server-stamped on Save
  // (timestamp overridable via the history "+ Add"); backs the history modal.
  app.get('/api/personal-health/body', async (req, res) => {
    try {
      const pid = parseInt(req.query.profile_id);
      if (!pid) return res.status(400).json({ error: 'profile_id required' });
      const lim = Math.min(parseInt(req.query.limit) || 200, 500);
      const r = await db.query(
        `SELECT id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS measured_at,
                waist_cm, hip_cm, round(waist_cm / NULLIF(hip_cm, 0), 2) AS whr
           FROM ph_body WHERE profile_id = $1 ORDER BY measured_at DESC, id DESC LIMIT $2`, [pid, lim]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });
  app.post('/api/personal-health/body', async (req, res) => {
    try {
      const b = req.body || {};
      const pid = parseInt(b.profile_id);
      if (!pid) return res.status(400).json({ error: 'profile_id required' });
      const waist = num(b.waist_cm), hip = num(b.hip_cm);
      if (waist == null && hip == null) return res.status(400).json({ error: 'enter waist or hip' });
      const r = await db.query(
        `INSERT INTO ph_body (profile_id, waist_cm, hip_cm, measured_at)
         VALUES ($1,$2,$3, COALESCE($4::timestamptz, now())) RETURNING id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') AS measured_at`,
        [pid, waist, hip, b.measured_at || null]);
      res.json({ ok: true, id: r.rows[0].id, measured_at: r.rows[0].measured_at });
    } catch (e) { err(res, e); }
  });
  app.patch('/api/personal-health/body/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      const add = (c, v) => { params.push(v); sets.push(`${c} = $${params.length}`); };
      if (b.waist_cm    !== undefined) add('waist_cm', num(b.waist_cm));
      if (b.hip_cm      !== undefined) add('hip_cm', num(b.hip_cm));
      if (b.measured_at !== undefined) add('measured_at', b.measured_at || null);
      if (!sets.length) return res.status(400).json({ error: 'no fields' });
      params.push(parseInt(req.params.id));
      await db.query(`UPDATE ph_body SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });
  app.delete('/api/personal-health/body/:id', async (req, res) => {
    try {
      await db.query('DELETE FROM ph_body WHERE id = $1', [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // ── Water (daily cups) — per-profile count tracker (like steps). Today total
  // for the card + history list/edit. The "behind pace" reminder lives in
  // routes-reminders.js. "Today" computed in Asia/Jerusalem.
  const _waterToday = "(measured_at AT TIME ZONE 'Asia/Jerusalem')::date = (now() AT TIME ZONE 'Asia/Jerusalem')::date";
  app.get('/api/personal-health/water', async (req, res) => {
    try {
      const pid = parseInt(req.query.profile_id);
      if (!pid) return res.status(400).json({ error: 'profile_id required' });
      const r = await db.query(
        `SELECT COALESCE(SUM(cups),0) AS today_total FROM ph_water WHERE profile_id=$1 AND ${_waterToday}`, [pid]);
      res.json(r.rows[0]);
    } catch (e) { err(res, e); }
  });
  app.get('/api/personal-health/water/list', async (req, res) => {
    try {
      const pid = parseInt(req.query.profile_id);
      if (!pid) return res.status(400).json({ error: 'profile_id required' });
      const lim = Math.min(parseInt(req.query.limit) || 200, 500);
      const r = await db.query(
        `SELECT id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS measured_at, cups
           FROM ph_water WHERE profile_id=$1 ORDER BY measured_at DESC, id DESC LIMIT $2`, [pid, lim]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });
  app.post('/api/personal-health/water', async (req, res) => {
    try {
      const b = req.body || {};
      const pid = parseInt(b.profile_id);
      const cups = num(b.cups);
      if (!pid || cups == null) return res.status(400).json({ error: 'profile_id and cups required' });
      const r = await db.query(
        `INSERT INTO ph_water (profile_id, cups, measured_at) VALUES ($1,$2, COALESCE($3::timestamptz, now()))
         RETURNING id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS measured_at`,
        [pid, cups, b.measured_at || null]);
      res.json({ ok: true, id: r.rows[0].id, measured_at: r.rows[0].measured_at });
    } catch (e) { err(res, e); }
  });
  app.patch('/api/personal-health/water/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      const add = (c, v) => { params.push(v); sets.push(`${c} = $${params.length}`); };
      if (b.cups        !== undefined) add('cups', num(b.cups));
      if (b.measured_at !== undefined) add('measured_at', b.measured_at || null);
      if (!sets.length) return res.status(400).json({ error: 'no fields' });
      params.push(parseInt(req.params.id));
      await db.query(`UPDATE ph_water SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });
  app.delete('/api/personal-health/water/:id', async (req, res) => {
    try {
      await db.query('DELETE FROM ph_water WHERE id = $1', [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // ── Steps (daily counter) — keyed by household_users.id (the canonical person,
  // so walking-trip imports from LXC 104 land on the same key). Manual entries are
  // server-stamped on Save; trip entries are inserted by scripts/steps_from_trips.py.
  // "Today" is computed in Asia/Jerusalem.
  const _today = "(measured_at AT TIME ZONE 'Asia/Jerusalem')::date = (now() AT TIME ZONE 'Asia/Jerusalem')::date";
  app.get('/api/personal-health/steps', async (req, res) => {
    try {
      const uid = parseInt(req.query.user_id);
      if (!uid) return res.status(400).json({ error: 'user_id required' });
      const r = await db.query(
        `SELECT
           COALESCE(SUM(steps) FILTER (WHERE ${_today}), 0)                       AS today_total,
           COALESCE(SUM(steps) FILTER (WHERE source='trip'   AND ${_today}), 0)   AS today_trip,
           COALESCE(SUM(steps) FILTER (WHERE source='manual' AND ${_today}), 0)   AS today_manual,
           COUNT(*)            FILTER (WHERE source='trip'   AND ${_today})        AS today_trip_count
         FROM ph_steps WHERE user_id = $1`, [uid]);
      res.json(r.rows[0]);
    } catch (e) { err(res, e); }
  });
  app.get('/api/personal-health/steps/list', async (req, res) => {
    try {
      const uid = parseInt(req.query.user_id);
      if (!uid) return res.status(400).json({ error: 'user_id required' });
      const lim = Math.min(parseInt(req.query.limit) || 200, 500);
      const r = await db.query(
        `SELECT id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS measured_at, steps, source, trip_id
           FROM ph_steps WHERE user_id = $1 ORDER BY measured_at DESC, id DESC LIMIT $2`, [uid, lim]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });
  app.post('/api/personal-health/steps', async (req, res) => {
    try {
      const b = req.body || {};
      const uid = parseInt(b.user_id);
      const steps = num(b.steps);
      if (!uid || steps == null) return res.status(400).json({ error: 'user_id and steps required' });
      const r = await db.query(
        `INSERT INTO ph_steps (user_id, steps, source, measured_at)
         VALUES ($1, $2, 'manual', COALESCE($3::timestamptz, now()))
         RETURNING id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') AS measured_at`,
        [uid, Math.round(steps), b.measured_at || null]);
      res.json({ ok: true, id: r.rows[0].id, measured_at: r.rows[0].measured_at });
    } catch (e) { err(res, e); }
  });
  app.patch('/api/personal-health/steps/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      const add = (c, v) => { params.push(v); sets.push(`${c} = $${params.length}`); };
      if (b.steps       !== undefined) add('steps', Math.round(num(b.steps)));
      if (b.measured_at !== undefined) add('measured_at', b.measured_at || null);
      if (!sets.length) return res.status(400).json({ error: 'no fields' });
      params.push(parseInt(req.params.id));
      await db.query(`UPDATE ph_steps SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });
  // Deleting a TRIP-derived entry also excludes its trip so the LXC-104 importer
  // won't re-add it. Manual entries just delete.
  app.delete('/api/personal-health/steps/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const t = await db.query('SELECT trip_id FROM ph_steps WHERE id = $1', [id]);
      const tripId = t.rows[0] && t.rows[0].trip_id;
      if (tripId) await db.query('INSERT INTO ph_steps_excluded_trips (trip_id) VALUES ($1) ON CONFLICT DO NOTHING', [tripId]);
      await db.query('DELETE FROM ph_steps WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // ── Morning exercises (daily routine) — per-profile log. Each row records the
  // routine's TOTAL calories + distinct muscles (written by lib-exercise-log from
  // the global dashboard_settings.medical.exercises definitions, via "Done" here
  // or the reminder "Clear"). "Today" is computed in Asia/Jerusalem.
  const _exToday = "(measured_at AT TIME ZONE 'Asia/Jerusalem')::date = (now() AT TIME ZONE 'Asia/Jerusalem')::date";
  // Today's totals: summed calories + the UNION of distinct muscles over today's rows.
  app.get('/api/personal-health/exercise', async (req, res) => {
    try {
      const pid = parseInt(req.query.profile_id);
      if (!pid) return res.status(400).json({ error: 'profile_id required' });
      const r = await db.query(
        `SELECT id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS measured_at,
                total_calories, muscles
           FROM ph_exercise_log WHERE profile_id=$1 AND ${_exToday}
          ORDER BY measured_at DESC, id DESC`, [pid]);
      let cal = 0; const mset = new Set();
      for (const row of r.rows) {
        cal += Number(row.total_calories) || 0;
        (Array.isArray(row.muscles) ? row.muscles : []).forEach(m => mset.add(String(m)));
      }
      res.json({ today_calories: Math.round(cal * 100) / 100, today_muscles: Array.from(mset),
                 today_count: r.rows.length, rows: r.rows });
    } catch (e) { err(res, e); }
  });
  app.get('/api/personal-health/exercise/list', async (req, res) => {
    try {
      const pid = parseInt(req.query.profile_id);
      if (!pid) return res.status(400).json({ error: 'profile_id required' });
      const lim = Math.min(parseInt(req.query.limit) || 200, 500);
      const r = await db.query(
        `SELECT id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS measured_at,
                total_calories, muscles, exercises
           FROM ph_exercise_log WHERE profile_id=$1 ORDER BY measured_at DESC, id DESC LIMIT $2`, [pid, lim]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });
  // "✓ Done / Log routine" — compute + insert from the global definitions (shared
  // with the reminder Clear path).
  app.post('/api/personal-health/exercise/log', async (req, res) => {
    try {
      const pid = parseInt((req.body || {}).profile_id);
      if (!pid) return res.status(400).json({ error: 'profile_id required' });
      const row = await logExerciseRoutine(db, pid);
      res.json({ ok: true, ...row });
    } catch (e) { err(res, e); }
  });
  // Manual / backdated entry (history "+ Add") — a plain calories row.
  app.post('/api/personal-health/exercise', async (req, res) => {
    try {
      const b = req.body || {};
      const pid = parseInt(b.profile_id);
      const cal = num(b.total_calories);
      if (!pid || cal == null) return res.status(400).json({ error: 'profile_id and total_calories required' });
      const r = await db.query(
        `INSERT INTO ph_exercise_log (profile_id, total_calories, muscles, measured_at)
         VALUES ($1, $2, $3::jsonb, COALESCE($4::timestamptz, now()))
         RETURNING id, to_char(measured_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS measured_at`,
        [pid, cal, JSON.stringify(Array.isArray(b.muscles) ? b.muscles : []), b.measured_at || null]);
      res.json({ ok: true, id: r.rows[0].id, measured_at: r.rows[0].measured_at });
    } catch (e) { err(res, e); }
  });
  app.patch('/api/personal-health/exercise/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      const add = (c, v) => { params.push(v); sets.push(`${c} = $${params.length}`); };
      if (b.total_calories !== undefined) add('total_calories', num(b.total_calories));
      if (b.measured_at    !== undefined) add('measured_at', b.measured_at || null);
      if (!sets.length) return res.status(400).json({ error: 'no fields' });
      params.push(parseInt(req.params.id));
      await db.query(`UPDATE ph_exercise_log SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });
  app.delete('/api/personal-health/exercise/:id', async (req, res) => {
    try {
      await db.query('DELETE FROM ph_exercise_log WHERE id = $1', [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });
};
