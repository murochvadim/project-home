// ── Privacy → Budget tab (x-spreadsheet, encrypted) ──────────────────────────
// Multi-sheet Excel-like table on the x-spreadsheet library (vendored, MIT).
//
// PHASE 2 — SERVER-BLIND ENCRYPTION. The workbook is stored as ciphertext in the
// privacy_sheets table (LXC 102) via /api/privacy/sheet. All crypto reuses the
// SAME Documents password + helpers in privacy.js (_pvKey / _pvEncStr / _pvDecStr
// / pvEnsureUnlocked; AES-256-GCM, PBKDF2-600k, salt+verifier in
// privacy_doc_crypto). The server never sees the workbook, key, or password.
//
// Lock model = whole-workbook: Locked → blank overlay, nothing loaded; Unlock →
// decrypt + load the entire workbook. privacy.js loads BEFORE this file, so the
// shared crypto globals are available.

let _pvofXs = null;          // x-spreadsheet instance (created once, lazily)
let _pvofShown = false;      // workbook is decrypted + visible
let _pvofSuppress = false;   // suppress the change handler during programmatic loadData
let _pvofLinks = [];         // cross-sheet "pulled" cells: [{ ts, tri, tci, ss, sr }]

function _pvofStatus(msg, ok) {
  const el = document.getElementById('pvof-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = ok === false ? '#c0392b' : '#2e7d32';
}

// Toggle the lock overlay + the Unlock / Save / Lock buttons.
function _pvofSetLocked(locked) {
  const ov = document.getElementById('pvof-lock');
  const unlockBtn = document.getElementById('pvof-unlock-btn');
  const saveBtn = document.getElementById('pvof-save-btn');
  const lockBtn = document.getElementById('pvof-lock-btn');
  const sizeCtl = document.getElementById('pvof-size-ctl');
  const pullBtn = document.getElementById('pvof-pull-btn');
  const refreshBtn = document.getElementById('pvof-refresh-btn');
  if (ov) ov.style.display = locked ? 'flex' : 'none';
  if (unlockBtn) unlockBtn.style.display = locked ? '' : 'none';
  if (saveBtn) saveBtn.style.display = locked ? 'none' : '';
  if (lockBtn) lockBtn.style.display = locked ? 'none' : '';
  if (pullBtn) pullBtn.style.display = locked ? 'none' : '';
  if (refreshBtn) refreshBtn.style.display = locked ? 'none' : '';
  if (sizeCtl) sizeCtl.style.display = locked ? 'none' : 'inline-flex';
}

function _pvofEnsureGrid() {
  const host = document.getElementById('pvof-xs');
  if (!host || typeof x_spreadsheet === 'undefined') return false;
  if (!_pvofXs) {
    _pvofXs = x_spreadsheet(host, {
      mode: 'edit',
      showToolbar: true,
      showGrid: true,
      showContextmenu: true,
      view: {
        height: () => Math.max(420, window.innerHeight - 300),
        width: () => host.clientWidth || (window.innerWidth - 280),
      },
      row: { len: 200, height: 25 },
      col: { len: 26, width: 100 },
    });
    _pvofXs.change(() => { if (!_pvofSuppress) _pvofStatus('Unsaved changes — click 💾 Save'); });
  }
  return true;
}

// Backups status strip (home QNAP time + cloud Drive time + folder link).
// Not sensitive (times + a link) → loaded regardless of lock state.
async function pvofLoadBackupStatus() {
  try {
    const r = await fetch('/api/privacy/budget-backup-status');
    const j = await r.json();
    const home = document.getElementById('pvof-bk-home');
    const cloud = document.getElementById('pvof-bk-cloud');
    const link = document.getElementById('pvof-bk-link');
    if (home) home.textContent = '🏠 Home: ' + (j.home_last_ok || 'never');
    if (cloud) cloud.textContent = '☁️ Cloud: ' + (j.cloud_last_ok || 'never');
    if (link && j.drive_folder_url) link.href = j.drive_folder_url;
  } catch (_) {
    const home = document.getElementById('pvof-bk-home');
    if (home) home.textContent = '🏠 Home: —';
  }
}

// Called by the Budget tab button (after showTab makes the panel visible).
function pvofOnTabShow() {
  pvofLoadBackupStatus();
  if (!_pvofEnsureGrid()) { _pvofStatus('x-spreadsheet failed to load', false); return; }
  // Stay/return to locked unless we're already unlocked AND the page key is live.
  if (_pvofShown && typeof _pvKey !== 'undefined' && _pvKey) {
    _pvofSetLocked(false);
  } else {
    _pvofShown = false;
    _pvofSetLocked(true);
    _pvofStatus('');
  }
}

// Unlock → prompt for the Documents password (shared session) → load + decrypt.
async function pvofUnlock() {
  if (!_pvofEnsureGrid()) return;
  if (typeof pvEnsureUnlocked !== 'function') { _pvofStatus('Crypto unavailable', false); return; }
  const ok = await pvEnsureUnlocked();
  if (!ok) { _pvofStatus('Cancelled — password needed', false); return; }
  await pvofLoadEncrypted();
}

// Load the encrypted workbook; one-time migrate the legacy plaintext copy.
async function pvofLoadEncrypted() {
  try {
    const r = await fetch('/api/privacy/sheet');
    const j = await r.json();
    if (j && j.enc_data && j.enc_iv) {
      const json = await _pvDecStr(_pvKey, j.enc_iv, j.enc_data);
      const parsed = JSON.parse(json);
      // New format wraps the workbook + cross-sheet links; old format is a bare workbook.
      const data = (parsed && parsed.__wb) ? parsed.__wb : parsed;
      _pvofLinks = (parsed && parsed.__wb && Array.isArray(parsed.__links)) ? parsed.__links : [];
      _pvofLoad(data);
      _pvofReveal();
      _pvofRefreshLinks(true);   // bring pulled cells up to date on open (silent — not "unsaved")
      _pvofStatus('Loaded');
      return;
    }
    // No ciphertext yet → migrate the Phase-1 plaintext workbook if present.
    const migrated = await _pvofMigratePlaintext();
    _pvofReveal();
    _pvofStatus(migrated ? 'Migrated to encrypted ✓' : 'Empty — start typing');
  } catch (e) {
    _pvofStatus('Unlock failed: ' + (e && e.message || e), false);
  }
}

// One-time: read dashboard_settings.privacy.offers (plaintext), encrypt it into
// privacy_sheets, then clear the plaintext key. Returns true if data was migrated.
async function _pvofMigratePlaintext() {
  try {
    const r = await fetch('/api/dashboard-settings/privacy.offers');
    const j = await r.json();
    const v = j && j.value;
    const hasData = v && (Array.isArray(v) ? v.length : Object.keys(v).length);
    if (!hasData) return false;
    _pvofLoad(v);
    await pvofSave();                                  // encrypt + POST to /sheet
    await fetch('/api/dashboard-settings/privacy.offers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: null }),           // wipe the plaintext copy
    });
    return true;
  } catch (_) { return false; }
}

