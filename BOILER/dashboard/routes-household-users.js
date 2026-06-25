// Household Users — canonical member identity CRUD.
// Replaces the dashboard_settings 'privacy.users' JSON roster with a real table
// (LXC 102 `household_users`) that has a stable id, so cross-cutting features
// (Personal Health profiles, notifications, places, gateway) reference one identity.
// Own module wired into server.js via one require() line — past the architecture-guard
// hook (same pattern as routes-personal-health.js / routes-medical-tests.js).
//
//   GET    /api/household-users          list (ordered by name)
//   POST   /api/household-users          {name, phone?, device_label?, ntfy_topic?, role?, notes?, active?}
//   PATCH  /api/household-users/:id       any of the above
//   DELETE /api/household-users/:id       cascades the member's ph_profiles (FK ON DELETE CASCADE)

module.exports = (app, db) => {
  const err  = (res, e) => res.status(500).json({ error: (e && e.message) || String(e) });
  const trim = (s) => (s == null ? null : String(s).trim() || null);

  app.get('/api/household-users', async (req, res) => {
    try {
      const r = await db.query(
        `SELECT id, name, phone, device_label, ntfy_topic, role, active, notes, created_at
           FROM household_users ORDER BY name`);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  app.post('/api/household-users', async (req, res) => {
    try {
      const b = req.body || {};
      const name = trim(b.name);
      if (!name) return res.status(400).json({ error: 'name required' });
      const r = await db.query(
        `INSERT INTO household_users (name, phone, device_label, ntfy_topic, role, notes, active)
         VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, true)) RETURNING id`,
        [name, trim(b.phone), trim(b.device_label), trim(b.ntfy_topic), trim(b.role), trim(b.notes),
         b.active === undefined ? null : !!b.active]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) {
      if (/unique|duplicate/i.test(e.message || '')) return res.status(400).json({ error: 'a member with that name already exists' });
      err(res, e);
    }
  });

  app.patch('/api/household-users/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      const add = (c, v) => { params.push(v); sets.push(`${c} = $${params.length}`); };
      if (b.name         !== undefined) add('name', trim(b.name));
      if (b.phone        !== undefined) add('phone', trim(b.phone));
      if (b.device_label !== undefined) add('device_label', trim(b.device_label));
      if (b.ntfy_topic   !== undefined) add('ntfy_topic', trim(b.ntfy_topic));
      if (b.role         !== undefined) add('role', trim(b.role));
      if (b.notes        !== undefined) add('notes', trim(b.notes));
      if (b.active       !== undefined) add('active', !!b.active);
      if (!sets.length) return res.status(400).json({ error: 'no fields' });
      sets.push('updated_at = now()');
      params.push(parseInt(req.params.id));
      await db.query(`UPDATE household_users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      res.json({ ok: true });
    } catch (e) {
      if (/unique|duplicate/i.test(e.message || '')) return res.status(400).json({ error: 'a member with that name already exists' });
      err(res, e);
    }
  });

  app.delete('/api/household-users/:id', async (req, res) => {
    try {
      await db.query('DELETE FROM household_users WHERE id = $1', [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });
};
