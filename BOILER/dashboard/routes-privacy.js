// Privacy page — Sites CRM + per-site documents (encrypted or plain).
//
// Own module (wired from server.js via one require line) so server.js stays
// free of new handlers (architecture-guard hook). Mirrors the Medical Documents
// storage pattern: file bytes live on QNAP (Claude_Data\Privacy_Site_Docs),
// metadata in Postgres; DELETE tunnels through LXC 104 SSH because the
// Windows-side `claude` SMB user can't delete on that share (QNAP ACL quirk).
//
// CRYPTO: the server is BLIND. For encrypted docs the browser does all AES-GCM
// (PBKDF2-SHA256 600k, client-side) — it uploads ciphertext + an encrypted
// filename; this module only stores/serves opaque blobs. The Documents password
// is never sent. privacy_doc_crypto holds only the KDF salt + a verifier blob.
//
// Endpoints:
//   GET/POST/PATCH/DELETE /api/privacy/sites[/:id]
//   GET  /api/privacy/crypto              KDF salt + verifier (or {setup:false})
//   POST /api/privacy/crypto              first-time set salt+verifier (browser-generated)
//   GET  /api/privacy/sites/:id/docs      list doc metadata
//   POST /api/privacy/sites/:id/docs      upload (multipart file + meta)
//   GET  /api/privacy/docs/:id/file       stream stored bytes (cipher or plain)
//   PATCH/DELETE /api/privacy/docs/:id    rename / delete

const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { NodeSSH } = require('node-ssh');
const { execFile } = require('child_process');

const DOCS_ROOT  = '\\\\192.168.1.155\\Claude_Data\\Privacy_Site_Docs';
const DOCS_LINUX = '/mnt/qnap-claude/Privacy_Site_Docs';   // LXC 104 view of same share
const EMAIL_AGENT = process.env.EMAIL_AGENT_URL || 'http://192.168.1.162:8780';  // LXC 110 (receipt PDFs)
const SSH_HOST = '192.168.1.227';
const SSH_USER = 'root';
const SSH_KEY  = process.env.SSH_KEY_PATH || os.homedir() + '/.ssh/id_ed25519';

try { fs.mkdirSync(DOCS_ROOT, { recursive: true }); }
catch (e) { console.error('[privacy] docs storage root unreachable:', e.message); }

// Local encrypted mirror of the Budget workbook — written on every save, picked
// up by the "Privacy Budget" Windows backup job (Project Health → LXC 104) and
// copied to QNAP. CIPHERTEXT ONLY (same blob stored in privacy_sheets).
const BUDGET_MIRROR_DIR  = process.env.BUDGET_MIRROR_DIR || 'C:\\Users\\muroc\\PrivacyBackup';
const BUDGET_MIRROR_FILE = path.join(BUDGET_MIRROR_DIR, 'privacy_budget.json');
try { fs.mkdirSync(BUDGET_MIRROR_DIR, { recursive: true }); }
catch (e) { console.error('[privacy] budget mirror dir unreachable:', e.message); }

// 30 MB cap (25 MB user files + AES-GCM/header overhead headroom).
const docUpload = multer({
  dest: path.join(os.tmpdir(), 'privacy-doc-uploads'),
  limits: { fileSize: 30 * 1024 * 1024 },
});

const _san = (s) => String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const _trim = (s) => (s == null ? null : String(s).trim() || null);
const _err = (res, e) => { console.error('[privacy]', e.message); res.status(500).json({ error: e.message }); };

async function _sshRm(linuxPaths) {
  const list = (Array.isArray(linuxPaths) ? linuxPaths : [linuxPaths]).filter(Boolean);
  if (!list.length) return;
  const ssh = new NodeSSH();
  await ssh.connect({ host: SSH_HOST, username: SSH_USER, privateKeyPath: SSH_KEY });
  for (const p of list) {
    if (/[\n;]/.test(p)) continue;
    await ssh.execCommand(`rm -f "${p.replace(/"/g, '\\"')}"`);
  }
  ssh.dispose();
}