function _pvofLoad(data) {
  _pvofSuppress = true;
  try { _pvofXs.loadData(data); } finally { _pvofSuppress = false; }
}

function _pvofReveal() {
  _pvofShown = true;
  _pvofSetLocked(false);
  _pvofSyncSizeInputs();
}

// Reflect the current workbook's row/col count in the toolbar inputs.
function _pvofSyncSizeInputs() {
  try {
    const d = _pvofXs.getData();
    const sh = Array.isArray(d) ? d[0] : d;
    const ri = document.getElementById('pvof-rows');
    const ci = document.getElementById('pvof-cols');
    if (ri) ri.value = (sh && sh.rows && sh.rows.len) || 200;
    if (ci) ci.value = (sh && sh.cols && sh.cols.len) || 26;
  } catch (_) {}
}

// Resize the grid (all sheets) to the chosen row/col count. Cells are preserved;
// the new size is saved with the workbook on the next 💾 Save.
function pvofApplySize() {
  if (!_pvofXs || !_pvofShown) { _pvofStatus('Unlock first', false); return; }
  const rows = Math.max(1, Math.min(5000, parseInt(document.getElementById('pvof-rows').value, 10) || 200));
  const cols = Math.max(1, Math.min(100, parseInt(document.getElementById('pvof-cols').value, 10) || 26));
  const data = _pvofXs.getData();
  const sheets = Array.isArray(data) ? data : [data];
  sheets.forEach(sh => {
    sh.rows = sh.rows || {}; sh.rows.len = rows;
    sh.cols = sh.cols || {}; sh.cols.len = cols;
  });
  _pvofLoad(sheets);
  document.getElementById('pvof-rows').value = rows;
  document.getElementById('pvof-cols').value = cols;
  _pvofStatus('Resized to ' + rows + ' rows × ' + cols + ' cols — click 💾 Save to keep');
}

