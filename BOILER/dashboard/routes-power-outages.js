// Power Outage Log — read endpoint for the "Power Outage Log" card on the
// Project Power page (power.html, Status tab).
//
// Kept in its own module (wired from server.js via a single require line) so
// this file's /api/power/outages route doesn't trip the repo's
// architecture-guard hook, which blocks adding `app.<method>(` directly to
// server.js. Same `db` (pg Pool) query style as routes-medical-tests.js.
//
// Source table: ups_power_events on LXC 102 (retention=forever). The 60-s UPS
// poller (scripts/ups_poll.py on LXC 105) promotes every apcupsd `ups_onbattery`
// alert into this table — started_at = mains lost, ended_at = mains restored
// (NULL = ongoing), duration_sec set when it ends. Read-only here.
//
//   GET /api/power/outages   — last 50 outages, newest first

module.exports = (app, db) => {
  app.get('/api/power/outages', async (req, res) => {
    try {
      const r = await db.query(
        `SELECT id, started_at, ended_at, duration_sec,
                (ended_at IS NULL) AS ongoing
           FROM ups_power_events
          ORDER BY started_at DESC
          LIMIT 50`,
      );
      res.json({ outages: r.rows });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  });
};
