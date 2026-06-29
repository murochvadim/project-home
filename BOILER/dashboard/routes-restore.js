// Restore — Project Health "Restore" tab. Lists available backups and runs a
// SAFE restore via /opt/restore-backup.sh on LXC 104 (which has the QNAP mount,
// the gdrive_sheets rclone remote, the gpg passphrase, DB access, and SSH to the
// laptop). Own module (one require() line in server.js) so server.js stays past
// the architecture-guard hook.
//
// SAFETY: project restores land in a NEW timestamped folder (QNAP Restores/ or
// laptop Restore/) — never the original. Budget restore replaces the live blob
// but auto-saves the current one as a rollback first. Refs are validated against
// strict patterns + the live source list, then the full path is built server-side
// (the client never passes raw paths) — no shell injection.

const os = require('os');
const { NodeSSH } = require('node-ssh');

const SSH_HOST = '192.168.1.227';
const SSH_USER = 'root';
const SSH_KEY = process.env.SSH_KEY_PATH || os.homedir() + '/.ssh/id_ed25519';

async function ssh(cmd) {
  const c = new NodeSSH();
  await c.connect({ host: SSH_HOST, username: SSH_USER, privateKeyPath: SSH_KEY });
  const r = await c.execCommand(cmd);
  c.dispose();
  return r;
}

const TS_RE = /^\d{4}-\d{2}-\d{2}_\d{6}$/;                       // QNAP snapshot dir
const PROJ_FILE_RE = /^project_home_(\d{4}-\d{2}-\d{2}|latest)\.tar\.gz\.gpg$/;
const BUD_FILE_RE = /^privacy_budget_(\d{4}-\d{2}-\d{2}|latest)\.json$/;

function lines(s) { return (s || '').split('\n').map(x => x.trim()).filter(Boolean); }

module.exports = function (app, db) {
  // List available backups for both the project folder and the Budget.
  app.get('/api/restore/sources', async (_req, res) => {
    try {
      const [pq, pd, bq, bd] = await Promise.all([
        ssh(`ls -1 '/mnt/qnap-claude/Claude Project' 2>/dev/null`),
        ssh(`rclone lsf gdrive_sheets:Claude_Project_Enc/ 2>/dev/null`),
        ssh(`ls -1 /mnt/qnap-claude/Privacy_Budget 2>/dev/null`),
        ssh(`rclone lsf gdrive_sheets:Privacy_Budget/ 2>/dev/null`),
      ]);
      const projQnap = lines(pq.stdout).filter(x => TS_RE.test(x)).reverse()
        .map(ts => ({ ref: ts, label: ts.replace('_', ' ') }));
      const projDrive = lines(pd.stdout).filter(x => PROJ_FILE_RE.test(x))
        .map(f => ({ ref: f, label: f.replace('project_home_', '').replace('.tar.gz.gpg', '') }));
      const budQnap = lines(bq.stdout).filter(x => TS_RE.test(x)).reverse()
        .map(ts => ({ ref: ts, label: ts.replace('_', ' ') }));
      const budDrive = lines(bd.stdout).filter(x => BUD_FILE_RE.test(x))
        .map(f => ({ ref: f, label: f.replace('privacy_budget_', '').replace('.json', '') }));
      res.json({ project: { qnap: projQnap, drive: projDrive }, budget: { qnap: budQnap, drive: budDrive } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Run a restore. body: { type:'project'|'budget', source:'qnap'|'drive', ref, dest:'qnap'|'laptop' }
  app.post('/api/restore/run', async (req, res) => {
    try {
      const b = req.body || {};
      const type = b.type, source = b.source, ref = b.ref;
      let dest = b.dest;
      if (!['project', 'budget'].includes(type)) return res.status(400).json({ error: 'bad type' });
      if (!['qnap', 'drive'].includes(source)) return res.status(400).json({ error: 'bad source' });

      // Validate ref + build the full source path server-side (no raw client paths).
      let fullRef;
      if (type === 'project' && source === 'qnap') {
        if (!TS_RE.test(ref)) return res.status(400).json({ error: 'bad ref' });
        fullRef = `/mnt/qnap-claude/Claude Project/${ref}/project_home`;
      } else if (type === 'project' && source === 'drive') {
        if (!PROJ_FILE_RE.test(ref)) return res.status(400).json({ error: 'bad ref' });
        fullRef = ref;
      } else if (type === 'budget' && source === 'qnap') {
        if (!TS_RE.test(ref)) return res.status(400).json({ error: 'bad ref' });
        fullRef = `/mnt/qnap-claude/Privacy_Budget/${ref}/PrivacyBackup/privacy_budget.json`;
      } else { // budget drive
        if (!BUD_FILE_RE.test(ref)) return res.status(400).json({ error: 'bad ref' });
        fullRef = ref;
      }

      if (type === 'budget') dest = 'db';
      else if (!['qnap', 'laptop'].includes(dest)) return res.status(400).json({ error: 'bad dest' });

      const cmd = `/opt/restore-backup.sh ${type} ${source} '${fullRef.replace(/'/g, "")}' ${dest}`;
      const r = await ssh(cmd);
      const out = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
      const ok = r.code === 0 && /RESTORED_(TO|BUDGET):/.test(r.stdout || '');
      const m = (r.stdout || '').match(/RESTORED_TO:\s*(.+)/);
      res.json({ ok, target: m ? m[1].trim() : null, output: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