// Save = getData() → encrypt with the Documents key → POST ciphertext.
async function pvofSave() {
  if (!_pvofXs) { _pvofStatus('Nothing to save yet', false); return; }
  if (typeof _pvKey === 'undefined' || !_pvKey) { _pvofStatus('Unlock first', false); return; }
  try {
    _pvofRefreshLinks(true);                           // ensure pulled cells hold current values before saving
    const json = JSON.stringify({ __wb: _pvofXs.getData(), __links: _pvofLinks });
    const enc = await _pvEncStr(_pvKey, json);         // {iv, ct}
    const r = await fetch('/api/privacy/sheet', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enc_data: enc.ct, enc_iv: enc.iv }),
    });
    const j = await r.json();
    if (j && j.ok) _pvofStatus('Saved ✓');
    else _pvofStatus('Save failed', false);
  } catch (e) {
    _pvofStatus('Save failed: ' + (e && e.message || e), false);
  }
}

// Lock this tab: wipe the decrypted workbook from the grid + show the overlay.
// (Does NOT clear the page-wide _pvKey — that's the Lock on the Sites tab.)
function pvofLockTab() {
  if (_pvofXs) { _pvofSuppress = true; try { _pvofXs.loadData([{ name: 'Sheet1' }]); } finally { _pvofSuppress = false; } }
  _pvofLinks = [];
  _pvofShown = false;
  _pvofSetLocked(true);
  _pvofStatus('Locked');
}

// ── Cross-sheet "Pull cell" ──────────────────────────────────────────────────
// x-spreadsheet has no cross-sheet formulas, so a "pull" copies the VALUE of a
// source cell (any sheet) into the selected cell. When the source is a total
// (a formula), we resolve it ourselves with a small evaluator that mirrors the
// engine's 8 built-ins (SUM/AVERAGE/MAX/MIN/IF/AND/OR/CONCAT) + arithmetic +
// comparisons + A1 refs/ranges. Links persist inside the encrypted workbook
// ({__wb,__links}) and are re-resolved on open / Save / ↻ Refresh. Unsupported
// formulas resolve to a visible #ERR (never a silently wrong number); a missing
// sheet/cell resolves to #REF (link kept, re-resolves if it returns).

const _PVOF_FUNCS = {
  SUM:     a => _pvofNums(a).reduce((s, n) => s + n, 0),
  AVERAGE: a => { const n = _pvofNums(a); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : 0; },
  MAX:     a => { const n = _pvofNums(a); return n.length ? Math.max.apply(null, n) : 0; },
  MIN:     a => { const n = _pvofNums(a); return n.length ? Math.min.apply(null, n) : 0; },
  IF:      a => (_pvofTruthy(a[0]) ? a[1] : a[2]),
  AND:     a => _pvofFlat(a).every(_pvofTruthy),
  OR:      a => _pvofFlat(a).some(_pvofTruthy),
  CONCAT:  a => _pvofFlat(a).map(x => (x == null ? '' : x)).join(''),
};
function _pvofFlat(args) { const o = []; for (const a of args) { if (Array.isArray(a)) o.push.apply(o, a); else o.push(a); } return o; }
function _pvofNums(args) { return _pvofFlat(args).map(Number).filter(n => !isNaN(n)); }
function _pvofTruthy(v) { if (Array.isArray(v)) v = v[0]; if (typeof v === 'string') return v !== '' && v.toUpperCase() !== 'FALSE'; return !!v; }

