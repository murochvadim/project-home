// People / Heritage — server side (Privacy → People tab). Phase 1: Directory +
// relationship edges. Dashboard-only; data in Postgres (LXC 102), photos on QNAP.
// Plaintext, LAN-only (AI-readable, like medical_contacts / journal_entries).
//
// Own module (one require() line in server.js) so it stays past the
// architecture-guard hook. Photo upload/serve/delete mirrors routes-privacy.js:
// bytes on QNAP Claude_Data\People_Photos, DELETE tunnels via LXC-104 SSH
// (Windows `claude` SMB user can't delete on that share — QNAP ACL quirk).
//
// Endpoints:
//   GET/POST/PATCH/DELETE /api/people[/:id]      directory CRUD (search via ?q=&category=)
//   GET  /api/people/relations?person_id=         edges of a person (or all)
//   POST /api/people/relations                    add an edge (idempotent)
//   DELETE /api/people/relations/:id              remove an edge
//   POST /api/people/:id/photo                    upload/replace photo (multipart file)
//   GET  /api/people/:id/photo                    stream the photo

const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { NodeSSH } = require('node-ssh');

const PHOTO_ROOT  = '\\\\192.168.1.155\\Claude_Data\\People_Photos';
const PHOTO_LINUX = '/mnt/qnap-claude/People_Photos';   // LXC 104 view of the same share
const SSH_HOST = '192.168.1.227';
const SSH_USER = 'root';
const SSH_KEY  = process.env.SSH_KEY_PATH || os.homedir() + '/.ssh/id_ed25519';

try { fs.mkdirSync(PHOTO_ROOT, { recursive: true }); }
catch (e) { console.error('[people] photo storage root unreachable:', e.message); }

const photoUpload = multer({ dest: path.join(os.tmpdir(), 'people-photo-uploads'), limits: { fileSize: 25 * 1024 * 1024 } });

const _san  = (s) => String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const _trim = (s) => (s == null ? null : (String(s).trim() || null));
const _num  = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
const _int  = (v) => (v === '' || v == null || isNaN(parseInt(v)) ? null : parseInt(v));
const _err  = (res, e) => { console.error('[people]', e.message); res.status(500).json({ error: e.message }); };

async function _sshRm(linuxPath) {
  if (!linuxPath || /[\n;]/.test(linuxPath)) return;
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: SSH_HOST, username: SSH_USER, privateKeyPath: SSH_KEY });
    await ssh.execCommand(`rm -f "${linuxPath.replace(/"/g, '\\"')}"`);
  } finally { ssh.dispose(); }
}

// columns a client may set on create/update (photo is set only via the photo endpoint)
const COLS = ['given_name', 'family_name', 'maiden_name', 'category', 'gender', 'birth_date', 'death_date',
  'phone', 'email', 'address', 'relationship_to_me', 'origin_place', 'origin_country', 'lat', 'lon', 'notes',
  'tags', 'household_user_id', 'pos_x', 'pos_y'];
const DATE_COLS = new Set(['birth_date', 'death_date']);
const NUM_COLS  = new Set(['lat', 'lon', 'pos_x', 'pos_y']);
const coerce = (k, v) => {
  if (k === 'household_user_id') return _int(v);
  if (NUM_COLS.has(k)) return _num(v);
  if (DATE_COLS.has(k)) return _trim(v);          // 'YYYY-MM-DD' or null; cast in SQL
  if (k === 'category') return (String(v || '').trim() || 'other');
  if (k === 'tags') return JSON.stringify(Array.isArray(v) ? v : []);
  return _trim(v);
};

