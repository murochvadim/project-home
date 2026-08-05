// Personal Daily Journal — server side (Privacy → Daily Journal tab).
// Plaintext rows in journal_entries (LAN-only, AI-readable). One row per
// (user, local day, slot, CATEGORY); +save upserts. Config (slots + categories)
// lives in dashboard_settings.journal. Categories ("gloomys", e.g. Politics /
// Weather) divide each capture; mood was dropped 2026-07-08 (categories-only).
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
        `SELECT id, to_char(entry_date,'YYYY-MM-DD') AS entry_date, slot_id, slot_name,
                category_id, category_name, comment, mood,
                to_char(created_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS created_local
           FROM journal_entries
          WHERE user_id = $1
            AND entry_date >= COALESCE($2::date, ${TODAY} - INTERVAL '30 days')
            AND entry_date <= COALESCE($3::date, ${TODAY})
          ORDER BY entry_date DESC, slot_name NULLS LAST, category_name NULLS LAST, id`,
        [uid, req.query.from || null, req.query.to || null]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  // Search — filter by category, free-text words, and date range (full history).
  // Any of cat / q / from / to is optional; empty = no constraint on that field.
  app.get('/api/journal/search', async (req, res) => {
    try {
      const uid = parseInt(req.query.user_id) || 1;
      const cat = (req.query.cat || '').toString().trim();
      const q = (req.query.q || '').toString().trim();
      const conds = ['user_id = $1'];
      const params = [uid];
      if (cat) { params.push(cat); conds.push(`category_id = $${params.length}`); }
      if (q) { params.push('%' + q + '%'); conds.push(`comment ILIKE $${params.length}`); }
      if (req.query.from) { params.push(req.query.from); conds.push(`entry_date >= $${params.length}::date`); }
      if (req.query.to) { params.push(req.query.to); conds.push(`entry_date <= $${params.length}::date`); }
      const r = await db.query(
        `SELECT id, to_char(entry_date,'YYYY-MM-DD') AS entry_date, slot_id, slot_name,
                category_id, category_name, comment
           FROM journal_entries
          WHERE ${conds.join(' AND ')}
          ORDER BY entry_date DESC, slot_name NULLS LAST, category_name NULLS LAST, id
          LIMIT 500`, params);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  // Today's entries (every slot/category that has one) — for the tab's Today section.
  app.get('/api/journal/today', async (req, res) => {
    try {
      const uid = parseInt(req.query.user_id) || 1;
      const r = await db.query(
        `SELECT id, slot_id, slot_name, category_id, category_name, comment, mood FROM journal_entries
          WHERE user_id = $1 AND entry_date = ${TODAY}`, [uid]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  // Upsert a (user, date, slot, category) entry — used by the reminder capture
  // panel AND the tab's inline editor. entry_date defaults to today (local).
  app.post('/api/journal', async (req, res) => {
    try {
      const b = req.body || {};
      const uid = parseInt(b.user_id) || 1;
      const slotId = (b.slot_id || '').toString().trim();
      if (!slotId) return res.status(400).json({ error: 'slot_id required' });
      const catId = (b.category_id || 'general').toString().trim() || 'general';
      // one mood per reminder capture — the client sends the same value on each
      // category row of that capture; read back from any of them.
      let mood = null;
      if (b.mood != null && b.mood !== '') mood = Math.max(1, Math.min(5, parseInt(b.mood) || 0)) || null;
      const r = await db.query(
        `INSERT INTO journal_entries (user_id, entry_date, slot_id, slot_name, category_id, category_name, comment, mood)
         VALUES ($1, COALESCE($2::date, ${TODAY}), $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, entry_date, slot_id, category_id)
         DO UPDATE SET comment = EXCLUDED.comment, slot_name = EXCLUDED.slot_name,
                       category_name = EXCLUDED.category_name, mood = EXCLUDED.mood, updated_at = now()
         RETURNING id`,
        [uid, b.entry_date || null, slotId, b.slot_name || null,
         catId, b.category_name || null, (b.comment == null ? '' : String(b.comment)), mood]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { err(res, e); }
  });

  // (No PATCH/:id — edits go through the POST upsert keyed by user+date+slot+category.)
  app.delete('/api/journal/:id', async (req, res) => {
    try { await db.query('DELETE FROM journal_entries WHERE id = $1', [parseInt(req.params.id)]); res.json({ ok: true }); }
    catch (e) { err(res, e); }
  });

  // ── Media attachments (journal_media) ────────────────────────────────
  // Photos/videos attached to a capture (user+day+slot). The BYTES live only on
  // the QNAP NAS media library (/mnt/media, uploaded via the media agent :8767);
  // here we store just the QNAP path so the journal can show + detach it. Detach
  // removes the link only — the file stays in the media library (analyzer/faces).

  // List attachments in a date range (default: last 30 days), for the tab + history.
  app.get('/api/journal/media', async (req, res) => {
    try {
      const uid = parseInt(req.query.user_id) || 1;
      const r = await db.query(
        `SELECT id, to_char(entry_date,'YYYY-MM-DD') AS entry_date, slot_id,
                media_path, media_type, orig_name,
                to_char(created_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS created_local
           FROM journal_media
          WHERE user_id = $1
            AND entry_date >= COALESCE($2::date, ${TODAY} - INTERVAL '30 days')
            AND entry_date <= COALESCE($3::date, ${TODAY})
          ORDER BY entry_date DESC, slot_id, id`,
        [uid, req.query.from || null, req.query.to || null]);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  // Attach a media file (already uploaded to /mnt/media via the media agent).
  app.post('/api/journal/media', async (req, res) => {
    try {
      const b = req.body || {};
      const uid = parseInt(b.user_id) || 1;
      const slotId = (b.slot_id || '').toString().trim();
      const mediaPath = (b.media_path || '').toString().trim();
      const mediaType = (b.media_type || '').toString().trim();
      if (!slotId) return res.status(400).json({ error: 'slot_id required' });
      if (!mediaPath.startsWith('/mnt/media/')) return res.status(400).json({ error: 'media_path must be under /mnt/media/' });
      if (mediaType !== 'image' && mediaType !== 'video') return res.status(400).json({ error: "media_type must be 'image' or 'video'" });
      const r = await db.query(
        `INSERT INTO journal_media (user_id, entry_date, slot_id, media_path, media_type, orig_name)
         VALUES ($1, COALESCE($2::date, ${TODAY}), $3, $4, $5, $6) RETURNING id`,
        [uid, b.entry_date || null, slotId, mediaPath, mediaType, (b.orig_name || null)]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { err(res, e); }
  });

  // Detach (delete the link row ONLY — file stays in the QNAP media library).
  app.delete('/api/journal/media/:id', async (req, res) => {
    try { await db.query('DELETE FROM journal_media WHERE id = $1', [parseInt(req.params.id)]); res.json({ ok: true }); }
    catch (e) { err(res, e); }
  });
};