function _pvofEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function _pvofColIdx(s) { let n = 0; for (const ch of String(s).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function _pvofColName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - m - 1) / 26 | 0; } return s; }
function _pvofParseRef(ref) { const m = String(ref).replace(/\$/g, '').match(/^([A-Za-z]+)(\d+)$/); return m ? { ci: _pvofColIdx(m[1]), ri: parseInt(m[2], 10) - 1 } : null; }
function _pvofWorkbook() { const d = _pvofXs.getData(); return Array.isArray(d) ? d : [d]; }
function _pvofSheetIdxByName(name) { return _pvofWorkbook().findIndex(s => s.name === name); }
function _pvofSheetByName(wb, name) { return wb.find(s => s.name === name); }
function _pvofRawCell(sheet, ri, ci) { const r = sheet && sheet.rows && sheet.rows[ri]; const c = r && r.cells && r.cells[ci]; return (c && c.text != null) ? String(c.text) : ''; }

// Evaluate a cell → number or string. `seen` guards formula cycles within a sheet.
function _pvofEvalCell(sheet, ri, ci, seen) {
  const raw = _pvofRawCell(sheet, ri, ci);
  if (raw === '') return 0;
  if (raw[0] !== '=') { const n = Number(raw); return isNaN(n) ? raw : n; }
  const key = ri + ',' + ci;
  if (seen.has(key)) throw new Error('cycle');
  seen.add(key);
  const p = { toks: _pvofTokenize(raw.slice(1)), i: 0, sheet: sheet, seen: seen };
  const v = _pvofParseExpr(p);
  if (p.i < p.toks.length) throw new Error('parse');
  seen.delete(key);
  return v;
}

