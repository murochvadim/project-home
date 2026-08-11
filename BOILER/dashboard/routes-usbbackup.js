// routes-usbbackup.js — "Ext Disk Backup": control + status for the one-session
// full-project backup to an external disk plugged into the Proxmox host.
//
// Business logic lives on the PVE host (/opt/usb-full-backup.sh); this module is a
// thin SSH proxy so server.js stays clear of the architecture-guard hook.
//
// Endpoints:
//   GET  /api/usb-backup/status  -> { disk:{connected,dev,size,model,fstype}, job:{state,phase,pct,...} }
//   POST /api/usb-backup/start   -> spawns the worker detached (systemd-run) on the PVE host
//   POST /api/usb-backup/stop    -> touches the stop flag (clean cancel)

const { NodeSSH } = require('node-ssh');
const os = require('os');

const PVE_HOST = '192.168.1.101';
const SSH_KEY = process.env.SSH_KEY_PATH || os.homedir() + '/.ssh/id_ed25519';

async function pve(cmd) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: PVE_HOST, username: 'root', privateKeyPath: SSH_KEY, readyTimeout: 9000 });
    const r = await ssh.execCommand(cmd);
    ssh.dispose();
    return { ok: true, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), code: r.code };
  } catch (e) {
    try { ssh.dispose(); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

// Detect the USB disk + read the worker status JSON in one round-trip.
const STATUS_CMD = `
d=$(lsblk -ndo NAME,TRAN,TYPE 2>/dev/null | awk '$2=="usb" && $3=="disk"{print $1; exit}')
if [ -n "$d" ]; then
  echo "connected=1"
  echo "dev=$d"
  echo "size=$(lsblk -ndo SIZE /dev/$d 2>/dev/null | tr -d ' ')"
  echo "model=$(lsblk -ndo MODEL /dev/$d 2>/dev/null | xargs)"
  p=$(lsblk -brno NAME,TYPE,FSTYPE,SIZE /dev/$d 2>/dev/null | awk '$2=="part" && ($3=="exfat"||$3=="ntfs"||$3=="ext4"||$3=="ext3"||$3=="ext2"||$3=="vfat"){print $1,$4}' | sort -k2 -n | tail -1 | awk '{print $1}')
  [ -z "$p" ] && p=$d
  echo "fstype=$(blkid -o value -s TYPE /dev/$p 2>/dev/null)"
else
  echo "connected=0"
fi
echo "__JOB__"
cat /run/usb-full-backup.json 2>/dev/null || echo '{"state":"idle"}'
`;

module.exports = function (app) {
  app.get('/api/usb-backup/status', async (req, res) => {
    const r = await pve(STATUS_CMD);
    if (!r.ok) return res.json({ ok: false, error: r.error, disk: { connected: false }, job: { state: 'unknown' } });
    const [diskPart, jobPart] = r.stdout.split('__JOB__');
    const disk = { connected: false };
    (diskPart || '').split('\n').forEach((ln) => {
      const i = ln.indexOf('=');
      if (i > 0) {
        const k = ln.slice(0, i).trim();
        const v = ln.slice(i + 1).trim();
        if (k === 'connected') disk.connected = v === '1';
        else disk[k] = v;
      }
    });
    let job = { state: 'idle' };
    try { job = JSON.parse((jobPart || '').trim()); } catch (_) {}
    res.json({ ok: true, disk, job });
  });

  app.post('/api/usb-backup/start', async (req, res) => {
    // guard: not already running, and a disk is present
    const s = await pve(STATUS_CMD);
    if (!s.ok) return res.status(500).json({ ok: false, error: s.error });
    const connected = /connected=1/.test(s.stdout);
    if (!connected) return res.status(400).json({ ok: false, error: 'No external USB disk detected' });
    const jobPart = s.stdout.split('__JOB__')[1] || '';
    let state = 'idle';
    try { state = (JSON.parse(jobPart.trim()) || {}).state || 'idle'; } catch (_) {}
    if (state === 'running') return res.status(409).json({ ok: false, error: 'A backup is already running' });
    // clear any stale unit + start detached so it survives the SSH session
    const r = await pve('rm -f /run/usb-full-backup.stop; systemctl reset-failed usb-full-backup 2>/dev/null; systemd-run --unit=usb-full-backup --collect /opt/usb-full-backup.sh');
    if (!r.ok) return res.status(500).json({ ok: false, error: r.error });
    if (r.code !== 0 && !/Running as unit/.test(r.stderr + r.stdout)) {
      return res.status(500).json({ ok: false, error: r.stderr || 'failed to start' });
    }
    res.json({ ok: true, started: true });
  });

  app.post('/api/usb-backup/stop', async (req, res) => {
    const r = await pve('touch /run/usb-full-backup.stop');
    if (!r.ok) return res.status(500).json({ ok: false, error: r.error });
    res.json({ ok: true, stopping: true });
  });
};
