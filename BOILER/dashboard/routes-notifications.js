// Notifications subsystem — server side (Main Agent → Notifications tab).
// UI-only: authoring (CRUD of notification_defs) + the popup feed
// (notification_events). ALL firing logic runs on the LXC rule engine
// (RULES/rules/notifications.py, group `notify`) — this module never evaluates
// conditions. Own module (one require() line in server.js) so it stays past the
// architecture-guard hook — like routes-journal.js / routes-people.js.
//
// The engine rule reads notification_defs with a 30 s TTL cache, so create/edit
// take effect within ~30 s with no reload. Deletes/toggles the same.
module.exports = (app, db) => {
  const err = (res, e) => { console.error('notifications:', e); res.status(500).json({ error: e.message }); };

  // ── Authoring: list / create / update / delete a notification ──
  app.get('/api/notifications/defs', async (_req, res) => {
    try {
      const r = await db.query(
        `SELECT id, name, enabled, trigger, trigger_param, conditions, message,
                delivery, delivery_time, throttle_min, surfaces, level, action,
                to_char(updated_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS updated_local
           FROM notification_defs ORDER BY id`);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  // Whitelisted writable fields → column mapping (keeps the shape validated).
  const FIELDS = ['name', 'enabled', 'trigger', 'trigger_param', 'conditions',
                  'message', 'delivery', 'delivery_time', 'throttle_min', 'surfaces', 'level', 'action'];
  const JSONF = new Set(['conditions', 'surfaces']);

  app.post('/api/notifications/defs', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.name || !b.trigger) return res.status(400).json({ error: 'name and trigger required' });
      const r = await db.query(
        `INSERT INTO notification_defs
           (name, enabled, trigger, trigger_param, conditions, message, delivery, delivery_time, throttle_min, surfaces, level, action)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [String(b.name), b.enabled !== false, String(b.trigger), b.trigger_param || null,
         JSON.stringify(b.conditions || []), String(b.message || ''),
         b.delivery || 'immediate', b.delivery_time || null, parseInt(b.throttle_min) || 0,
         JSON.stringify(b.surfaces || { popup: true, pages: 'all', phone: false }),
         b.level || 'info', b.action || null]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { err(res, e); }
  });

  app.patch('/api/notifications/defs/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const b = req.body || {};
      const sets = [], vals = [];
      for (const f of FIELDS) {
        if (!(f in b)) continue;
        vals.push(JSONF.has(f) ? JSON.stringify(b[f]) : b[f]);
        sets.push(`${f} = $${vals.length}`);
      }
      if (!sets.length) return res.json({ ok: true, unchanged: true });
      vals.push(id);
      await db.query(`UPDATE notification_defs SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  app.delete('/api/notifications/defs/:id', async (req, res) => {
    try { await db.query('DELETE FROM notification_defs WHERE id = $1', [parseInt(req.params.id)]); res.json({ ok: true }); }
    catch (e) { err(res, e); }
  });

  // Clear the fired-event log (the "Recent notifications" list). Safe: browsers
  // track their own cursor, so removing old rows never re-pops anything.
  app.delete('/api/notifications/events', async (_req, res) => {
    try { const r = await db.query('DELETE FROM notification_events'); res.json({ ok: true, deleted: r.rowCount }); }
    catch (e) { err(res, e); }
  });

  // ── Popup feed: events newer than the caller's cursor, still fresh, popup-surfaced.
  // The client (notify-toast.js) passes ?since=<last id it showed> and filters by page.
  app.get('/api/notifications/feed', async (req, res) => {
    try {
      const since = parseInt(req.query.since) || 0;
      // Normal (non-interactive) notifications: since-cursor, not-expired. Interactive
      // ones are handled by the sticky `pending` channel below, so they're excluded here.
      const r = await db.query(
        `SELECT id, def_id, level, title, body, surfaces, data,
                extract(epoch FROM ts) AS ts_epoch,
                (expires_at IS NOT NULL AND expires_at < now()) AS expired
           FROM notification_events
          WHERE id > $1
            AND (surfaces->>'popup') = 'true'
            AND (expires_at IS NULL OR expires_at > now())
            AND (data->>'action') IS NULL
          ORDER BY id ASC LIMIT 50`, [since]);
      // Sticky interactive notifications (e.g. the main-door-close set_people prompt):
      // the LATEST unresolved one PER DEF is returned on EVERY poll — independent of
      // the browser cursor AND of expires_at — so it can never be missed just because
      // the laptop was closed. `DISTINCT ON (def_id) … ORDER BY def_id, id DESC` means
      // even a residual pile-up (e.g. a flapping burst, or a laptop-closed backlog)
      // surfaces as ONE prompt showing the newest occupancy — never a stack. Cleared
      // by POST /:id/resolve, which resolves the whole def family in one Save.
      const p = await db.query(
        `SELECT DISTINCT ON (def_id) id, def_id, level, title, body, surfaces, data,
                extract(epoch FROM ts) AS ts_epoch
           FROM notification_events
          WHERE (surfaces->>'popup') = 'true'
            AND (data->>'action') IS NOT NULL
            AND resolved_at IS NULL
          ORDER BY def_id, id DESC`);
      // Also return the current max id so a first-load client can set its cursor
      // WITHOUT replaying history (only future non-interactive events should pop).
      const maxR = await db.query('SELECT COALESCE(MAX(id),0) AS max_id FROM notification_events');
      res.json({ events: r.rows, pending: p.rows, max_id: parseInt(maxR.rows[0].max_id) });
    } catch (e) { err(res, e); }
  });

  // ── Resolve a sticky interactive notification. The popup's Save calls this
  // after writing the value; the event then stops resurfacing in `pending` on
  // every browser. This is the ONLY thing that clears a main-door-close prompt.
  // ONE Save clears the WHOLE def family: it resolves every unresolved interactive
  // event of the same def as `id` — so a flapping burst or a laptop-closed backlog
  // of door prompts is cleared in a single click, not one-by-one. ──
  app.post('/api/notifications/:id/resolve', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'id required' });
      const r = await db.query(
        `UPDATE notification_events SET resolved_at = now()
          WHERE resolved_at IS NULL AND (data->>'action') IS NOT NULL
            AND def_id = (SELECT def_id FROM notification_events WHERE id = $1)`,
        [id]);
      res.json({ ok: true, resolved: r.rowCount });
    } catch (e) { err(res, e); }
  });

  // ── Test: render the def's message against current live state and insert one
  // event now, so the author sees exactly what the popup will look like. ──
  app.post('/api/notifications/test/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const dR = await db.query('SELECT * FROM notification_defs WHERE id = $1', [id]);
      if (!dR.rows.length) return res.status(404).json({ error: 'not found' });
      const def = dR.rows[0];

      // Pull the few live values placeholders can reference.
      const sR = await db.query(
        `SELECT key, value FROM rule_engine_state WHERE key IN ('people_home','home_mode')`);
      const st = {}; for (const row of sR.rows) st[row.key] = row.value;
      const now = new Date();
      const fmt = (opts) => now.toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', ...opts });
      const subs = {
        people_home: st.people_home != null ? st.people_home : '?',
        home_mode: st.home_mode || '?',
        time: fmt({ hour: '2-digit', minute: '2-digit', hour12: false }),
        date: fmt({ day: '2-digit', month: '2-digit', year: 'numeric' }),
        count: 1,
      };
      const body = String(def.message || def.name).replace(/\{(\w+)\}/g, (m, k) => (k in subs ? subs[k] : m));
      // Carry the interactive action (e.g. set_people) + live value so the Test
      // popup looks exactly like the real fire.
      const data = { test: true };
      if (def.action) {
        data.action = def.action;
        if (def.action === 'set_people') data.people_home = (st.people_home != null ? parseInt(st.people_home) : null);
      }
      await db.query(
        `INSERT INTO notification_events (def_id, title, body, level, surfaces, data)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, def.name, body, def.level, def.surfaces, JSON.stringify(data)]);
      res.json({ ok: true, body });
    } catch (e) { err(res, e); }
  });
};
