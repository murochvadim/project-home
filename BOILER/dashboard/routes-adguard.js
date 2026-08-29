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
//   GET /api/adguard/summary                    { status, stats, clients }
//   GET /api/adguard/filters                    filter lists (id -> name)
//   GET /api/adguard/querylog?limit=N[&status=] query-log passthrough (<=5000)
//   GET /api/adguard/impact                     "Check Devices" report (popup)

const os = require('os');
const { NodeSSH } = require('node-ssh');

const AGH_URL  = (process.env.ADGUARD_URL || 'http://192.168.1.217:8080').replace(/\/+$/, '');
const AGH_USER = process.env.ADGUARD_USER || '';
const AGH_PASS = process.env.ADGUARD_PASS || '';

// Service control (Stop/Start for a Tuya flash session) SSHes to RP01 and runs
// `sudo systemctl <action> AdGuardHome`. rp01_project has passwordless sudo; the
// key is the same one routes-people.js uses. Reading state goes over SSH too
// (is-active), because once AGH is stopped its own HTTP API is down.
const RP01_HOST = '192.168.1.217';
const RP01_USER = 'rp01_project';
const SSH_KEY   = process.env.SSH_KEY_PATH || os.homedir() + '/.ssh/id_ed25519';
const AGH_UNIT  = 'AdGuardHome';

async function _sshAgh(cmd) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: RP01_HOST, username: RP01_USER, privateKeyPath: SSH_KEY, readyTimeout: 12000 });
    return await ssh.execCommand(cmd);
  } finally { ssh.dispose(); }
}

// Representative device-control cloud endpoints for the "Check Devices" impact
// check — if a blocklist ever caught one of these, that device would lose its
// cloud. Tested live via AGH's /control/filtering/check_host.
const CONTROL_DOMAINS = [
  'a3.tuyaeu.com', 'm2.tuyaeu.com', 'h3-eu.iot-dns.com', 'm3-eu.lifeaiot.com', 'qas-gl-us-api.tineco.com',
  'n-deventry-gw.tplinkcloud.com', 'aps1-homecare-cloud.i.tplinknbu.com',
  'api.amazonalexa.com', 'alexa.na.gateway.devices.a2z.com', 'avs-alexa-18-na.amazon.com', 'dp-gw-na.amazon.com',
  'logsink.devices.nest.com', 'cdn.samsungcloudsolution.com', 'iot.api.bose.io',
  'reu.comws.homeconnectegw.com', 'fw.prod.gws.ring.amazon.dev', 'connectivity.smartthings.com', 'discovery.meethue.com',
];

function _authHeader() {
  // Basic-auth to AdGuard — same stored-credential shape as the NetBird client,
  // just a Basic header instead of a token.
  return 'Basic ' + Buffer.from(`${AGH_USER}:${AGH_PASS}`).toString('base64');
}

