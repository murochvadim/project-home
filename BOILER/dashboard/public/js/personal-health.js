// Personal Health — Medical → Personal Health tab (minimum first step).
// People come from the EXISTING household-users registry (Privacy → Settings →
// Users, stored in dashboard_settings key 'privacy.users' as [{name, smartphone}]).
// This tab attaches a body profile (sex / DOB / height) + a weight log to each
// member by name, and computes BMI / age / ideal-weight. No people are created here.
(function () {
  const API = '/api/personal-health';
  let _users = [];      // household member names (from privacy.users)
  let _profiles = [];   // ph_profiles rows (body details, keyed by name)
  let _selName = null;  // currently-selected household member
  let _curProfileId = null; // resolved ph_profiles.id of the selected person (meds + weight)
  let _meds = [], _editMedId = null;
  let _doctors = [], _infoMedId = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const dpart = (s) => (s ? String(s).slice(0, 10) : '');
  const profileFor = (name) => _profiles.find(p => p.name === name) || null;

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
    const [uRes, pRes] = await Promise.all([
      fetch('/api/dashboard-settings/privacy.users').then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(API + '/profiles').then(r => r.json()).catch(() => []),
    ]);
    const uv = uRes && uRes.value;
    _users = (Array.isArray(uv) ? uv : []).map(u => (u && u.name || '').trim()).filter(Boolean);
    _profiles = Array.isArray(pRes) ? pRes : [];
    const sel = $('ph-person');
    sel.innerHTML = '<option value="">— select person —</option>' +
      _users.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    $('ph-no-users').style.display = _users.length ? 'none' : '';
    // Prescriber dropdown ← your doctors (Medical → Contacts, kind='doctor').
    try {
      const cs = await (await fetch('/api/medical/contacts')).json();
      _doctors = (Array.isArray(cs) ? cs : []).filter(c => c.kind === 'doctor');
    } catch (e) { _doctors = []; }
    const ps = $('ph-i-prescriber');
    if (ps) ps.innerHTML = '<option value="">—</option>' +
      _doctors.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    if (_selName && _users.includes(_selName)) { sel.value = _selName; showEdit(true); renderDetail(); }
    else { _selName = null; showEdit(false); $('ph-detail').style.display = 'none'; }
  }
  window.phInit = phInit;

  const showEdit = (on) => { $('ph-edit-btn').style.display = on ? '' : 'none'; };

  window.phSelectPerson = function (name) {
    _selName = name || null;
    if (_selName) { showEdit(true); renderDetail(); }
    else { showEdit(false); $('ph-detail').style.display = 'none'; }
  };

  // ── body-details form (sex / DOB / height) — name = the selected household user ──
  window.phEditDetails = function () {
    if (!_selName) return;
    const p = profileFor(_selName) || {};
    $('ph-f-sex').value        = p.sex || '';
    $('ph-f-dob').value        = dpart(p.date_of_birth);
    $('ph-f-height').value     = p.height_cm != null ? p.height_cm : '';
    $('ph-f-allergies').value  = p.allergies || '';
    $('ph-f-conditions').value = p.conditions || '';
    $('ph-form-status').textContent = '';
    $('ph-person-form').style.display = '';
  };
  window.phCancelForm = function () { $('ph-person-form').style.display = 'none'; };
  window.phSaveDetails = async function () {
    if (!_selName) return;
    const body = { sex: $('ph-f-sex').value, date_of_birth: $('ph-f-dob').value || null, height_cm: $('ph-f-height').value || null,
                   allergies: $('ph-f-allergies').value.trim(), conditions: $('ph-f-conditions').value.trim() };
    const p = profileFor(_selName);
    const r = p
      ? await fetch(`${API}/profiles/${p.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      : await fetch(`${API}/profiles`,         { method: 'POST',  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: _selName, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('ph-form-status').textContent = 'Failed: ' + (j.error || r.status); return; }
    $('ph-person-form').style.display = 'none';
    await phInit();
  };

  // ── detail (summary + log + history) ──
  async function renderDetail() {
    $('ph-detail').style.display = '';
    $('ph-sum-name').textContent = '· ' + _selName;
    const p = profileFor(_selName);
    if (!p) {
      $('ph-summary').innerHTML = '<div style="color:#888;">No health details for <b>' + esc(_selName) +
        '</b> yet — click <b>Edit details</b> to add height / date of birth / sex (needed for BMI).</div>';
      $('ph-logcard').style.display = 'none';
      $('ph-histcard').style.display = 'none';
      $('ph-medscard').style.display = 'none';
      _curProfileId = null;
      return;
    }
    $('ph-logcard').style.display = '';
    $('ph-histcard').style.display = '';
    $('ph-medscard').style.display = '';
    _curProfileId = p.id;
    phLoadMeds(p.id);
    const h = p.height_cm != null ? Number(p.height_cm) : null;
    const meas = await (await fetch(`${API}/measurements?profile_id=${p.id}`)).json();
    const latestW = meas.length ? Number(meas[0].weight_kg)
      : (p.latest_weight_kg != null ? Number(p.latest_weight_kg) : null);
    const b = bmi(latestW, h), cat = bmiCat(b), ir = idealRange(h), a = age(p.date_of_birth);

    const chip = (label, val) =>
      `<div><div style="font-size:0.72rem;color:#888;text-transform:uppercase;">${label}</div>
        <div style="font-size:1.3rem;font-weight:700;">${val}</div></div>`;
    $('ph-summary').innerHTML =
      chip('Age', a == null ? '—' : a) +
      chip('Sex', p.sex ? esc(p.sex) : '—') +
      chip('Height', h != null ? h + ' cm' : '—') +
      chip('Latest weight', latestW != null ? latestW + ' kg' : '—') +
      `<div><div style="font-size:0.72rem;color:#888;text-transform:uppercase;">BMI</div>
        <div style="font-size:1.3rem;font-weight:700;color:${cat.color};">${b == null ? '—' : b.toFixed(1)}
        <span style="font-size:0.78rem;font-weight:600;">${cat.label}</span></div></div>` +
      chip('Ideal weight', ir ? `${ir.lo.toFixed(0)}–${ir.hi.toFixed(0)} kg` : '—');

    if (!$('ph-w-date').value) $('ph-w-date').value = new Date().toISOString().slice(0, 10);

    $('ph-history').innerHTML = meas.length ? `
      <table class="data-table"><thead><tr><th>Date</th><th>Weight</th><th>BMI</th><th></th></tr></thead>
      <tbody>${meas.map(m => {
        const mb = bmi(Number(m.weight_kg), h), mc = bmiCat(mb);
        return `<tr><td>${esc(dpart(m.measured_at))}</td><td>${Number(m.weight_kg)} kg</td>
          <td style="color:${mc.color};font-weight:600;">${mb == null ? '—' : mb.toFixed(1)}</td>
          <td><button class="btn btn-secondary btn-sm" style="color:#c0392b;" onclick="phDelMeas(${m.id})">Del</button></td></tr>`;
      }).join('')}</tbody></table>`
      : '<div style="color:#aaa;">No measurements yet — log a weight above.</div>';
  }

  // ── log / delete weight ──
  window.phLogWeight = async function () {
    const p = profileFor(_selName); if (!p) return;
    const w = $('ph-w-kg').value;
    if (!w) { $('ph-w-status').textContent = 'Enter a weight'; return; }
    const r = await fetch(`${API}/measurements`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: p.id, measured_at: $('ph-w-date').value || null, weight_kg: w }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('ph-w-status').textContent = 'Failed: ' + (j.error || r.status); return; }
    $('ph-w-kg').value = ''; $('ph-w-status').textContent = '✓ saved';
    await phInit(); await renderDetail();
  };
  window.phDelMeas = async function (id) {
    if (!confirm('Delete this measurement?')) return;
    await fetch(`${API}/measurements/${id}`, { method: 'DELETE' });
    await phInit(); await renderDetail();
  };

  // ── Medications (pills) ──────────────────────────────────────────────────────
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
    $('ph-meds-list').innerHTML = _meds.length ? `
      <table class="data-table"><thead><tr><th>Medication</th><th>Dose</th><th>Schedule</th><th></th></tr></thead>
      <tbody>${_meds.map(m => `<tr style="${m.active ? '' : 'opacity:0.5;'}">
        <td>💊 ${esc(m.name)}${m.active ? '' : ' <span style="font-size:0.7rem;color:#888;">(stopped)</span>'}</td>
        <td>${esc(m.dose || '—')}</td>
        <td>${esc(medSchedText(m))}</td>
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
