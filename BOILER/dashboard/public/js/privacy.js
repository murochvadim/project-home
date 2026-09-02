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
// Appointment card color bands (Settings tab). red_days = days right before the
// appointment (red); yellow_days = days before red (yellow); grey_days = days
// AFTER the appointment that it STAYS RED, before turning grey forever. GREEN =
// anything further out in the future (auto, no limit). Stored in
// dashboard_settings key 'privacy.settings'.
let _pvApptColors = { red_days: 3, yellow_days: 7, grey_days: 7 };

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
  if (name === 'doccreate' && typeof pvdcOnShow === 'function') pvdcOnShow();
  if (name === 'settings') { _pvFillSettingsForm(); pvTravelLoad(); pvLoadUsers(); pvLoadReminders(); if (typeof pvPeopleSettingsLoad === 'function') pvPeopleSettingsLoad(); }
  if (name === 'places' && typeof pvPlacesOnShow === 'function') pvPlacesOnShow();
}
async function pvRefresh() { await pvLoadSettings(); await pvLoadCrypto(); await pvLoadSites(); pvRenderLockState(); pvJournalLoadCfg(); }

// Appointment color-band widths, stored as dashboard_settings key 'privacy.settings'.
const _PV_BAND_KEYS = ['yellow_days', 'red_days', 'grey_days'];
function _pvFillSettingsForm() {
  _PV_BAND_KEYS.forEach(k => { const i = document.getElementById('pv-set-' + k); if (i) i.value = _pvApptColors[k]; });
}
async function pvLoadSettings() {
  try {
    const r = await fetch('/api/dashboard-settings/privacy.settings');
    if (!r.ok) return;
    const v = (await r.json() || {}).value || {};
    _PV_BAND_KEYS.forEach(k => { const n = parseInt(v[k], 10); if (Number.isFinite(n) && n >= 0) _pvApptColors[k] = n; });
  } catch (e) { /* keep defaults */ }
}
async function pvSaveSettings() {
  const st = document.getElementById('pv-set-status');
  const out = {};
  for (const k of _PV_BAND_KEYS) {
    const n = parseInt(document.getElementById('pv-set-' + k).value, 10);
    if (!Number.isFinite(n) || n < 0 || n > 3650) { if (st) { st.style.color = '#c0392b'; st.textContent = 'Each value must be a number 0–3650.'; } return; }
    out[k] = n;
  }
  try {
    const r = await fetch('/api/dashboard-settings/privacy.settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: out }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    _pvApptColors = out;
    if (st) { st.style.color = '#2e7d32'; st.textContent = '✓ Saved'; }
    pvRenderSites();   // re-color appointment cards with the new bands
  } catch (e) { if (st) { st.style.color = '#c0392b'; st.textContent = 'Save failed: ' + e.message; } }
}

// ── Travel mode (dashboard_settings key 'travel') — when abroad, personal features
// follow the active country's local time; home automation stays Israel. Also drives
// the global "Travel" clock injected on every page by alerts-monitor.js. ──
const _PV_TRAVEL_FEATS = [
  ['daily_journal', 'Daily Journal'], ['medical', 'Medical'],
  ['personal_health', 'Personal Health'], ['reminders', 'Reminders badge'],
];
const _PV_TZ_LIST = [
  'Asia/Jerusalem',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Amsterdam', 'Europe/Athens', 'Europe/Moscow', 'Europe/Istanbul',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
  'Asia/Dubai', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Shanghai',
  'Asia/Tokyo', 'Asia/Kolkata', 'Asia/Seoul',
  'Australia/Sydney', 'Pacific/Auckland', 'Africa/Cairo', 'Africa/Johannesburg', 'UTC',
];
let _pvTravel = { active_timezone: 'Asia/Jerusalem', features: {} };
function _pvTravelIsHome() {
  const tz = _pvTravel.active_timezone || 'Asia/Jerusalem';
  return !tz || tz === 'Asia/Jerusalem';
}
function _pvTravelBadge() {
  const badge = document.getElementById('pv-travel-badge'); if (!badge) return;
  if (_pvTravelIsHome()) { badge.textContent = '🏠 Home — Israel'; badge.style.background = '#dcfce7'; badge.style.color = '#15803d'; }
  else { badge.textContent = '🧳 Away — ' + _pvTravel.active_timezone; badge.style.background = '#fef3c7'; badge.style.color = '#b45309'; }
}
function pvTravelRender() {
  const sel = document.getElementById('pv-travel-tz');
  if (sel) {
    if (!sel.options.length) sel.innerHTML = _PV_TZ_LIST.map(z => `<option value="${z}">${z === 'Asia/Jerusalem' ? 'Asia/Jerusalem (Home)' : z}</option>`).join('');
    sel.value = _pvTravel.active_timezone || 'Asia/Jerusalem';
    if (sel.selectedIndex < 0 && _pvTravel.active_timezone) {  // unknown tz → add + select
      const o = document.createElement('option'); o.value = o.textContent = _pvTravel.active_timezone; sel.appendChild(o); sel.value = _pvTravel.active_timezone;
    }
  }
  const feats = _pvTravel.features || {};
  const host = document.getElementById('pv-travel-feats');
  if (host) host.innerHTML = _PV_TRAVEL_FEATS.map(([k, label]) =>
    `<label style="display:flex; align-items:center; gap:7px;"><input type="checkbox" data-travel-feat="${k}" ${feats[k] ? 'checked' : ''}> ${label}</label>`).join('');
  _pvTravelBadge();
}
async function pvTravelLoad() {
  try {
    const j = await (await fetch('/api/dashboard-settings/travel')).json();
    const v = (j && j.value) || {};
    _pvTravel = { active_timezone: v.active_timezone || 'Asia/Jerusalem', features: (v.features && typeof v.features === 'object') ? v.features : {} };
  } catch (e) { _pvTravel = { active_timezone: 'Asia/Jerusalem', features: {} }; }
  pvTravelRender();
}
function pvTravelHome() {
  const sel = document.getElementById('pv-travel-tz'); if (sel) sel.value = 'Asia/Jerusalem';
  _pvTravel = Object.assign({}, _pvTravel, { active_timezone: 'Asia/Jerusalem' });
  _pvTravelBadge();
}
async function pvTravelSave() {
  const st = document.getElementById('pv-travel-status');
  const sel = document.getElementById('pv-travel-tz');
  const tz = (sel && sel.value) || 'Asia/Jerusalem';
  const features = {};
  document.querySelectorAll('#pv-travel-feats input[data-travel-feat]').forEach(cb => { features[cb.getAttribute('data-travel-feat')] = cb.checked; });
  const out = { active_timezone: tz, features };
  try {
    const r = await fetch('/api/dashboard-settings/travel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: out }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    _pvTravel = out;
    // refresh the shared cache so pvjTodayJeru + the global clock update immediately
    if (window.loadTravelSettings) { try { await window.loadTravelSettings(true); } catch (e) {} }
    if (window.travelClockRefresh) { try { window.travelClockRefresh(); } catch (e) {} }
    pvTravelRender();
    if (st) { st.style.color = '#2e7d32'; st.textContent = '✓ Saved'; }
  } catch (e) { if (st) { st.style.color = '#c0392b'; st.textContent = 'Save failed: ' + e.message; } }
}

// ── Reminders badge config (dashboard_settings key 'reminders') — which pages
// show the badge + snooze minutes + on/off. Consumed by the shared
// reminders-badge.js on every page. ──
const _PV_REM_PAGES = [
  ['index', 'Boiler Agent'], ['main-agent', 'Main Agent'], ['devices', 'Device Agent'],
  ['media', 'Media Agents'], ['corridor', 'Corridor Agents'], ['rooms', 'Project Rooms'],
  ['living-room', 'Living Room'], ['balcony', 'Balcony'], ['my-bathroom', 'My BathRoom'],
  ['bedroom', 'Bedroom'], ['voice', 'Voice'], ['health', 'Project Health'],
  ['network', 'Project Network'], ['power', 'Project Power'], ['gateway', 'Project Gateway'],
  ['esp-boards', 'Project Boards'], ['project-general', 'Project General'],
  ['privacy', 'Privacy'], ['communication', 'Communication'], ['medical', 'Medical'],
];
async function pvLoadReminders() {
  let cfg = {};
  try { const j = await (await fetch('/api/dashboard-settings/reminders')).json(); cfg = (j && j.value) || {}; } catch (e) { /* defaults */ }
  const pages = Array.isArray(cfg.pages) ? cfg.pages : [];
  const en = document.getElementById('pv-rem-enabled'); if (en) en.checked = cfg.enabled !== false;
  const sn = document.getElementById('pv-rem-snooze'); if (sn) sn.value = cfg.snooze_min || 30;
  const mw = document.getElementById('pv-rem-medwin'); if (mw) mw.value = (cfg.med_window_hours != null ? cfg.med_window_hours : 8);
  const host = document.getElementById('pv-rem-pages');
  if (host) host.innerHTML = _PV_REM_PAGES.map(([slug, label]) =>
    `<label style="display:flex; align-items:center; gap:5px;"><input type="checkbox" class="pv-rem-page" value="${slug}" ${pages.indexOf(slug) !== -1 ? 'checked' : ''}> ${label}</label>`).join('');
  const st = document.getElementById('pv-rem-status'); if (st) st.textContent = '';
}
async function pvSaveReminders() {
  const st = document.getElementById('pv-rem-status');
  const pages = Array.from(document.querySelectorAll('.pv-rem-page:checked')).map(c => c.value);
  // med_window_hours allows a literal 0 (= old clear-at-midnight behavior).
  const mwRaw = parseInt(document.getElementById('pv-rem-medwin').value, 10);
  const value = {
    enabled: document.getElementById('pv-rem-enabled').checked,
    snooze_min: Math.max(1, parseInt(document.getElementById('pv-rem-snooze').value, 10) || 30),
    med_window_hours: Number.isFinite(mwRaw) ? Math.min(24, Math.max(0, mwRaw)) : 8,
    pages,
  };
  try {
    const r = await fetch('/api/dashboard-settings/reminders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (st) { st.style.color = '#2e7d32'; st.textContent = '✓ Saved'; }
  } catch (e) { if (st) { st.style.color = '#c0392b'; st.textContent = 'Save failed: ' + e.message; } }
}

// ── Users (Settings tab) — household members, backed by the canonical
// `household_users` TABLE (LXC 102) via /api/household-users — NOT the old
// dashboard_settings 'privacy.users' JSON blob. Each row has a stable id: per-field
// edits PATCH, a new row POSTs on its first named edit, ✕ DELETEs (cascades the
// member's health profile). Fields: name, device_label (phone label = old
// 'smartphone'), phone (number). See PRIVACY/CLAUDE.md.
let _pvUsers = [];
let _pvPhoneOpts = [];   // device-label autocomplete suggestions (tracked + network)
async function pvLoadUsers() {
  try {
    const r = await fetch('/api/household-users');
    _pvUsers = r.ok ? await r.json() : [];
    if (!Array.isArray(_pvUsers)) _pvUsers = [];
  } catch (e) { _pvUsers = []; }
  pvLoadPhoneOptions();   // fill the datalist (async, independent of the user rows)
  pvRenderUsers();
}
// Smartphone suggestions: geolocation tracked_devices + named net_devices.
async function pvLoadPhoneOptions() {
  const opts = new Set();
  try {
    const geo = await (await fetch('/api/geolocation/settings')).json();
    (geo.tracked_devices || []).forEach(d => { const l = (d.label || d.name || d.device_id || '').trim(); if (l) opts.add(l); });
  } catch (e) { /* ignore */ }
  try {
    // net_devices is mostly home-automation gear + TVs/soundbars/robots that
    // share phone-maker vendors. Keep PHONE rows: a phone-model name OR a
    // randomized ("Locally administered") MAC, MINUS an explicit non-phone list.
    const PHONE_RE = /\b(galaxy|iphone|pixel|redmi|oneplus|huawei|honor|motorola|moto|oppo|vivo|realme|poco|fold|flip|phone)\b|\bnote\s?\d{1,2}\b|\b[sa]\s?\d{2}\b/i;
    const NOT_PHONE_RE = /\b(tv|soundbar|robot|roborock|vacuum|cleaning|tablet|asus|laptop|pc|imac|macbook|switch|sensor|light|lamp|blind|curtain|presence|fridge|oven|hob|hood|hub|gateway|assistant|server|printer|camera|speaker|echo|alexa|nest|pixoo|awtrix|panel|plug|socket|thermostat|boiler|valve|projector|doorbell|chime|star)\b/i;
    const nets = await (await fetch('/api/network/devices')).json();
    (Array.isArray(nets) ? nets : []).forEach(n => {
      const nm = (n.name || '').trim();
      if (!nm || NOT_PHONE_RE.test(nm)) return;
      if (/locally administered/i.test(n.vendor || '') || PHONE_RE.test(nm)) opts.add(nm);
    });
  } catch (e) { /* ignore */ }
  _pvPhoneOpts = [...opts].sort((a, b) => a.localeCompare(b));
  const dl = document.getElementById('pv-phones-datalist');
  if (dl) dl.innerHTML = _pvPhoneOpts.map(o => `<option value="${_esc(o)}"></option>`).join('');
}
function pvRenderUsers() {
  const host = document.getElementById('pv-users-list');
  if (!host) return;
  if (!_pvUsers.length) { host.innerHTML = '<div style="color:#aaa; font-size:0.85rem;">No users yet — click “+ Add user”.</div>'; return; }
  const inp = 'padding:5px 8px; border:1px solid #ccc; border-radius:4px; font-size:0.85rem; min-width:0;';
  host.innerHTML = _pvUsers.map((u, i) => `
    <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
      <input value="${_esc(u.name || '')}" placeholder="real name" onchange="pvUserSet(${i},'name',this.value)" style="flex:1; ${inp}">
      <span style="color:#bbb;" title="phone device label">📱</span>
      <input value="${_esc(u.device_label || '')}" list="pv-phones-datalist" placeholder="phone device…" onchange="pvUserSet(${i},'device_label',this.value)" style="flex:1.3; ${inp}">
      <span style="color:#bbb;" title="phone number">☎</span>
      <input value="${_esc(u.phone || '')}" type="tel" placeholder="phone number" onchange="pvUserSet(${i},'phone',this.value)" style="flex:1; ${inp}">
      <button class="btn btn-secondary btn-sm" style="color:#c0392b;" onclick="pvUserDelete(${i})">✕</button>
    </div>`).join('');
}
function pvUsersStatus(msg, isErr) {
  const st = document.getElementById('pv-users-status');
  if (!st) return;
  st.style.color = isErr ? '#c0392b' : '#2e7d32';
  st.textContent = msg;
  clearTimeout(st._t); st._t = setTimeout(() => { st.textContent = ''; }, 1500);
}
// Per-field persistence against the household_users table: a new (id-less) row is
// CREATED on its first edit once it has a name; existing rows PATCH the changed field.
async function pvUserSet(i, field, val) {
  const u = _pvUsers[i]; if (!u) return;
  u[field] = (val || '').trim();
  try {
    if (!u.id) {
      if (!u.name) return;   // need a name before the row can be created
      const r = await fetch('/api/household-users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: u.name, device_label: u.device_label || '', phone: u.phone || '' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      u.id = j.id;
    } else {
      const body = {}; body[field] = u[field];
      const r = await fetch('/api/household-users/' + u.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    }
    pvUsersStatus('✓ Saved');
  } catch (e) { pvUsersStatus('Save failed: ' + e.message, true); }
}
async function pvUserDelete(i) {
  const u = _pvUsers[i]; if (!u) return;
  if (u.id && !confirm(`Delete "${u.name || 'this member'}"? This also removes their Personal Health profile, weight log, blood-pressure log and medications.`)) return;
  try {
    if (u.id) {
      const r = await fetch('/api/household-users/' + u.id, { method: 'DELETE' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    }
    _pvUsers.splice(i, 1); pvRenderUsers(); pvUsersStatus('✓ Saved');
  } catch (e) { pvUsersStatus('Delete failed: ' + e.message, true); }
}
function pvAddUser() {
  _pvUsers.push({ name: '', device_label: '', phone: '' });
  pvRenderUsers();
  const ins = document.querySelectorAll('#pv-users-list input');
  if (ins.length) ins[ins.length - 3].focus();   // focus the new row's name input (3 inputs/row now)
}
window.addEventListener('DOMContentLoaded', pvRefresh);

async function pvLoadCrypto() {
  try { _pvCrypto = await (await fetch('/api/privacy/crypto')).json(); } catch (e) { _pvCrypto = { setup: false }; }
}
function pvRenderLockState() {
  const el = document.getElementById('pv-lock-state');
  if (!el) return;
  const btn = (label, fn, blue) => `<button class="btn btn-sm ${blue ? '' : 'btn-secondary'}" style="${blue ? 'background:#2563eb;color:#fff;' : ''}margin-left:6px;" onclick="${fn}">${label}</button>`;
  // Green Vaultwarden + orange Google Drive launchers, same btn-sm size, right of the action button.
  const vw = `<button class="btn btn-sm" style="background:#3a7d44;color:#fff;margin-left:6px;" onclick="window.open('https://192.168.1.196','_blank')">🔑 Vaultwarden</button>`;
  const gd = `<button class="btn btn-sm" style="background:#222;color:#fff;margin-left:6px;" onclick="window.open('https://drive.google.com/drive/u/0/my-drive','_blank')">📁 Google Drive</button>`;
  if (!_pvCrypto || !_pvCrypto.setup) { el.innerHTML = '🔓 no Documents password yet' + btn('Set password', 'pvHeaderSet()', true) + vw + gd; return; }
  el.innerHTML = (_pvKey
    ? '🔓 Docs unlocked' + btn('Lock', 'pvLock()')
    : '🔒 Docs locked' + btn('Unlock', 'pvHeaderUnlock()', true)) + vw + gd;
}
function pvLock() { _pvKey = null; pvRenderLockState(); if (_pvDocSite) pvRenderDocs(); }
async function pvHeaderSet() { if (await pvPromptPassword('setup')) { pvRenderLockState(); if (_pvDocSite) pvRenderDocs(); } }
async function pvHeaderUnlock() { if (await pvPromptPassword('unlock')) { pvRenderLockState(); if (_pvDocSite) pvRenderDocs(); } }

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
  host.innerHTML = '<div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; align-items:stretch;">' + rows.map(s => {
    // Phones first (Main + additional), then the rest, as a 2-column grid so the
    // icons line up in one column and the data in the next. (Docs button is in
    // the right action column now.)
    const cells = [];
    const addRow = (ic, html) => cells.push(`<span style="text-align:center;">${ic}</span><span>${html}</span>`);
    if (s.main_tel) addRow('📞', `Main — <a href="tel:${_esc(s.main_tel)}">${_esc(s.main_tel)}</a>`);
    (s.add_tels || []).forEach(t => {
      const person = _esc(t.person || ''), tel = _esc(t.tel || '');
      if (tel || person) addRow('📞', `${person ? person + ' — ' : ''}${tel ? `<a href="tel:${tel}">${tel}</a>` : ''}`);
    });
    if (s.fax)     addRow('📠', `Fax — ${_esc(s.fax)}`);
    if (s.email)   addRow('✉', `<a href="mailto:${_esc(s.email)}">${_esc(s.email)}</a>`);
    if (s.website) addRow('🌐', `<a href="${_esc(s.website)}" target="_blank">${_esc(s.website)}</a>`);
    return `<div class="card" data-site-id="${s.id}" style="padding:10px 12px; display:flex; flex-direction:column;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
        <div style="min-width:0;">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <span style="cursor:grab; color:#bbb; user-select:none; font-size:1.05rem; line-height:1;" title="Drag to reorder" data-pv-drag-handle="1" draggable="true">⋮⋮</span>
            ${s.kind ? `<span style="font-size:0.72rem; font-weight:600; letter-spacing:.5px; text-transform:uppercase; background:#e7ecfb; color:#3a55a8; padding:3px 10px; border-radius:12px;">${_esc(s.kind)}</span>` : ''}
            <span style="font-size:1.2rem; font-weight:700; color:#222;">${_esc(s.name)}</span>
          </div>
          <div style="display:flex; gap:36px; align-items:flex-start; margin-top:6px; flex-wrap:wrap;">
            <div style="font-size:0.95rem; color:#555; display:grid; grid-template-columns:auto 1fr; gap:5px 8px; align-items:center;">${cells.join('')}</div>
          </div>
        </div>
        <div style="display:flex; flex-direction:column; gap:5px; flex-shrink:0; width:132px;">
          <button class="btn btn-secondary btn-sm" style="width:100%; box-sizing:border-box;" onclick="pvOpenDocs(${s.id})">📄 Docs (${s.doc_count})</button>
          <button class="btn btn-secondary btn-sm" style="width:100%; box-sizing:border-box;" onclick="pvOpenReceipts(${s.id})" title="Spend chart + receipts (total ${(s.receipt_total||0).toLocaleString()} ₪)">📊 Chart (${s.receipt_count||0})</button>
          ${s.vault_item ? `<a class="btn btn-secondary btn-sm" style="width:100%; box-sizing:border-box; text-align:center;" href="https://192.168.1.196" target="_blank" title="Open Vaultwarden (item: ${_esc(s.vault_item)})">🔑 Vaultwarden</a>` : ''}
          <div style="display:flex; gap:5px;">
            <button class="btn btn-secondary btn-sm" style="flex:1;" onclick="pvEditSite(${s.id})">Edit</button>
            <button class="btn btn-secondary btn-sm" style="flex:1; color:#c0392b;" onclick="pvDeleteSite(${s.id})">Del</button>
          </div>
        </div>
      </div>
      <div style="flex:1; display:flex; align-items:center; justify-content:center; margin-top:8px;">${_pvApptReminderArea(s)}</div>
    </div>`;
  }).join('') + '</div>';
  // Align the vertically-centred appointment rows between the two cards in each
  // grid row: equalise their top-section height so the space below (where the
  // appointment centres) matches, putting both appointments on the same level.
  const _cards = [...host.querySelectorAll('[data-site-id]')];
  for (let i = 0; i < _cards.length; i += 2) {
    const tops = _cards.slice(i, i + 2).map(c => c.firstElementChild);
    tops.forEach(t => { t.style.minHeight = ''; });
    const mx = Math.max(...tops.map(t => t.offsetHeight));
    tops.forEach(t => { t.style.minHeight = mx + 'px'; });
  }
  if (!q) pvWireSiteDrag(host);   // drag-reorder only on the full (unfiltered) list
}
function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Drag-to-reorder site cards by the ⋮⋮ handle (mirrors power.js mdWireDragReorder,
// adapted for cards). On drop, POST the new order → sort_order, then reload.
let _pvDragId = null;
function pvWireSiteDrag(host) {
  const cards = Array.from(host.querySelectorAll('[data-site-id]'));
  for (const card of cards) {
    const handle = card.querySelector('[data-pv-drag-handle]');
    if (handle) {
      handle.addEventListener('dragstart', (e) => {
        _pvDragId = card.dataset.siteId;
        card.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', _pvDragId); } catch (_) {}
      });
      handle.addEventListener('dragend', () => { card.style.opacity = ''; _pvDragId = null; });
    }
    card.addEventListener('dragover', (e) => {
      if (!_pvDragId || card.dataset.siteId === _pvDragId) return;
      e.preventDefault();
      card.style.outline = '2px dashed #3a55a8';
    });
    card.addEventListener('dragleave', () => { card.style.outline = ''; });
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.style.outline = '';
      if (!_pvDragId || card.dataset.siteId === _pvDragId) return;
      const targetId = card.dataset.siteId;
      const order = cards.map(c => c.dataset.siteId);
      const from = order.indexOf(_pvDragId);
      if (from >= 0) order.splice(from, 1);
      order.splice(order.indexOf(targetId), 0, _pvDragId);
      try {
        const r = await fetch('/api/privacy/sites/reorder', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: order.map(Number) }),
        });
        if (!r.ok) { const d = await r.json().catch(() => ({})); alert('Reorder failed: ' + (d.error || r.statusText)); }
      } catch (err) { alert('Reorder failed: ' + (err.message || err)); }
      await pvLoadSites();   // re-render in the server-confirmed order
    });
  }
}

// ── Appointment + reminder (mirrors the Medical Contacts pattern) ────────────
// Split a TIMESTAMPTZ ISO into date / hour / minute for the 3 inputs
// (a single datetime-local follows OS locale → can't force 24h on en-US Windows).
function _pvIsoToParts(iso) {
  if (!iso) return { date: '', hour: '', minute: '' };
  const d = new Date(iso);
  if (isNaN(d)) return { date: '', hour: '', minute: '' };
  const pad = n => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, hour: String(d.getHours()), minute: pad(d.getMinutes()) };
}
// Combine the 3 inputs into a UTC ISO (anchored to the wall-clock typed). No date → ''.
function _pvPartsToISO(date, hourStr, minStr) {
  if (!date) return '';
  const h = Math.max(0, Math.min(23, parseInt(hourStr || '0', 10) || 0));
  const m = Math.max(0, Math.min(59, parseInt(minStr || '0', 10) || 0));
  const pad = n => String(n).padStart(2, '0');
  const d = new Date(`${date}T${pad(h)}:${pad(m)}`);
  return isNaN(d) ? '' : d.toISOString();
}
function pvClearAppt() { ['pv-f-appt-date', 'pv-f-appt-hour', 'pv-f-appt-min', 'pv-f-appt-note'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; }); }
function pvClearReminder() { const e = document.getElementById('pv-f-reminder'); if (e) e.value = ''; }

