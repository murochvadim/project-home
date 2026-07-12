// Jura — drinks graph for the Living Room -> Jura tab.
//
// Own module (wired from server.js via one require line) so server.js stays
// clear of the architecture-guard hook. UI-only: reads the jura_daily snapshot
// table (LXC 102) that the LXC-104 cron `jura_daily_snapshot.py` fills every
// 30 min from devices.last_state (salon_bridge cumulative counters).
//
// GET /api/jura/daily-drinks?period=day|month|year[&limit=N]
//   Coffees made per day — the pre-computed jura_daily.made column (today's
//   cumulative cnt_coffee minus the previous logged day's). ONLY the Coffee
//   drink is counted. `period` groups by day / calendar month / calendar year.
//   → [{ label, drinks }]  (label: 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY')

module.exports = (app, db) => {
  // Allowlist — the trunc unit + label format are NEVER taken from user input
  // directly (only via this map), so the query can't be injected.
  const PERIODS = {
    day:   { trunc: 'day',   fmt: 'YYYY-MM-DD' },
    month: { trunc: 'month', fmt: 'YYYY-MM' },
    year:  { trunc: 'year',  fmt: 'YYYY' },
  };

  app.get('/api/jura/daily-drinks', async (req, res) => {
    try {
      const p = PERIODS[req.query.period] || PERIODS.day;
      const limit = Math.min(Math.max(parseInt(req.query.limit || req.query.days, 10) || 60, 1), 366);
      const r = await db.query(`
        SELECT to_char(date_trunc('${p.trunc}', day), '${p.fmt}') AS label,
               SUM(GREATEST(made, 0)) AS drinks
        FROM jura_daily
        WHERE made IS NOT NULL            -- first logged day has no prior → NULL
        GROUP BY date_trunc('${p.trunc}', day)
        ORDER BY date_trunc('${p.trunc}', day)
      `);
      const rows = r.rows
        .map(x => ({ label: x.label, drinks: parseInt(x.drinks, 10) || 0 }))
        .slice(-limit);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
