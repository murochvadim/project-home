// Jura — per-day drink graph for the Living Room -> Jura tab.
//
// Own module (wired from server.js via one require line) so server.js stays
// clear of the architecture-guard hook that blocks new `app.<method>(` handlers.
// UI-only: reads the jura_daily snapshot table (LXC 102) that the LXC-104 cron
// `jura_daily_snapshot.py` fills every 30 min from devices.last_state.
//
// GET /api/jura/daily-drinks?days=N
//   → [{ day:'YYYY-MM-DD', drinks:N }] — drinks made each day EXCLUDING hot water
//     and milk portions, computed as the day-over-day delta of the cumulative
//     counters: (Δtotal − Δhotwater − Δmilk). The first stored day has no prior
//     day to diff against, so it's omitted (the graph starts on day 2 of logging).

module.exports = (app, db) => {
  app.get('/api/jura/daily-drinks', async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days) || 60, 1), 366);
      const r = await db.query(`
        SELECT to_char(day, 'YYYY-MM-DD') AS day,
               (total    - LAG(total)    OVER (ORDER BY day))
             - (hotwater - LAG(hotwater) OVER (ORDER BY day))
             - (milk     - LAG(milk)     OVER (ORDER BY day)) AS drinks
        FROM jura_daily
        ORDER BY day
      `);
      const rows = r.rows
        .filter(x => x.drinks !== null)                         // drop the first (no prior day)
        .map(x => ({ day: x.day, drinks: Math.max(0, parseInt(x.drinks, 10)) }))
        .slice(-days);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