// The appointment is ALWAYS centred in the card (the centre column of a 3-col
// grid); the 🔔 reminder, when present, sits immediately to its LEFT (left column,
// right-aligned), and the empty right column is a balancing spacer so the
// appointment stays centred whether or not a reminder exists. If only a reminder
// exists, it stays in the left column (left of centre). The wrapper in
// pvRenderSites centres this block vertically in the middle of the card.
function _pvApptReminderArea(s) {
  const appt = _pvApptCard(s), rem = _pvReminderCard(s);
  if (!appt && !rem) return '';
  return `<div style="display:grid; grid-template-columns:minmax(0,1fr) 200px minmax(0,1fr); align-items:stretch; gap:8px; width:100%;">
    <div style="display:flex; justify-content:flex-end; align-items:stretch; min-width:0;">${rem}</div>
    <div style="display:flex; align-items:stretch;">${appt}</div>
    <div></div>
  </div>`;
}
// Pick the color band for an appointment date. Card text is always black (set in
// _pvApptCard); a band only carries fill (bg), border (bC == bg = "no frame"),
// and the past flag. Red spans the days just before the appointment AND the
// grey_days just after it; then grey forever. Future beyond yellow → green.
function _pvApptBand(d) {
  if (isNaN(d)) return { bg: '#f9fafb', bC: '#d1d5db', past: false };   // invalid date
  const k = _pvApptColors;
  const RED = { bg: '#fecaca', bC: '#fecaca' };
  const days = (d.getTime() - Date.now()) / 86400000;   // days until (negative = past)
  if (days < 0) {   // past the appointment day
    if (-days <= k.grey_days) return { ...RED, past: true };               // still red for grey_days after
    return { bg: '#f3f4f6', bC: '#f3f4f6', past: true };                   // grey — forever after that
  }
  if (days <= k.red_days)                  return { ...RED, past: false };                            // red — days before
  if (days <= k.red_days + k.yellow_days)  return { bg: '#fef9c3', bC: '#fef9c3', past: false };      // yellow — before red
  return { bg: '#f0fdf4', bC: '#f0fdf4', past: false };                                               // green — anything further out
}
function _pvApptCard(s) {
  if (!s.next_appointment_at) return '';
  const d = new Date(s.next_appointment_at);
  const when = isNaN(d) ? s.next_appointment_at
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const c = _pvApptBand(d);
  const badge = c.past ? `<span style="margin-left:6px; padding:1px 8px; background:#6b7280; color:#fff; border-radius:10px; font-size:0.7rem; font-weight:600;">past</span>` : '';
  const note = s.next_appointment_note ? `<div style="margin-top:1px; font-size:0.82rem; color:#000; font-style:italic; line-height:1.2;">${_esc(s.next_appointment_note)}</div>` : '';
  return `<div style="width:200px; box-sizing:border-box; display:flex; flex-direction:column; justify-content:center; padding:5px 14px; background:${c.bg}; border:1.5px solid ${c.bC}; border-radius:8px; text-align:center; line-height:1.25;">
    <div style="font-size:0.72rem; color:#000; font-weight:600; text-transform:uppercase; letter-spacing:0.4px;">📅 Next appointment${badge}</div>
    <div style="font-size:0.94rem; font-weight:700; color:#000;">${_esc(when)}</div>${note}</div>`;
}
function _pvReminderCard(s) {
  if (!s.reminder_text) return '';
  return `<div style="width:200px; max-width:100%; box-sizing:border-box; display:flex; flex-direction:column; justify-content:center; padding:5px 14px; background:#eef5ff; border:1.5px solid #eef5ff; border-radius:8px; text-align:center; line-height:1.25;">
    <div style="font-size:0.72rem; color:#1e40af; font-weight:600; text-transform:uppercase; letter-spacing:0.4px;">🔔 Reminder</div>
    <div style="font-size:0.92rem; font-weight:600; color:#1e3a8a;">${_esc(s.reminder_text)}</div></div>`;
}

