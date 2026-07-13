// Jura — per-drink graph for the Living Room -> Jura tab.
//
// Own module (wired from server.js via one require line) so server.js stays
// clear of the architecture-guard hook. UI-only: reads two LXC-102 tables the
// LXC-104 `jura-ingest` daemon fills the instant the machine reports:
//   • jura_drinks — one row per drink event (ts + qty + drink_type), sub-day graph
//   • jura_daily  — one row per day; made_by_type = per-type drinks that day (forever)
// Every drink EXCEPT Hot Water and Flat White is tracked (Milk Portion IS).
//
// GET /api/jura/drinks?range=6h|24h|1week|1month|1year|3year
//   Per-type drink counts per time bucket, gaps filled with 0. 6h/24h bucket the
//   per-drink event log (jura_drinks); week..3yr bucket the daily per-type totals
//   (jura_daily.made_by_type).
//   → { labels: [...], series: [ { key, data:[...] }, ... ] }
//     (one series per drink type that has any drink in the range; server orders
//      by TYPE_ORDER, the client maps key -> label + colour.)
//
// GET /api/jura/daily-drinks?period=day|month|year   (legacy coffee-only, kept)

module.exports = (app, db) => {
  // "Today" in the apartment timezone (jura_daily.day is Jerusalem-local).
  const TODAY = "(now() AT TIME ZONE 'Asia/Jerusalem')::date";

  // Stable stacking order (coffee-first). Client owns labels + colours.
  const TYPE_ORDER = [
    'coffee', 'espresso', 'cappuccino', 'latte', 'esp_macchiato',
    'ristretto', 'milk', '2espressi', '2coffee', '2ristretti',
  ];

  // Allowlist — every SQL fragment comes ONLY from this map, never user input.
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
        // Per-drink events, bucketed + split by type. generate_series builds the
        // (clock-aligned) buckets so empty ones still emit a row (type NULL) for
        // the label; labels in apartment-local time.
        sql = `
          SELECT to_char(b.bucket AT TIME ZONE 'Asia/Jerusalem', '${r.fmt}') AS label,
                 d.drink_type AS type,
                 COALESCE(SUM(d.qty), 0)::int AS n
          FROM generate_series(${r.start}, now(), interval '${r.step}') b(bucket)
          LEFT JOIN jura_drinks d
            ON d.ts >= b.bucket AND d.ts < b.bucket + interval '${r.step}'
          GROUP BY b.bucket, d.drink_type
          ORDER BY b.bucket
        `;
      } else {
        // Daily per-type totals (made_by_type jsonb), bucketed by day/month.
        sql = `
          SELECT to_char(b.bucket, '${r.fmt}') AS label,
                 kv.key AS type,
                 COALESCE(SUM((kv.value)::int), 0)::int AS n
          FROM generate_series(${r.start}, ${TODAY}, interval '${r.step}') b(bucket)
          LEFT JOIN jura_daily jd
            ON date_trunc('${r.trunc}', jd.day) = date_trunc('${r.trunc}', b.bucket)
           AND jd.made_by_type <> '{}'::jsonb
          LEFT JOIN LATERAL jsonb_each_text(jd.made_by_type) kv(key, value) ON true
          GROUP BY b.bucket, kv.key
          ORDER BY b.bucket
        `;
      }
      const out = await db.query(sql);

      // Pivot (label, type, n) triples -> { labels, series[] }.
      const labels = [];
      const seenLabel = new Set();
      const byType = {};   // type -> { label -> n }
      for (const row of out.rows) {
        if (!seenLabel.has(row.label)) { seenLabel.add(row.label); labels.push(row.label); }
        if (row.type == null) continue;      // empty-bucket placeholder row
        (byType[row.type] || (byType[row.type] = {}))[row.label] = row.n;
      }
      // Order: known types first (TYPE_ORDER), then any unexpected type. Only
      // include a type that actually has a drink in the range.
      const present = Object.keys(byType);
      const ordered = [
        ...TYPE_ORDER.filter(t => present.includes(t)),
        ...present.filter(t => !TYPE_ORDER.includes(t)),
      ];
      const series = ordered.map(key => ({
        key,
        data: labels.map(l => byType[key][l] || 0),
      }));
      res.json({ labels, series });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Legacy endpoint (coffee-only, kept so nothing breaks if an old page caches it).
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
