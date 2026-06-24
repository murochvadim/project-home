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
//   POST   /api/personal-health/measurements             {profile_id, measured_at?, weight_kg}
//   DELETE /api/personal-health/measurements/:id

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
        `SELECT p.id, p.name, p.sex, to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
                p.height_cm, p.allergies, p.conditions, p.created_at,
                (SELECT m.weight_kg FROM ph_measurements m WHERE m.profile_id = p.id
                  ORDER BY m.measured_at DESC, m.id DESC LIMIT 1) AS latest_weight_kg
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
        `INSERT INTO ph_profiles (name, sex, date_of_birth, height_cm, allergies, conditions)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [name, trim(b.sex), b.date_of_birth || null, num(b.height_cm), trim(b.allergies), trim(b.conditions)]);
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
      const r = await db.query(
        `SELECT id, profile_id, to_char(measured_at, 'YYYY-MM-DD') AS measured_at,
                weight_kg, created_at
           FROM ph_measurements WHERE profile_id = $1
          ORDER BY measured_at DESC, id DESC`, [pid]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  app.post('/api/personal-health/measurements', async (req, res) => {
    try {
      const b = req.body || {};
      const pid = parseInt(b.profile_id);
      const w = num(b.weight_kg);
      if (!pid || w == null) return res.status(400).json({ error: 'profile_id and weight_kg required' });
      const r = await db.query(
        `INSERT INTO ph_measurements (profile_id, measured_at, weight_kg)
         VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3) RETURNING id`,
        [pid, b.measured_at || null, w]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { err(res, e); }
  });

  app.delete('/api/personal-health/measurements/:id', async (req, res) => {
    try {
      await db.query('DELETE FROM ph_measurements WHERE id = $1', [parseInt(req.params.id)]);
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
           prescriber_id, started_at, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::date,$19) RETURNING id`,
        [pid, name, trim(b.dose), trim(b.freq), num(b.interval_n), trim(b.times),
         trim(b.dow), b.next_due || null, trim(b.notes),
         trim(b.purpose), trim(b.ingredients), trim(b.drug_class), trim(b.avoid_with),
         trim(b.contraindications), trim(b.side_effects), trim(b.warnings),
         num(b.prescriber_id), b.started_at || null, b.active !== false]);
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
};
