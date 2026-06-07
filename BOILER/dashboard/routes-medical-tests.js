// Medical Tests — results CRUD for the "Tests" tab on medical.html.
//
// Kept in its own module (wired from server.js via a single require line) so
// server.js stays free of new route handlers — the repo's architecture-guard
// hook blocks adding `app.<method>(` directly to server.js. Same dashboard-only
// pattern + `db` (pg Pool) query style as the /api/medical/contacts cluster.
//
// Backs a single generic table `medical_test_results` (test_type='hearing' now,
// 'vision' later). Endpoints:
//   GET    /api/medical/test-results[?type=hearing]   list, newest first
//   POST   /api/medical/test-results                  { test_type, results, meta? }
//   DELETE /api/medical/test-results/:id

module.exports = (app, db) => {
  const err = (res, e) => res.status(500).json({ error: (e && e.message) || String(e) });

  // List (optionally filtered by test_type), newest first.
  app.get('/api/medical/test-results', async (req, res) => {
    try {
      const params = [];
      let where = '';
      if (req.query.type) { params.push(String(req.query.type)); where = 'WHERE test_type = $1'; }
      const r = await db.query(
        `SELECT id, test_type, tested_at, results, meta, created_at
           FROM medical_test_results ${where}
          ORDER BY tested_at DESC`,
        params,
      );
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  // Create one result row. results must be a JSON object; meta optional.
  app.post('/api/medical/test-results', async (req, res) => {
    const b = req.body || {};
    const type = (b.test_type || '').trim();
    if (!type) return res.status(400).json({ error: 'test_type is required' });
    if (b.results == null || typeof b.results !== 'object') {
      return res.status(400).json({ error: 'results (object) is required' });
    }
    try {
      const r = await db.query(
        `INSERT INTO medical_test_results (test_type, results, meta)
         VALUES ($1, $2::jsonb, $3::jsonb)
         RETURNING id, test_type, tested_at, results, meta, created_at`,
        [type, JSON.stringify(b.results), JSON.stringify(b.meta || {})],
      );
      res.json(r.rows[0]);
    } catch (e) { err(res, e); }
  });

  // Delete one result row.
  app.delete('/api/medical/test-results/:id', async (req, res) => {
    try {
      await db.query('DELETE FROM medical_test_results WHERE id = $1', [parseInt(req.params.id, 10)]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });
};
