// Privacy page — Sites CRM + per-site documents (client-side encrypted/plain).
//
// ALL crypto is here, in the browser. The Documents password never leaves this
// page: PBKDF2-SHA256 (600k) derives an AES-256-GCM key; files + filenames are
// encrypted/decrypted locally. The server only stores opaque ciphertext + the
// KDF salt + a verifier blob. Forget the password = encrypted docs are
// unrecoverable (that's the privacy guarantee).

const PV_VERIFY_TOKEN = 'privacy-vault-verify-v1';
let _pvSites = [];
let _pvCrypto = null;        // {setup, salt, verifier, verifier_iv, kdf_iters}
let _pvKey = null;           // unlocked AES-GCM CryptoKey (session only), or null
let _pvDocSite = null;       // site whose Docs modal is open

// ── base64 <-> bytes ─────────────────────────────────────────────
function _b64(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
function _unb64(s) { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }

// ── crypto primitives ────────────────────────────────────────────
async function _pvDeriveKey(password, saltBytes, iters) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: iters, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function _pvEncBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: _b64(iv), ct };
}
async function _pvDecBytes(key, ivB64, ctBuf) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: _unb64(ivB64) }, key, ctBuf);
}
async function _pvEncStr(key, str) {
  const e = await _pvEncBytes(key, new TextEncoder().encode(str));
  return { iv: e.iv, ct: _b64(e.ct) };
}
async function _pvDecStr(key, ivB64, ctB64) {
  const buf = await _pvDecBytes(key, ivB64, _unb64(ctB64));
  return new TextDecoder().decode(buf);
}

// ── tab + refresh ────────────────────────────────────────────────
function showTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (btn) btn.classList.add('active');
}
async function pvRefresh() { await pvLoadCrypto(); await pvLoadSites(); pvRenderLockState(); }
window.addEventListener('DOMContentLoaded', pvRefresh);

async function pvLoadCrypto() {
  try { _pvCrypto = await (await fetch('/api/privacy/crypto')).json(); } catch (e) { _pvCrypto = { setup: false }; }
}
function pvRenderLockState() {
  const el = document.getElementById('pv-lock-state');
  if (!el) return;
  if (!_pvCrypto || !_pvCrypto.setup) { el.innerHTML = '🔓 no Documents password set yet'; return; }
  el.innerHTML = _pvKey
    ? '🔓 Docs unlocked <a href="#" onclick="pvLock();return false;" style="margin-left:6px;">Lock</a>'
    : '🔒 Docs locked';
}
function pvLock() { _pvKey = null; pvRenderLockState(); if (_pvDocSite) pvRenderDocs(); }