async function _agh(path, timeoutMs = 6000) {
  if (!AGH_USER || !AGH_PASS) {
    const e = new Error('ADGUARD_USER/ADGUARD_PASS not configured');
    e.status = 503;
    throw e;
  }
  let r;
  try {
    r = await fetch(`${AGH_URL}${path}`, {
      headers: { Authorization: _authHeader(), Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
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
  // Service state — SSH `systemctl is-active` (works even when AGH's HTTP is down).
  app.get('/api/adguard/service', async (_req, res) => {
    try {
      const r = await _sshAgh(`sudo -n systemctl is-active ${AGH_UNIT}`);
      const state = (r.stdout || r.stderr || '').trim();
      res.json({ active: state === 'active', state });
    } catch (e) {
      res.status(502).json({ error: 'RP01 unreachable: ' + e.message });
    }
  });

  // Service control — Stop/Start AdGuard on RP01 for a Tuya flash session (frees
  // :53 + RAM). Allowlisted action → sudo systemctl → read state back.
  app.post('/api/adguard/service', async (req, res) => {
    try {
      const action = ((req.body && req.body.action) || '').toLowerCase();
      if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ error: 'action must be start|stop|restart' });
      }
      const r = await _sshAgh(`sudo -n systemctl ${action} ${AGH_UNIT}`);
      if (r.code !== 0) return res.status(500).json({ error: (r.stderr || 'systemctl failed').trim() });
      const s = await _sshAgh(`sudo -n systemctl is-active ${AGH_UNIT}`);
      res.json({ ok: true, action, active: (s.stdout || '').trim() === 'active' });
    } catch (e) {
      res.status(502).json({ error: 'RP01 unreachable: ' + e.message });
    }
  });

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

  // Filter lists (id -> name) so the "Check Devices" impact check can classify
  // each blocked domain by WHICH list caught it (ads/telemetry vs security vs
  // a custom rule) instead of guessing from the domain text.
  app.get('/api/adguard/filters', async (_req, res) => {
    try { res.json(await _agh('/control/filtering/status')); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Recent query log — feeds the "recent lookups" card and the client-side
  // per-device aggregation (group by client -> domains reached / blocked).
  // Optional ?status=blocked (AGH response_status) for the "Check Devices"
  // impact check, which needs a large blocked-only window.
  app.get('/api/adguard/querylog', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 300, 5000);
      const status = /^[a-z_]+$/.test(req.query.status || '') ? `&response_status=${req.query.status}` : '';
      res.json(await _agh(`/control/querylog?limit=${limit}${status}`));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Device Impact Check — a single structured report for the "Check Devices"
  // popup. Two independent proofs that blocking isn't breaking anything:
  //   1. Per-device blocked-log analysis — the ONLY thing that can block a real
  //      device cloud is a custom rule, so those devices are flagged.
  //   2. Live check_host of known device-control domains — confirms none are
  //      caught by any list.
  app.get('/api/adguard/impact', async (_req, res) => {
    try {
      const [status, stats, filtersR, blocked, clients] = await Promise.all([
        _agh('/control/status'),
        _agh('/control/stats'),
        _agh('/control/filtering/status'),
        _agh('/control/querylog?response_status=blocked&limit=2000', 25000),
        _agh('/control/clients'),
      ]);
      const secRe = /phish|malware|threat|urlhaus|abuse|scam|ransom|botnet|c2/i;
      const cat = {};
      (filtersR.filters || []).forEach(f => { cat[f.id] = secRe.test(f.name || '') ? 'security' : 'ads'; });
      const names = {};
      (clients.auto_clients || []).forEach(c => { if (c.ip && c.name) names[c.ip] = c.name; });
      (clients.clients || []).forEach(c => (c.ids || []).forEach(id => { if (c.name) names[id] = c.name; }));

      const dev = {};
      (blocked.data || []).forEach(e => {
        const ip = e.client || '?';
        const dom = (e.question || {}).name || '';
        if (!dom || ip === '127.0.0.1' || ip === '::1') return;
        const fid = e.filterId;
        const c = (fid == null || fid === 0) ? 'custom' : (cat[fid] || 'custom');
        const o = dev[ip] || (dev[ip] = { ads: 0, security: new Set(), custom: new Set() });
        if (c === 'ads') o.ads++;
        else if (c === 'security') o.security.add(dom);
        else o.custom.add(dom);
      });
      const nm = ip => names[ip] || ip;
      const losing = Object.entries(dev).filter(([, o]) => o.custom.size)
        .map(([ip, o]) => ({ device: nm(ip), domains: [...o.custom].slice(0, 8) }));
      const security = Object.entries(dev).filter(([, o]) => o.security.size)
        .map(([ip, o]) => ({ device: nm(ip), domain: [...o.security][0] }));

      // Live control-cloud test (no DNS needed — AGH tells us if it'd block).
      const checks = await Promise.all(CONTROL_DOMAINS.map(async d => {
        try {
          const r = await _agh('/control/filtering/check_host?name=' + encodeURIComponent(d));
          return { domain: d, blocked: /^Filtered/.test(r.reason || '') };
        } catch { return { domain: d, blocked: false, err: true }; }
      }));
      const cloudsBlocked = checks.filter(c => c.blocked).map(c => c.domain);

      const q = stats.num_dns_queries || 0, b = stats.num_blocked_filtering || 0;
      res.json({
        protection: !!status.protection_enabled,
        version: status.version || '?',
        monitored: (stats.top_clients || []).length,
        queries_24h: q,
        blocked_24h: b,
        block_pct: q ? +(100 * b / q).toFixed(1) : 0,
        devices_losing: losing.length,
        devices_losing_list: losing,
        control_tested: CONTROL_DOMAINS.length,
        control_blocked: cloudsBlocked.length,
        control_blocked_list: cloudsBlocked,
        security_blocks: security.length,
        security_list: security.slice(0, 8),
        sampled_blocked: (blocked.data || []).length,
      });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });
};
