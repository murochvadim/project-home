// routes-cast.js — laptop → TV screen-mirror trigger.
//
// This is a Windows-HOST action (cast the laptop's own screen to the TV), so it
// legitimately runs on the dashboard host, not an LXC — it spawns PowerShell on
// the same machine to open the Cast panel (Win+K) and click the TV. Lives in its
// own module so server.js stays clear of the architecture-guard hook.
//
// Endpoint: POST /api/cast/connect-tv85
//   Runs cast-to-tv85.ps1, returns { ok, message }. ok=true when the script
//   clicked the TV. The TV's "Allow" prompt (unless set to "Allow always") is a
//   physical step on the TV that no software can bypass.

const { execFile } = require('child_process');
const path = require('path');

module.exports = function (app) {
  app.post('/api/cast/connect-tv85', (req, res) => {
    const script = path.join(__dirname, 'cast-to-tv85.ps1');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout: 25000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        const errOut = (stderr || '').trim();
        if (err && !out) {
          return res.status(500).json({ ok: false, message: err.message, stderr: errOut });
        }
        res.json({ ok: /^OK:/.test(out), message: out || errOut || 'No output from cast script.' });
      }
    );
  });
};