// ── Sites CRM ────────────────────────────────────────────────────
async function pvLoadSites() {
  try { _pvSites = await (await fetch('/api/privacy/sites')).json(); } catch (e) { _pvSites = []; }
  pvRenderSites();
}
function pvRenderSites() {
  const host = document.getElementById('pv-sites-list');
  if (!host) return;
  const q = (document.getElementById('pv-filter').value || '').toLowerCase();
  const rows = _pvSites.filter(s => !q || (s.name + ' ' + (s.kind || '')).toLowerCase().includes(q));
  if (!rows.length) { host.innerHTML = '<div style="color:#aaa;">No sites yet — click “+ Add site”.</div>'; return; }
  host.innerHTML = rows.map(s => {
    const tels = (s.add_tels || []).map(t => `<div style="font-size:0.78rem;color:#666;">📞 ${_esc(t.tel || '')}${t.person ? ' — ' + _esc(t.person) : ''}</div>`).join('');
    const link = (u, t) => u ? `<a href="${_esc(u)}" ${t === 'web' ? 'target="_blank"' : ''}>${_esc(u)}</a>` : '<span style="color:#bbb;">—</span>';
    return `<div class="card" style="margin-bottom:8px; padding:10px 12px;">
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
        <div style="flex:1;">
          <div style="font-weight:600;">${s.kind ? `<span style="font-size:0.7rem;background:#eef;color:#447;padding:1px 6px;border-radius:8px;margin-right:6px;">${_esc(s.kind)}</span>` : ''}${_esc(s.name)}</div>
          <div style="display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:0.8rem; color:#555; margin-top:5px;">
            ${s.main_tel ? `<span>📞 Main</span><a href="tel:${_esc(s.main_tel)}">${_esc(s.main_tel)}</a>` : ''}
            ${s.fax ? `<span>📠 Fax</span><span>${_esc(s.fax)}</span>` : ''}
            ${s.email ? `<span>✉ Email</span><a href="mailto:${_esc(s.email)}">${_esc(s.email)}</a>` : ''}
            ${s.website ? `<span>🌐 Web</span>${link(s.website, 'web')}` : ''}
          </div>
          ${tels}
        </div>
        <div style="display:flex; flex-direction:column; gap:5px; align-items:flex-end;">
          <button class="btn btn-sm" style="background:#2563eb;color:#fff;width:120px;" onclick="pvOpenDocs(${s.id})">📄 Docs (${s.doc_count})</button>
          ${s.vault_item ? `<a class="btn btn-secondary btn-sm" style="width:120px;text-align:center;" href="https://192.168.1.196" target="_blank" title="Open Vaultwarden (item: ${_esc(s.vault_item)})">🔑 Vaultwarden</a>` : ''}
          <div style="display:flex; gap:5px;">
            <button class="btn btn-secondary btn-sm" onclick="pvEditSite(${s.id})">Edit</button>
            <button class="btn btn-secondary btn-sm" style="color:#c0392b;" onclick="pvDeleteSite(${s.id})">Del</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}
function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ── Site form ────────────────────────────────────────────────────
function pvOpenSiteForm(site) {
  document.getElementById('pv-site-modal-title').textContent = site ? 'Edit site' : 'Add site';
  document.getElementById('pv-site-id').value = site ? site.id : '';
  ['kind', 'name', 'main_tel', 'fax', 'email', 'website', 'vault_item', 'notes'].forEach(f =>
    document.getElementById('pv-f-' + f).value = site ? (site[f] || '') : '');
  document.getElementById('pv-tels').innerHTML = '';
  ((site && site.add_tels) || []).forEach(t => pvAddTelRow(t));
  document.getElementById('pv-site-modal').style.display = 'flex';
}
function pvCloseSiteForm() { document.getElementById('pv-site-modal').style.display = 'none'; }
function pvEditSite(id) { pvOpenSiteForm(_pvSites.find(s => s.id === id)); }
function pvAddTelRow(t) {
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:6px;';
  div.innerHTML = `<input class="pv-tel-num" placeholder="phone" value="${_esc(t && t.tel)}" style="flex:1;font-size:0.85rem;padding:4px 7px;">
    <input class="pv-tel-person" placeholder="person / label" value="${_esc(t && t.person)}" style="flex:1;font-size:0.85rem;padding:4px 7px;">
    <button class="btn btn-secondary btn-sm" onclick="this.parentElement.remove()">×</button>`;
  document.getElementById('pv-tels').appendChild(div);
}
async function pvSaveSite() {
  const id = document.getElementById('pv-site-id').value;
  const body = {};
  ['kind', 'name', 'main_tel', 'fax', 'email', 'website', 'vault_item', 'notes'].forEach(f => body[f] = document.getElementById('pv-f-' + f).value.trim());
  if (!body.name) { alert('Name is required'); return; }
  body.add_tels = [...document.querySelectorAll('#pv-tels > div')].map(d => ({
    tel: d.querySelector('.pv-tel-num').value.trim(), person: d.querySelector('.pv-tel-person').value.trim(),
  })).filter(t => t.tel || t.person);
  const url = id ? `/api/privacy/sites/${id}` : '/api/privacy/sites';
  const r = await fetch(url, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { alert('Save failed: ' + (await r.json()).error); return; }
  pvCloseSiteForm(); await pvLoadSites();
}
async function pvDeleteSite(id) {
  const s = _pvSites.find(x => x.id === id);
  if (!confirm(`Delete site "${s.name}" and its ${s.doc_count} document(s)? This cannot be undone.`)) return;
  await fetch(`/api/privacy/sites/${id}`, { method: 'DELETE' });
  await pvLoadSites();
}

// ── Password modal (promise-based) ───────────────────────────────
let _pvPwResolve = null, _pvPwMode = 'unlock';
function pvPromptPassword(mode) {
  _pvPwMode = mode;
  document.getElementById('pv-pw-title').textContent = mode === 'setup' ? 'Set a Documents password' : 'Unlock documents';
  document.getElementById('pv-pw-help').textContent = mode === 'setup'
    ? 'This one password protects ALL encrypted docs. Store it in Vaultwarden — if forgotten, encrypted docs are unrecoverable.'
    : 'Enter your Documents password to view/add encrypted documents.';
  document.getElementById('pv-pw-input').value = '';
  document.getElementById('pv-pw-input2').value = '';
  document.getElementById('pv-pw-input2').style.display = mode === 'setup' ? 'block' : 'none';
  document.getElementById('pv-pw-err').textContent = '';
  document.getElementById('pv-pw-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('pv-pw-input').focus(), 50);
  return new Promise(res => { _pvPwResolve = res; });
}
function pvPwCancel() { document.getElementById('pv-pw-modal').style.display = 'none'; if (_pvPwResolve) { _pvPwResolve(false); _pvPwResolve = null; } }
async function pvPwSubmit() {
  const pw = document.getElementById('pv-pw-input').value;
  const err = document.getElementById('pv-pw-err');
  if (!pw) { err.textContent = 'Enter a password'; return; }
  try {
    if (_pvPwMode === 'setup') {
      if (pw.length < 8) { err.textContent = 'Use at least 8 characters'; return; }
      if (pw !== document.getElementById('pv-pw-input2').value) { err.textContent = 'Passwords do not match'; return; }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await _pvDeriveKey(pw, salt, 600000);
      const v = await _pvEncStr(key, PV_VERIFY_TOKEN);
      const r = await fetch('/api/privacy/crypto', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salt: _b64(salt), verifier: v.ct, verifier_iv: v.iv, kdf_iters: 600000 }) });
      if (!r.ok) { err.textContent = 'Setup failed: ' + (await r.json()).error; return; }
      _pvKey = key; await pvLoadCrypto();
    } else {
      const key = await _pvDeriveKey(pw, _unb64(_pvCrypto.salt), _pvCrypto.kdf_iters);
      try {
        const tok = await _pvDecStr(key, _pvCrypto.verifier_iv, _pvCrypto.verifier);
        if (tok !== PV_VERIFY_TOKEN) throw new Error('bad');
      } catch (_) { err.textContent = 'Wrong password'; return; }
      _pvKey = key;
    }
  } catch (e) { err.textContent = 'Error: ' + e.message; return; }
  document.getElementById('pv-pw-modal').style.display = 'none';
  pvRenderLockState();
  if (_pvPwResolve) { _pvPwResolve(true); _pvPwResolve = null; }
}
// Ensure unlocked (sets _pvKey). Returns true if key available.
async function pvEnsureUnlocked() {
  if (_pvKey) return true;
  if (!_pvCrypto || !_pvCrypto.setup) return pvPromptPassword('setup');
  return pvPromptPassword('unlock');
}

// ── Documents modal ──────────────────────────────────────────────
async function pvOpenDocs(siteId) {
  _pvDocSite = _pvSites.find(s => s.id === siteId);
  document.getElementById('pv-docs-title').textContent = '📄 ' + _pvDocSite.name;
  document.getElementById('pv-doc-name').value = '';
  document.getElementById('pv-doc-file').value = '';
  document.getElementById('pv-doc-add-status').textContent = '';
  document.getElementById('pv-docs-modal').style.display = 'flex';
  await pvLoadDocs();
}
function pvCloseDocs() { document.getElementById('pv-docs-modal').style.display = 'none'; _pvDocSite = null; }
let _pvDocs = [];
async function pvLoadDocs() {
  _pvDocs = await (await fetch(`/api/privacy/sites/${_pvDocSite.id}/docs`)).json();
  pvRenderDocs();
}
function pvDocsLockbar() {
  const bar = document.getElementById('pv-docs-lockbar');
  const hasEnc = _pvDocs.some(d => d.encrypted);
  if (!hasEnc) { bar.innerHTML = 'No encrypted docs here yet. New docs are 🔒 encrypted by default (uncheck to add a plain one).'; return; }
  bar.innerHTML = _pvKey
    ? '🔓 Unlocked — encrypted docs are readable. <a href="#" onclick="pvLock();return false;">Lock</a>'
    : '🔒 Locked — encrypted docs are hidden. <button class="btn btn-sm" style="background:#2563eb;color:#fff;margin-left:6px;" onclick="pvUnlockDocs()">Unlock</button>';
}
async function pvUnlockDocs() { if (await pvEnsureUnlocked()) pvRenderDocs(); }
async function pvRenderDocs() {
  pvDocsLockbar();
  const host = document.getElementById('pv-docs-list');
  if (!_pvDocs.length) { host.innerHTML = '<div style="color:#aaa;">No documents.</div>'; return; }
  const rows = await Promise.all(_pvDocs.map(async d => {
    let name, locked = false;
    if (d.encrypted) {
      if (_pvKey) { try { name = await _pvDecStr(_pvKey, d.name_iv, d.enc_name); } catch (_) { name = '⚠ decrypt error'; } }
      else { name = 'Encrypted document'; locked = true; }
    } else { name = d.doc_name; }
    const icon = d.encrypted ? '🔒' : '🔓';
    const kb = d.file_size ? Math.max(1, Math.round(d.file_size / 1024)) + ' KB' : '';
    const actions = locked
      ? '<span style="color:#aaa;font-size:0.78rem;">unlock to open</span>'
      : `<button class="btn btn-secondary btn-sm" onclick="pvViewDoc(${d.id})">Open</button>
         <button class="btn btn-secondary btn-sm" onclick="pvRenameDoc(${d.id})">Rename</button>`;
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:1px solid #eee;padding:7px 2px;">
      <div style="min-width:0;"><span title="${d.encrypted ? 'encrypted' : 'plain'}">${icon}</span>
        <span style="font-size:0.88rem;">${_esc(name)}</span>
        <span style="font-size:0.72rem;color:#aaa;margin-left:6px;">${kb} · ${_esc(d.created_at || '')}</span></div>
      <div style="display:flex;gap:5px;flex-shrink:0;">${actions}
        <button class="btn btn-secondary btn-sm" style="color:#c0392b;" onclick="pvDeleteDoc(${d.id})">Del</button></div>
    </div>`;
  }));
  host.innerHTML = rows.join('');
}

