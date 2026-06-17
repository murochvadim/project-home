// routes-places.js — CRUD for visited_places, backing the Privacy > Places
// travel map. Own module so server.js stays clear of the architecture-guard hook.
//
//   GET    /api/places        list all geocoded places (for the map)
//   POST   /api/places        add a manual place (browser geocodes -> lat/lon)
//   PATCH  /api/places/:id    edit a place
//   DELETE /api/places/:id    remove a place
//
// Manual rows use source='manual' with source_id=NULL (NULLs are distinct in the
// UNIQUE(source, source_id) constraint, so manual adds never collide).

module.exports = function (app, db) {
  app.get('/api/places', async (_req, res) => {
    try {
      const r = await db.query(
        `SELECT id, source, kind, place_name, address, city, country, country_code,
                lat, lon, visited_at, end_at, rating, notes, visitors, visit_count
           FROM visited_places
          WHERE lat IS NOT NULL AND lon IS NOT NULL
          ORDER BY visited_at DESC NULLS LAST, id DESC`);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/places', async (req, res) => {
    try {
      const b = req.body || {};
      const name = (b.place_name || '').trim();
      const lat = parseFloat(b.lat), lon = parseFloat(b.lon);
      if (!name) return res.status(400).json({ error: 'place_name is required' });
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'could not resolve a location (lat/lon)' });
      const trim = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
      const visitors = Array.isArray(b.visitors) ? b.visitors.map(s => String(s).trim()).filter(Boolean) : [];
      const visitCount = (b.visit_count === '' || b.visit_count == null) ? null : parseInt(b.visit_count, 10);
      const r = await db.query(
        `INSERT INTO visited_places
           (source, kind, place_name, address, city, country, country_code, lat, lon, visited_at, end_at, rating, notes, source_id, visitors, visit_count)
         VALUES ('manual', $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13::jsonb,$14)
         RETURNING id, source, kind, place_name, address, city, country, country_code, lat, lon, visited_at, end_at, rating, notes, visitors, visit_count`,
        [trim(b.kind) || 'visit', name, trim(b.address), trim(b.city), trim(b.country), trim(b.country_code),
         lat, lon, trim(b.visited_at), trim(b.end_at),
         (b.rating === '' || b.rating == null) ? null : parseInt(b.rating, 10), trim(b.notes),
         JSON.stringify(visitors), Number.isFinite(visitCount) ? visitCount : null]);
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/places/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const cols = ['kind', 'place_name', 'address', 'city', 'country', 'country_code', 'lat', 'lon', 'visited_at', 'end_at', 'rating', 'notes', 'visit_count'];
      const sets = [], vals = []; let i = 1;
      for (const k of cols) {
        if (b[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(b[k] === '' ? null : b[k]); }
      }
      if (b.visitors !== undefined) {
        sets.push(`visitors = $${i++}::jsonb`);
        vals.push(JSON.stringify(Array.isArray(b.visitors) ? b.visitors.map(s => String(s).trim()).filter(Boolean) : []));
      }
      if (!sets.length) return res.json({ ok: true });
      vals.push(req.params.id);
      await db.query(`UPDATE visited_places SET ${sets.join(', ')} WHERE id = $${i}`, vals);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/places/:id', async (req, res) => {
    try { await db.query('DELETE FROM visited_places WHERE id = $1', [req.params.id]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
};
