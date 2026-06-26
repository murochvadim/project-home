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

  async function phInit() {
    _phLoadApptColors();   // shared Schedule & appointment color bands (Privacy → Settings)
    const [uRes, pRes] = await Promise.all([
      fetch('/api/household-users').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(API + '/profiles').then(r => r.json()).catch(() => []),
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
      $('ph-stepscard').style.display = 'none';
      $('ph-medscard').style.display = 'none';
      _curProfileId = null;
      return;
    }
    $('ph-logcard').style.display = '';
    $('ph-bpcard').style.display = '';
    $('ph-stepscard').style.display = '';
    $('ph-medscard').style.display = '';
    _curProfileId = p.id;
    phLoadMeds(p.id);
    phLoadSteps();
    phSchedRender('weight', p.weight_sched);
    phSchedRender('bp', p.bp_sched);
    const h = p.height_cm != null ? Number(p.height_cm) : null;
    const meas = await (await fetch(`${API}/measurements?profile_id=${p.id}`)).json();
    const latestW = meas.length ? Number(meas[0].weight_kg)
      : (p.latest_weight_kg != null ? Number(p.latest_weight_kg) : null);
    const b = bmi(latestW, h), cat = bmiCat(b), ir = idealRange(h), a = age(p.date_of_birth);

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
      chip('Ideal', ir ? `${ir.lo.toFixed(0)}–${ir.hi.toFixed(0)} kg` : '—');
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

  // ── Measure schedule (Weight / BP) — {freq, interval_n} on the profile, drives
  // a FUTURE reminder watcher. Same options as meds minus weekday / day / time. ──
  const _schedPre = (kind) => (kind === 'weight' ? 'ph-w' : 'ph-bp');
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
    const pre = _schedPre(kind), col = kind === 'weight' ? 'weight_sched' : 'bp_sched';
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
  const STEP_DEFAULTS = { steps_per_km: 1300, walk_min_kmh: 2, walk_max_kmh: 9, walk_max_km: 30, history_limit: 10 };
  window.medSettingsInit = async function () {
    let cfg = {};
    try { const j = await (await fetch('/api/dashboard-settings/medical.steps')).json(); cfg = (j && j.value) || {}; } catch (e) {}
    cfg = Object.assign({}, STEP_DEFAULTS, cfg);
    $('set-steps-per-km').value = cfg.steps_per_km;
    $('set-walk-min').value     = cfg.walk_min_kmh;
    $('set-walk-max').value     = cfg.walk_max_kmh;
    $('set-walk-maxkm').value   = cfg.walk_max_km;
    $('set-history-limit').value = cfg.history_limit;
    $('set-status').textContent = '';
  };
  window.medSettingsSave = async function () {
    const value = {
      steps_per_km: Number($('set-steps-per-km').value) || STEP_DEFAULTS.steps_per_km,
      walk_min_kmh: Number($('set-walk-min').value)     || STEP_DEFAULTS.walk_min_kmh,
      walk_max_kmh: Number($('set-walk-max').value)     || STEP_DEFAULTS.walk_max_kmh,
      walk_max_km:  Number($('set-walk-maxkm').value)   || STEP_DEFAULTS.walk_max_km,
      history_limit: Number($('set-history-limit').value) || STEP_DEFAULTS.history_limit,
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
    if (_histKind === 'steps') await phLoadSteps(); else await renderDetail();
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

  function medSchedText(m) {
    const t  = m.times ? ' · ' + m.times : '';
    const nd = m.next_due ? ' · next ' + m.next_due : '';
    switch (m.freq) {
      case 'daily':          return 'Daily' + t;
      case 'weekly':         return 'Weekly' + (m.dow ? ' · ' + m.dow : '') + t;
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
        <td>${esc(medSchedText(m))}</td>
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
