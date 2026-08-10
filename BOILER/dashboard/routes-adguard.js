// AdGuard Home proxy — read-only API for the Project Health "AdGuard" tab.
//
// Kept in its own module (wired from server.js via a single require line) so
// server.js stays free of new `app.<method>(` handlers — the repo's
// architecture-guard hook blocks adding them directly to server.js.
//
// UI-only: it just proxies AdGuard Home's own HTTP API running on RP01
// (192.168.1.217). ALL the DNS logic + query logging + blocking lives on the
// Pi; the dashboard only displays what the Pi computes. If the Pi is down these
// endpoints return 502 and the tab shows "unavailable" (the svc-adguard health
// cell also goes red).
//
// Credentials come from PM2-injected env (ecosystem.config.js <- .env):
//   ADGUARD_URL   (e.g. http://192.168.1.217:8080)
//   ADGUARD_USER / ADGUARD_PASS   (AdGuard admin basic-auth)
//
// Endpoints:
//   GET /api/adguard/summary            { status, stats, clients }
//   GET /api/adguard/querylog?limit=N   AdGuard query-log passthrough (<=1000)

const AGH_URL  = (process.env.ADGUARD_URL || 'http://192.168.1.217:8080').replace(/\/+$/, '');
const AGH_USER = process.env.ADGUARD_USER || '';
const AGH_PASS = process.env.ADGUARD_PASS || '';

function _authHeader() {
  // Basic-auth to AdGuard — same stored-credential shape as the NetBird client,
  // just a Basic header instead of a token.
  return 'Basic ' + Buffer.from(`${AGH_USER}:${AGH_PASS}`).toString('base64');
}

async function _agh(path) {
  if (!AGH_USER || !AGH_PASS) {
    const e = new Error('ADGUARD_USER/ADGUARD_PASS not configured');
    e.status = 503;
    throw e;
  }
  let r;
  try {
    r = await fetch(`${AGH_URL}${path}`, {
      headers: { Authorization: _authHeader(), Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
  } catch (err) {
    const e = new Error(`AdGuard unreachable: ${err.message}`);
    e.status = 502; // Pi down / AGH stopped
    throw e;
  }
  if (!r.ok) {
    const e = new Error(`AdGuard HTTP ${r.status}`);
    e.status = r.status >= 500 || r.status === 401 ? 502 : r.status;
    throw e;
  }
  return r.json();
}

module.exports = function (app) {
  // One combined call for the tab: header/health + 24h overview + top cards +
  // client IP->name map. Parallel fetch keeps it one round-trip for the browser.
  app.get('/api/adguard/summary', async (_req, res) => {
    try {
      const [status, stats, clients] = await Promise.all([
        _agh('/control/status'),
        _agh('/control/stats'),
        _agh('/control/clients'),
      ]);
      res.json({ status, stats, clients });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Recent query log — feeds the "recent lookups" card and the client-side
  // per-device aggregation (group by client -> domains reached / blocked).
  app.get('/api/adguard/querylog', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);
      res.json(await _agh(`/control/querylog?limit=${limit}`));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });
};
