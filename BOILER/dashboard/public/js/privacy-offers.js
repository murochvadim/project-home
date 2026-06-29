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
  if (ov) ov.style.display = locked ? 'flex' : 'none';
  if (unlockBtn) unlockBtn.style.display = locked ? '' : 'none';
  if (saveBtn) saveBtn.style.display = locked ? 'none' : '';
  if (lockBtn) lockBtn.style.display = locked ? 'none' : '';
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

// Called by the Budget tab button (after showTab makes the panel visible).
function pvofOnTabShow() {
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
      const data = JSON.parse(json);
      _pvofLoad(data);
      _pvofReveal();
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
    const json = JSON.stringify(_pvofXs.getData());
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
  _pvofShown = false;
  _pvofSetLocked(true);
  _pvofStatus('Locked');
}