// ── Site form ────────────────────────────────────────────────────
function pvOpenSiteForm(site) {
  document.getElementById('pv-site-modal-title').textContent = site ? 'Edit site' : 'Add site';
  document.getElementById('pv-site-id').value = site ? site.id : '';
  // Kind: a <select> with a "Custom…" option that reveals a free-text input.
  const kindSel = document.getElementById('pv-f-kind');
  const kindCustom = document.getElementById('pv-f-kind-custom');
  const kv = site ? (site.kind || '') : '';
  const known = [...kindSel.options].some(o => o.value === kv && o.value !== '' && o.value !== '__custom__');
  if (kv && !known) { kindSel.value = '__custom__'; kindCustom.value = kv; kindCustom.style.display = 'block'; }
  else { kindSel.value = kv; kindCustom.value = ''; kindCustom.style.display = 'none'; }
  ['name', 'main_tel', 'fax', 'email', 'website', 'vault_item', 'notes'].forEach(f =>
    document.getElementById('pv-f-' + f).value = site ? (site[f] || '') : '');
  document.getElementById('pv-tels').innerHTML = '';
  ((site && site.add_tels) || []).forEach(t => pvAddTelRow(t));
  // Appointment + reminder
  const parts = _pvIsoToParts(site ? site.next_appointment_at : '');
  document.getElementById('pv-f-appt-date').value = parts.date;
  document.getElementById('pv-f-appt-hour').value = parts.hour;
  document.getElementById('pv-f-appt-min').value = parts.minute;
  document.getElementById('pv-f-appt-note').value = site ? (site.next_appointment_note || '') : '';
  document.getElementById('pv-f-reminder').value = site ? (site.reminder_text || '') : '';
  document.getElementById('pv-site-modal').style.display = 'flex';
}
function pvKindChanged() {
  const sel = document.getElementById('pv-f-kind'), ci = document.getElementById('pv-f-kind-custom');
  const isCustom = sel.value === '__custom__';
  ci.style.display = isCustom ? 'block' : 'none';
  if (isCustom) ci.focus();
}
function pvCloseSiteForm() { document.getElementById('pv-site-modal').style.display = 'none'; }
function pvEditSite(id) { pvOpenSiteForm(_pvSites.find(s => s.id === id)); }
function pvAddTelRow(t) {
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:6px;';
  div.innerHTML = `<input class="pv-tel-person" placeholder="person / label" value="${_esc(t && t.person)}" style="flex:1;font-size:0.88rem;padding:5px 7px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;">
    <input class="pv-tel-num" placeholder="phone" value="${_esc(t && t.tel)}" style="flex:1;font-size:0.88rem;padding:5px 7px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;">
    <button class="btn btn-secondary btn-sm" onclick="this.parentElement.remove()">×</button>`;
  document.getElementById('pv-tels').appendChild(div);
}
async function pvSaveSite() {
  const id = document.getElementById('pv-site-id').value;
  const body = {};
  ['kind', 'name', 'main_tel', 'fax', 'email', 'website', 'vault_item', 'notes'].forEach(f => body[f] = document.getElementById('pv-f-' + f).value.trim());
  if (body.kind === '__custom__') body.kind = document.getElementById('pv-f-kind-custom').value.trim();
  if (!body.name) { alert('Name is required'); return; }
  body.add_tels = [...document.querySelectorAll('#pv-tels > div')].map(d => ({
    tel: d.querySelector('.pv-tel-num').value.trim(), person: d.querySelector('.pv-tel-person').value.trim(),
  })).filter(t => t.tel || t.person);
  const apptISO = _pvPartsToISO(document.getElementById('pv-f-appt-date').value.trim(),
    document.getElementById('pv-f-appt-hour').value.trim(), document.getElementById('pv-f-appt-min').value.trim());
  body.next_appointment_at = apptISO;
  body.next_appointment_note = apptISO ? document.getElementById('pv-f-appt-note').value.trim() : '';
  body.reminder_text = document.getElementById('pv-f-reminder').value.trim();
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
  // reset the 👁 show-password toggle each open so a password never leaks visibly
  document.getElementById('pv-pw-input').type = 'password';
  document.getElementById('pv-pw-input2').type = 'password';
  { const sc = document.getElementById('pv-pw-show'); if (sc) sc.checked = false; }
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
  document.getElementById('pv-link-name').value = '';
  document.getElementById('pv-link-url').value = '';
  document.getElementById('pv-link-add-status').textContent = '';
  document.getElementById('pv-path-name').value = '';
  document.getElementById('pv-path-value').value = '';
  document.getElementById('pv-path-add-status').textContent = '';
  document.getElementById('pv-docs-modal').style.display = 'flex';
  await pvLoadDocs();
}
function pvCloseDocs() { document.getElementById('pv-docs-modal').style.display = 'none'; _pvDocSite = null; }

