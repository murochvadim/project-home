// Jura — coffee graph for the Living Room -> Jura tab.
//
// Own module (wired from server.js via one require line) so server.js stays
// clear of the architecture-guard hook. UI-only: reads two LXC-102 tables the
// LXC-104 `jura-ingest` daemon fills the instant the machine reports:
//   • jura_daily   — one row per day, `made` = coffees that day (forever)
//   • jura_drinks  — one row per coffee event (ts + qty), for the sub-day graph
// ONLY the Coffee counter is tracked (per the user).
//
// GET /api/jura/drinks?range=6h|24h|1week|1month|1year|3year
//   Coffees per time bucket, gaps filled with 0. 6h/24h bucket the per-coffee
//   event log (jura_drinks); week..3yr bucket the daily totals (jura_daily).
//   → [{ label, drinks }]
//
// GET /api/jura/daily-drinks?period=day|month|year   (legacy, kept for compat)

module.exports = (app, db) => {
  // "Today" in the apartment timezone (jura_daily.day is Jerusalem-local, so
  // never compare against the server's UTC current_date).
  const TODAY = "(now() AT TIME ZONE 'Asia/Jerusalem')::date";

  // Allowlist — every SQL fragment below comes ONLY from this map, never from
  // user input, so the interpolation can't be injected. `range` is the key.
  const RANGES = {
    '6h':     { src: 'drinks', start: "date_trunc('hour', now()) - interval '6 hours'",   step: '30 minutes', fmt: 'HH24:MI' },
    '24h':    { src: 'drinks', start: "date_trunc('hour', now()) - interval '24 hours'",  step: '1 hour',     fmt: 'HH24:MI' },
    '1week':  { src: 'daily',  start: `${TODAY} - interval '6 days'`,                      step: '1 day',      fmt: 'MM-DD',   trunc: 'day'   },
    '1month': { src: 'daily',  start: `${TODAY} - interval '29 days'`,                     step: '1 day',      fmt: 'MM-DD',   trunc: 'day'   },
    '1year':  { src: 'daily',  start: `date_trunc('month', ${TODAY}) - interval '11 months'`, step: '1 month', fmt: 'YYYY-MM', trunc: 'month' },
    '3year':  { src: 'daily',  start: `date_trunc('month', ${TODAY}) - interval '35 months'`, step: '1 month', fmt: 'YYYY-MM', trunc: 'month' },
  };

  app.get('/api/jura/drinks', async (req, res) => {
    try {
      const r = RANGES[req.query.range] || RANGES['24h'];
      let sql;
      if (r.src === 'drinks') {
        // Per-coffee events, bucketed. generate_series builds the (clock-aligned)
        // buckets so empty ones render as 0; labels in apartment-local time.
        sql = `
          SELECT to_char(b.bucket AT TIME ZONE 'Asia/Jerusalem', '${r.fmt}') AS label,
                 COALESCE(SUM(d.qty), 0)::int AS drinks
          FROM generate_series(${r.start}, now(), interval '${r.step}') b(bucket)
          LEFT JOIN jura_drinks d
            ON d.ts >= b.bucket AND d.ts < b.bucket + interval '${r.step}'
          GROUP BY b.bucket
          ORDER BY b.bucket
        `;
      } else {
        // Daily totals, bucketed by day or calendar month, gaps filled with 0.
        sql = `
          SELECT to_char(b.bucket, '${r.fmt}') AS label,
                 COALESCE(SUM(GREATEST(jd.made, 0)), 0)::int AS drinks
          FROM generate_series(${r.start}, ${TODAY}, interval '${r.step}') b(bucket)
          LEFT JOIN jura_daily jd
            ON date_trunc('${r.trunc}', jd.day) = date_trunc('${r.trunc}', b.bucket)
           AND jd.made IS NOT NULL
          GROUP BY b.bucket
          ORDER BY b.bucket
        `;
      }
      const out = await db.query(sql);
      res.json(out.rows.map(x => ({ label: x.label, drinks: x.drinks })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Legacy endpoint (kept so nothing breaks if an old page caches it).
  app.get('/api/jura/daily-drinks', async (req, res) => {
    try {
      const PERIODS = {
        day:   { trunc: 'day',   fmt: 'YYYY-MM-DD' },
        month: { trunc: 'month', fmt: 'YYYY-MM' },
        year:  { trunc: 'year',  fmt: 'YYYY' },
      };
      const p = PERIODS[req.query.period] || PERIODS.day;
      const limit = Math.min(Math.max(parseInt(req.query.limit || req.query.days, 10) || 60, 1), 366);
      const r = await db.query(`
        SELECT to_char(date_trunc('${p.trunc}', day), '${p.fmt}') AS label,
               SUM(GREATEST(made, 0)) AS drinks
        FROM jura_daily
        WHERE made IS NOT NULL
        GROUP BY date_trunc('${p.trunc}', day)
        ORDER BY date_trunc('${p.trunc}', day)
      `);
      res.json(r.rows.map(x => ({ label: x.label, drinks: parseInt(x.drinks, 10) || 0 })).slice(-limit));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