async function pvAddDoc() {
  const file = document.getElementById('pv-doc-file').files[0];
  const nameField = document.getElementById('pv-doc-name').value.trim();
  const enc = document.getElementById('pv-doc-enc').checked;
  const st = document.getElementById('pv-doc-add-status');
  if (!file) { st.textContent = 'Pick a file first'; return; }
  if (file.size > 25 * 1024 * 1024) { st.textContent = 'File too large (max 25 MB)'; return; }
  const name = nameField || file.name;
  st.textContent = 'Working…';
  try {
    const fd = new FormData();
    let meta;
    if (enc) {
      if (!(await pvEnsureUnlocked())) { st.textContent = 'Cancelled (password needed)'; return; }
      const bytes = await file.arrayBuffer();
      const encFile = await _pvEncBytes(_pvKey, bytes);
      // store the real filename inside enc_name so type is derived on decrypt (not leaked)
      const encName = await _pvEncStr(_pvKey, name + '||' + file.name);
      meta = { encrypted: true, enc_name: encName.ct, name_iv: encName.iv, file_iv: encFile.iv, file_size: encFile.ct.byteLength };
      fd.append('file', new Blob([encFile.ct], { type: 'application/octet-stream' }), 'enc.bin');
    } else {
      meta = { encrypted: false, doc_name: name, mime_type: file.type || 'application/octet-stream' };
      fd.append('file', file, file.name);
    }
    fd.append('meta', JSON.stringify(meta));
    const r = await fetch(`/api/privacy/sites/${_pvDocSite.id}/docs`, { method: 'POST', body: fd });
    if (!r.ok) { st.textContent = 'Upload failed: ' + (await r.json()).error; return; }
    st.textContent = '✓ added';
    document.getElementById('pv-doc-name').value = '';
    document.getElementById('pv-doc-file').value = '';
    await pvLoadDocs(); await pvLoadSites();
  } catch (e) { st.textContent = 'Error: ' + e.message; }
}