function _pvofTokenize(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const r = s.slice(i); let m;
    if ((m = r.match(/^\s+/)))                                { i += m[0].length; continue; }
    if ((m = r.match(/^\d+(\.\d+)?/)))                        { out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
    if ((m = r.match(/^"([^"]*)"/)))                          { out.push({ t: 'str', v: m[1] });            i += m[0].length; continue; }
    if ((m = r.match(/^[A-Za-z]+\d+:[A-Za-z]+\d+/)))         { const ab = m[0].split(':'); out.push({ t: 'range', a: _pvofParseRef(ab[0]), b: _pvofParseRef(ab[1]) }); i += m[0].length; continue; }
    if ((m = r.match(/^[A-Za-z]+\d+/)))                       { out.push({ t: 'ref', ref: _pvofParseRef(m[0]) }); i += m[0].length; continue; }
    if ((m = r.match(/^[A-Za-z]+/)))                          { out.push({ t: 'func', v: m[0].toUpperCase() }); i += m[0].length; continue; }
    if ((m = r.match(/^(>=|<=|<>|[+\-*/(),<>=])/)))           { out.push({ t: 'op', v: m[0] });             i += m[0].length; continue; }
    throw new Error('token');
  }
  return out;
}
function _pvofPeek(p) { return p.toks[p.i]; }
function _pvofNext(p) { return p.toks[p.i++]; }
function _pvofCmpVal(v) { const n = Number(v); return isNaN(n) ? v : n; }
function _pvofParseExpr(p) {          // comparison layer (lowest precedence)
  let v = _pvofParseAdd(p);
  const tk = _pvofPeek(p);
  if (tk && tk.t === 'op' && ['>', '<', '>=', '<=', '=', '<>'].indexOf(tk.v) >= 0) {
    _pvofNext(p); const a = _pvofCmpVal(v), b = _pvofCmpVal(_pvofParseAdd(p));
    switch (tk.v) { case '>': return a > b; case '<': return a < b; case '>=': return a >= b; case '<=': return a <= b; case '=': return a === b; case '<>': return a !== b; }
  }
  return v;
}
function _pvofParseAdd(p) {
  let v = _pvofParseTerm(p);
  while (_pvofPeek(p) && _pvofPeek(p).t === 'op' && (_pvofPeek(p).v === '+' || _pvofPeek(p).v === '-')) {
    const op = _pvofNext(p).v, r = _pvofParseTerm(p);
    v = (op === '+') ? (Number(v) || 0) + (Number(r) || 0) : (Number(v) || 0) - (Number(r) || 0);
  }
  return v;
}
function _pvofParseTerm(p) {
  let v = _pvofParseFactor(p);
  while (_pvofPeek(p) && _pvofPeek(p).t === 'op' && (_pvofPeek(p).v === '*' || _pvofPeek(p).v === '/')) {
    const op = _pvofNext(p).v, r = _pvofParseFactor(p);
    v = (op === '*') ? (Number(v) || 0) * (Number(r) || 0) : ((Number(r) || 0) === 0 ? 0 : (Number(v) || 0) / (Number(r) || 0));
  }
  return v;
}
function _pvofParseFactor(p) {
  const tk = _pvofPeek(p);
  if (!tk) throw new Error('eof');
  if (tk.t === 'op' && tk.v === '-') { _pvofNext(p); return -(Number(_pvofParseFactor(p)) || 0); }
  if (tk.t === 'op' && tk.v === '(') { _pvofNext(p); const v = _pvofParseExpr(p); if (!_pvofPeek(p) || _pvofPeek(p).v !== ')') throw new Error(')'); _pvofNext(p); return v; }
  if (tk.t === 'num') { _pvofNext(p); return tk.v; }
  if (tk.t === 'str') { _pvofNext(p); return tk.v; }
  if (tk.t === 'ref') { _pvofNext(p); if (!tk.ref) throw new Error('ref'); return _pvofEvalCell(p.sheet, tk.ref.ri, tk.ref.ci, p.seen); }
  if (tk.t === 'func') {
    _pvofNext(p);
    if (!_pvofPeek(p) || _pvofPeek(p).v !== '(') throw new Error('(');
    _pvofNext(p);
    const args = [];
    if (_pvofPeek(p) && _pvofPeek(p).v !== ')') {
      args.push(_pvofParseArg(p));
      while (_pvofPeek(p) && _pvofPeek(p).v === ',') { _pvofNext(p); args.push(_pvofParseArg(p)); }
    }
    if (!_pvofPeek(p) || _pvofPeek(p).v !== ')') throw new Error(')');
    _pvofNext(p);
    const fn = _PVOF_FUNCS[tk.v]; if (!fn) throw new Error('fn');
    return fn(args);
  }
  throw new Error('factor');
}
function _pvofParseArg(p) {
  if (_pvofPeek(p) && _pvofPeek(p).t === 'range') {   // a range arg → flat list of its cell values
    const rg = _pvofNext(p), out = [];
    if (!rg.a || !rg.b) throw new Error('range');
    const r0 = Math.min(rg.a.ri, rg.b.ri), r1 = Math.max(rg.a.ri, rg.b.ri);
    const c0 = Math.min(rg.a.ci, rg.b.ci), c1 = Math.max(rg.a.ci, rg.b.ci);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(_pvofEvalCell(p.sheet, r, c, p.seen));
    return out;
  }
  return _pvofParseExpr(p);
}

// Resolve one link's source → its current value (number/string/#ERR/#REF).
function _pvofResolve(wb, link) {
  const src = _pvofSheetByName(wb, link.ss), rc = _pvofParseRef(link.sr);
  if (!src || !rc) return '#REF';
  try { return _pvofEvalCell(src, rc.ri, rc.ci, new Set()); } catch (e) { return '#ERR'; }
}

// Re-resolve every pulled cell and write it in place (cellText targets a sheet by
// index, so no view reset). silent=true → open/save (no "unsaved" nag).
function _pvofRefreshLinks(silent) {
  if (!_pvofXs || !_pvofShown || !_pvofLinks.length) return;
  let ok = 0, bad = 0;
  _pvofSuppress = true;
  try {
    for (const link of _pvofLinks) {
      const wb = _pvofWorkbook();                       // fresh each iter so link-chains see prior writes
      const val = _pvofResolve(wb, link);
      if (val === '#REF' || val === '#ERR') bad++; else ok++;
      const tIdx = _pvofSheetIdxByName(link.ts);
      if (tIdx >= 0) _pvofXs.cellText(link.tri, link.tci, String(val), tIdx);
    }
  } finally { _pvofSuppress = false; }
  _pvofXs.reRender();
  if (!silent) _pvofStatus('Refreshed ' + ok + ' pulled cell' + (ok === 1 ? '' : 's') + (bad ? (' · ' + bad + ' unresolved (#REF/#ERR)') : '') + ' — click 💾 Save to keep');
}
window.pvofRefreshLinks = function () { _pvofRefreshLinks(false); };

// ↻ Refresh button.
function pvofRefreshCells() {
  if (!_pvofXs || !_pvofShown) { _pvofStatus('Unlock first', false); return; }
  if (!_pvofLinks.length) { _pvofStatus('No pulled cells yet — use 🔗 Pull cell'); return; }
  _pvofRefreshLinks(false);
}

// 🔗 Pull cell button → dialog → write the value + remember the link.
function pvofPullCell() {
  if (!_pvofXs || !_pvofShown) { _pvofStatus('Unlock first', false); return; }
  _pvofOpenPullDialog(_pvofActiveSel());   // never bails — the target is editable in the dialog
}

// Best-effort active sheet + selected cell (accessors vary by x-spreadsheet build);
// falls back to first sheet / A1 — the dialog lets the user correct the target.
function _pvofActiveSel() {
  const xs = _pvofXs, wb = _pvofWorkbook();
  const first = (wb[0] && wb[0].name) || 'Sheet1';
  const dp = (xs && xs.data && xs.data.selector) ? xs.data : (xs && xs.sheet && xs.sheet.data);
  if (!dp || !dp.selector) return { ts: first, tri: 0, tci: 0 };
  const sel = dp.selector, rng = sel.range || {};
  const num = (v, d) => (typeof v === 'number' && v >= 0) ? v : d;
  return { ts: dp.name || first, tri: num(sel.ri, num(rng.sri, 0)), tci: num(sel.ci, num(rng.sci, 0)) };
}

function _pvofApplyLink(link) {
  const wb = _pvofWorkbook();
  const val = _pvofResolve(wb, link);
  const tIdx = _pvofSheetIdxByName(link.ts);
  if (tIdx < 0) { _pvofStatus('Target sheet gone', false); return; }
  _pvofSuppress = true;
  try { _pvofXs.cellText(link.tri, link.tci, String(val), tIdx); } finally { _pvofSuppress = false; }
  // one link per target cell — replace any existing
  _pvofLinks = _pvofLinks.filter(l => !(l.ts === link.ts && l.tri === link.tri && l.tci === link.tci));
  _pvofLinks.push(link);
  _pvofXs.reRender();
  _pvofStatus('Pulled ' + link.ss + '!' + link.sr.toUpperCase() + ' = ' + val + ' — click 💾 Save to keep');
}

function _pvofOpenPullDialog(tgt) {
  const wb = _pvofWorkbook();
  const names = wb.map(s => s.name);
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);';
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  const linkRows = () => _pvofLinks.length
    ? _pvofLinks.map((l, k) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:.82rem;padding:3px 0;border-top:1px solid #f0ece6;">
        <span>${_pvofEsc(l.ts)}!${_pvofEsc(_pvofColName(l.tci) + (l.tri + 1))} ⟵ <b>${_pvofEsc(l.ss)}!${_pvofEsc(String(l.sr).toUpperCase())}</b></span>
        <button data-rm="${k}" title="Remove this pull (keeps the current number)" style="background:#eee;border:none;border-radius:6px;cursor:pointer;padding:2px 8px;">✕</button></div>`).join('')
    : '<div style="font-size:.8rem;color:#999;padding:4px 0;">No pulled cells yet.</div>';
  const render = () => {
    ov.innerHTML = `<div style="background:#fff;border-radius:14px;padding:20px 24px;max-width:420px;width:92%;box-shadow:0 12px 40px rgba(0,0,0,.3);">
      <div style="font-size:1.05rem;font-weight:700;color:#166534;margin-bottom:4px;">🔗 Pull a value from another sheet</div>
      <div style="font-size:.82rem;color:#666;margin-bottom:12px;">Copy a cell's value from one sheet <b>into</b> another. The target is pre-filled from the cell you clicked — change it if needed.</div>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;">
        <label style="font-size:.8rem;color:#444;">Into sheet<br>
          <select id="pvof-pd-tsheet" style="margin-top:3px;padding:5px;min-width:130px;">
            ${names.map(n => `<option value="${_pvofEsc(n)}">${_pvofEsc(n)}</option>`).join('')}
          </select></label>
        <label style="font-size:.8rem;color:#444;">Cell<br>
          <input id="pvof-pd-tcell" placeholder="e.g. B2" style="margin-top:3px;padding:5px;width:90px;text-transform:uppercase;"></label>
      </div>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">
        <label style="font-size:.8rem;color:#444;">From sheet<br>
          <select id="pvof-pd-sheet" style="margin-top:3px;padding:5px;min-width:130px;">
            ${names.map(n => `<option value="${_pvofEsc(n)}">${_pvofEsc(n)}</option>`).join('')}
          </select></label>
        <label style="font-size:.8rem;color:#444;">Cell<br>
          <input id="pvof-pd-cell" placeholder="e.g. B20" style="margin-top:3px;padding:5px;width:90px;text-transform:uppercase;"></label>
        <button id="pvof-pd-go" class="btn btn-sm" style="background:#16a34a;color:#fff;">Pull</button>
        <button id="pvof-pd-cancel" class="btn btn-secondary btn-sm">Close</button>
      </div>
      <div id="pvof-pd-err" style="font-size:.8rem;color:#c0392b;min-height:1.1em;margin-top:6px;"></div>
      <div style="margin-top:10px;"><div style="font-size:.78rem;color:#777;margin-bottom:2px;">Current pulls</div>${linkRows()}</div>
    </div>`;
    const tsheet = ov.querySelector('#pvof-pd-tsheet'); if (tsheet) tsheet.value = tgt.ts;
    const tcell = ov.querySelector('#pvof-pd-tcell'); if (tcell) tcell.value = _pvofColName(tgt.tci) + (tgt.tri + 1);
    const def = names.find(n => n !== tgt.ts) || names[0];
    const ssheet = ov.querySelector('#pvof-pd-sheet'); if (ssheet && def) ssheet.value = def;
    ov.querySelector('#pvof-pd-cancel').addEventListener('click', close);
    ov.querySelector('#pvof-pd-go').addEventListener('click', () => {
      const err = ov.querySelector('#pvof-pd-err');
      const tsN = ov.querySelector('#pvof-pd-tsheet').value;
      const tRef = _pvofParseRef((ov.querySelector('#pvof-pd-tcell').value || '').trim());
      const ss = ov.querySelector('#pvof-pd-sheet').value;
      const sr = (ov.querySelector('#pvof-pd-cell').value || '').trim();
      if (!tRef) { err.textContent = 'Enter a target cell like B2.'; return; }
      if (!_pvofParseRef(sr)) { err.textContent = 'Enter a source cell like B20.'; return; }
      _pvofApplyLink({ ts: tsN, tri: tRef.ri, tci: tRef.ci, ss: ss, sr: sr.toUpperCase() });
      close();
    });
    ov.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      _pvofLinks.splice(parseInt(b.dataset.rm, 10), 1);
      _pvofStatus('Pull removed — click 💾 Save to keep');
      render();
    }));
  };
  render();
  document.body.appendChild(ov);
  const c = ov.querySelector('#pvof-pd-cell'); if (c) c.focus();
}