// ── Receipts (per site) — structured data + link to the filed PDF ─────────────
let _pvRcSite = null, _pvReceipts = [];
async function pvOpenReceipts(siteId) {
  _pvRcSite = _pvSites.find(s => s.id === siteId);
  document.getElementById('pv-receipts-title').textContent = '🧾 ' + _pvRcSite.name;
  document.getElementById('pv-receipts-list').innerHTML = '<div style="color:#aaa;">Loading…</div>';
  document.getElementById('pv-receipts-total').textContent = '';
  document.getElementById('pv-receipts-modal').style.display = 'flex';
  await pvLoadReceipts();
}
function pvCloseReceipts() { document.getElementById('pv-receipts-modal').style.display = 'none'; _pvRcSite = null; if (_pvReceiptChart) { _pvReceiptChart.destroy(); _pvReceiptChart = null; } }
async function pvLoadReceipts() {
  try {
    const d = await (await fetch(`/api/privacy/sites/${_pvRcSite.id}/receipts`, { cache: 'no-store' })).json();
    _pvReceipts = d.rows || [];
    _pvReceiptPeriod = d.chart_period || 'monthly';
    const cur = (_pvReceipts[0] && _pvReceipts[0].currency) || 'ILS';
    document.getElementById('pv-receipts-total').innerHTML =
      `<b>${_pvReceipts.length}</b> receipt(s) · total <b>${(d.total || 0).toLocaleString()} ${cur === 'ILS' ? '₪' : _esc(cur)}</b>`;
  } catch (e) { _pvReceipts = []; }
  pvRenderReceipts();
  pvRenderReceiptChart();
}
let _pvReceiptChart = null, _pvReceiptPeriod = 'monthly';
function pvRenderReceiptChart() {
  const wrap = document.getElementById('pv-receipts-chartwrap');
  const rows = _pvReceipts.filter(r => r.invoice_date && r.amount != null);
  if (_pvReceiptChart) { _pvReceiptChart.destroy(); _pvReceiptChart = null; }
  if (!rows.length || typeof Chart === 'undefined') { wrap.style.display = 'none'; return; }
  // Group by the vendor's chosen period (set via /create-email-rule; default monthly).
  const P = _pvReceiptPeriod === 'yearly' ? { len: 4, word: 'year' }
          : _pvReceiptPeriod === 'daily'  ? { len: 10, word: 'day' }
          :                                 { len: 7, word: 'month' };
  // Sum amount per bucket (a vendor can have several receipts in one bucket).
  const buckets = {};
  rows.forEach(r => { const k = String(r.invoice_date).slice(0, P.len); buckets[k] = (buckets[k] || 0) + (parseFloat(r.amount) || 0); });
  const labels = Object.keys(buckets).sort();
  const vals = labels.map(k => Math.round(buckets[k] * 100) / 100);
  const cur = (rows[0].currency === 'ILS') ? '₪' : (rows[0].currency || '');
  const name = (_pvRcSite && _pvRcSite.name) || '';
  wrap.style.display = 'block';
  _pvReceiptChart = new Chart(document.getElementById('pv-receipts-chart').getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data: vals, backgroundColor: '#3a55a8', borderRadius: 3, maxBarThickness: 46 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: `Spend per ${P.word} — ${name}` },
        tooltip: { callbacks: { label: c => cur + c.parsed.y.toLocaleString() } }
      },
      scales: { y: { beginAtZero: true, ticks: { callback: v => cur + v } } }
    }
  });
}
function pvRenderReceipts() {
  const host = document.getElementById('pv-receipts-list');
  if (!_pvReceipts.length) { host.innerHTML = '<div style="color:#aaa;">No receipts yet. They appear here after an email-rule extracts them.</div>'; return; }
  host.innerHTML = '<table style="width:100%; border-collapse:collapse; font-size:0.86rem;">' +
    '<tr style="text-align:left; color:#666; border-bottom:2px solid #eee;">' +
    '<th style="padding:5px 6px;">Date</th><th>Vendor</th><th style="text-align:right;">Amount</th>' +
    '<th style="padding-left:12px;">Invoice&nbsp;#</th><th>PDF</th><th></th></tr>' +
    _pvReceipts.map(r => {
      const amt = (r.amount != null ? Number(r.amount).toLocaleString() : '—');
      const cur = (r.currency === 'ILS' ? '₪' : (r.currency || ''));
      const pdf = r.doc_id
        ? `<a href="/api/privacy/docs/${r.doc_id}/file" target="_blank" rel="noopener">📄 view</a>`
        : '<span style="color:#bbb;" title="PDF files when you next open this window">—</span>';
      return `<tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:5px 6px;">${_esc(r.invoice_date || '')}</td>
        <td>${_esc(r.vendor || '')}</td>
        <td style="text-align:right; font-weight:600;">${amt} ${cur}</td>
        <td style="padding-left:12px;">${_esc(r.invoice_no || '')}</td>
        <td>${pdf}</td>
        <td style="text-align:right;"><button class="btn btn-secondary btn-sm" style="color:#c0392b;" onclick="pvDeleteReceipt(${r.id})">Del</button></td>
      </tr>`;
    }).join('') + '</table>';
}
async function pvDeleteReceipt(id) {
  if (!confirm('Delete this receipt (and its filed PDF)?')) return;
  await fetch(`/api/privacy/receipts/${id}`, { method: 'DELETE' });
  await pvLoadReceipts();
  await pvLoadSites();   // refresh the site cards' receipt counts
}
function pvExportReceiptsCsv() {
  if (!_pvReceipts.length) { alert('No receipts to export.'); return; }
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [['Invoice date', 'Vendor', 'Amount', 'Currency', 'Invoice no'].map(esc).join(',')]
    .concat(_pvReceipts.map(r => [r.invoice_date, r.vendor, r.amount, r.currency, r.invoice_no].map(esc).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `receipts_${((_pvRcSite && _pvRcSite.name) || 'site').replace(/[^a-z0-9]+/gi, '_')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
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
    // Plain link (e.g. a Google Drive URL) — never encrypted; click opens it.
    if (d.kind === 'link') {
      const nm = d.doc_name || d.url;
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:1px solid #eee;padding:7px 2px;">
        <div style="min-width:0;"><span title="link">🔗</span>
          <a href="${_esc(d.url)}" target="_blank" rel="noopener" style="font-size:0.88rem;">${_esc(nm)}</a>
          <span style="font-size:0.72rem;color:#aaa;margin-left:6px;">link · ${_esc(d.created_at || '')}</span></div>
        <div style="display:flex;gap:5px;flex-shrink:0;">
          <button class="btn btn-secondary btn-sm" style="width:58px;flex-shrink:0;" onclick="pvOpenLink(${d.id})">Open</button>
          <button class="btn btn-secondary btn-sm" style="width:58px;flex-shrink:0;" onclick="pvEditLink(${d.id})">Edit</button>
          <button class="btn btn-secondary btn-sm" style="width:58px;flex-shrink:0;color:#c0392b;" onclick="pvDeleteDoc(${d.id})">Del</button></div>
      </div>`;
    }
    // Filesystem / network path — a pointer (no file). Open runs explorer.exe on
    // the host (this laptop); Copy is the fallback (browsers can't open a file
    // path from a page, and a remote viewer would paste it on their own machine).
    if (d.kind === 'path') {
      const nm = d.doc_name || d.url;
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:1px solid #eee;padding:7px 2px;">
        <div style="min-width:0;"><span title="path">📁</span>
          <span style="font-size:0.88rem;">${_esc(nm)}</span>
          <span style="font-size:0.74rem;color:#888;margin-left:6px;word-break:break-all;">${_esc(d.url)}</span>
          <span style="font-size:0.72rem;color:#aaa;margin-left:6px;">path · ${_esc(d.created_at || '')}</span></div>
        <div style="display:flex;gap:5px;flex-shrink:0;">
          <button class="btn btn-secondary btn-sm" style="width:58px;flex-shrink:0;box-sizing:border-box;" onclick="pvCopyPath(${d.id})" title="Copy the path, then paste into Windows Explorer">Copy</button>
          <button class="btn btn-secondary btn-sm" style="width:58px;flex-shrink:0;box-sizing:border-box;background:#3a7d44;color:#fff;" onclick="pvOpenPath(${d.id})" title="Open on this laptop (the dashboard host) in its default app / Explorer">Open</button>
          <button class="btn btn-secondary btn-sm" style="width:58px;flex-shrink:0;box-sizing:border-box;" onclick="pvEditPath(${d.id})">Edit</button>
          <button class="btn btn-secondary btn-sm" style="width:58px;flex-shrink:0;box-sizing:border-box;color:#c0392b;" onclick="pvDeleteDoc(${d.id})">Del</button></div>
      </div>`;
    }
    let name, locked = false;
    if (d.encrypted) {
      if (_pvKey) { try { name = (await _pvDecStr(_pvKey, d.name_iv, d.enc_name)).split('||')[0]; } catch (_) { name = '⚠ decrypt error'; } }
      else { name = 'Encrypted document'; locked = true; }
    } else { name = d.doc_name; }
    const icon = d.encrypted ? '🔒' : '🔓';
    const kb = d.file_size ? Math.max(1, Math.round(d.file_size / 1024)) + ' KB' : '';
    const actions = locked
      ? `<button class="btn btn-secondary btn-sm" style="width:58px;flex-shrink:0;opacity:0.4;cursor:not-allowed;" disabled title="Unlock to open">Open</button>
         <button class="btn btn-secondary btn-sm" style="width:58px;flex-shrink:0;opacity:0.4;cursor:not-allowed;" disabled title="Unlock to edit">Edit</button>`
      : `<button class="btn btn-secondary btn-sm" style="width:58px;flex-shrink:0;" onclick="pvViewDoc(${d.id})">Open</button>
         <button class="btn btn-secondary btn-sm" style="width:58px;flex-shrink:0;" onclick="pvRenameDoc(${d.id})">Edit</button>`;
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:1px solid #eee;padding:7px 2px;">
      <div style="min-width:0;"><span title="${d.encrypted ? 'encrypted' : 'plain'}">${icon}</span>
        <span style="font-size:0.88rem;">${_esc(name)}</span>
        <span style="font-size:0.72rem;color:#aaa;margin-left:6px;">${kb} · ${_esc(d.created_at || '')}</span></div>
      <div style="display:flex;gap:5px;flex-shrink:0;">${actions}
        <button class="btn btn-secondary btn-sm" style="width:58px;flex-shrink:0;color:#c0392b;" onclick="pvDeleteDoc(${d.id})">Del</button></div>
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

// ── Plain links (no file, no encryption) ──────────────────────────
async function pvAddLink() {
  const name = document.getElementById('pv-link-name').value.trim();
  const url  = document.getElementById('pv-link-url').value.trim();
  const st = document.getElementById('pv-link-add-status');
  if (!name || !url) { st.textContent = 'Name and URL required'; return; }
  st.textContent = 'Working…';
  try {
    const r = await fetch(`/api/privacy/sites/${_pvDocSite.id}/links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url }) });
    if (!r.ok) { st.textContent = 'Failed: ' + ((await r.json()).error || r.status); return; }
    st.textContent = '✓ added';
    document.getElementById('pv-link-name').value = '';
    document.getElementById('pv-link-url').value = '';
    await pvLoadDocs(); await pvLoadSites();
  } catch (e) { st.textContent = 'Error: ' + e.message; }
}
function pvOpenLink(id) { const d = _pvDocs.find(x => x.id === id); if (d && d.url) window.open(d.url, '_blank', 'noopener'); }
async function pvEditLink(id) {
  const d = _pvDocs.find(x => x.id === id);
  const nn = prompt('Link name:', d.doc_name || '');
  if (nn == null) return;
  const nu = prompt('URL:', d.url || '');
  if (nu == null) return;
  if (!nn.trim() || !nu.trim()) { alert('Name and URL are both required'); return; }
  await fetch(`/api/privacy/docs/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc_name: nn.trim(), url: nu.trim() }) });
  await pvLoadDocs();
}

// ── Paths (a filesystem / network path pointer — no file, no encryption) ──────
async function pvAddPath() {
  const name = document.getElementById('pv-path-name').value.trim();
  const p    = document.getElementById('pv-path-value').value.trim();
  const st = document.getElementById('pv-path-add-status');
  if (!name || !p) { st.textContent = 'Name and path required'; return; }
  st.textContent = 'Working…';
  try {
    const r = await fetch(`/api/privacy/sites/${_pvDocSite.id}/paths`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path: p }) });
    if (!r.ok) { st.textContent = 'Failed: ' + ((await r.json()).error || r.status); return; }
    st.textContent = '✓ added';
    document.getElementById('pv-path-name').value = '';
    document.getElementById('pv-path-value').value = '';
    await pvLoadDocs(); await pvLoadSites();
  } catch (e) { st.textContent = 'Error: ' + e.message; }
}
async function pvCopyPath(id) {
  const d = _pvDocs.find(x => x.id === id);
  if (!d || !d.url) return;
  try { await navigator.clipboard.writeText(d.url); document.getElementById('pv-path-add-status').textContent = '📋 copied: ' + d.url; }
  catch (_) { window.prompt('Copy this path:', d.url); }
}
// Open on the Windows host (the laptop running this dashboard). Server runs
// explorer.exe <path>; opens on the laptop, not on a remote viewer's device.
async function pvOpenPath(id) {
  const st = document.getElementById('pv-path-add-status');
  st.textContent = 'Opening on the laptop…';
  try {
    const r = await fetch(`/api/privacy/docs/${id}/open`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { st.textContent = 'Open failed: ' + (j.error || r.status); return; }
    st.textContent = '▶ opened on the laptop';
  } catch (e) { st.textContent = 'Error: ' + e.message; }
}
async function pvEditPath(id) {
  const d = _pvDocs.find(x => x.id === id);
  const nn = prompt('Path name:', d.doc_name || '');
  if (nn == null) return;
  const np = prompt('Path:', d.url || '');
  if (np == null) return;
  if (!nn.trim() || !np.trim()) { alert('Name and path are both required'); return; }
  await fetch(`/api/privacy/docs/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc_name: nn.trim(), url: np.trim() }) });
  await pvLoadDocs();
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

