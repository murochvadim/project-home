// Irrigation watering history — read-only. Rows are written by the Irrigation
// Log rule (LXC 105) into irrigation_log; this serves the Balcony Irrigation
// tab's Watering history card. Own module (one require() in server.js) so it
// stays past the architecture-guard hook.
//
//   GET /api/irrigation/log?limit=N   (N in 1..200, default 30) → recent sessions

module.exports = function (app, db) {
  app.get('/api/irrigation/log', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 30));
      const r = await db.query(
        `SELECT id, valve_id, valve_name, opened_at, closed_at, duration_sec, source
           FROM irrigation_log ORDER BY opened_at DESC LIMIT $1`, [limit]);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