// File a receipt's original PDF into the site's Docs window. LXC 110 has no QNAP
// access, so the dashboard pulls the PDF bytes from the Email Agent and writes them
// to DOCS_ROOT + a plain kind='receipt' privacy_site_docs row, linked back via doc_id.
async function _fileReceiptPdf(db, r) {
  if (!r.gmail_id) return null;
  const resp = await fetch(`${EMAIL_AGENT}/api/email/attachment/${encodeURIComponent(r.gmail_id)}`);
  if (!resp.ok) throw new Error('agent attachment ' + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  const nm = (`Receipt ${r.vendor || ''} ${r.invoice_no || ''}`).replace(/\s+/g, ' ').trim() || 'Receipt';
  const ins = await db.query(
    `INSERT INTO privacy_site_docs (site_id, encrypted, kind, doc_name, file_path, mime_type, file_size)
     VALUES ($1, false, 'receipt', $2, '', 'application/pdf', $3) RETURNING id`,
    [r.site_id, nm, buf.length]);
  const docId = ins.rows[0].id;
  const filename = `${docId}__receipt.pdf`;
  await fs.promises.writeFile(path.join(DOCS_ROOT, filename), buf);
  await db.query('UPDATE privacy_site_docs SET file_path = $1 WHERE id = $2', [filename, docId]);
  await db.query('UPDATE privacy_site_receipts SET doc_id = $1 WHERE id = $2', [docId, r.id]);
  return docId;
}

module.exports = function (app, db) {
  // ── Sites CRM ──────────────────────────────────────────────────────────────
  app.get('/api/privacy/sites', async (_req, res) => {
    try {
      const r = await db.query(`
        SELECT s.id, s.kind, s.name, s.main_tel, s.add_tels, s.fax, s.email,
               s.website, s.vault_item, s.notes,
               s.next_appointment_at, s.next_appointment_note, s.reminder_text,
               (SELECT COUNT(*) FROM privacy_site_docs d WHERE d.site_id = s.id) AS doc_count,
               (SELECT COUNT(*) FROM privacy_site_receipts rc WHERE rc.site_id = s.id) AS receipt_count,
               (SELECT COALESCE(SUM(rc.amount),0) FROM privacy_site_receipts rc WHERE rc.site_id = s.id) AS receipt_total
          FROM privacy_sites s
         ORDER BY s.sort_order ASC NULLS LAST, s.kind NULLS LAST, s.name`);
      res.json(r.rows);
    } catch (e) { _err(res, e); }
  });

  // Drag-to-reorder: persist the new card order (sort_order = position).
  app.post('/api/privacy/sites/reorder', async (req, res) => {
    try {
      const order = (req.body && req.body.order) || [];
      if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order array required' });
      for (let i = 0; i < order.length; i++) {
        await db.query('UPDATE privacy_sites SET sort_order = $1 WHERE id = $2', [i, parseInt(order[i])]);
      }
      res.json({ ok: true });
    } catch (e) { _err(res, e); }
  });

  app.post('/api/privacy/sites', async (req, res) => {
    try {
      const b = req.body || {};
      if (!_trim(b.name)) return res.status(400).json({ error: 'name required' });
      const tels = Array.isArray(b.add_tels) ? b.add_tels : [];
      const r = await db.query(`
        INSERT INTO privacy_sites (kind, name, main_tel, add_tels, fax, email, website, vault_item, notes,
                                   next_appointment_at, next_appointment_note, reminder_text)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [_trim(b.kind), _trim(b.name), _trim(b.main_tel), JSON.stringify(tels),
         _trim(b.fax), _trim(b.email), _trim(b.website), _trim(b.vault_item), _trim(b.notes),
         _trim(b.next_appointment_at), _trim(b.next_appointment_note), _trim(b.reminder_text)]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { _err(res, e); }
  });

  app.patch('/api/privacy/sites/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (b.kind !== undefined)       add('kind', _trim(b.kind));
      if (b.name !== undefined)       add('name', _trim(b.name));
      if (b.main_tel !== undefined)   add('main_tel', _trim(b.main_tel));
      if (b.add_tels !== undefined)   { params.push(JSON.stringify(Array.isArray(b.add_tels) ? b.add_tels : [])); sets.push(`add_tels = $${params.length}::jsonb`); }
      if (b.fax !== undefined)        add('fax', _trim(b.fax));
      if (b.email !== undefined)      add('email', _trim(b.email));
      if (b.website !== undefined)    add('website', _trim(b.website));
      if (b.vault_item !== undefined) add('vault_item', _trim(b.vault_item));
      if (b.notes !== undefined)      add('notes', _trim(b.notes));
      if (b.next_appointment_at !== undefined)   add('next_appointment_at', _trim(b.next_appointment_at));
      if (b.next_appointment_note !== undefined) add('next_appointment_note', _trim(b.next_appointment_note));
      if (b.reminder_text !== undefined)         add('reminder_text', _trim(b.reminder_text));
      if (!sets.length) return res.status(400).json({ error: 'no fields' });
      sets.push('updated_at = NOW()');
      params.push(parseInt(req.params.id));
      await db.query(`UPDATE privacy_sites SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      res.json({ ok: true });
    } catch (e) { _err(res, e); }
  });

  app.delete('/api/privacy/sites/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const docs = await db.query('SELECT file_path FROM privacy_site_docs WHERE site_id = $1', [id]);
      const paths = docs.rows.map(r => r.file_path).filter(fp => fp && !/[\\/]/.test(fp)).map(fp => DOCS_LINUX + '/' + fp);
      try { await _sshRm(paths); } catch (e) { console.error('[privacy] site delete file cleanup:', e.message); }
      await db.query('DELETE FROM privacy_sites WHERE id = $1', [id]);  // cascade removes doc rows
      res.json({ ok: true });
    } catch (e) { _err(res, e); }
  });

  // ── Documents-password crypto setup (server holds salt+verifier only) ──────
  app.get('/api/privacy/crypto', async (_req, res) => {
    try {
      const r = await db.query('SELECT salt, verifier, verifier_iv, kdf_iters FROM privacy_doc_crypto WHERE id = 1');
      if (!r.rows.length) return res.json({ setup: false });
      res.json({ setup: true, ...r.rows[0] });
    } catch (e) { _err(res, e); }
  });

  app.post('/api/privacy/crypto', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.salt || !b.verifier || !b.verifier_iv) return res.status(400).json({ error: 'salt, verifier, verifier_iv required' });
      const exists = await db.query('SELECT 1 FROM privacy_doc_crypto WHERE id = 1');
      if (exists.rows.length) return res.status(409).json({ error: 'Documents password already set' });
      await db.query(
        `INSERT INTO privacy_doc_crypto (id, salt, verifier, verifier_iv, kdf_iters) VALUES (1,$1,$2,$3,$4)`,
        [b.salt, b.verifier, b.verifier_iv, parseInt(b.kdf_iters) || 600000]);
      res.json({ ok: true });
    } catch (e) { _err(res, e); }
  });

  // ── Budget spreadsheet (server-blind, singleton) ────────────────────────────
  // Stores only ciphertext + IV. Browser encrypts/decrypts with the Documents
  // password (same privacy_doc_crypto salt/verifier the docs use).
  app.get('/api/privacy/sheet', async (_req, res) => {
    try {
      const r = await db.query(
        `SELECT enc_data, enc_iv,
                to_char(updated_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') AS updated_at
           FROM privacy_sheets WHERE id = 1`);
      if (!r.rows.length) return res.json({ enc_data: null, enc_iv: null, updated_at: null });
      res.json(r.rows[0]);
    } catch (e) { _err(res, e); }
  });

  app.post('/api/privacy/sheet', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.enc_data || !b.enc_iv) return res.status(400).json({ error: 'enc_data, enc_iv required' });
      await db.query(
        `INSERT INTO privacy_sheets (id, enc_data, enc_iv, updated_at)
         VALUES (1, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET enc_data = EXCLUDED.enc_data, enc_iv = EXCLUDED.enc_iv, updated_at = now()`,
        [b.enc_data, b.enc_iv]);
      // best-effort encrypted mirror to disk for the Windows backup (ciphertext only)
      try {
        fs.writeFileSync(BUDGET_MIRROR_FILE, JSON.stringify({ enc_data: b.enc_data, enc_iv: b.enc_iv, updated_at: new Date().toISOString() }));
      } catch (e) { console.error('[privacy] budget mirror write failed:', e.message); }
      res.json({ ok: true });
    } catch (e) { _err(res, e); }
  });

  // Budget backup status — last home (QNAP via Windows backup) + cloud (Drive) times.
  app.get('/api/privacy/budget-backup-status', async (_req, res) => {
    try {
      const home = await db.query(
        `SELECT to_char(MAX(started_at) AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS last_ok
           FROM backup_log
          WHERE status='ok' AND job_id = (SELECT id FROM backup_jobs WHERE name='Privacy Budget' LIMIT 1)`);
      const cloud = await db.query(`SELECT value FROM dashboard_settings WHERE key='privacy.cloud_backup'`);
      const cloudLast = cloud.rows.length && cloud.rows[0].value ? (cloud.rows[0].value.last_ok || null) : null;
      res.json({
        home_last_ok: (home.rows[0] && home.rows[0].last_ok) || null,
        cloud_last_ok: cloudLast,
        drive_folder_url: 'https://drive.google.com/drive/folders/1qNvSXmwv8iNg7FlOmNUvDcATrvbGDWZT',
      });
    } catch (e) { _err(res, e); }
  });

  // Project-folder backup status — last home (QNAP "Claude Project Folder") +
  // cloud (encrypted Drive) times. Surfaced on Project Health → Backup Storages.
  app.get('/api/privacy/project-backup-status', async (_req, res) => {
    try {
      const home = await db.query(
        `SELECT to_char(MAX(started_at) AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') AS last_ok
           FROM backup_log
          WHERE status='ok' AND job_id = (SELECT id FROM backup_jobs WHERE name='Claude Project Folder' LIMIT 1)`);
      const cloud = await db.query(`SELECT value FROM dashboard_settings WHERE key='privacy.project_backup'`);
      const cloudLast = cloud.rows.length && cloud.rows[0].value ? (cloud.rows[0].value.last_ok || null) : null;
      res.json({
        home_last_ok: (home.rows[0] && home.rows[0].last_ok) || null,
        cloud_last_ok: cloudLast,
        drive_folder_url: 'https://drive.google.com/drive/folders/1mBtDGPyJV1VhWMwlNpcYVx-7apKQevie',
      });
    } catch (e) { _err(res, e); }
  });

  // ── Documents ──────────────────────────────────────────────────────────────
  app.get('/api/privacy/sites/:id/docs', async (req, res) => {
    try {
      const r = await db.query(
        `SELECT id, encrypted, kind, url, doc_name, enc_name, name_iv, file_iv, mime_type, file_size,
                to_char(created_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') AS created_at
           FROM privacy_site_docs WHERE site_id = $1 ORDER BY created_at DESC`, [parseInt(req.params.id)]);
      res.json(r.rows);
    } catch (e) { _err(res, e); }
  });

  // Upload. multipart: `file` (already ciphertext if encrypted) + `meta` JSON.
  app.post('/api/privacy/sites/:id/docs', docUpload.single('file'), async (req, res) => {
    let tmp = null;
    try {
      if (!req.file) return res.status(400).json({ error: 'file required' });
      tmp = req.file.path;
      let m = {};
      try { m = JSON.parse(req.body.meta || '{}'); } catch { return res.status(400).json({ error: 'meta must be JSON' }); }
      const siteId = parseInt(req.params.id);
      const encrypted = !!m.encrypted;
      if (encrypted && (!m.enc_name || !m.name_iv || !m.file_iv)) {
        return res.status(400).json({ error: 'encrypted docs need enc_name, name_iv, file_iv' });
      }
      if (!encrypted && !_trim(m.doc_name)) return res.status(400).json({ error: 'doc_name required for plain docs' });

      const ins = await db.query(
        `INSERT INTO privacy_site_docs (site_id, encrypted, doc_name, enc_name, name_iv, file_path, file_iv, mime_type, file_size)
         VALUES ($1,$2,$3,$4,$5,'',$6,$7,$8) RETURNING id`,
        [siteId, encrypted, encrypted ? null : _trim(m.doc_name), encrypted ? m.enc_name : null,
         encrypted ? m.name_iv : null, encrypted ? m.file_iv : null,
         encrypted ? null : _trim(m.mime_type), req.file.size]);
      const id = ins.rows[0].id;
      const filename = `${id}__${encrypted ? 'enc' : _san(m.doc_name)}.bin`;
      await fs.promises.copyFile(tmp, path.join(DOCS_ROOT, filename));
      await db.query('UPDATE privacy_site_docs SET file_path = $1 WHERE id = $2', [filename, id]);
      res.json({ ok: true, id });
    } catch (e) { _err(res, e); }
    finally { if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} } }
  });

  // Add a plain LINK (e.g. a Google Drive URL) — no file, no encryption.
  // Stored as a kind='link' row in the same docs table so it shows in the
  // Docs window alongside files. file_path='' (no file → DELETE skips QNAP rm).
  app.post('/api/privacy/sites/:id/links', async (req, res) => {
    try {
      const b = req.body || {};
      const name = _trim(b.name);
      const url = _trim(b.url);
      if (!name || !url) return res.status(400).json({ error: 'name and url required' });
      const ins = await db.query(
        `INSERT INTO privacy_site_docs (site_id, encrypted, kind, doc_name, url, file_path)
         VALUES ($1, false, 'link', $2, $3, '') RETURNING id`,
        [parseInt(req.params.id), name, url]);
      res.json({ ok: true, id: ins.rows[0].id });
    } catch (e) { _err(res, e); }
  });

  // Add a PATH (e.g. \\192.168.1.155\share\contract.pdf) — a pointer to where a
  // document physically lives, no upload. Stored as kind='path' in the same docs
  // table; the path goes in the `url` column, file_path='' (no file → DELETE skips
  // the QNAP rm, file-serve rejects it). Plaintext like a link — no encryption.
  app.post('/api/privacy/sites/:id/paths', async (req, res) => {
    try {
      const b = req.body || {};
      const name = _trim(b.name);
      const p = _trim(b.path);
      if (!name || !p) return res.status(400).json({ error: 'name and path required' });
      const ins = await db.query(
        `INSERT INTO privacy_site_docs (site_id, encrypted, kind, doc_name, url, file_path)
         VALUES ($1, false, 'path', $2, $3, '') RETURNING id`,
        [parseInt(req.params.id), name, p]);
      res.json({ ok: true, id: ins.rows[0].id });
    } catch (e) { _err(res, e); }
  });

  app.get('/api/privacy/docs/:id/file', async (req, res) => {
    try {
      const r = await db.query('SELECT encrypted, doc_name, file_path, mime_type FROM privacy_site_docs WHERE id = $1', [parseInt(req.params.id)]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      const d = r.rows[0];
      if (!d.file_path || /[\\/]/.test(d.file_path)) return res.status(400).json({ error: 'bad file_path' });
      const abs = path.join(DOCS_ROOT, d.file_path);
      if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file missing on storage' });
      // Encrypted -> opaque octet-stream (browser decrypts). Plain -> its mime.
      res.setHeader('Content-Type', d.encrypted ? 'application/octet-stream' : (d.mime_type || 'application/octet-stream'));
      fs.createReadStream(abs).pipe(res);
    } catch (e) { _err(res, e); }
  });

  // Open a PATH doc on the Windows HOST (this dashboard runs on the laptop).
  // explorer.exe launches a file with its default app, or opens a folder — works
  // for local + UNC (\\server\share) paths. The path is passed as a SINGLE arg
  // (no shell) so it can't inject commands. explorer.exe returns exit 1 even on
  // success, so the spawn error is ignored. Only kind='path' rows are openable.
  app.post('/api/privacy/docs/:id/open', async (req, res) => {
    try {
      const r = await db.query('SELECT kind, url FROM privacy_site_docs WHERE id = $1', [parseInt(req.params.id)]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      const d = r.rows[0];
      if (d.kind !== 'path' || !_trim(d.url)) return res.status(400).json({ error: 'not a path document' });
      execFile('explorer.exe', [d.url], () => {});   // fire-and-forget (exit code is meaningless)
      res.json({ ok: true });
    } catch (e) { _err(res, e); }
  });

  // Rename: plain -> doc_name; encrypted -> enc_name + name_iv.
  app.patch('/api/privacy/docs/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (b.doc_name !== undefined) add('doc_name', _trim(b.doc_name));
      if (b.url      !== undefined) add('url', _trim(b.url));
      if (b.enc_name !== undefined) add('enc_name', b.enc_name);
      if (b.name_iv  !== undefined) add('name_iv', b.name_iv);
      if (!sets.length) return res.status(400).json({ error: 'no fields' });
      params.push(parseInt(req.params.id));
      await db.query(`UPDATE privacy_site_docs SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      res.json({ ok: true });
    } catch (e) { _err(res, e); }
  });

  app.delete('/api/privacy/docs/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const r = await db.query('SELECT file_path FROM privacy_site_docs WHERE id = $1', [id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      const fp = r.rows[0].file_path;
      if (fp && !/[\\/]/.test(fp)) { try { await _sshRm(DOCS_LINUX + '/' + fp); } catch (e) { console.error('[privacy] doc rm:', e.message); } }
      await db.query('DELETE FROM privacy_site_docs WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (e) { _err(res, e); }
  });

  // ── Receipts (per site) ─────────────────────────────────────────────────────
  // Structured receipt rows (vendor/amount/invoice_date) written by the Email Agent;
  // the original PDF is lazily filed into the site's Docs window on first view.
  app.get('/api/privacy/sites/:id/receipts', async (req, res) => {
    try {
      const siteId = parseInt(req.params.id);
      // file any not-yet-filed PDFs (best-effort; a missing/deleted email is skipped)
      const pend = await db.query(
        `SELECT id, site_id, gmail_id, vendor, invoice_no, invoice_date
           FROM privacy_site_receipts
          WHERE site_id = $1 AND doc_id IS NULL AND gmail_id IS NOT NULL`, [siteId]);
      for (const r of pend.rows) {
        try { await _fileReceiptPdf(db, r); }
        catch (e) { console.error('[privacy] receipt pdf file:', e.message); }
      }
      const r = await db.query(
        `SELECT rc.id, rc.vendor, rc.amount, rc.currency, rc.invoice_no, rc.gmail_id, rc.doc_id,
                to_char(rc.invoice_date, 'YYYY-MM-DD') AS invoice_date,
                to_char(rc.created_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') AS created_at
           FROM privacy_site_receipts rc
          WHERE rc.site_id = $1
          ORDER BY rc.invoice_date DESC NULLS LAST, rc.created_at DESC`, [siteId]);
      const total = r.rows.reduce((s, x) => s + (parseFloat(x.amount) || 0), 0);
      // per-vendor chart grouping (yearly|monthly|daily), set by /create-email-rule; default monthly
      let chart_period = 'monthly';
      try {
        const cp = await db.query("SELECT value FROM dashboard_settings WHERE key = 'privacy.chart_periods'");
        const m = (cp.rows[0] && cp.rows[0].value) || {};
        if (m[String(siteId)]) chart_period = m[String(siteId)];
      } catch (_) {}
      res.json({ rows: r.rows, total: Math.round(total * 100) / 100, chart_period });
    } catch (e) { _err(res, e); }
  });

  // Delete a receipt (and its filed PDF doc, if any).
  app.delete('/api/privacy/receipts/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const r = await db.query('SELECT doc_id FROM privacy_site_receipts WHERE id = $1', [id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      const docId = r.rows[0].doc_id;
      await db.query('DELETE FROM privacy_site_receipts WHERE id = $1', [id]);
      if (docId) {
        const d = await db.query('SELECT file_path FROM privacy_site_docs WHERE id = $1', [docId]);
        if (d.rows.length) {
          const fp = d.rows[0].file_path;
          if (fp && !/[\\/]/.test(fp)) { try { await _sshRm(DOCS_LINUX + '/' + fp); } catch (e) { console.error('[privacy] receipt doc rm:', e.message); } }
          await db.query('DELETE FROM privacy_site_docs WHERE id = $1', [docId]);
        }
      }
      res.json({ ok: true });
    } catch (e) { _err(res, e); }
  });
};