// ─── Daily Journal (Privacy → Daily Journal tab) ─────────────────────────────
const PVJ_MOODS = ['😞', '😕', '😐', '🙂', '😄'];   // 1..5 — ONE mood per reminder capture
const PVJ_UID = 1;                                   // Vadim (household_users.id)
const PVJ_DEFAULT_CATS = [{ id: 'general', name: 'General' }];   // seed when none set
let pvjCfg = { enabled: false, user_id: PVJ_UID, slots: [], categories: [] };
let pvjEntries = [];
const pvjEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function _pvjFrom(days) { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); }
// active category list (falls back to a single "General" so the journal always works)
function pvjCats() { return (pvjCfg.categories && pvjCfg.categories.length) ? pvjCfg.categories : PVJ_DEFAULT_CATS; }

async function pvJournalLoadCfg() {
  try {
    const j = await (await fetch('/api/dashboard-settings/journal')).json();
    const v = (j && j.value) || {};
    pvjCfg = { enabled: v.enabled === true, user_id: Number(v.user_id) || PVJ_UID,
               slots: Array.isArray(v.slots) ? v.slots : [],
               categories: Array.isArray(v.categories) ? v.categories : [] };
  } catch (e) { pvjCfg = { enabled: false, user_id: PVJ_UID, slots: [], categories: [] }; }
  pvJournalCfgRender();
}
function pvJournalCfgRender() {
  const en = document.getElementById('pvj-enabled'); if (en) en.checked = !!pvjCfg.enabled;
  const box = document.getElementById('pvj-slots');
  if (box) {
    box.innerHTML = !pvjCfg.slots.length
      ? '<div style="font-size:0.82rem;color:#aaa;margin:6px 0;">No reminders yet — click “+ Add reminder”.</div>'
      : pvjCfg.slots.map((s, i) => `
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
          <input value="${pvjEsc(s.name || '')}" data-pvj-i="${i}" data-pvj-k="name" placeholder="name (e.g. בוקר)"
            style="flex:1; padding:5px 8px; border:1px solid #ccc; border-radius:4px;">
          <input type="time" value="${pvjEsc(s.time_hm || '')}" data-pvj-i="${i}" data-pvj-k="time_hm"
            style="padding:5px 8px; border:1px solid #ccc; border-radius:4px;">
          <button onclick="pvJournalCfgRemoveSlot(${i})" title="Remove"
            style="padding:3px 9px; border:1px solid #c0392b; color:#c0392b; background:#fff; border-radius:4px; cursor:pointer;">✕</button>
        </div>`).join('');
  }
  const cbox = document.getElementById('pvj-cats');
  if (cbox) {
    cbox.innerHTML = !pvjCfg.categories.length
      ? '<div style="font-size:0.82rem;color:#aaa;margin:6px 0;">No categories yet — a single “General” is used until you add some.</div>'
      : pvjCfg.categories.map((c, i) => `
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
          <input value="${pvjEsc(c.name || '')}" data-pvjc-i="${i}" placeholder="category (e.g. פוליטיקה)"
            style="flex:1; padding:5px 8px; border:1px solid #ccc; border-radius:4px;">
          <button onclick="pvJournalCatRemove(${i})" title="Remove"
            style="padding:3px 9px; border:1px solid #c0392b; color:#c0392b; background:#fff; border-radius:4px; cursor:pointer;">✕</button>
        </div>`).join('');
  }
}
function pvJournalCfgCollect() {
  const slots = pvjCfg.slots.map(s => ({ ...s }));
  document.querySelectorAll('[data-pvj-i]').forEach(inp => {
    const i = parseInt(inp.dataset.pvjI), k = inp.dataset.pvjK;
    while (slots.length <= i) slots.push({});
    slots[i][k] = inp.value;
  });
  return slots.filter(s => s.time_hm).map(s => ({
    id: s.id || ('s' + Math.random().toString(36).slice(2, 9)),
    name: (s.name || '').trim(), time_hm: s.time_hm,
  }));
}
// Categories keep a STABLE id across renames (entries link by id) — the name input
// only edits the label. Rows with a blank name are dropped on collect/save.
function pvJournalCatCollect() {
  const cats = pvjCfg.categories.map(c => ({ ...c }));
  document.querySelectorAll('[data-pvjc-i]').forEach(inp => {
    const i = parseInt(inp.dataset.pvjcI);
    while (cats.length <= i) cats.push({});
    cats[i].name = inp.value;
  });
  return cats.filter(c => (c.name || '').trim()).map(c => ({
    id: c.id || ('c' + Math.random().toString(36).slice(2, 9)),
    name: (c.name || '').trim(),
  }));
}
function pvJournalCfgAddSlot() { pvjCfg.slots = pvJournalCfgCollect(); pvjCfg.categories = pvJournalCatCollect(); pvjCfg.slots.push({ id: 's' + Math.random().toString(36).slice(2, 9), name: '', time_hm: '12:00' }); pvJournalCfgRender(); }
function pvJournalCfgRemoveSlot(i) { pvjCfg.slots = pvJournalCfgCollect(); pvjCfg.categories = pvJournalCatCollect(); pvjCfg.slots.splice(i, 1); pvJournalCfgRender(); }
function pvJournalCatAdd() { pvjCfg.slots = pvJournalCfgCollect(); pvjCfg.categories = pvJournalCatCollect(); pvjCfg.categories.push({ id: 'c' + Math.random().toString(36).slice(2, 9), name: '' }); pvJournalCfgRender(); }
function pvJournalCatRemove(i) { pvjCfg.slots = pvJournalCfgCollect(); pvjCfg.categories = pvJournalCatCollect(); pvjCfg.categories.splice(i, 1); pvJournalCfgRender(); }
async function pvJournalCfgSave() {
  const st = document.getElementById('pvj-cfg-status');
  const value = { enabled: document.getElementById('pvj-enabled').checked, user_id: PVJ_UID, slots: pvJournalCfgCollect(), categories: pvJournalCatCollect() };
  try {
    const r = await fetch('/api/dashboard-settings/journal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    pvjCfg = value; pvJournalCfgRender();
    if (st) { st.style.color = '#2e7d32'; st.textContent = '✓ Saved'; setTimeout(() => { st.textContent = ''; }, 2000); }
  } catch (e) { if (st) { st.style.color = '#c0392b'; st.textContent = 'Error: ' + (e.message || e); } }
}

// "Today" as the Asia/Jerusalem local day (YYYY-MM-DD) — independent of the
// device's timezone, so the entry_date we send always matches the server's day
// even when the laptop is abroad (en-CA formats as YYYY-MM-DD; he-IL would give
// DD.MM.YYYY which a <input type="date"> can't consume).
function pvjTodayJeru() {
  // Travel-aware: when the `daily_journal` feature travels (Privacy → Settings →
  // Travel), "today" follows the active country's timezone; else Asia/Jerusalem.
  const tz = (window.activeTzFor ? window.activeTzFor('daily_journal') : 'Asia/Jerusalem');
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}
// ── Daily Journal media attachments (photos/videos on the QNAP media library) ──
// Bytes go browser → media agent (LXC 100) → /mnt/media (QNAP) ONLY; Postgres
// (journal_media) stores just the path. Deleting an attachment removes the link AND the
// file on the NAS (see routes-journal.js) — it is a real delete, not a detach.
const PVJ_MEDIA_INGEST = 'http://192.168.1.138:8767';   // POST /api/media/upload
const PVJ_MEDIA_PLAYER = 'http://192.168.1.138:8766';   // /api/media/thumb + /stream
let pvjMediaMap = {};                                   // "<date>|<slot>" → [rows]
const pvjMediaKey = (d, s) => d + '|' + s;
const pvjRelOf  = (p) => String(p || '').replace(/^\/mnt\/media\//, '');
const pvjRelEnc = (p) => pvjRelOf(p).split('/').map(encodeURIComponent).join('/');
const pvjThumb  = (p) => PVJ_MEDIA_PLAYER + '/api/media/thumb?path=' + encodeURIComponent(pvjRelOf(p));

// Upload + metadata prompt now live in js/journal-media.js so the Communication page
// (WhatsApp -> journal) uses the very same code. Thin wrappers keep the call sites here.
const pvjUpload = (file, dateStr) => window.journalUploadMedia(file, dateStr);

async function pvJournalLoadMedia(from, to, merge) {
  let rows = [];
  try {
    const p = new URLSearchParams({ user_id: PVJ_UID });
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    rows = await (await fetch('/api/journal/media?' + p)).json();
  } catch (e) { rows = []; }
  if (!merge) pvjMediaMap = {};
  (rows || []).forEach(m => {
    const k = pvjMediaKey(m.entry_date, m.slot_id);
    (pvjMediaMap[k] = pvjMediaMap[k] || []);
    if (!pvjMediaMap[k].some(x => x.id === m.id)) pvjMediaMap[k].push(m);
  });
}
// Thumbnail row (HTML string) for a capture — used by Today, History, and Search.
function pvjMediaChipsHtml(date, slot) {
  const list = pvjMediaMap[pvjMediaKey(date, slot)] || [];
  if (!list.length) return '';
  return list.map(m => {
    const rel = pvjRelEnc(m.media_path);
    const thumb = m.media_type === 'image'
      ? `<img src="${pvjThumb(m.media_path)}" style="height:52px;width:52px;object-fit:cover;border-radius:6px;display:block;background:#0b3b37;">`
      : `<span style="display:inline-flex;align-items:center;justify-content:center;height:52px;width:52px;background:#0b3b37;color:#fff;border-radius:6px;font-size:1.4rem;">🎬</span>`;
    return `<span style="position:relative;display:inline-block;">
      <span style="cursor:pointer;" title="${pvjEsc(m.orig_name || '')}" onclick="pvjLightbox('${rel}','${m.media_type}')">${thumb}</span>
      <button title="Delete from the journal and from the NAS" onclick="pvJournalDetach(${m.id})"
        style="position:absolute;top:-7px;right:-7px;background:#c0392b;color:#fff;border:none;border-radius:50%;width:18px;height:18px;line-height:16px;font-size:0.7rem;cursor:pointer;padding:0;">✕</button>
    </span>`;
  }).join('');
}
async function pvJournalAttach(input, slotId) {
  if (!input.files || !input.files.length) return;
  const D = document.getElementById('pvj-date')?.value || pvjTodayJeru();
  const files = Array.from(input.files); input.value = '';
  const box = document.querySelector(`.pvj-media[data-slot="${slotId}"]`);
  const uploaded = [];
  for (const f of files) {
    const type = (f.type || '').startsWith('video') ? 'video' : 'image';
    let ph = null;
    if (box) { ph = document.createElement('span'); ph.textContent = '⏳'; ph.style.cssText = 'font-size:1.3rem;'; box.appendChild(ph); }
    try {
      const path = await pvjUpload(f, D);
      await fetch('/api/journal/media', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: PVJ_UID, entry_date: D, slot_id: slotId, media_path: path, media_type: type, orig_name: f.name }),
      });
      uploaded.push({ file: f, path });
      if (ph) ph.remove();
    } catch (e) { if (ph) { ph.textContent = '✗'; ph.title = e.message || 'failed'; } }
  }
  // Show the attached chips now; the metadata prompt runs after.
  await pvJournalLoadMedia(D, D, true);
  const b2 = document.querySelector(`.pvj-media[data-slot="${slotId}"]`);
  if (b2) b2.innerHTML = pvjMediaChipsHtml(D, slotId);
  await pvJournalLoadEntries(); pvJournalRenderTimeline();

  // Per-file metadata prompt (Event/Year/Location/People). Kick a media scan first so the
  // library rows register (async), then prompt + PATCH each. Skip leaves it date-named only.
  if (uploaded.length) {
    try { await fetch(PVJ_MEDIA_INGEST + '/api/media/scan', { method: 'POST' }); } catch (_) {}
    for (const u of uploaded) {
      const meta = await pvjMediaMetaPrompt(u.file.name, D);
      if (meta) await pvjApplyMediaMeta(u.path, meta);
    }
  }
}