module.exports = (app, db) => {
  const SELECT = `SELECT p.*, h.name AS member_name FROM people p
                    LEFT JOIN household_users h ON h.id = p.household_user_id`;

  // ── Directory list (optional ?q= free-text + ?category=) ──
  app.get('/api/people', async (req, res) => {
    try {
      const conds = [], params = [];
      if (req.query.category) { params.push(req.query.category); conds.push(`p.category = $${params.length}`); }
      if (req.query.q) {
        params.push('%' + String(req.query.q).trim() + '%');
        const n = params.length;
        conds.push(`(coalesce(p.given_name,'')||' '||coalesce(p.family_name,'')||' '||coalesce(p.maiden_name,'')
                     ||' '||coalesce(p.relationship_to_me,'')||' '||coalesce(p.notes,'')||' '||coalesce(p.origin_place,'')
                     ) ILIKE $${n}`);
      }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const r = await db.query(`${SELECT} ${where} ORDER BY p.family_name NULLS LAST, p.given_name NULLS LAST, p.id`, params);
      res.json(r.rows);
    } catch (e) { _err(res, e); }
  });

  // ── Relations (registered BEFORE /:id routes so 'relations' isn't seen as an id) ──
  app.get('/api/people/relations', async (req, res) => {
    try {
      const pid = _int(req.query.person_id);
      const r = pid
        ? await db.query('SELECT * FROM people_relations WHERE from_person_id=$1 OR to_person_id=$1 ORDER BY id', [pid])
        : await db.query('SELECT * FROM people_relations ORDER BY id');
      res.json(r.rows);
    } catch (e) { _err(res, e); }
  });
  app.post('/api/people/relations', async (req, res) => {
    try {
      const b = req.body || {};
      const from = _int(b.from_person_id), to = _int(b.to_person_id), rel = _trim(b.rel_type);
      if (!from || !to || !rel) return res.status(400).json({ error: 'from_person_id, to_person_id, rel_type required' });
      if (from === to) return res.status(400).json({ error: 'cannot relate a person to themselves' });
      const r = await db.query(
        `INSERT INTO people_relations (from_person_id, to_person_id, rel_type, notes)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (from_person_id, to_person_id, rel_type) DO UPDATE SET notes = EXCLUDED.notes
         RETURNING *`, [from, to, rel, _trim(b.notes)]);
      res.json(r.rows[0]);
    } catch (e) { _err(res, e); }
  });
  app.delete('/api/people/relations/:id', async (req, res) => {
    try { await db.query('DELETE FROM people_relations WHERE id=$1', [parseInt(req.params.id)]); res.json({ ok: true }); }
    catch (e) { _err(res, e); }
  });

  // ── Bulk position save (auto-arrange) — one UPDATE for the whole set ──
  // Registered BEFORE /:id so 'positions' isn't parsed as an id.
  app.post('/api/people/positions', async (req, res) => {
    try {
      const list = Array.isArray((req.body || {}).positions) ? req.body.positions : [];
      const rows = list.map(p => ({ id: _int(p.id), px: _num(p.pos_x), py: _num(p.pos_y) }))
                       .filter(p => p.id != null && p.px != null && p.py != null);
      if (!rows.length) return res.json({ ok: true, updated: 0 });
      const vals = [], ph = [];
      rows.forEach((p, i) => { const b = i * 3; ph.push(`($${b + 1}::int,$${b + 2}::numeric,$${b + 3}::numeric)`); vals.push(p.id, p.px, p.py); });
      await db.query(
        `UPDATE people AS t SET pos_x = v.px, pos_y = v.py, updated_at = now()
           FROM (VALUES ${ph.join(',')}) AS v(id, px, py) WHERE t.id = v.id`, vals);
      res.json({ ok: true, updated: rows.length });
    } catch (e) { _err(res, e); }
  });

  // ── Create a person ──
  app.post('/api/people', async (req, res) => {
    try {
      const b = req.body || {};
      const cols = [], vals = [], ph = [];
      for (const k of COLS) {
        if (!(k in b) && k !== 'category') continue;
        cols.push(k); vals.push(coerce(k, b[k]));
        ph.push(DATE_COLS.has(k) ? `$${vals.length}::date` : (k === 'tags' ? `$${vals.length}::jsonb` : `$${vals.length}`));
      }
      if (!cols.includes('category')) { cols.push('category'); vals.push('other'); ph.push(`$${vals.length}`); }
      const r = await db.query(
        `INSERT INTO people (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING id`, vals);
      const row = await db.query(`${SELECT} WHERE p.id=$1`, [r.rows[0].id]);
      res.json(row.rows[0]);
    } catch (e) { _err(res, e); }
  });

  // ── Photo upload/replace (multipart 'file') ──
  app.post('/api/people/:id/photo', photoUpload.single('file'), async (req, res) => {
    const tmp = req.file && req.file.path;
    try {
      const id = parseInt(req.params.id);
      if (!req.file) return res.status(400).json({ error: 'no file' });
      const cur = await db.query('SELECT photo FROM people WHERE id=$1', [id]);
      if (!cur.rows.length) return res.status(404).json({ error: 'person not found' });
      const ext = (path.extname(req.file.originalname || '') || '.jpg').toLowerCase().slice(0, 8);
      const filename = `${id}__${_san(req.body.name || 'photo')}${ext}`;
      await fs.promises.copyFile(tmp, path.join(PHOTO_ROOT, filename));
      await db.query('UPDATE people SET photo=$1, updated_at=now() WHERE id=$2', [filename, id]);
      const old = cur.rows[0].photo;
      if (old && old !== filename) _sshRm(PHOTO_LINUX + '/' + old).catch(() => {});   // best-effort
      res.json({ ok: true, photo: filename });
    } catch (e) { _err(res, e); }
    finally { if (tmp) fs.promises.unlink(tmp).catch(() => {}); }
  });

  // ── Serve a photo (inline) ──
  app.get('/api/people/:id/photo', async (req, res) => {
    try {
      const r = await db.query('SELECT photo FROM people WHERE id=$1', [parseInt(req.params.id)]);
      const f = r.rows[0] && r.rows[0].photo;
      if (!f || /[\\/]/.test(f) || f.includes('..')) return res.status(404).end();
      const abs = path.join(PHOTO_ROOT, f);
      if (!fs.existsSync(abs)) return res.status(404).end();
      const ext = path.extname(f).toLowerCase();
      res.setHeader('Content-Type', ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg');
      fs.createReadStream(abs).pipe(res);
    } catch (e) { _err(res, e); }
  });

  // ── Update a person (dynamic whitelist, like routes-places / household-users) ──
  app.patch('/api/people/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], vals = [];
      for (const k of COLS) {
        if (!(k in b)) continue;
        vals.push(coerce(k, b[k]));
        sets.push(DATE_COLS.has(k) ? `${k}=$${vals.length}::date` : (k === 'tags' ? `${k}=$${vals.length}::jsonb` : `${k}=$${vals.length}`));
      }
      if (!sets.length) return res.json({ ok: true });
      vals.push(parseInt(req.params.id));
      await db.query(`UPDATE people SET ${sets.join(',')}, updated_at=now() WHERE id=$${vals.length}`, vals);
      res.json({ ok: true });
    } catch (e) { _err(res, e); }
  });

  // ── Delete a person (relations CASCADE; also remove the photo file) ──
  app.delete('/api/people/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const cur = await db.query('SELECT photo FROM people WHERE id=$1', [id]);
      await db.query('DELETE FROM people WHERE id=$1', [id]);
      const f = cur.rows[0] && cur.rows[0].photo;
      if (f && !/[\\/]/.test(f)) _sshRm(PHOTO_LINUX + '/' + f).catch(() => {});   // best-effort
      res.json({ ok: true });
    } catch (e) { _err(res, e); }
  });
};
