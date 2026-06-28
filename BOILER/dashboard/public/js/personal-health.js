// Personal Health — Medical → Personal Health tab (minimum first step).
// People come from the canonical `household_users` table (Privacy → Settings →
// Users) via GET /api/household-users. This tab attaches a body profile
// (sex / DOB / height) + a weight log to each member, and computes BMI / age /
// ideal-weight. No people are created here.
(function () {
  const API = '/api/personal-health';
  let _users = [];      // household member objects {id,name,…} (from /api/household-users)
  let _profiles = [];   // ph_profiles rows (body details, keyed by name)
  let _selName = null;  // currently-selected household member
  let _curProfileId = null; // resolved ph_profiles.id of the selected person (meds + weight)
  let _meds = [], _editMedId = null;
  let _doctors = [], _infoMedId = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const dpart = (s) => (s ? String(s).slice(0, 10) : '');
  const _hm2min = (hm) => { const [h, m] = (hm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  let _waterCfg = {};   // global water goal/window (Medical → Settings → 💧 Water)
  async function _loadWaterCfg() {
    try { const j = await (await fetch('/api/dashboard-settings/medical.water')).json(); _waterCfg = (j && j.value) || {}; }
    catch (e) { _waterCfg = {}; }
  }
  const userByName = (name) => _users.find(u => u && u.name === name) || null;
  // Resolve a member's health profile by the stable user_id (the canonical link, so a
  // member rename can't orphan it); fall back to name during the transition window.
  const profileFor = (name) => {
    const u = userByName(name);
    return _profiles.find(p => (u && p.user_id === u.id) || p.name === name) || null;
  };

  function age(dob) {
    if (!dob) return null;
    const d = new Date(dob), n = new Date();
    let a = n.getFullYear() - d.getFullYear();
    const m = n.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && n.getDate() < d.getDate())) a--;
    return a;
  }
  function bmi(w, h) { if (!w || !h) return null; const m = h / 100; return w / (m * m); }
  function bmiCat(b) {
    if (b == null) return { label: '', color: '#888' };
    if (b < 18.5)  return { label: 'Underweight', color: '#e67e22' };
    if (b < 25)    return { label: 'Normal',      color: '#2e7d32' };
    if (b < 30)    return { label: 'Overweight',  color: '#e67e22' };
    return           { label: 'Obese',          color: '#c0392b' };
  }
  function idealRange(h) { if (!h) return null; const m = h / 100; return { lo: 18.5 * m * m, hi: 24.9 * m * m }; }
  // Waist-to-Hip Ratio = waist ÷ hip. WHO health bands differ by sex.
  function whr(waist, hip) { return (!waist || !hip) ? null : waist / hip; }
  function whrCat(r, sex) {
    if (r == null) return { label: '', color: '#888' };
    const male = (sex || '').toLowerCase().startsWith('m');
    const mod = male ? 0.90 : 0.80, high = male ? 1.00 : 0.85; // men / women cut-points
    if (r < mod)  return { label: 'Low',      color: '#2e7d32' };
    if (r < high) return { label: 'Moderate', color: '#e67e22' };
    return            { label: 'High',     color: '#c0392b' };
  }

  async function phInit() {
    _phLoadApptColors();   // shared Schedule & appointment color bands (Privacy → Settings)
    const [uRes, pRes] = await Promise.all([
      fetch('/api/household-users').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(API + '/profiles').then(r => r.json()).catch(() => []),
      _loadWaterCfg(),   // sets _waterCfg (global goal/window) before renderDetail
      _loadExCfg(),      // sets _exCfg (global exercise definitions) before renderDetail
    ]);
    const uv = uRes;   // /api/household-users returns the member array directly
    _users = (Array.isArray(uv) ? uv : []).filter(u => u && (u.name || '').trim());
    _profiles = Array.isArray(pRes) ? pRes : [];
    const sel = $('ph-person');
    sel.innerHTML = '<option value="">— select person —</option>' +
      _users.map(u => `<option value="${esc(u.name)}">${esc(u.name)}</option>`).join('');
    $('ph-no-users').style.display = _users.length ? 'none' : '';
    // Prescriber dropdown ← your doctors (Medical → Contacts, kind='doctor').
    try {
      const cs = await (await fetch('/api/medical/contacts')).json();
      _doctors = (Array.isArray(cs) ? cs : []).filter(c => c.kind === 'doctor');
    } catch (e) { _doctors = []; }
    const ps = $('ph-i-prescriber');
    if (ps) ps.innerHTML = '<option value="">—</option>' +
      _doctors.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    if (_selName && _users.some(u => u.name === _selName)) { sel.value = _selName; showEdit(true); renderDetail(); }
    else { _selName = null; showEdit(false); $('ph-detail').style.display = 'none'; }
  }
  window.phInit = phInit;

  const showEdit = (on) => { $('ph-edit-btn').style.display = on ? '' : 'none'; };

  window.phSelectPerson = function (name) {
    _selName = name || null;
    if (_selName) { showEdit(true); renderDetail(); }
    else { showEdit(false); $('ph-detail').style.display = 'none'; }
  };

  // ── allergies / conditions — stored as newline-joined text, edited as add-as-many-
  // as-needed input rows, shown read-only as chips. Each line = one item (so the
  // future med cross-check can match them individually). ──
  const _phSplit = (s) => (s ? String(s).split(/\n+/).map(x => x.trim()).filter(Boolean) : []);
  function _phListRowHtml(kind, value, idx) {
    const ph = kind === 'allergies' ? 'e.g. penicillin' : 'e.g. hypertension';
    return `<div style="display:flex;gap:6px;margin-bottom:4px;align-items:center;">
      <span style="font-size:0.74rem;color:#999;min-width:18px;text-align:right;">${idx + 1}.</span>
      <input type="text" class="ph-f-${kind}-item" value="${esc(value)}" placeholder="${ph}" style="padding:5px 8px;width:200px;">
      <button type="button" onclick="phRemoveListItem('${kind}', this)" title="Remove" style="border:none;background:#f3e0e0;color:#c0392b;border-radius:4px;cursor:pointer;padding:0 9px;font-size:1rem;line-height:1.4;">×</button>
    </div>`;
  }
  function phRenderList(kind, items) {
    const arr = (items && items.length) ? items : [''];   // always show one blank row
    $('ph-f-' + kind + '-list').innerHTML = arr.map((v, i) => _phListRowHtml(kind, v, i)).join('');
  }
  // read ALL current inputs (incl. empties) so add/remove re-renders keep typed values
  const _phReadList = (kind) => Array.from(document.querySelectorAll('.ph-f-' + kind + '-item')).map(i => i.value);
  window.phAddListItem = function (kind) {
    const vals = _phReadList(kind); vals.push('');
    phRenderList(kind, vals);   // re-render → numbers stay 1…N
    const items = document.querySelectorAll('.ph-f-' + kind + '-item');
    if (items.length) items[items.length - 1].focus();
  };
  window.phRemoveListItem = function (kind, btn) {
    const list = $('ph-f-' + kind + '-list');
    const idx = Array.from(list.children).indexOf(btn.parentNode);
    const vals = _phReadList(kind);
    if (idx > -1) vals.splice(idx, 1);
    phRenderList(kind, vals.length ? vals : ['']);   // re-render → auto-renumber
  };
  function _phCollectList(kind) {
    return Array.from(document.querySelectorAll('.ph-f-' + kind + '-item'))
      .map(i => i.value.trim()).filter(Boolean).join('\n');
  }
  function _phRenderAcDisplay(p) {
    const host = $('ph-ac-display'); if (!host) return;
    const block = (label, items, txt, num) => items.length
      ? `<div style="font-size:0.8rem;"><span style="color:${txt};font-weight:600;">${label}:</span> ` +
        items.map((v, i) => `<span style="display:inline-block;background:#fbeaea;color:${txt};border-radius:10px;padding:1px 8px;margin:2px 2px 0 0;"><b style="color:${num};">${i + 1}.</b> ${esc(v)}</span>`).join('') + '</div>'
      : '';
    const html = block('⚠ Allergies', _phSplit(p && p.allergies), '#a33', '#a33') +
                 block('🩺 Conditions', _phSplit(p && p.conditions), '#000', '#1a7f37');
    host.innerHTML = html;
    host.style.display = 'none';                 // default CLOSED, not persisted — reset on every render
    const tog = $('ph-ac-toggle');
    if (tog) { tog.style.display = html ? '' : 'none'; tog.textContent = '👁'; tog.title = 'Show allergies & conditions'; }
  }
  // toggle the read-only allergies/conditions chips (transient — not remembered)
  window.phToggleAc = function () {
    const host = $('ph-ac-display'), tog = $('ph-ac-toggle');
    const show = host.style.display === 'none';
    host.style.display = show ? 'flex' : 'none';
    if (tog) { tog.textContent = show ? '🙈' : '👁'; tog.title = (show ? 'Hide' : 'Show') + ' allergies & conditions'; }
  };

  // ── body-details form (sex / DOB / height) — name = the selected household user ──
  window.phEditDetails = function () {
    if (!_selName) return;
    const p = profileFor(_selName) || {};
    $('ph-f-sex').value        = p.sex || '';
    $('ph-f-dob').value        = dpart(p.date_of_birth);
    $('ph-f-height').value     = p.height_cm != null ? p.height_cm : '';
    phRenderList('allergies', _phSplit(p.allergies));
    phRenderList('conditions', _phSplit(p.conditions));
    $('ph-form-status').textContent = '';
    $('ph-person-form').style.display = '';
  };
  window.phCancelForm = function () { $('ph-person-form').style.display = 'none'; };
  window.phSaveDetails = async function () {
    if (!_selName) return;
    const body = { sex: $('ph-f-sex').value, date_of_birth: $('ph-f-dob').value || null, height_cm: $('ph-f-height').value || null,
                   allergies: _phCollectList('allergies'), conditions: _phCollectList('conditions') };
    const p = profileFor(_selName);
    const r = p
      ? await fetch(`${API}/profiles/${p.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      : await fetch(`${API}/profiles`,         { method: 'POST',  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: _selName, user_id: (userByName(_selName) || {}).id, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('ph-form-status').textContent = 'Failed: ' + (j.error || r.status); return; }
    $('ph-person-form').style.display = 'none';
    await phInit();
  };

  // ── detail (summary + log + history) ──
  async function renderDetail() {
    $('ph-detail').style.display = '';
    const p = profileFor(_selName);
    if (!p) {
      $('ph-summary').innerHTML = '<span style="font-size:0.72rem;color:#888;">No details yet — click <b>Edit details</b></span>';
      $('ph-ac-display').innerHTML = ''; $('ph-ac-display').style.display = 'none';
      { const t = $('ph-ac-toggle'); if (t) t.style.display = 'none'; }
      $('ph-logcard').style.display = 'none';
      $('ph-bpcard').style.display = 'none';
      $('ph-bodycard').style.display = 'none';
      $('ph-watercard').style.display = 'none';
      $('ph-exercisecard').style.display = 'none';
      $('ph-stepscard').style.display = 'none';
      $('ph-medscard').style.display = 'none';
      _curProfileId = null;
      return;
    }
    $('ph-logcard').style.display = '';
    $('ph-bpcard').style.display = '';
    $('ph-bodycard').style.display = '';
    $('ph-watercard').style.display = '';
    $('ph-exercisecard').style.display = '';
    $('ph-stepscard').style.display = '';
    $('ph-medscard').style.display = '';
    _curProfileId = p.id;
    phLoadMeds(p.id);
    phLoadSteps();
    phLoadWater();
    phLoadExercise();
    phSchedRender('weight', p.weight_sched);
    phSchedRender('bp', p.bp_sched);
    phSchedRender('body', p.body_sched);
    const h = p.height_cm != null ? Number(p.height_cm) : null;
    const meas = await (await fetch(`${API}/measurements?profile_id=${p.id}`)).json();
    const latestW = meas.length ? Number(meas[0].weight_kg)
      : (p.latest_weight_kg != null ? Number(p.latest_weight_kg) : null);
    const b = bmi(latestW, h), cat = bmiCat(b), ir = idealRange(h), a = age(p.date_of_birth);
    const waistL = p.latest_waist_cm != null ? Number(p.latest_waist_cm) : null;
    const hipL   = p.latest_hip_cm   != null ? Number(p.latest_hip_cm)   : null;
    const wr = whr(waistL, hipL), wcat = whrCat(wr, p.sex);

    // trimmed/compact chips — sit inline to the right of the Edit details button
    const chip = (label, val) =>
      `<div style="text-align:center;line-height:1.15;">
        <div style="font-size:0.58rem;color:#888;text-transform:uppercase;letter-spacing:.3px;">${label}</div>
        <div style="font-size:0.92rem;font-weight:700;">${val}</div></div>`;
    $('ph-summary').innerHTML =
      chip('Age', a == null ? '—' : a) +
      chip('Sex', p.sex ? esc(p.sex) : '—') +
      chip('Height', h != null ? h + ' cm' : '—') +
      chip('Weight', latestW != null ? latestW + ' kg' : '—') +
      `<div style="text-align:center;line-height:1.15;">
        <div style="font-size:0.58rem;color:#888;text-transform:uppercase;letter-spacing:.3px;">BMI</div>
        <div style="font-size:0.92rem;font-weight:700;color:${cat.color};">${b == null ? '—' : b.toFixed(1)}
        <span style="font-size:0.62rem;font-weight:600;">${cat.label}</span></div></div>` +
      chip('Ideal', ir ? `${ir.lo.toFixed(0)}–${ir.hi.toFixed(0)} kg` : '—') +
      chip('Waist', waistL != null ? waistL + ' cm' : '—') +
      chip('Hip', hipL != null ? hipL + ' cm' : '—') +
      `<div style="text-align:center;line-height:1.15;">
        <div style="font-size:0.58rem;color:#888;text-transform:uppercase;letter-spacing:.3px;">WHR</div>
        <div style="font-size:0.92rem;font-weight:700;color:${wcat.color};">${wr == null ? '—' : wr.toFixed(2)}
        <span style="font-size:0.62rem;font-weight:600;">${wcat.label}</span></div></div>`;
    _phRenderAcDisplay(p);
  }

  // ── log weight — stamped with a server timestamp on Save (same style as BP) ──
  window.phLogWeight = async function () {
    const p = profileFor(_selName); if (!p) return;
    const w = $('ph-w-kg').value;
    if (!w) { $('ph-w-status').textContent = 'Enter a weight'; return; }
    const r = await fetch(`${API}/measurements`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: p.id, weight_kg: w }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('ph-w-status').textContent = 'Failed: ' + (j.error || r.status); return; }
    $('ph-w-kg').value = ''; $('ph-w-status').textContent = '✓ saved ' + (j.measured_at || '');
    await phInit(); await renderDetail();
  };
  // Blood pressure — saved with a server timestamp; no history shown.
  window.phLogBP = async function () {
    const p = profileFor(_selName); if (!p) return;
    const sys = $('ph-bp-sys').value, dia = $('ph-bp-dia').value, pulse = $('ph-bp-pulse').value;
    if (!sys && !dia && !pulse) { $('ph-bp-status').textContent = 'Enter a reading'; return; }
    const r = await fetch(`${API}/bp`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: p.id, systolic: sys || null, diastolic: dia || null, pulse: pulse || null }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('ph-bp-status').textContent = 'Failed: ' + (j.error || r.status); return; }
    $('ph-bp-sys').value = ''; $('ph-bp-dia').value = ''; $('ph-bp-pulse').value = '';
    $('ph-bp-status').textContent = '✓ saved ' + (j.measured_at || '');
  };
  window.phDelMeas = async function (id) {
    if (!confirm('Delete this measurement?')) return;
    await fetch(`${API}/measurements/${id}`, { method: 'DELETE' });
    await phInit(); await renderDetail();
  };
  // Waist & hip — saved with a server timestamp (history modal = 'body').
  window.phLogBody = async function () {
    const p = profileFor(_selName); if (!p) return;
    const waist = $('ph-body-waist').value, hip = $('ph-body-hip').value;
    if (!waist && !hip) { $('ph-body-status').textContent = 'Enter waist or hip'; return; }
    const r = await fetch(`${API}/body`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: p.id, waist_cm: waist || null, hip_cm: hip || null }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('ph-body-status').textContent = 'Failed: ' + (j.error || r.status); return; }
    $('ph-body-waist').value = ''; $('ph-body-hip').value = '';
    $('ph-body-status').textContent = '✓ saved ' + (j.measured_at || '');
    await phInit(); await renderDetail();
  };
  // ℹ️ "where to measure" body diagram (popup) — static SVG in medical.html.
  window.phBodyDiagram = function () { $('ph-body-diagram').style.display = 'flex'; };
  window.phBodyDiagramClose = function () { $('ph-body-diagram').style.display = 'none'; };

  // ── steps (daily counter) — keyed by the household_users id of the selected
  // person, so manual entries and the LXC-104 walking-trip imports share a key. ──
  const curUserId = () => (userByName(_selName) || {}).id || null;
  async function phLoadSteps() {
    const uid = curUserId();
    if (!uid) { $('ph-st-today').innerHTML = 'Today: <b>—</b>'; return; }
    try {
      const s = await (await fetch(`${API}/steps?user_id=${uid}`)).json();
      const tot = Number(s.today_total || 0), trip = Number(s.today_trip || 0), tc = Number(s.today_trip_count || 0);
      $('ph-st-today').innerHTML = `Today: <b>${tot.toLocaleString()}</b> steps` +
        (trip > 0 ? ` <span style="color:#888;">(${trip.toLocaleString()} from ${tc} walking trip${tc === 1 ? '' : 's'})</span>` : '');
    } catch (e) { $('ph-st-today').innerHTML = 'Today: <b>—</b>'; }
  }
  window.phLogSteps = async function () {
    const uid = curUserId(); if (!uid) return;
    const n = $('ph-st-num').value;
    if (!n) { $('ph-st-status').textContent = 'Enter steps'; return; }
    const r = await fetch(`${API}/steps`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: uid, steps: n }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('ph-st-status').textContent = 'Failed: ' + (j.error || r.status); return; }
    $('ph-st-num').value = ''; $('ph-st-status').textContent = '✓ saved ' + (j.measured_at || '');
    await phLoadSteps();
  };

  // ── water (daily cups) — per-profile count + a goal/window that drives the
  // 💧 "behind pace" reminder. Mirrors the steps tracker. ──
  async function phLoadWater() {
    const p = profileFor(_selName);
    const g = $('ph-wt-goal');
    const tgt = Number(_waterCfg.target) || 0;
    const on = _waterCfg.enabled !== false && tgt > 0;
    if (g) {
      if (on) {
        const sh = _waterCfg.start_hm || '08:00', eh = _waterCfg.end_hm || '22:00';
        let iv = Number(_waterCfg.interval_min) || 0;
        if (!iv) { const dur = _hm2min(eh) - _hm2min(sh); iv = dur > 0 ? Math.round(dur / tgt) : 0; }
        g.innerHTML = `🎯 ${tgt} cups · ${esc(sh)}–${esc(eh)}` + (iv > 0 ? ` · every ~${iv} min` : '') +
          ` · <span style="color:#2563eb;">edit in Settings</span>`;
      } else {
        g.innerHTML = '🎯 No goal yet — set it in <span style="color:#2563eb;">Settings → 💧 Water</span>';
      }
    }
    if (!p) { $('ph-wt-today').innerHTML = 'Today: <b>—</b>'; return; }
    try {
      const w = await (await fetch(`${API}/water?profile_id=${p.id}`)).json();
      const tot = Number(w.today_total || 0);
      const done = tgt && tot >= tgt;
      $('ph-wt-today').innerHTML = `Today: <b style="color:${done ? '#2e7d32' : '#2563eb'};">${tot}</b> / ${tgt || '—'} cups` + (done ? ' ✓' : '');
    } catch (e) { $('ph-wt-today').innerHTML = 'Today: <b>—</b>'; }
  }
  window.phLogWater = async function (cups) {
    const p = profileFor(_selName); if (!p) return;
    const r = await fetch(`${API}/water`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: p.id, cups: cups || 1 }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('ph-wt-status').textContent = 'Failed: ' + (j.error || r.status); return; }
    $('ph-wt-status').textContent = '✓'; setTimeout(() => { $('ph-wt-status').textContent = ''; }, 1200);
    await phLoadWater();
  };
  // ── Settings tab: global 💧 water config (dashboard_settings.medical.water),
  // read by the reminders evaluator + the per-person card's goal line. ──
  const WATER_DEFAULTS = { enabled: true, target: 8, start_hm: '08:00', end_hm: '22:00', interval_min: 0 };
  window.medWaterSettingsInit = async function () {
    await _loadWaterCfg();
    const cfg = Object.assign({}, WATER_DEFAULTS, _waterCfg);
    $('setw-enabled').checked  = cfg.enabled !== false;
    $('setw-target').value     = cfg.target;
    $('setw-start').value      = cfg.start_hm;
    $('setw-end').value        = cfg.end_hm;
    $('setw-interval').value   = cfg.interval_min || '';
    $('setw-status').textContent = '';
  };
  window.medWaterSettingsSave = async function () {
    const value = {
      enabled:      $('setw-enabled').checked,
      target:       Number($('setw-target').value) || WATER_DEFAULTS.target,
      start_hm:     $('setw-start').value || WATER_DEFAULTS.start_hm,
      end_hm:       $('setw-end').value || WATER_DEFAULTS.end_hm,
      interval_min: Number($('setw-interval').value) || 0,   // 0 = auto (window ÷ target)
    };
    try {
      const r = await fetch('/api/dashboard-settings/medical.water', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _waterCfg = value;
      $('setw-status').style.color = '#2e7d32'; $('setw-status').textContent = '✓ Saved';
      if (_selName) await phLoadWater();
    } catch (e) { $('setw-status').style.color = '#c0392b'; $('setw-status').textContent = 'Failed: ' + e.message; }
  };

  // ── Morning exercises (daily routine) ────────────────────────────────────────
  // Definitions live GLOBALLY in dashboard_settings.medical.exercises
  // {enabled, schedule:{time_hm}, items:[{id,name,reps,cal_per_rep,muscles[],other,include}]}.
  // Each person logs the routine (✓ Done here / reminder Clear) → ph_exercise_log,
  // which records total calories + distinct muscles (computed in lib-exercise-log.js).
  const MUSCLE_LIST = [
    { key: 'chest', label: 'Chest' }, { key: 'shoulders', label: 'Shoulders' }, { key: 'biceps', label: 'Biceps' },
    { key: 'forearms', label: 'Forearms' }, { key: 'abs', label: 'Rectus Abdominis' }, { key: 'obliques', label: 'External Obliques' },
    { key: 'obliques_int', label: 'Internal Obliques' }, { key: 'transverse', label: 'Transverse Abdominis' },
    { key: 'quads', label: 'Quads' }, { key: 'hipflexors', label: 'Hip flexors' },
    { key: 'upperback', label: 'Upper back' }, { key: 'lowerback', label: 'Lower back' }, { key: 'triceps', label: 'Triceps' },
    { key: 'glutes', label: 'Glutes' }, { key: 'hamstrings', label: 'Hamstrings' }, { key: 'calves', label: 'Calves' },
    { key: 'fullbody', label: 'Full body / Cardio' },
  ];
  const MUSCLE_LABEL = Object.fromEntries(MUSCLE_LIST.map(m => [m.key, m.label]));
  // ── Detailed vector anatomy: front + back muscular figure. Each muscle group is
  // its own shape so an exercise's selected muscles highlight EXACTLY. FRONT body
  // centred ≈x100, BACK body ≈x300 (back shapes are the front coords + 200). The
  // base skin silhouette gives the human form; muscle shapes sit on top. ──
  const _SKIN = '#f1d7c4', _SKINLINE = '#c7a890', _MUS = '#d79784', _MUSLINE = '#a9624e', _HI = '#2563eb', _HILINE = '#1d4ed8';
  function _phBody(ox) {
    const x = (v) => v + ox;
    return `<g fill="${_SKIN}" stroke="${_SKINLINE}" stroke-width="1.2">` +
      `<ellipse cx="${x(100)}" cy="26" rx="15" ry="17"/>` +                       // head
      `<rect x="${x(93)}" y="40" width="14" height="12" rx="4"/>` +              // neck
      `<rect x="${x(73)}" y="50" width="54" height="82" rx="17"/>` +             // chest/torso
      `<rect x="${x(78)}" y="120" width="44" height="60" rx="13"/>` +            // abdomen/pelvis
      `<rect x="${x(55)}" y="54" width="16" height="106" rx="8"/>` +             // left arm
      `<rect x="${x(129)}" y="54" width="16" height="106" rx="8"/>` +           // right arm
      `<ellipse cx="${x(63)}" cy="168" rx="8" ry="10"/>` +                       // left hand
      `<ellipse cx="${x(137)}" cy="168" rx="8" ry="10"/>` +                     // right hand
      `<rect x="${x(79)}" y="174" width="19" height="160" rx="9"/>` +            // left leg
      `<rect x="${x(102)}" y="174" width="19" height="160" rx="9"/>` +          // right leg
      `<ellipse cx="${x(86)}" cy="340" rx="10" ry="6"/>` +                       // left foot
      `<ellipse cx="${x(114)}" cy="340" rx="10" ry="6"/>` +                     // right foot
      `</g>`;
  }
  // Each muscle group → its shape(s) (front and/or back, absolute coords).
  const PH_MUSCLES = [
    { key: 'shoulders',  svg: '<ellipse cx="68" cy="60" rx="11" ry="12"/><ellipse cx="132" cy="60" rx="11" ry="12"/><ellipse cx="268" cy="60" rx="11" ry="12"/><ellipse cx="332" cy="60" rx="11" ry="12"/>' },
    { key: 'chest',      svg: '<path d="M99,58 Q80,55 80,74 Q82,85 98,82 Z"/><path d="M101,58 Q120,55 120,74 Q118,85 102,82 Z"/>' },
    { key: 'biceps',     svg: '<ellipse cx="62" cy="86" rx="7" ry="16"/><ellipse cx="138" cy="86" rx="7" ry="16"/>' },
    { key: 'forearms',   svg: '<ellipse cx="62" cy="124" rx="6" ry="18"/><ellipse cx="138" cy="124" rx="6" ry="18"/><ellipse cx="262" cy="124" rx="6" ry="18"/><ellipse cx="338" cy="124" rx="6" ry="18"/>' },
    { key: 'abs',        svg: '<rect x="90" y="100" width="20" height="74" rx="7"/>' },
    { key: 'obliques',     svg: '<path d="M89,110 Q82,142 89,170 L94,170 L94,110 Z"/><path d="M111,110 Q118,142 111,170 L106,170 L106,110 Z"/>' },
    { key: 'obliques_int', svg: '<path d="M94,128 Q89,150 94,166 L98,166 L98,128 Z"/><path d="M106,128 Q111,150 106,166 L102,166 L102,128 Z"/>' },
    { key: 'transverse',   svg: '<rect x="89" y="150" width="22" height="13" rx="6"/>' },
    { key: 'hipflexors',   svg: '<ellipse cx="94" cy="176" rx="6" ry="10"/><ellipse cx="106" cy="176" rx="6" ry="10"/>' },
    { key: 'quads',      svg: '<ellipse cx="88" cy="212" rx="11" ry="36"/><ellipse cx="112" cy="212" rx="11" ry="36"/>' },
    { key: 'upperback',  svg: '<path d="M300,52 L320,72 L300,108 L280,72 Z"/><path d="M280,82 Q274,104 288,118 L292,114 L286,84 Z"/><path d="M320,82 Q326,104 312,118 L308,114 L314,84 Z"/>' },
    { key: 'triceps',    svg: '<ellipse cx="262" cy="86" rx="7" ry="16"/><ellipse cx="338" cy="86" rx="7" ry="16"/>' },
    { key: 'lowerback',  svg: '<rect x="288" y="118" width="9" height="30" rx="3"/><rect x="303" y="118" width="9" height="30" rx="3"/>' },
    { key: 'glutes',     svg: '<path d="M299,150 Q283,150 282,166 Q285,179 299,176 Z"/><path d="M301,150 Q317,150 318,166 Q315,179 301,176 Z"/>' },
    { key: 'hamstrings', svg: '<ellipse cx="289" cy="214" rx="11" ry="34"/><ellipse cx="311" cy="214" rx="11" ry="34"/>' },
    { key: 'calves',     svg: '<ellipse cx="289" cy="294" rx="9" ry="30"/><ellipse cx="311" cy="294" rx="9" ry="30"/>' },
  ];
  // Render the figure. `sel` = highlighted muscle keys (or ['fullbody'] = all).
  window.phMuscleSvg = function (sel, width) {
    width = width || 160;
    const S = Array.isArray(sel) ? sel : [], full = S.includes('fullbody');
    const mus = PH_MUSCLES.map((m) => {
      const on = full || S.includes(m.key);
      return `<g fill="${on ? _HI : _MUS}" fill-opacity="${on ? 0.95 : 0.8}" stroke="${on ? _HILINE : _MUSLINE}" stroke-width="0.7">${m.svg}</g>`;
    }).join('');
    // scale(1.3,1) widens BOTH bodies horizontally without making them taller.
    // viewBox left-offset 40 so the two bodies sit balanced around the centre line.
    return `<svg viewBox="40 0 440 360" width="${width}" xmlns="http://www.w3.org/2000/svg" style="display:block;max-width:100%;height:auto;">` +
      `<g transform="scale(1.3,1)">` + _phBody(0) + _phBody(200) + mus + `</g>` +
      '<line x1="260" y1="12" x2="260" y2="346" stroke="#9a9a9a" stroke-width="1.2"/>' +
      '<text x="130" y="358" font-size="12" fill="#9ca3af" text-anchor="middle">Front</text>' +
      '<text x="390" y="358" font-size="12" fill="#9ca3af" text-anchor="middle">Back</text>' +
      '</svg>';
  };
  // Reference "Muscle Map" card (Settings tab, right of the Morning Exercises card)
  // — the big figure + tappable muscle chips that highlight each group.
  let _mapSel = [];
  window.phMapToggle = function (k) {
    const i = _mapSel.indexOf(k);
    if (i >= 0) _mapSel.splice(i, 1); else _mapSel.push(k);
    phRenderMuscleMap();
  };
  function phRenderMuscleMap() {
    const host = $('setx-musclemap'); if (!host) return;
    const chips = MUSCLE_LIST.map((m) => {
      const on = _mapSel.includes(m.key);
      return `<span onclick="phMapToggle('${m.key}')" style="cursor:pointer;user-select:none;font-size:0.72rem;padding:3px 8px;border-radius:11px;border:1px solid ${on ? '#1d4ed8' : '#cbd5e1'};background:${on ? '#dbeafe' : '#fff'};color:${on ? '#1d4ed8' : '#555'};">${esc(m.label)}</span>`;
    }).join('');
    // Figure: FIXED size, vertically centred (flex:1 wrapper centres it; SVG width is
    // fixed so it stays constant even as the card grows). Chips below.
    host.innerHTML = `<div style="flex:1;display:flex;align-items:center;justify-content:center;min-height:0;">${phMuscleSvg(_mapSel, 290)}</div>` +
      `<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:10px;">${chips}</div>`;
  }
  window.phRenderMuscleMap = phRenderMuscleMap;

  // Hover popup — shows an exercise's short Hebrew summary (desc_he) on mouse-over.
  function _exTipPos(ev) {
    const tip = $('ex-hover-tip'); if (!tip) return;
    tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - 330) + 'px';
    tip.style.top = Math.min(ev.clientY + 16, window.innerHeight - 130) + 'px';
  }
  window.exTip = function (ev, id) {
    const it = (_exCfg.items || []).find(x => x.id === id); if (!it) return;
    const t = (it.desc_he == null ? '' : String(it.desc_he)).trim(); if (!t) return;
    const tip = $('ex-hover-tip'); if (!tip) return;
    tip.innerHTML = `<div style="direction:ltr;text-align:left;font-weight:700;margin-bottom:4px;">${esc(it.name || '')}</div>` +
      `<div style="direction:rtl;text-align:right;">${esc(t)}</div>`;
    tip.style.display = 'block'; _exTipPos(ev);
  };
  window.exTipMove = function (ev) { const tip = $('ex-hover-tip'); if (tip && tip.style.display === 'block') _exTipPos(ev); };
  window.exTipHide = function () { const tip = $('ex-hover-tip'); if (tip) tip.style.display = 'none'; };

  function _muscleNames(it) {
    const out = (it.muscles || []).map(k => MUSCLE_LABEL[k] || k);
    const o = (it.other == null ? '' : String(it.other)).trim();
    if (o) out.push(o);
    return out;
  }
  function _muscleNames(it) {
    const out = (it.muscles || []).map(k => MUSCLE_LABEL[k] || k);
    const o = (it.other == null ? '' : String(it.other)).trim();
    if (o) out.push(o);
    return out;
  }

  let _exCfg = { enabled: true, schedule: { time_hm: '07:00' }, items: [] };
  async function _loadExCfg() {
    try {
      const j = await (await fetch('/api/dashboard-settings/medical.exercises')).json();
      const v = (j && j.value) || {};
      _exCfg = { enabled: v.enabled !== false, schedule: (v.schedule && v.schedule.time_hm) ? v.schedule : { time_hm: '07:00' },
                 items: Array.isArray(v.items) ? v.items : [] };
    } catch (e) { _exCfg = { enabled: true, schedule: { time_hm: '07:00' }, items: [] }; }
  }

  // Personal Health card: today's totals only (the routine is managed in Settings).
  async function phLoadExercise() {
    const p = profileFor(_selName);
    if (!p) { $('ph-ex-today').innerHTML = 'Today: <b>—</b>'; return; }
    try {
      const x = await (await fetch(`${API}/exercise?profile_id=${p.id}`)).json();
      const cal = Math.round(Number(x.today_calories || 0)), nm = (x.today_muscles || []).length, cnt = Number(x.today_count || 0);
      $('ph-ex-today').innerHTML = `Today: <b style="color:${cnt ? '#2e7d32' : '#2563eb'};">${cal}</b> cal · <b>${nm}</b> muscle${nm === 1 ? '' : 's'}` +
        (cnt ? ` <span style="color:#888;font-size:0.78rem;">(${cnt}×)</span>` : '');
    } catch (e) { $('ph-ex-today').innerHTML = 'Today: <b>—</b>'; }
  }
  window.phLogExercise = async function () {
    const p = profileFor(_selName); if (!p) return;
    if (!_exCfg.items.filter(it => it.include !== false).length) { $('ph-ex-status').textContent = 'No exercises set'; return; }
    const r = await fetch(`${API}/exercise/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile_id: p.id }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('ph-ex-status').textContent = 'Failed: ' + (j.error || r.status); return; }
    $('ph-ex-status').textContent = '✓ logged'; setTimeout(() => { $('ph-ex-status').textContent = ''; }, 1500);
    await phLoadExercise();
  };
  window.phMuscleLegend = function () {
    const host = $('ph-ex-legend-body');
    if (host) host.innerHTML = phMuscleSvg([], 300) +
      '<div style="font-size:0.78rem;color:#666;margin-top:8px;max-width:320px;">Each exercise highlights the muscle group(s) it works. Pick them from the preset list when you add an exercise in Settings; “Other” muscles are counted but shown as text. The <b>🧍 Muscle Map</b> card lets you tap any muscle to see where it is.</div>';
    $('ph-ex-legend').style.display = 'flex';
  };
  window.phMuscleLegendClose = function () { $('ph-ex-legend').style.display = 'none'; };

  // ── Settings tab: global 🏋️ exercise definitions (dashboard_settings.medical.exercises) ──
  // The exercise's muscles are chosen on the 🧍 Muscle Map card (its tappable chips
  // drive `_mapSel`); the form here holds only name / reps / cal / include.
  let _exEditId = null;
  window.medExSettingsInit = async function () {
    await _loadExCfg();
    if ($('setx-enabled')) $('setx-enabled').checked = _exCfg.enabled !== false;
    if ($('setx-time')) $('setx-time').value = (_exCfg.schedule && _exCfg.schedule.time_hm) || '07:00';
    _exResetForm(); _exRenderList();
    if ($('setx-status')) $('setx-status').textContent = '';
  };
  function _exResetForm() {
    _exEditId = null; _mapSel = [];
    ['setx-name', 'setx-sug-sets', 'setx-suggested', 'setx-sets', 'setx-reps', 'setx-cpr', 'setx-hold', 'setx-calsec'].forEach(id => { if ($(id)) $(id).value = ''; });
    if ($('setx-kind')) $('setx-kind').value = 'reps';
    if ($('setx-include')) $('setx-include').checked = true;
    if ($('setx-addbtn')) $('setx-addbtn').textContent = '+ Add exercise';
    phExKindChange(); phRenderMuscleMap();
  }
  // Swap the Real-count input (reps↔hold) inside the Real group + the Calories label.
  window.phExKindChange = function () {
    const hold = $('setx-kind') && $('setx-kind').value === 'hold';
    if ($('setx-real-reps-wrap')) $('setx-real-reps-wrap').style.display = hold ? 'none' : '';
    if ($('setx-real-hold-wrap')) $('setx-real-hold-wrap').style.display = hold ? '' : 'none';
    if ($('setx-cpr-lbl')) $('setx-cpr-lbl').style.display = hold ? 'none' : '';
    if ($('setx-calsec-lbl')) $('setx-calsec-lbl').style.display = hold ? '' : 'none';
  };
  // Calories + a "sug · sets×reps/hold" detail string for one item (kind/sets aware).
  function _exItemCal(it) {
    const sets = Number(it.sets) || 1;
    if (it.kind === 'hold') return Math.round((Number(it.hold_sec) || 0) * sets * (Number(it.cal_per_sec) || 0) * 10) / 10;
    return Math.round((Number(it.reps) || 0) * sets * (Number(it.cal_per_rep) || 0) * 10) / 10;
  }
  function _exItemDetail(it, cal) {
    const u = (it.kind === 'hold') ? 's' : '';
    const ss = Number(it.suggested_sets) || 0;     // suggested sets (0 = not specified)
    const sc = Number(it.suggested) || 0;          // suggested count per set
    const rs = Number(it.sets) || 1;               // real sets
    const rc = (it.kind === 'hold') ? (Number(it.hold_sec) || 0) : (Number(it.reps) || 0);  // real count per set
    const sugStr = (ss > 1 ? ss + '×' : '') + (sc || '—') + u;
    const realStr = (rs > 1 ? rs + '×' : '') + rc + u;
    // "real …" turns red when it deviates from the suggestion — in count OR sets (each judged only when suggested).
    const changed = (sc > 0 && rc !== sc) || (ss > 0 && rs !== ss);
    const col = changed ? '#c0392b' : '#1a7f37';
    return `suggested ${sugStr} · <span style="color:${col};">real ${realStr} = ${cal} cal</span>`;
  }
  function _exRenderList() {
    const host = $('setx-list'); if (!host) return;
    host.innerHTML = _exCfg.items.length ? _exCfg.items.map((it) => {
      const cal = _exItemCal(it);
      const ms = _muscleNames(it);
      return `<div draggable="true" data-ex-id="${it.id}" ondragstart="phExDragStart(event,'${it.id}')" ondragover="phExDragOver(event,'${it.id}')" ondrop="phExDrop(event,'${it.id}')" ondragend="phExDragEnd(event)" onmouseenter="exTip(event,'${it.id}')" onmousemove="exTipMove(event)" onmouseleave="exTipHide()" style="display:flex;gap:8px;align-items:center;padding:9px 4px;border-bottom:1px solid #cfd4da;">
        <span style="cursor:grab;color:#aaa;font-size:1rem;line-height:1;flex:0 0 auto;user-select:none;" title="Drag to reorder">⋮⋮</span>` +
        `<input type="checkbox" ${it.include !== false ? 'checked' : ''} onchange="phExToggleInclude('${it.id}')" title="Include in the routine total" style="transform:scale(1.1);margin:0;flex:0 0 auto;">` +
        `<span style="flex:1;min-width:0;font-size:0.85rem;"><b>${esc(it.name || '')}</b> ` +
        `<span style="color:#1a7f37;font-weight:600;white-space:nowrap;">· ${_exItemDetail(it, cal)}</span>` +
        `<br><span style="font-size:0.7rem;color:#777;">${esc(ms.join(', ')) || '—'}</span></span>` +
        `<span>${phMuscleSvg(it.muscles || [], 44)}</span>` +
        `<button class="btn btn-secondary btn-sm" style="padding:2px 6px;font-size:0.72rem;flex:0 0 auto;" onclick="phExEdit('${it.id}')">Edit</button>` +
        `<button class="btn btn-secondary btn-sm" style="padding:2px 6px;font-size:0.72rem;color:#c0392b;flex:0 0 auto;" onclick="phExDel('${it.id}')" title="Delete">✕</button></div>`;
    }).join('') : '<div style="color:#aaa;padding:8px;">No exercises yet.</div>';
  }
  window.phExToggleInclude = async function (id) {
    const it = _exCfg.items.find(x => x.id === id); if (!it) return;
    it.include = !(it.include !== false);
    await _exPersist(); _exRenderList(); if (_selName) phLoadExercise();
  };
  // --- Drag-to-reorder the exercise list (same pattern as playlists / rules) ---
  let _exDragId = null;
  window.phExDragStart = function (ev, id) {
    _exDragId = id; exTipHide();
    try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', id); } catch (e) {}
    const row = ev.currentTarget; if (row) row.style.opacity = '0.45';
  };
  window.phExDragOver = function (ev, id) {
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = 'move'; } catch (e) {}
    const row = ev.currentTarget;
    if (row && _exDragId && id !== _exDragId) row.style.boxShadow = 'inset 0 2px 0 #2563eb';
  };
  window.phExDragEnd = function (ev) {
    _exDragId = null;
    const host = $('setx-list'); if (host) Array.from(host.children).forEach(c => { c.style.opacity = ''; c.style.boxShadow = ''; });
  };
  window.phExDrop = async function (ev, targetId) {
    ev.preventDefault();
    const from = _exDragId; _exDragId = null;
    const host = $('setx-list'); if (host) Array.from(host.children).forEach(c => { c.style.opacity = ''; c.style.boxShadow = ''; });
    if (!from || from === targetId) return;
    const items = _exCfg.items;
    const fi = items.findIndex(x => x.id === from); if (fi < 0) return;
    const [moved] = items.splice(fi, 1);
    const ti = items.findIndex(x => x.id === targetId);
    items.splice(ti < 0 ? items.length : ti, 0, moved);   // drop BEFORE the target row
    await _exPersist(); _exRenderList(); if (_selName) phLoadExercise();
  };
  window.phExEdit = function (id) {
    const it = _exCfg.items.find(x => x.id === id); if (!it) return;
    _exEditId = id;
    $('setx-name').value = it.name || ''; $('setx-suggested').value = it.suggested || '';
    $('setx-sug-sets').value = it.suggested_sets || '';
    $('setx-kind').value = it.kind === 'hold' ? 'hold' : 'reps';
    $('setx-sets').value = it.sets || '';
    $('setx-reps').value = it.reps || ''; $('setx-cpr').value = it.cal_per_rep || '';
    $('setx-hold').value = it.hold_sec || ''; $('setx-calsec').value = it.cal_per_sec || '';
    $('setx-include').checked = it.include !== false;
    $('setx-addbtn').textContent = '✓ Update';
    phExKindChange();
    _mapSel = (it.muscles || []).slice(); phRenderMuscleMap();
  };
  window.phExDel = async function (id) {
    if (!confirm('Remove this exercise?')) return;
    _exCfg.items = _exCfg.items.filter(x => x.id !== id);
    await _exPersist(); _exResetForm(); _exRenderList(); if (_selName) phLoadExercise();
  };
  window.phExFormSave = async function () {
    const name = ($('setx-name').value || '').trim();
    if (!name) { if ($('setx-status')) $('setx-status').textContent = ''; $('setx-name').focus(); return; }
    const prev = _exEditId ? _exCfg.items.find(x => x.id === _exEditId) : null;
    const kind = ($('setx-kind').value === 'hold') ? 'hold' : 'reps';
    const item = { id: _exEditId || ('ex_' + Math.random().toString(36).slice(2, 9)),
      name, kind, suggested_sets: Number($('setx-sug-sets').value) || 0,
      suggested: Number($('setx-suggested').value) || 0, sets: Number($('setx-sets').value) || 1,
      muscles: _mapSel.slice(), other: '', include: $('setx-include').checked, desc_he: (prev && prev.desc_he) || '' };
    if (kind === 'hold') { item.hold_sec = Number($('setx-hold').value) || 0; item.cal_per_sec = Number($('setx-calsec').value) || 0; }
    else { item.reps = Number($('setx-reps').value) || 0; item.cal_per_rep = Number($('setx-cpr').value) || 0; }
    if (_exEditId) { const i = _exCfg.items.findIndex(x => x.id === _exEditId); if (i >= 0) _exCfg.items[i] = item; }
    else _exCfg.items.push(item);
    await _exPersist(); _exResetForm(); _exRenderList(); if (_selName) phLoadExercise();
  };
  async function _exPersist() {
    if ($('setx-enabled')) _exCfg.enabled = $('setx-enabled').checked;
    if ($('setx-time')) _exCfg.schedule = { time_hm: $('setx-time').value || '07:00' };
    const value = { enabled: _exCfg.enabled, schedule: _exCfg.schedule, items: _exCfg.items };
    try {
      const r = await fetch('/api/dashboard-settings/medical.exercises', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if ($('setx-status')) { $('setx-status').style.color = '#2e7d32'; $('setx-status').textContent = '✓ Saved'; setTimeout(() => { if ($('setx-status')) $('setx-status').textContent = ''; }, 1200); }
    } catch (e) { if ($('setx-status')) { $('setx-status').style.color = '#c0392b'; $('setx-status').textContent = 'Failed: ' + e.message; } }
  }
  window.medExSettingsSave = async function () { await _exPersist(); };

  // ── Measure schedule (Weight / BP) — {freq, interval_n} on the profile, drives
  // a FUTURE reminder watcher. Same options as meds minus weekday / day / time. ──
  const _schedPre = (kind) => ({ weight: 'ph-w', bp: 'ph-bp', body: 'ph-body' }[kind]);
  function _schedToggleN(pre, freq) {
    const showN = freq === 'every_n_days' || freq === 'every_n_months';
    $(pre + '-interval').style.display = showN ? '' : 'none';
    $(pre + '-interval-unit').style.display = showN ? '' : 'none';
    $(pre + '-interval-unit').textContent = freq === 'every_n_months' ? 'months' : freq === 'every_n_days' ? 'days' : '';
    return showN;
  }
  function phSchedRender(kind, sched) {
    const pre = _schedPre(kind); sched = sched || {};
    $(pre + '-freq').value = sched.freq || '';
    const showN = _schedToggleN(pre, sched.freq);
    $(pre + '-interval').value = showN && sched.interval_n != null ? sched.interval_n : '';
    $(pre + '-sched-status').textContent = '';
  }
  window.phSchedChange = async function (kind) {
    const p = profileFor(_selName); if (!p) return;
    const pre = _schedPre(kind), col = { weight: 'weight_sched', bp: 'bp_sched', body: 'body_sched' }[kind];
    const freq = $(pre + '-freq').value;
    const showN = _schedToggleN(pre, freq);
    let sched = null;
    if (freq) { sched = { freq }; if (showN) sched.interval_n = Number($(pre + '-interval').value) || 1; }
    const r = await fetch(`${API}/profiles/${p.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [col]: sched }) });
    const st = $(pre + '-sched-status');
    if (r.ok) { p[col] = sched; st.style.color = '#3a7d44'; st.textContent = '✓'; setTimeout(() => { st.textContent = ''; }, 1500); }
    else { st.style.color = '#c0392b'; st.textContent = 'failed'; }
  };

  // ── Settings tab: step-counting config (dashboard_settings.medical.steps),
  // read by the LXC-104 walking-trip → steps watcher. ──
  const STEP_DEFAULTS = { steps_per_km: 1300, accuracy_gate_m: 35, phantom_min_m: 150, drive_kmh: 15, walk_max_km: 30, history_limit: 10 };
  window.medSettingsInit = async function () {
    let cfg = {};
    try { const j = await (await fetch('/api/dashboard-settings/medical.steps')).json(); cfg = (j && j.value) || {}; } catch (e) {}
    cfg = Object.assign({}, STEP_DEFAULTS, cfg);
    $('set-steps-per-km').value  = cfg.steps_per_km;
    $('set-acc-gate').value      = cfg.accuracy_gate_m;
    $('set-phantom-min').value   = cfg.phantom_min_m;
    $('set-drive-kmh').value     = cfg.drive_kmh;
    $('set-walk-maxkm').value    = cfg.walk_max_km;
    $('set-history-limit').value = cfg.history_limit;
    $('set-status').textContent = '';
  };
  window.medSettingsSave = async function () {
    const pmRaw = Number($('set-phantom-min').value);   // 0 allowed (disables the phantom floor)
    const value = {
      steps_per_km:    Number($('set-steps-per-km').value)  || STEP_DEFAULTS.steps_per_km,
      accuracy_gate_m: Number($('set-acc-gate').value)      || STEP_DEFAULTS.accuracy_gate_m,
      phantom_min_m:   Number.isFinite(pmRaw) ? Math.max(0, pmRaw) : STEP_DEFAULTS.phantom_min_m,
      drive_kmh:       Number($('set-drive-kmh').value)     || STEP_DEFAULTS.drive_kmh,
      walk_max_km:     Number($('set-walk-maxkm').value)    || STEP_DEFAULTS.walk_max_km,
      history_limit:   Number($('set-history-limit').value) || STEP_DEFAULTS.history_limit,
    };
    try {
      const r = await fetch('/api/dashboard-settings/medical.steps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      $('set-status').style.color = '#2e7d32'; $('set-status').textContent = '✓ Saved';
    } catch (e) { $('set-status').style.color = '#c0392b'; $('set-status').textContent = 'Failed: ' + e.message; }
  };

  // ── History modal (Log weight / Log BP / Daily steps): last-N list (limit from
  // Settings) + per-row edit + remove, and a "+ Add" with a chosen timestamp. ──
  const HIST = {
    weight: {
      title: 'Weight history', base: () => `${API}/measurements`, ok: () => !!_curProfileId,
      listUrl: (n) => `${API}/measurements?profile_id=${_curProfileId}&limit=${n}`,
      fields: [{ k: 'weight_kg', ph: 'kg', step: '0.1', w: 80 }],
      rowVal: (r) => `${esc(r.weight_kg)} kg`,
      addBody: (v, ts) => ({ profile_id: _curProfileId, weight_kg: v.weight_kg, measured_at: ts }),
      patchBody: (v, ts) => ({ weight_kg: v.weight_kg, measured_at: ts }),
    },
    bp: {
      title: 'Blood pressure history', base: () => `${API}/bp`, ok: () => !!_curProfileId,
      listUrl: (n) => `${API}/bp?profile_id=${_curProfileId}&limit=${n}`,
      fields: [{ k: 'systolic', ph: 'sys', w: 60 }, { k: 'diastolic', ph: 'dia', w: 60 }, { k: 'pulse', ph: 'pulse', w: 60 }],
      rowVal: (r) => `${r.systolic == null ? '—' : r.systolic}/${r.diastolic == null ? '—' : r.diastolic}${r.pulse != null ? ' · ♥ ' + r.pulse : ''}`,
      addBody: (v, ts) => ({ profile_id: _curProfileId, systolic: v.systolic || null, diastolic: v.diastolic || null, pulse: v.pulse || null, measured_at: ts }),
      patchBody: (v, ts) => ({ systolic: v.systolic || null, diastolic: v.diastolic || null, pulse: v.pulse || null, measured_at: ts }),
    },
    body: {
      title: 'Waist & hip history', base: () => `${API}/body`, ok: () => !!_curProfileId,
      listUrl: (n) => `${API}/body?profile_id=${_curProfileId}&limit=${n}`,
      fields: [{ k: 'waist_cm', ph: 'waist cm', step: '0.1', w: 80 }, { k: 'hip_cm', ph: 'hip cm', step: '0.1', w: 80 }],
      rowVal: (r) => `W ${r.waist_cm == null ? '—' : r.waist_cm} · H ${r.hip_cm == null ? '—' : r.hip_cm}` +
        (r.whr != null ? ` · WHR <b>${Number(r.whr).toFixed(2)}</b>` : ''),
      addBody: (v, ts) => ({ profile_id: _curProfileId, waist_cm: v.waist_cm || null, hip_cm: v.hip_cm || null, measured_at: ts }),
      patchBody: (v, ts) => ({ waist_cm: v.waist_cm || null, hip_cm: v.hip_cm || null, measured_at: ts }),
    },
    water: {
      title: 'Water history', base: () => `${API}/water`, ok: () => !!_curProfileId,
      listUrl: (n) => `${API}/water/list?profile_id=${_curProfileId}&limit=${n}`,
      fields: [{ k: 'cups', ph: 'cups', step: '0.5', w: 70 }],
      rowVal: (r) => `${r.cups} cup${Number(r.cups) === 1 ? '' : 's'}`,
      addBody: (v, ts) => ({ profile_id: _curProfileId, cups: v.cups || 1, measured_at: ts }),
      patchBody: (v, ts) => ({ cups: v.cups, measured_at: ts }),
    },
    exercise: {
      title: 'Exercise history', base: () => `${API}/exercise`, ok: () => !!_curProfileId,
      listUrl: (n) => `${API}/exercise/list?profile_id=${_curProfileId}&limit=${n}`,
      fields: [{ k: 'total_calories', ph: 'cal', step: '1', w: 80 }],
      rowVal: (r) => `${Math.round(Number(r.total_calories) || 0)} cal · ${(Array.isArray(r.muscles) ? r.muscles.length : 0)} muscle${(Array.isArray(r.muscles) && r.muscles.length === 1) ? '' : 's'}`,
      addBody: (v, ts) => ({ profile_id: _curProfileId, total_calories: v.total_calories, measured_at: ts }),
      patchBody: (v, ts) => ({ total_calories: v.total_calories, measured_at: ts }),
    },
    steps: {
      title: 'Steps history', base: () => `${API}/steps`, ok: () => !!curUserId(),
      listUrl: (n) => `${API}/steps/list?user_id=${curUserId()}&limit=${n}`,
      fields: [{ k: 'steps', ph: 'steps', w: 90 }],
      rowVal: (r) => `${Number(r.steps).toLocaleString()} steps` + (r.source === 'trip' ? ' <span style="font-size:0.66rem;background:#e0f2fe;color:#075985;padding:1px 6px;border-radius:8px;">trip</span>' : ''),
      addBody: (v, ts) => ({ user_id: curUserId(), steps: v.steps, measured_at: ts }),
      patchBody: (v, ts) => ({ steps: v.steps, measured_at: ts }),
    },
  };
  let _histKind = null, _histRows = [], _histLimit = 10;
  const _histTs = (d, t) => { if (!d) return null; try { return new Date(d + 'T' + (t || '00:00')).toISOString(); } catch (e) { return null; } };

  window.phHistory = async function (kind) {
    const c = HIST[kind]; if (!c || !c.ok()) return;
    _histKind = kind;
    try { const j = await (await fetch('/api/dashboard-settings/medical.steps')).json(); _histLimit = (j && j.value && Number(j.value.history_limit)) || 10; } catch (e) { _histLimit = 10; }
    $('ph-hist-title').textContent = c.title;
    _histBuildAdd();
    await _histList();
    $('ph-hist-modal').style.display = 'flex';
  };
  window.phHistClose = function () { $('ph-hist-modal').style.display = 'none'; };
  window.phHistReload = async function () { await _histList(); };

  function _histBuildAdd() {
    const c = HIST[_histKind];
    const now = new Date();
    const d = now.toISOString().slice(0, 10), t = now.toTimeString().slice(0, 5);
    const flds = c.fields.map(f => `<label style="font-size:0.72rem;color:#555;">${f.ph}<br><input id="pha-${f.k}" type="number" ${f.step ? `step="${f.step}"` : ''} min="0" style="width:${f.w}px;padding:5px;box-sizing:border-box;"></label>`).join('');
    $('ph-hist-add').innerHTML =
      `<label style="font-size:0.72rem;color:#555;">Date<br><input id="pha-date" type="date" value="${d}" style="padding:5px;"></label>` +
      `<label style="font-size:0.72rem;color:#555;">Time<br><input id="pha-time" type="time" value="${t}" style="padding:5px;"></label>` + flds +
      `<button class="btn btn-sm" style="background:#2563eb;color:#fff;" onclick="phHistAdd()">+ Add</button>`;
  }
  async function _histList() {
    const c = HIST[_histKind];
    try { _histRows = await (await fetch(c.listUrl(_histLimit))).json(); } catch (e) { _histRows = []; }
    if (!Array.isArray(_histRows)) _histRows = [];
    const host = $('ph-hist-list');
    host.innerHTML = _histRows.length ? _histRows.map(_histRowHtml).join('')
      : '<div style="color:#aaa;padding:10px;">No entries yet.</div>';
  }
  function _histRowHtml(r) {
    return `<div id="ph-hr-${r.id}" style="display:flex;gap:8px;align-items:center;padding:6px 4px;border-bottom:1px solid #eee;font-size:0.85rem;">
      <span style="color:#888;min-width:120px;">${esc(r.measured_at || '')}</span>
      <span style="flex:1;">${HIST[_histKind].rowVal(r)}</span>
      <button class="btn btn-secondary btn-sm" onclick="phHistEdit(${r.id})">Edit</button>
      <button class="btn btn-secondary btn-sm" style="color:#c0392b;" onclick="phHistDel(${r.id})">✕</button>
    </div>`;
  }
  window.phHistEdit = function (id) {
    const r = _histRows.find(x => x.id === id); if (!r) return;
    const c = HIST[_histKind];
    const parts = (r.measured_at || '').split(' '), d = parts[0] || '', t = parts[1] || '';
    const flds = c.fields.map(f => `<input id="phe-${id}-${f.k}" type="number" ${f.step ? `step="${f.step}"` : ''} min="0" value="${r[f.k] != null ? r[f.k] : ''}" placeholder="${f.ph}" style="width:${f.w}px;padding:4px 6px;">`).join(' ');
    $('ph-hr-' + id).innerHTML =
      `<input id="phe-${id}-date" type="date" value="${d}" style="padding:4px;"> ` +
      `<input id="phe-${id}-time" type="time" value="${t}" style="padding:4px;"> ` + flds +
      ` <button class="btn btn-sm" style="background:#3a7d44;color:#fff;" onclick="phHistSave(${id})">Save</button>` +
      ` <button class="btn btn-secondary btn-sm" onclick="phHistReload()">Cancel</button>`;
  };
  window.phHistSave = async function (id) {
    const c = HIST[_histKind];
    const v = {}; c.fields.forEach(f => v[f.k] = $('phe-' + id + '-' + f.k).value);
    const ts = _histTs($('phe-' + id + '-date').value, $('phe-' + id + '-time').value);
    const r = await fetch(`${c.base()}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c.patchBody(v, ts)) });
    if (!r.ok) { alert('Save failed'); return; }
    await _histList(); await _histRefreshCard();
  };
  window.phHistDel = async function (id) {
    if (!confirm('Remove this entry?')) return;
    await fetch(`${HIST[_histKind].base()}/${id}`, { method: 'DELETE' });
    await _histList(); await _histRefreshCard();
  };
  window.phHistAdd = async function () {
    const c = HIST[_histKind];
    const v = {}; c.fields.forEach(f => v[f.k] = $('pha-' + f.k).value);
    if (c.fields.every(f => !v[f.k])) return;
    const ts = _histTs($('pha-date').value, $('pha-time').value);
    const r = await fetch(c.base(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c.addBody(v, ts)) });
    if (!r.ok) { alert('Add failed'); return; }
    c.fields.forEach(f => $('pha-' + f.k).value = '');
    await _histList(); await _histRefreshCard();
  };
  async function _histRefreshCard() {
    // body: reload profiles so the latest Waist/Hip/WHR summary chips refresh after a
    // history edit (renderDetail reads the cached profile's latest_*; weight refetches
    // measurements itself so it doesn't need this).
    if (_histKind === 'steps') await phLoadSteps();
    else if (_histKind === 'water') await phLoadWater();
    else if (_histKind === 'exercise') await phLoadExercise();
    else if (_histKind === 'body') { await phInit(); await renderDetail(); }
    else await renderDetail();
  }

  // ── Medications (pills) ──────────────────────────────────────────────────────
  // ── Special Schedule color band — uses the SHARED project-wide "Schedule &
  // appointment colors" (dashboard_settings.privacy.settings, edited in Privacy →
  // Settings). Same logic as privacy.js _pvApptBand, copied here because
  // medical.html doesn't load privacy.js. ──
  let _phApptColors = { red_days: 3, yellow_days: 7, grey_days: 7 };
  async function _phLoadApptColors() {
    try {
      const v = (await (await fetch('/api/dashboard-settings/privacy.settings')).json() || {}).value || {};
      ['red_days', 'yellow_days', 'grey_days'].forEach(k => { const n = parseInt(v[k], 10); if (Number.isFinite(n) && n >= 0) _phApptColors[k] = n; });
    } catch (e) { /* keep defaults */ }
  }
  function _phApptBand(d) {
    if (isNaN(d)) return { bg: '#f9fafb', past: false };
    const k = _phApptColors, RED = '#fecaca';
    const days = (d.getTime() - Date.now()) / 86400000;
    if (days < 0) return (-days <= k.grey_days) ? { bg: RED, past: true } : { bg: '#f3f4f6', past: true };
    if (days <= k.red_days) return { bg: RED, past: false };
    if (days <= k.red_days + k.yellow_days) return { bg: '#fef9c3', past: false };
    return { bg: '#f0fdf4', past: false };
  }
  function _phSpecialCell(m) {
    if (!m.special_date) return '<td style="color:#ccc;">—</td>';
    const d = new Date(m.special_date + 'T00:00:00');
    const band = _phApptBand(d);
    const when = isNaN(d) ? esc(m.special_date) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const note = m.special_note ? ` · ${esc(m.special_note)}` : '';
    const past = band.past ? ' <span style="font-size:0.66rem;color:#777;">(past)</span>' : '';
    return `<td style="background:${band.bg};color:#000;border-radius:4px;">${when}${note}${past}</td>`;
  }

  // "2026-11-15" → "15 Nov 2026"
  const _phFmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  // html=true → the next-due date is a bigger green span (for the table); html
  // falsy → plain text (for the Info window). Dynamic parts esc'd in html mode.
  function medSchedText(m, html) {
    const t  = m.times ? ' · ' + (html ? esc(m.times) : m.times) : '';
    const ds = _phFmtDate(m.next_due);
    const nd = m.next_due
      ? ' · next' + (html ? `<span style="color:#1a7f37;font-size:0.92rem;font-weight:600;margin-left:8px;">${ds}</span>` : ' ' + ds)
      : '';
    const dow = m.dow ? ' · ' + (html ? esc(m.dow) : m.dow) : '';
    switch (m.freq) {
      case 'daily':          return 'Daily' + t;
      case 'weekly':         return 'Weekly' + dow + t;
      case 'every_n_months': return `Every ${m.interval_n || '?'} month(s)` + nd + t;
      case 'every_n_days':   return `Every ${m.interval_n || '?'} day(s)` + nd + t;
      case 'once':           return 'One-time' + nd + t;
      case 'as_needed':      return 'As needed';
      default:               return m.freq || '—';
    }
  }
  async function phLoadMeds(profileId) {
    _meds = await (await fetch(`${API}/medications?profile_id=${profileId}`)).json();
    // Row shows the basic med info (name · dose · schedule) + actions. The ℹ️ Info
    // button opens the extra/safety info (purpose, avoid-with, contraindications…).
    const hasSpecial = _meds.some(m => m.special_date);
    $('ph-meds-list').innerHTML = _meds.length ? `
      <table class="data-table"><thead><tr><th>Medication</th><th>Dose</th><th>Schedule</th>${hasSpecial ? '<th>Special Schedule</th>' : ''}<th></th></tr></thead>
      <tbody>${_meds.map(m => `<tr style="${m.active ? '' : 'opacity:0.5;'}">
        <td>💊 ${esc(m.name)}${m.active ? '' : ' <span style="font-size:0.7rem;color:#888;">(stopped)</span>'}</td>
        <td>${esc(m.dose || '—')}</td>
        <td>${medSchedText(m, true)}</td>
        ${hasSpecial ? _phSpecialCell(m) : ''}
        <td style="white-space:nowrap;text-align:right;">
          <button class="btn btn-secondary btn-sm" onclick="phMedInfo(${m.id})">ℹ️ Info</button>
          <button class="btn btn-secondary btn-sm" onclick="phEditMed(${m.id})">Edit</button>
          <button class="btn btn-secondary btn-sm" onclick="phToggleMed(${m.id}, ${m.active ? 'false' : 'true'})">${m.active ? 'Stop' : 'Resume'}</button>
          <button class="btn btn-secondary btn-sm" style="color:#c0392b;" onclick="phDelMed(${m.id})">Del</button></td>
      </tr>`).join('')}</tbody></table>`
      : '<div style="color:#aaa;">No medications — click <b>+ Add medication</b>.</div>';
  }
  window.phFreqChanged = function () {
    const f = $('ph-m-freq').value, show = (id, on) => { $(id).style.display = on ? '' : 'none'; };
    show('ph-m-interval-wrap', f === 'every_n_months' || f === 'every_n_days');
    show('ph-m-dow-wrap',      f === 'weekly');
    show('ph-m-nextdue-wrap',  f === 'every_n_months' || f === 'every_n_days' || f === 'once');
    show('ph-m-times-wrap',    f !== 'as_needed');
    $('ph-m-interval-unit').textContent = f === 'every_n_months' ? 'months' : f === 'every_n_days' ? 'days' : 'N';
  };
  function fillMedForm(m) {
    $('ph-m-name').value     = m.name || '';
    $('ph-m-dose').value     = m.dose || '';
    $('ph-m-freq').value     = m.freq || 'daily';
    $('ph-m-interval').value = m.interval_n != null ? m.interval_n : '';
    $('ph-m-dow').value      = m.dow || '';
    $('ph-m-nextdue').value  = dpart(m.next_due);
    $('ph-m-times').value    = m.times || '';
    $('ph-m-notes').value    = m.notes || '';
    $('ph-m-special-date').value = dpart(m.special_date);
    $('ph-m-special-note').value = m.special_note || '';
    $('ph-m-active').checked = m.active !== false;
    $('ph-med-status').textContent = '';
    phFreqChanged();
    $('ph-med-form').style.display = '';
  }
  window.phAddMed  = function ()   { _editMedId = null; fillMedForm({ freq: 'daily', active: true }); };
  window.phEditMed = function (id) { const m = _meds.find(x => x.id === id); if (m) { _editMedId = id; fillMedForm(m); } };
  window.phCancelMed = function () { $('ph-med-form').style.display = 'none'; };
  window.phSaveMed = async function () {
    if (!_curProfileId) return;
    const name = $('ph-m-name').value.trim();
    if (!name) { $('ph-med-status').textContent = 'Name required'; return; }
    const body = {
      profile_id: _curProfileId, name, dose: $('ph-m-dose').value.trim(),
      freq: $('ph-m-freq').value, interval_n: $('ph-m-interval').value || null,
      times: $('ph-m-times').value.trim(), dow: $('ph-m-dow').value.trim(),
      next_due: $('ph-m-nextdue').value || null, notes: $('ph-m-notes').value.trim(),
      special_date: $('ph-m-special-date').value || null, special_note: $('ph-m-special-note').value.trim(),
      active: $('ph-m-active').checked,
    };
    const r = _editMedId
      ? await fetch(`${API}/medications/${_editMedId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      : await fetch(`${API}/medications`,               { method: 'POST',  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('ph-med-status').textContent = 'Failed: ' + (j.error || r.status); return; }
    $('ph-med-form').style.display = 'none';
    await phLoadMeds(_curProfileId);
  };
  window.phToggleMed = async function (id, active) {
    await fetch(`${API}/medications/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }) });
    await phLoadMeds(_curProfileId);
  };
  window.phDelMed = async function (id) {
    if (!confirm('Delete this medication?')) return;
    await fetch(`${API}/medications/${id}`, { method: 'DELETE' });
    await phLoadMeds(_curProfileId);
  };

  // ── Info window (all details for one pill) ───────────────────────────────────
  window.phMedInfo = function (id) {
    const m = _meds.find(x => x.id === id); if (!m) return;
    _infoMedId = id;
    $('ph-info-title').textContent = '💊 ' + m.name + (m.active ? '' : ' (stopped)');
    const doc = _doctors.find(d => String(d.id) === String(m.prescriber_id));
    const cell = (color) => `style="display:grid;grid-template-columns:150px 1fr;gap:8px;padding:5px 0;border-bottom:1px solid #f3f0ea;"`;
    const row  = (l, v) => v ? `<div ${cell()}><div style="color:#888;font-size:0.8rem;">${esc(l)}</div><div>${esc(v)}</div></div>` : '';
    const warn = (l, v) => v ? `<div ${cell()}><div style="color:#a33;font-size:0.8rem;font-weight:600;">⚠ ${esc(l)}</div><div style="color:#a33;">${esc(v)}</div></div>` : '';
    const html =
      row('Dose', m.dose) + row('Schedule', medSchedText(m)) + row('Purpose', m.purpose) +
      row('Ingredients', m.ingredients) + row('Drug class', m.drug_class) +
      warn('Avoid with', m.avoid_with) + warn('Contraindications', m.contraindications) +
      row('Side effects', m.side_effects) + row('Warnings', m.warnings) +
      row('Prescriber', doc ? doc.name : '') + row('Started', m.started_at) + row('Notes', m.notes);
    $('ph-info-body').innerHTML = html || '<div style="color:#888;">No extra info yet — click <b>✎ Edit info</b> to add it.</div>';
    // read mode
    $('ph-info-body').style.display = '';
    $('ph-info-form').style.display = 'none';
    $('ph-info-editbtn').style.display = '';
    $('ph-info-savebtn').style.display = 'none';
    $('ph-info-canceledit').style.display = 'none';
    $('ph-med-info').style.display = 'flex';
  };
  window.phCloseInfo = function () { $('ph-med-info').style.display = 'none'; };
  // Edit only the extra/safety info (the basic med info is edited from the row's Edit).
  window.phInfoEdit = function () {
    const m = _meds.find(x => x.id === _infoMedId); if (!m) return;
    $('ph-i-purpose').value     = m.purpose || '';
    $('ph-i-ingredients').value = m.ingredients || '';
    $('ph-i-class').value       = m.drug_class || '';
    $('ph-i-prescriber').value  = m.prescriber_id != null ? String(m.prescriber_id) : '';
    $('ph-i-started').value     = dpart(m.started_at);
    $('ph-i-avoid').value       = m.avoid_with || '';
    $('ph-i-contra').value      = m.contraindications || '';
    $('ph-i-side').value        = m.side_effects || '';
    $('ph-i-warn').value        = m.warnings || '';
    $('ph-i-status').textContent = '';
    $('ph-info-body').style.display = 'none';
    $('ph-info-form').style.display = '';
    $('ph-info-editbtn').style.display = 'none';
    $('ph-info-savebtn').style.display = '';
    $('ph-info-canceledit').style.display = '';
  };
  window.phInfoCancelEdit = function () { phMedInfo(_infoMedId); };
  window.phInfoSave = async function () {
    if (!_infoMedId) return;
    const body = {
      purpose: $('ph-i-purpose').value.trim(), ingredients: $('ph-i-ingredients').value.trim(),
      drug_class: $('ph-i-class').value.trim(), prescriber_id: $('ph-i-prescriber').value || null,
      started_at: $('ph-i-started').value || null, avoid_with: $('ph-i-avoid').value.trim(),
      contraindications: $('ph-i-contra').value.trim(), side_effects: $('ph-i-side').value.trim(),
      warnings: $('ph-i-warn').value.trim(),
    };
    const r = await fetch(`${API}/medications/${_infoMedId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('ph-i-status').textContent = 'Failed: ' + (j.error || r.status); return; }
    await phLoadMeds(_curProfileId);
    phMedInfo(_infoMedId);
  };
})();