// Per-file metadata prompt for a just-attached journal item. Resolves the metadata object
// on Save, or null on Skip. Reuses the same fields as the analyzer's edit modal.
const pvjMediaMetaPrompt = (fileName, dateStr) => window.journalMediaMetaPrompt(fileName, dateStr);


// Wait for the media_library row (registered async by the scan) then PATCH the metadata.
// Uses the exact endpoints the analyzer edit modal uses: GET (player :8766), PATCH (ingest :8767).
const pvjApplyMediaMeta = (path, meta) => window.journalApplyMediaMeta(path, meta);

async function pvJournalDetach(id) {
  if (!confirm('Delete this photo/video? It is removed from the journal AND deleted from the media library on the NAS.')) return;
  try { await fetch('/api/journal/media/' + id, { method: 'DELETE' }); } catch (e) { /* ignore */ }
  const D = document.getElementById('pvj-date')?.value || pvjTodayJeru();
  await pvJournalLoadMedia(_pvjFrom(90));
  await pvJournalLoadMedia(D, D, true);
  document.querySelectorAll('.pvj-media[data-slot]').forEach(el => { el.innerHTML = pvjMediaChipsHtml(D, el.dataset.slot); });
  pvJournalRenderTimeline();
  const sr = document.getElementById('pvj-search-results');
  if (sr && sr.innerHTML.includes('pvjLightbox')) pvJournalSearch();
}
function pvjLightbox(relEnc, type) {
  let m = document.getElementById('pvj-lightbox');
  if (!m) {
    m = document.createElement('div');
    m.id = 'pvj-lightbox';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:100000;display:none;align-items:center;justify-content:center;';
    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close) pvjLightboxClose(); });
    document.body.appendChild(m);
  }
  const url = PVJ_MEDIA_PLAYER + '/api/media/stream/' + relEnc;
  m.innerHTML = (type === 'video'
    ? `<video src="${url}" controls autoplay playsinline style="max-width:92vw;max-height:88vh;border-radius:8px;background:#000;"></video>`
    : `<img src="${url}" style="max-width:92vw;max-height:88vh;border-radius:8px;object-fit:contain;">`)
    + `<button data-close="1" style="position:absolute;top:14px;right:18px;background:#fff;border:none;border-radius:6px;font-size:1.1rem;cursor:pointer;padding:4px 12px;">✕</button>`;
  m.style.display = 'flex';
}
function pvjLightboxClose() { const m = document.getElementById('pvj-lightbox'); if (m) { m.style.display = 'none'; m.innerHTML = ''; } }

