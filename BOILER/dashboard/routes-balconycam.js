// routes-balconycam.js — Balcony Logitech C925e camera controls (UVC via v4l2-ctl).
//
// The camera is a USB webcam on the Proxmox host (192.168.1.101, /dev/video0). The
// live video/audio is served by go2rtc on the host (:1984) straight to the browser —
// this module NEVER proxies media bytes. It only proxies the CONTROL surface: read +
// set v4l2 controls over SSH, same shape as routes-robotcam.js / routes-usbbackup.js
// (own module → one require() line in server.js, past the architecture-guard hook).
//
// Endpoints:
//   GET  /api/balconycam/controls  -> [{name,type,min,max,step,default,value,inactive,group,menu[]}]
//   POST /api/balconycam/control   -> body { name, value }  OR  { reset:true }
//   GET  /api/balconycam/status    -> { go2rtc:bool, camera:bool }

const { NodeSSH } = require('node-ssh');
const os = require('os');

const PVE_HOST = '192.168.1.101';
const SSH_KEY = process.env.SSH_KEY_PATH || os.homedir() + '/.ssh/id_ed25519';
const VIDEO = '/dev/video0';

async function pve(cmd) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: PVE_HOST, username: 'root', privateKeyPath: SSH_KEY, readyTimeout: 9000 });
    const r = await ssh.execCommand(cmd);
    ssh.dispose();
    return { ok: true, stdout: (r.stdout || ''), stderr: (r.stderr || '').trim(), code: r.code };
  } catch (e) {
    try { ssh.dispose(); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

// Parse `v4l2-ctl --list-ctrls-menus` output into structured controls.
function parseControls(out) {
  const ctrls = [];
  let group = '';
  let cur = null;
  const CTRL = /^\s*([a-zA-Z0-9_]+)\s+0x[0-9a-f]+\s+\((\w+)\)\s*:\s*(.+)$/;
  const MENU = /^\s+(\d+):\s+(.+?)\s*$/;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const cm = line.match(CTRL);
    if (cm) {
      const [, name, type, rest] = cm;
      const num = (k) => { const m = rest.match(new RegExp(k + '=(-?\\d+)')); return m ? parseInt(m[1], 10) : null; };
      cur = {
        name, type, group,
        min: num('min'), max: num('max'), step: num('step'),
        default: num('default'), value: num('value'),
        inactive: /\binactive\b/.test(rest),
        menu: type === 'menu' ? [] : undefined,
      };
      ctrls.push(cur);
      continue;
    }
    const mm = line.match(MENU);
    if (mm && cur && cur.type === 'menu') { cur.menu.push({ value: parseInt(mm[1], 10), label: mm[2] }); continue; }
    // Section header line (e.g. "User Controls" / "Camera Controls")
    if (!/0x[0-9a-f]/.test(line) && /^[A-Za-z]/.test(line.trim())) group = line.trim();
  }
  return ctrls;
}

module.exports = function (app) {
  app.get('/api/balconycam/controls', async (req, res) => {
    const r = await pve(`v4l2-ctl -d ${VIDEO} --list-ctrls-menus`);
    if (!r.ok) return res.status(502).json({ ok: false, error: r.error });
    if (r.code !== 0 && !r.stdout) return res.status(502).json({ ok: false, error: r.stderr || 'v4l2-ctl failed' });
    res.json({ ok: true, device: VIDEO, controls: parseControls(r.stdout) });
  });

  app.post('/api/balconycam/control', async (req, res) => {
    const body = req.body || {};
    // Reset: set every control to its parsed default.
    if (body.reset) {
      const lr = await pve(`v4l2-ctl -d ${VIDEO} --list-ctrls-menus`);
      if (!lr.ok) return res.status(502).json({ ok: false, error: lr.error });
      const sets = parseControls(lr.stdout)
        .filter((c) => c.default != null && (c.type === 'int' || c.type === 'bool' || c.type === 'menu'))
        .map((c) => `${c.name}=${c.default}`);
      if (!sets.length) return res.json({ ok: true, reset: 0 });
      const sr = await pve(`v4l2-ctl -d ${VIDEO} ${sets.map((s) => `--set-ctrl=${s}`).join(' ')}`);
      if (!sr.ok) return res.status(502).json({ ok: false, error: sr.error });
      return res.json({ ok: true, reset: sets.length });
    }
    // Single control set — strict validation guards against shell injection.
    const name = String(body.name || '');
    if (!/^[a-zA-Z0-9_]+$/.test(name)) return res.status(400).json({ ok: false, error: 'bad control name' });
    const value = parseInt(body.value, 10);
    if (!Number.isFinite(value)) return res.status(400).json({ ok: false, error: 'value must be an integer' });
    const sr = await pve(`v4l2-ctl -d ${VIDEO} --set-ctrl=${name}=${value}`);
    if (!sr.ok) return res.status(502).json({ ok: false, error: sr.error });
    if (sr.code !== 0) return res.status(502).json({ ok: false, error: sr.stderr || 'set failed' });
    res.json({ ok: true, name, value });
  });

  app.get('/api/balconycam/status', async (req, res) => {
    const r = await pve(
      `systemctl is-active go2rtc 2>/dev/null; echo ---; ` +
      `v4l2-ctl --list-devices 2>/dev/null | grep -c C925e`);
    if (!r.ok) return res.json({ ok: false, go2rtc: false, camera: false, error: r.error });
    const [act, cam] = r.stdout.split('---');
    res.json({
      ok: true,
      go2rtc: /active/.test(act || ''),
      camera: parseInt((cam || '0').trim(), 10) > 0,
    });
  });
};