async function pvViewDoc(id) {
  const d = _pvDocs.find(x => x.id === id);
  try {
    const buf = await (await fetch(`/api/privacy/docs/${id}/file`)).arrayBuffer();
    let bytes, fname, mime;
    if (d.encrypted) {
      if (!(await pvEnsureUnlocked())) return;
      bytes = await _pvDecBytes(_pvKey, d.file_iv, buf);
      const decName = await _pvDecStr(_pvKey, d.name_iv, d.enc_name);
      fname = (decName.split('||')[1]) || (decName.split('||')[0]);
      mime = _pvMimeFromName(fname);
    } else { bytes = buf; fname = d.doc_name; mime = d.mime_type || _pvMimeFromName(fname); }
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    if (/^(application\/pdf|image\/|text\/)/.test(mime)) window.open(url, '_blank');
    else { const a = document.createElement('a'); a.href = url; a.download = fname || 'document'; a.click(); }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { alert('Open failed: ' + e.message); }
}
function _pvMimeFromName(n) {
  const ext = (String(n || '').match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  return { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    txt: 'text/plain', webp: 'image/webp' }[ext] || 'application/octet-stream';
}

async function pvRenameDoc(id) {
  const d = _pvDocs.find(x => x.id === id);
  let cur = d.encrypted ? '' : d.doc_name;
  if (d.encrypted && _pvKey) { try { cur = (await _pvDecStr(_pvKey, d.name_iv, d.enc_name)).split('||')[0]; } catch (_) {} }
  const nn = prompt('New name:', cur);
  if (nn == null || !nn.trim()) return;
  let body;
  if (d.encrypted) {
    if (!(await pvEnsureUnlocked())) return;
    let origFile = nn.trim();
    try { origFile = (await _pvDecStr(_pvKey, d.name_iv, d.enc_name)).split('||')[1] || nn.trim(); } catch (_) {}
    const e = await _pvEncStr(_pvKey, nn.trim() + '||' + origFile);
    body = { enc_name: e.ct, name_iv: e.iv };
  } else { body = { doc_name: nn.trim() }; }
  await fetch(`/api/privacy/docs/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await pvLoadDocs();
}
async function pvDeleteDoc(id) {
  if (!confirm('Delete this document?')) return;
  await fetch(`/api/privacy/docs/${id}`, { method: 'DELETE' });
  await pvLoadDocs(); await pvLoadSites();
}