async function pvJournalOnShow() {
  if (window.loadTravelSettings) { try { await window.loadTravelSettings(true); } catch (e) {} }
  await pvJournalLoadCfg();
  pvJournalSearchCats();
  // Default to today (Jerusalem) on every open, so normal daily use isn't left
  // pointed at a previously back-dated day.
  const dEl = document.getElementById('pvj-date');
  if (dEl) { dEl.max = pvjTodayJeru(); dEl.value = pvjTodayJeru(); }
  await pvJournalRenderToday();
  await pvJournalLoadEntries();
  pvJournalRenderTimeline();
}
async function pvJournalRenderToday() {
  const box = document.getElementById('pvj-today'); if (!box) return;
  // The card authors ONE date — today by default, or any past day picked in
  // #pvj-date (back-dating). Load that day's existing rows to pre-fill.
  const D = document.getElementById('pvj-date')?.value || pvjTodayJeru();
  const hintEl = document.getElementById('pvj-backdate-hint');
  if (hintEl) {
    const back = D !== pvjTodayJeru();
    hintEl.style.display = back ? '' : 'none';
    if (back) hintEl.textContent = `Back-dating to ${D} — fill any box and Save.`;
  }
  let today = [];
  try { today = await (await fetch(`/api/journal?user_id=${PVJ_UID}&from=${D}&to=${D}`)).json(); } catch (e) { today = []; }
  await pvJournalLoadMedia(D, D, true);   // attachments for this day (merge — keeps history map)
  // key existing entries by slot → category
  const byId = {}; (today || []).forEach(e => { (byId[e.slot_id] = byId[e.slot_id] || {})[e.category_id] = e; });
  if (!pvjCfg.slots.length) { box.innerHTML = '<div style="font-size:0.86rem;color:#888;">No journal reminders configured — set them in <b>Settings → 📓 Daily Journal reminders</b>.</div>'; return; }
  const cats = pvjCats();
  box.innerHTML = pvjCfg.slots.map(s => {
    const bySlot = byId[s.id] || {};
    // one mood per reminder — read it from any existing category row of this slot
    const mood = Number(Object.values(bySlot).map(e => e.mood).find(m => m != null)) || 0;
    const catBoxes = cats.map(c => {
      const e = bySlot[c.id] || {};
      return `<div style="margin-bottom:8px;">
        <div style="font-size:0.8rem; color:#0f766e; font-weight:600; margin-bottom:3px;">${pvjEsc(c.name)}</div>
        <textarea dir="rtl" rows="2" data-cat="${pvjEsc(c.id)}" data-catname="${pvjEsc(c.name)}" data-eid="${e.id != null ? e.id : ''}"
          placeholder="…" style="width:100%; box-sizing:border-box; resize:vertical; border:1px solid #ddd; border-radius:6px; padding:6px 9px; font-size:0.95rem;">${pvjEsc(e.comment || '')}</textarea>
      </div>`;
    }).join('');
    return `<div style="border:1px solid #eee; border-radius:8px; padding:10px 12px; margin-bottom:10px;" data-pvj-slot="${pvjEsc(s.id)}" data-pvj-name="${pvjEsc(s.name)}"${mood ? ` data-mood="${mood}"` : ''}>
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;"><b>${pvjEsc(s.name || 'Journal')}</b><span style="font-size:0.78rem;color:#999;">${pvjEsc(s.time_hm || '')}</span></div>
      ${catBoxes}
      <div style="display:flex; align-items:center; gap:10px; margin-top:4px;">
        <div class="pvj-mood" title="Mood for this reminder" style="display:flex; gap:3px;">
          ${PVJ_MOODS.map((m, i) => `<button type="button" data-mood="${i + 1}" style="font-size:1.3rem; background:${mood === i + 1 ? '#dcfce7' : '#f6f6f6'}; border:2px solid ${mood === i + 1 ? '#16a34a' : 'transparent'}; border-radius:7px; cursor:pointer; padding:2px 5px;">${m}</button>`).join('')}
        </div>
        <button onclick="pvJournalSaveToday(this)" class="btn btn-sm" style="background:#0f766e; color:#fff; margin-left:auto;">💾 Save</button>
        <span class="pvj-slot-status" style="font-size:0.8rem; color:#2e7d32;"></span>
      </div>
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:8px;">
        <label style="cursor:pointer; background:#f0fdfa; color:#0f766e; border:1px solid #99f6e4; border-radius:6px; padding:4px 10px; font-size:0.82rem; white-space:nowrap;">📎 Photo/Video
          <input type="file" accept="image/*,video/*" multiple style="display:none;" onchange="pvJournalAttach(this,'${pvjEsc(s.id)}')">
        </label>
        <div class="pvj-media" data-slot="${pvjEsc(s.id)}" style="display:flex; flex-wrap:wrap; gap:8px; align-items:center;">${pvjMediaChipsHtml(D, s.id)}</div>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-pvj-slot]').forEach(row => {
    row.querySelectorAll('.pvj-mood button').forEach(mb => mb.addEventListener('click', () => {
      row.dataset.mood = mb.getAttribute('data-mood');
      row.querySelectorAll('.pvj-mood button').forEach(b => { b.style.borderColor = 'transparent'; b.style.background = '#f6f6f6'; });
      mb.style.borderColor = '#16a34a'; mb.style.background = '#dcfce7';
    }));
  });
}
async function pvJournalSaveToday(btn) {
  const row = btn.closest('[data-pvj-slot]');
  const st = row.querySelector('.pvj-slot-status');
  const mood = row.dataset.mood ? parseInt(row.dataset.mood) : null;   // one mood per reminder
  // Author date. For TODAY, omit entry_date so the server stays authoritative on
  // the date (identical to the original behaviour — no client/server midnight
  // clock-skew for normal same-day capture). Only send it when back-dating.
  const D = document.getElementById('pvj-date')?.value || pvjTodayJeru();
  const dateField = (D && D !== pvjTodayJeru()) ? { entry_date: D } : {};
  const post = (cat, name, comment) => fetch('/api/journal', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: PVJ_UID, ...dateField, slot_id: row.dataset.pvjSlot, slot_name: row.dataset.pvjName,
      category_id: cat, category_name: name, comment, mood }) });
  // Per box: text → upsert; emptied a box that HAD a saved row → delete it; untouched empty → skip.
  const posts = [];
  row.querySelectorAll('textarea[data-cat]').forEach(ta => {
    const comment = (ta.value || '').trim();
    if (comment) posts.push(post(ta.dataset.cat, ta.dataset.catname, comment));
    else if (ta.dataset.eid) posts.push(fetch(`/api/journal/${ta.dataset.eid}`, { method: 'DELETE' }));
  });
  // mood-only capture (no category text, nothing to delete) → attach the mood to the first category
  if (!posts.length && mood) {
    const ta = row.querySelector('textarea[data-cat]');
    if (ta) posts.push(post(ta.dataset.cat, ta.dataset.catname, ''));
  }
  if (!posts.length) { row.querySelector('textarea[data-cat]')?.focus(); return; }
  try {
    const rs = await Promise.all(posts);
    if (rs.some(r => !r.ok)) throw new Error('save');
    if (st) { st.textContent = '✓'; setTimeout(() => { st.textContent = ''; }, 1500); }
    await pvJournalRenderToday();
    await pvJournalLoadEntries(); pvJournalRenderTimeline();
  } catch (e) { if (st) { st.style.color = '#c0392b'; st.textContent = 'Failed'; } }
}
async function pvJournalLoadEntries() {
  try { pvjEntries = await (await fetch(`/api/journal?user_id=${PVJ_UID}&from=${_pvjFrom(90)}`)).json(); }
  catch (e) { pvjEntries = []; }
  await pvJournalLoadMedia(_pvjFrom(90));   // attachments for the same 90-day history window
}
// Shared renderer (History + Search): group Day → Reminder(slot). The mood is
// shown ONCE per reminder (it's a single value for the whole capture), with its
// categories listed underneath — never a mood-per-category.
function _pvjEntryList(rows) {
  if (!rows.length) return '<div style="color:#aaa;">No entries.</div>';
  const byDay = {}; rows.forEach(e => { (byDay[e.entry_date] = byDay[e.entry_date] || []).push(e); });
  const days = Object.keys(byDay).sort().reverse();
  return days.map(d => {
    const bySlot = {}; byDay[d].forEach(e => { (bySlot[e.slot_id] = bySlot[e.slot_id] || []).push(e); });
    const blocks = Object.keys(bySlot).map(sid => {
      const es = bySlot[sid];
      const mood = Number(es.map(e => e.mood).find(m => m != null)) || 0;   // one per reminder
      const lines = es.map(e => `<div style="display:flex; gap:8px; align-items:flex-start; margin:2px 0;">
        <span style="font-size:0.72rem; color:#0f766e; background:#e6f4f1; border-radius:4px; padding:1px 6px; white-space:nowrap;">${pvjEsc(e.category_name || 'General')}</span>
        <span dir="rtl" style="flex:1; text-align:right;">${pvjEsc(e.comment || '')}</span>
        <button onclick="pvJournalDelEntry(${e.id})" title="Delete" style="border:none;background:none;color:#c0392b;cursor:pointer;font-size:0.8rem;">✕</button>
      </div>`).join('');
      const mediaHtml = pvjMediaChipsHtml(d, sid);
      return `<div style="margin:4px 0 8px;">
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:2px;">
          <span style="font-size:1.15rem;" title="mood for this reminder">${mood ? PVJ_MOODS[mood - 1] : '·'}</span>
          <span style="font-size:0.78rem; color:#999;">${pvjEsc(es[0].slot_name || '')}</span>
        </div>
        <div style="padding-left:28px;">${lines}</div>
        ${mediaHtml ? `<div style="padding-left:28px; margin-top:6px; display:flex; flex-wrap:wrap; gap:8px; align-items:center;">${mediaHtml}</div>` : ''}
      </div>`;
    }).join('');
    return `<div style="border-top:1px solid #f0eee8; padding:8px 0;">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
        <span style="font-weight:700; color:#0f766e;">${pvjEsc(d)}</span>
        <button onclick="pvJournalEditDay('${pvjEsc(d)}')" title="Load this day into the entry card above to edit" style="border:1px solid #0f766e; background:#fff; color:#0f766e; border-radius:5px; cursor:pointer; font-size:0.72rem; padding:1px 7px;">✎ Edit</button>
      </div>
      ${blocks}
    </div>`;
  }).join('');
}
const PVJ_HIST_DAYS = 10;   // history shows only the last N days (older → use Search)
function pvJournalRenderTimeline() {
  const box = document.getElementById('pvj-timeline'); if (!box) return;
  const rows = pvjEntries || [];
  const allDays = [...new Set(rows.map(e => e.entry_date))].sort().reverse();
  const keep = new Set(allDays.slice(0, PVJ_HIST_DAYS));
  const shown = rows.filter(e => keep.has(e.entry_date));
  box.innerHTML = _pvjEntryList(shown)
    + (allDays.length > PVJ_HIST_DAYS
        ? `<div style="color:#999; font-size:0.8rem; padding:8px 0; border-top:1px solid #f0eee8;">Showing the last ${PVJ_HIST_DAYS} days. For older entries use <b>Search</b> above.</div>`
        : '');
}
// Load a history/search day into the editable Entry card above (back-date + reload).
function pvJournalEditDay(dateStr) {
  const dp = document.getElementById('pvj-date');
  if (dp) dp.value = dateStr;
  pvJournalRenderToday();
  const card = document.getElementById('pvj-today');
  if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
// ── Search: by category + words + date range (full history, server-side) ──
function pvJournalSearchCats() {
  const sel = document.getElementById('pvj-s-cat'); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' +
    pvjCats().map(c => `<option value="${pvjEsc(c.id)}">${pvjEsc(c.name)}</option>`).join('');
  sel.value = cur;
}
async function pvJournalSearch() {
  const box = document.getElementById('pvj-search-results'); if (!box) return;
  const cat = document.getElementById('pvj-s-cat')?.value || '';
  const q = document.getElementById('pvj-s-q')?.value.trim() || '';
  const from = document.getElementById('pvj-s-from')?.value || '';
  const to = document.getElementById('pvj-s-to')?.value || '';
  const p = new URLSearchParams({ user_id: PVJ_UID });
  if (cat) p.set('cat', cat); if (q) p.set('q', q); if (from) p.set('from', from); if (to) p.set('to', to);
  box.innerHTML = '<div style="color:#aaa;">Searching…</div>';
  let rows = [];
  try { rows = await (await fetch(`/api/journal/search?${p}`)).json(); } catch (e) { rows = []; }
  // Load attachments for the searched range so thumbnails show under matched entries.
  await pvJournalLoadMedia(from || _pvjFrom(365), to || '', true);
  box.innerHTML = _pvjEntryList(Array.isArray(rows) ? rows : []);
}
function pvJournalSearchClear() {
  ['pvj-s-cat', 'pvj-s-q', 'pvj-s-from', 'pvj-s-to'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const box = document.getElementById('pvj-search-results'); if (box) box.innerHTML = '<div style="color:#aaa;">Enter a filter and press Search.</div>';
}
async function pvJournalDelEntry(id) {
  if (!confirm('Delete this journal entry?')) return;
  await fetch(`/api/journal/${id}`, { method: 'DELETE' });
  await pvJournalLoadEntries(); pvJournalRenderToday(); pvJournalRenderTimeline();
  // if the Search results are showing, refresh them too (the row may be there)
  const sr = document.getElementById('pvj-search-results');
  if (sr && sr.querySelector('[onclick^="pvJournalDelEntry"]')) pvJournalSearch();
}
// Refresh the tab after a capture-panel Save (reminders-badge dispatches this).
window.addEventListener('ph-journal-changed', () => {
  if (document.getElementById('tab-journal')) { pvJournalRenderToday(); pvJournalLoadEntries().then(() => pvJournalRenderTimeline()); }
});
