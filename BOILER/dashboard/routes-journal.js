// Personal Daily Journal — server side (Privacy → Daily Journal tab).
// Plaintext rows in journal_entries (LAN-only, AI-readable). One row per
// (user, local day, slot); +save upserts. Config lives in dashboard_settings.journal.
// Own module (one require() line in server.js) so it stays past the
// architecture-guard hook — like routes-personal-health.js / routes-medical-tests.js.
module.exports = (app, db) => {
  const err = (res, e) => { console.error('journal:', e); res.status(500).json({ error: e.message }); };
  const TODAY = "(now() AT TIME ZONE 'Asia/Jerusalem')::date";

  // List entries in a date range (default: last 30 days). Newest day first.
  app.get('/api/journal', async (req, res) => {
    try {
      const uid = parseInt(req.query.user_id) || 1;
      const r = await db.query(
        `SELECT id, to_char(entry_date,'YYYY-MM-DD') AS entry_date, slot_id, slot_name, comment, mood,
                to_char(created_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS created_local
           FROM journal_entries
          WHERE user_id = $1
            AND entry_date >= COALESCE($2::date, ${TODAY} - INTERVAL '30 days')
            AND entry_date <= COALESCE($3::date, ${TODAY})
          ORDER BY entry_date DESC, slot_name NULLS LAST, id`,
        [uid, req.query.from || null, req.query.to || null]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  // Today's entries (all slots that have one) — for the tab's Today section.
  app.get('/api/journal/today', async (req, res) => {
    try {
      const uid = parseInt(req.query.user_id) || 1;
      const r = await db.query(
        `SELECT id, slot_id, slot_name, comment, mood FROM journal_entries
          WHERE user_id = $1 AND entry_date = ${TODAY}`, [uid]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  // Upsert a (user, date, slot) entry — used by the reminder capture panel AND
  // the tab's inline editor. entry_date defaults to today (local).
  app.post('/api/journal', async (req, res) => {
    try {
      const b = req.body || {};
      const uid = parseInt(b.user_id) || 1;
      const slotId = (b.slot_id || '').toString().trim();
      if (!slotId) return res.status(400).json({ error: 'slot_id required' });
      let mood = null;
      if (b.mood != null && b.mood !== '') mood = Math.max(1, Math.min(5, parseInt(b.mood) || 0)) || null;
      const r = await db.query(
        `INSERT INTO journal_entries (user_id, entry_date, slot_id, slot_name, comment, mood)
         VALUES ($1, COALESCE($2::date, ${TODAY}), $3, $4, $5, $6)
         ON CONFLICT (user_id, entry_date, slot_id)
         DO UPDATE SET comment = EXCLUDED.comment, mood = EXCLUDED.mood,
                       slot_name = EXCLUDED.slot_name, updated_at = now()
         RETURNING id`,
        [uid, b.entry_date || null, slotId, b.slot_name || null, (b.comment == null ? '' : String(b.comment)), mood]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { err(res, e); }
  });

  app.patch('/api/journal/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      const add = (c, v) => { params.push(v); sets.push(`${c} = $${params.length}`); };
      if (b.comment !== undefined) add('comment', b.comment == null ? '' : String(b.comment));
      if (b.mood !== undefined) add('mood', (b.mood == null || b.mood === '') ? null : (parseInt(b.mood) || null));
      if (!sets.length) return res.status(400).json({ error: 'no fields' });
      sets.push('updated_at = now()');
      params.push(parseInt(req.params.id));
      await db.query(`UPDATE journal_entries SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  app.delete('/api/journal/:id', async (req, res) => {
    try { await db.query('DELETE FROM journal_entries WHERE id = $1', [parseInt(req.params.id)]); res.json({ ok: true }); }
    catch (e) { err(res, e); }
  });
};
