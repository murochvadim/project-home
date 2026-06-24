// routes-phonelink.js - Phone Link ("Link to Windows") recovery + alert dismiss.
//
// Windows-HOST actions (recover Phone Link on THIS laptop) - the dashboard runs
// on the same machine, so these spawn PowerShell locally, exactly like
// routes-cast.js. Kept in their own module so server.js stays clear of the
// architecture-guard hook (only server.js is checked).
//
// Surfaced as buttons on Project Health -> System Alerts for phonelink:* alerts:
//   POST /api/phonelink/restart  - LIGHT fix: restart Phone Link + re-register
//                                  CrossDevice (no data loss, NO re-pair).
//   POST /api/phonelink/reset    - HARD fix: Reset-AppxPackage YourPhone +
//                                  CrossDevice (wipes data -> re-sign-in + QR re-pair).
//   POST /api/phonelink/dismiss  - resolve ONE system_alerts row by id (the
//                                  watchdog re-raises in <=5 min if still broken).

const { execFile } = require('child_process');
const path = require('path');

function runPs(script, timeoutMs, res) {
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { timeout: timeoutMs, windowsHide: true },
    (err, stdout, stderr) => {
      const out = (stdout || '').trim();
      const errOut = (stderr || '').trim();
      if (err && !out) {
        return res.status(500).json({ ok: false, message: err.message, stderr: errOut });
      }
      res.json({ ok: /^OK:/.test(out), message: out || errOut || 'No output from recovery script.' });
    }
  );
}

module.exports = function (app, db) {
  // LIGHT - restart + re-register CrossDevice (no re-pair)
  app.post('/api/phonelink/restart', (req, res) => {
    runPs(path.join(__dirname, 'phonelink-restart.ps1'), 40000, res);
  });

  // HARD - full reset (needs re-sign-in + QR re-pair). Slow, generous timeout.
  app.post('/api/phonelink/reset', (req, res) => {
    runPs(path.join(__dirname, 'phonelink-reset.ps1'), 90000, res);
  });

  // DISMISS - resolve a single active alert (cosmetic; watchdog re-raises if
  // the condition still holds on its next pass).
  app.post('/api/phonelink/dismiss', async (req, res) => {
    const id = parseInt(req.body && req.body.id, 10);
    if (!id) return res.status(400).json({ ok: false, message: 'missing alert id' });
    try {
      const r = await db.query(
        'UPDATE system_alerts SET resolved_at = NOW() WHERE id = $1 AND resolved_at IS NULL',
        [id]
      );
      res.json({ ok: true, dismissed: r.rowCount });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });
};
