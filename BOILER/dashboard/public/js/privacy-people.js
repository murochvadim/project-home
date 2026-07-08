// People / Heritage — Directory (Privacy → People tab), Phase 1.
// The list shows ONLY a colored person-icon + first/last name (per the plan);
// clicking a person opens a window to view/edit all their data + relations.
// Adding a person is the ＋ icon at the top-left → same window, empty.
// Backend: routes-people.js. Reuses Nominatim (like Places) + /api/household-users.
(function () {
  const API = '/api/people';
  // default buckets (drive the icon-ring color + totals); overridable via
  // dashboard_settings.people.categories later.
  const PPL_DEFAULT_CATS = [
    { id: 'family_mine',   name: 'My family',     color: '#2563eb' },
    { id: 'family_spouse', name: "Wife's family", color: '#7c3aed' },
    { id: 'friend',        name: 'Friends',       color: '#16a34a' },
    { id: 'other',         name: 'People I know',  color: '#9ca3af' },
  ];
  const GENDERS = ['', 'female', 'male', 'other'];
  const REL_TYPES = ['parent', 'child', 'spouse', 'sibling', 'friend', 'other'];

  // shared grid so figures stay aligned in rows/columns (auto-layout AND after a drag snaps to it)
  const GRID = { COLW: 104, ROWH: 118, PAD: 14, PAD_TOP: 56 };
  const _snap = (v, origin, cell) => Math.max(0, origin + Math.round((v - origin) / cell) * cell);

  let _cats = PPL_DEFAULT_CATS, _people = [], _users = [];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const catBy = (id) => _cats.find(c => c.id === id) || { id: id || 'other', name: id || '—', color: '#9ca3af' };
  const nameOf = (p) => ([p.given_name, p.family_name].filter(Boolean).join(' ') || p.maiden_name || ('#' + p.id));

  window.pvPeopleOnShow = async function () {
    await _loadCats(); await _loadUsers(); await _loadPeople();
  };
  async function _loadCats() {
    try { const j = await (await fetch('/api/dashboard-settings/people')).json(); const v = (j && j.value) || {};
      _cats = (Array.isArray(v.categories) && v.categories.length) ? v.categories : PPL_DEFAULT_CATS; }
    catch (e) { _cats = PPL_DEFAULT_CATS; }
  }
  async function _loadUsers() {
    try { _users = await (await fetch('/api/household-users')).json(); } catch (e) { _users = []; }
    if (!Array.isArray(_users)) _users = [];
  }
  async function _loadPeople() {
    try { _people = await (await fetch(API)).json(); } catch (e) { _people = []; }
    if (!Array.isArray(_people)) _people = [];
    _fillFilterCats(); pvPeopleRender();
  }

  // ── list: icon + first/last name only; click a person → view/edit window ──
  function _fillFilterCats() {
    const sel = document.getElementById('ppl-filter-cat'); if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All categories</option>' + _cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    sel.value = cur;
  }
  // free canvas: each person is a draggable figure at (pos_x,pos_y); unplaced
  // people auto-grid until first drag. Drag saves the position; a click opens the window.
  window.pvPeopleRender = function () {
    const box = document.getElementById('ppl-canvas'); if (!box) return;
    const fc = (document.getElementById('ppl-filter-cat') || {}).value || '';
    const fq = ((document.getElementById('ppl-filter-q') || {}).value || '').trim().toLowerCase();
    const match = (p) => (!fc || p.category === fc) &&
      (!fq || (`${p.given_name || ''} ${p.family_name || ''} ${p.maiden_name || ''} ${p.relationship_to_me || ''} ${p.notes || ''}`).toLowerCase().includes(fq));
    const rows = _people.filter(match);
    const tEl = document.getElementById('ppl-totals');
    if (tEl) tEl.innerHTML = _cats.map(c => `<span style="margin-left:8px; white-space:nowrap;"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c.color};"></span> ${esc(c.name)} ${_people.filter(p => p.category === c.id).length}</span>`).join('') + ` · <b>Total ${_people.length}</b>`;
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = '<div style="color:#aaa; padding:12px;">No people yet — click ＋ to add someone.</div>'; return; }
    const COLW = GRID.COLW, ROWH = GRID.ROWH, PAD = GRID.PAD, PAD_TOP = GRID.PAD_TOP;   // PAD_TOP clears the floating ＋/🔍 icons
    const cols = Math.max(1, Math.floor((box.clientWidth - PAD) / COLW)) || 6;
    let gi = 0;
    rows.forEach(p => {
      let x = p.pos_x, y = p.pos_y;
      if (x == null || y == null) { x = PAD + (gi % cols) * COLW; y = PAD_TOP + Math.floor(gi / cols) * ROWH; gi++; }
      else { x = _snap(x, PAD, COLW); y = _snap(y, PAD_TOP, ROWH); }   // keep saved positions on the grid too
      const c = catBy(p.category);
      const av = p.photo
        ? `<img src="${API}/${p.id}/photo?t=${Date.now()}" draggable="false" style="display:block;margin:0 auto;width:64px;height:64px;border-radius:50%;object-fit:cover;border:3px solid ${c.color};pointer-events:none;">`
        : `<div style="margin:0 auto;width:64px;height:64px;border-radius:50%;background:${c.color}22;border:3px solid ${c.color};display:flex;align-items:center;justify-content:center;font-size:1.9rem;pointer-events:none;">👤</div>`;
      const el = document.createElement('div');
      el.dataset.id = p.id;
      el.title = `${nameOf(p)} — ${c.name}`;
      el.style.cssText = `position:absolute; left:${x}px; top:${y}px; width:88px; text-align:center; cursor:grab; user-select:none; touch-action:none;`;
      el.innerHTML = `${av}<div style="font-size:0.82rem; margin-top:5px; line-height:1.2; word-break:break-word; pointer-events:none;">${esc(nameOf(p))}</div>`;
      box.appendChild(el);
      _makeDraggable(el, p);
    });
  };
  function _makeDraggable(el, p) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragging = false;
    el.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY; ox = parseFloat(el.style.left) || 0; oy = parseFloat(el.style.top) || 0;
      el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing'; el.style.zIndex = 1000;
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      el.style.left = Math.max(0, ox + dx) + 'px'; el.style.top = Math.max(0, oy + dy) + 'px';
    });
    const end = () => {
      if (!dragging) return; dragging = false; el.style.cursor = 'grab'; el.style.zIndex = '';
      if (moved) {
        // snap to the grid so figures stay aligned in rows/columns
        const nx = _snap(parseFloat(el.style.left) || 0, GRID.PAD, GRID.COLW);
        const ny = _snap(parseFloat(el.style.top) || 0, GRID.PAD_TOP, GRID.ROWH);
        el.style.left = nx + 'px'; el.style.top = ny + 'px';
        p.pos_x = nx; p.pos_y = ny;
        fetch(`${API}/${p.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pos_x: nx, pos_y: ny }) }).catch(() => {});
      } else {
        pvPeopleEdit(p.id);   // it was a click, not a drag → open the window
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // search icon → toggle the search box (same click-to-open pattern as ＋); closing clears the filter
  window.pvPeopleSearchToggle = function () {
    const inp = document.getElementById('ppl-filter-q'); if (!inp) return;
    const shown = inp.style.display !== 'none';
    if (shown) { inp.style.display = 'none'; inp.value = ''; pvPeopleRender(); }   // close + clear filter
    else { inp.style.display = 'inline-block'; inp.focus(); }
  };

  // ── shared field set (used by the Add/Edit window) ──
  function _fieldsHtml(pre, p) {
    p = p || {};
    const opt = (v, cur, lab) => `<option value="${esc(v)}"${String(cur || '') === String(v) ? ' selected' : ''}>${esc(lab)}</option>`;
    const catOpts = _cats.map(c => opt(c.id, p.category || 'other', c.name)).join('');
    const genOpts = GENDERS.map(g => opt(g, p.gender || '', g || '—')).join('');
    const userOpts = '<option value="">— not a household member —</option>' + _users.map(u => opt(u.id, p.household_user_id || '', u.name)).join('');
    const I = (k, ph, type) => `<input id="${pre}-${k}" value="${esc(p[k] || '')}" placeholder="${esc(ph || '')}" ${type ? `type="${type}"` : ''} style="width:100%; box-sizing:border-box; padding:5px 8px; border:1px solid #ccc; border-radius:4px; margin-bottom:6px;">`;
    return `
      <div style="display:flex; gap:6px;">${I('given_name', 'first name')}${I('family_name', 'family name')}</div>
      ${I('maiden_name', 'maiden name (optional)')}
      <label style="font-size:0.76rem; color:#666;">Category</label>
      <select id="${pre}-category" style="width:100%; padding:5px 8px; border:1px solid #ccc; border-radius:4px; margin-bottom:6px;">${catOpts}</select>
      <div style="display:flex; gap:6px; align-items:center;">
        <select id="${pre}-gender" style="flex:1; padding:5px 8px; border:1px solid #ccc; border-radius:4px; margin-bottom:6px;">${genOpts}</select>
        <label style="font-size:0.72rem; color:#666;">born <input id="${pre}-birth_date" type="date" value="${esc(p.birth_date ? String(p.birth_date).slice(0,10) : '')}" style="padding:4px; border:1px solid #ccc; border-radius:4px;"></label>
        <label style="font-size:0.72rem; color:#666;">died <input id="${pre}-death_date" type="date" value="${esc(p.death_date ? String(p.death_date).slice(0,10) : '')}" style="padding:4px; border:1px solid #ccc; border-radius:4px;"></label>
      </div>
      ${I('relationship_to_me', 'how you know them / how related')}
      ${I('phone', 'phone')}${I('email', 'email')}${I('address', 'address')}
      <div style="display:flex; gap:6px; align-items:center;">
        ${I('origin_place', 'origin place')}${I('origin_country', 'country')}
        <button type="button" onclick="pvPeopleGeocode('${pre}')" style="padding:5px 8px; border:1px solid #2563eb; color:#2563eb; background:#fff; border-radius:4px; cursor:pointer; white-space:nowrap;">📍 Find</button>
      </div>
      <input id="${pre}-lat" type="hidden" value="${esc(p.lat != null ? p.lat : '')}"><input id="${pre}-lon" type="hidden" value="${esc(p.lon != null ? p.lon : '')}">
      <span id="${pre}-geo" style="font-size:0.72rem; color:#16a34a;">${(p.lat != null && p.lon != null) ? '📍 located' : ''}</span>
      ${I('tags', 'tags, comma-separated')}
      <label style="font-size:0.76rem; color:#666;">Household member link</label>
      <select id="${pre}-household_user_id" style="width:100%; padding:5px 8px; border:1px solid #ccc; border-radius:4px; margin-bottom:6px;">${userOpts}</select>
      <textarea id="${pre}-notes" rows="2" placeholder="notes / story" style="width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid #ccc; border-radius:4px;">${esc(p.notes || '')}</textarea>`;
  }
  function _readFields(pre) {
    const g = (k) => { const el = document.getElementById(`${pre}-${k}`); return el ? el.value : ''; };
    const tags = g('tags').split(',').map(s => s.trim()).filter(Boolean);
    return {
      given_name: g('given_name'), family_name: g('family_name'), maiden_name: g('maiden_name'),
      category: g('category'), gender: g('gender'), birth_date: g('birth_date'), death_date: g('death_date'),
      relationship_to_me: g('relationship_to_me'), phone: g('phone'), email: g('email'), address: g('address'),
      origin_place: g('origin_place'), origin_country: g('origin_country'), lat: g('lat'), lon: g('lon'),
      tags, notes: g('notes'), household_user_id: g('household_user_id'),
    };
  }
  window.pvPeopleGeocode = async function (pre) {
    const q = [document.getElementById(`${pre}-origin_place`).value, document.getElementById(`${pre}-origin_country`).value].filter(Boolean).join(', ');
    const geo = document.getElementById(`${pre}-geo`);
    if (!q) { if (geo) geo.textContent = ''; return; }
    if (geo) { geo.style.color = '#888'; geo.textContent = 'looking…'; }
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q);
      const j = await (await fetch(url, { headers: { 'Accept': 'application/json' } })).json();
      if (Array.isArray(j) && j[0]) {
        document.getElementById(`${pre}-lat`).value = parseFloat(j[0].lat);
        document.getElementById(`${pre}-lon`).value = parseFloat(j[0].lon);
        if (geo) { geo.style.color = '#16a34a'; geo.textContent = '📍 located'; }
      } else if (geo) { geo.style.color = '#c0392b'; geo.textContent = 'not found'; }
    } catch (e) { if (geo) { geo.style.color = '#c0392b'; geo.textContent = 'error'; } }
  };
  async function _uploadPhoto(id, file, name) {
    const fd = new FormData(); fd.append('file', file); fd.append('name', name || 'photo');
    await fetch(`${API}/${id}/photo`, { method: 'POST', body: fd });
  }

  // ── Add / Edit window (one modal for both) ──
  window.pvPeopleAddOpen = function () { _openModal(null, []); };
  window.pvPeopleEdit = async function (id) {
    const p = _people.find(x => x.id === id); if (!p) return;
    let rels = [];
    try { rels = await (await fetch(`${API}/relations?person_id=${id}`)).json(); } catch (e) { rels = []; }
    _openModal(p, Array.isArray(rels) ? rels : []);
  };
  function _openModal(p, rels) {
    const isAdd = !p;
    const c = isAdd ? { color: '#0f766e' } : catBy(p.category);
    const photoBlock = isAdd
      ? `<div style="margin-bottom:8px;"><label style="font-size:0.76rem; color:#666;">Photo</label><input id="pple-photo" type="file" accept="image/*" style="width:100%; font-size:0.82rem;"></div>`
      : `<div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
          ${p.photo ? `<img src="${API}/${p.id}/photo?t=${Date.now()}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:3px solid ${c.color};">` : `<div style="width:56px;height:56px;border-radius:50%;background:${c.color}22;border:3px solid ${c.color};display:flex;align-items:center;justify-content:center;font-size:1.6rem;">👤</div>`}
          <input id="pple-photo" type="file" accept="image/*" style="font-size:0.82rem;">
        </div>`;
    const relBlock = isAdd ? '' : `
      <div style="border-top:1px solid #eee; margin-top:14px; padding-top:10px;">
        <div style="font-weight:700; color:#0f766e; margin-bottom:6px;">🔗 Relations</div>
        <div id="pple-rels">${_relsHtml(p.id, rels)}</div>
        <div style="display:flex; gap:6px; align-items:center; margin-top:8px; flex-wrap:wrap;">
          <select id="pple-rel-type" style="padding:5px 8px; border:1px solid #ccc; border-radius:4px;">${REL_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}</select>
          <span style="color:#888;">→</span>
          <select id="pple-rel-to" style="flex:1; min-width:160px; padding:5px 8px; border:1px solid #ccc; border-radius:4px;">${_people.filter(x => x.id !== p.id).map(x => `<option value="${x.id}">${esc(nameOf(x))}</option>`).join('')}</select>
          <button onclick="pvPeopleRelAdd(${p.id})" class="btn btn-sm" style="background:#0f766e; color:#fff;">＋ Add relation</button>
        </div>
      </div>`;
    const delBtn = isAdd ? '' : `<button onclick="pvPeopleDel(${p.id})" class="btn btn-sm" style="background:#c0392b; color:#fff; margin-left:auto;">✕ Delete</button>`;
    const ov = document.createElement('div');
    ov.id = 'ppl-edit'; ov.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);';
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    ov.innerHTML = `<div style="background:#fff;border-radius:14px;padding:18px 22px;max-width:560px;width:94%;max-height:88vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.3);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div style="font-size:1.05rem;font-weight:700;color:#0f766e;">${isAdd ? '👤 Add person' : 'Edit — ' + esc(nameOf(p))}</div>
        <button onclick="document.getElementById('ppl-edit').remove()" style="background:#eee;border:none;border-radius:8px;cursor:pointer;padding:4px 12px;">Close</button>
      </div>
      ${photoBlock}
      ${_fieldsHtml('pple', p || {})}
      <div style="display:flex; gap:10px; margin-top:10px; align-items:center;">
        <button onclick="pvPeoplePersonSave(${isAdd ? 0 : p.id})" class="btn btn-sm" style="background:#2563eb; color:#fff;">💾 Save</button>
        <span id="pple-status" style="font-size:0.8rem; color:#2e7d32;"></span>
        ${delBtn}
      </div>
      ${relBlock}
    </div>`;
    document.body.appendChild(ov);
  }
  window.pvPeoplePersonSave = async function (id) {
    const st = document.getElementById('pple-status');
    const body = _readFields('pple');
    if (!id && !body.given_name && !body.family_name && !body.maiden_name) { if (st) { st.style.color = '#c0392b'; st.textContent = 'Enter a name'; } return; }
    try {
      let pid = id;
      if (id) {
        const r = await fetch(`${API}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(r.status);
      } else {
        const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
        pid = (await r.json()).id;
      }
      const f = document.getElementById('pple-photo');
      if (f && f.files && f.files[0]) await _uploadPhoto(pid, f.files[0], `${body.given_name} ${body.family_name}`.trim());
      if (st) { st.textContent = '✓ Saved'; }
      await _loadPeople();
      setTimeout(() => { const ov = document.getElementById('ppl-edit'); if (ov) ov.remove(); }, 400);
    } catch (e) { if (st) { st.style.color = '#c0392b'; st.textContent = 'Error: ' + (e.message || e); } }
  };
  window.pvPeopleDel = async function (id) {
    const p = _people.find(x => x.id === id);
    if (!confirm(`Delete ${p ? nameOf(p) : 'this person'}? (their relationship links are removed too)`)) return;
    await fetch(`${API}/${id}`, { method: 'DELETE' });
    const ov = document.getElementById('ppl-edit'); if (ov) ov.remove();
    await _loadPeople();
  };

  // ── relations sub-section ──
  function _relsHtml(personId, rels) {
    if (!rels.length) return '<div style="color:#aaa; font-size:0.85rem;">No relations yet.</div>';
    return rels.map(r => {
      const otherId = r.from_person_id === personId ? r.to_person_id : r.from_person_id;
      const other = _people.find(x => x.id === otherId);
      const dir = r.from_person_id === personId ? '→' : '←';
      return `<div style="display:flex; gap:8px; align-items:center; font-size:0.86rem; padding:3px 0;">
        <span style="color:#0f766e; font-weight:600;">${esc(r.rel_type)}</span> <span style="color:#888;">${dir}</span>
        <span style="flex:1;">${esc(other ? nameOf(other) : '#' + otherId)}</span>
        <button onclick="pvPeopleRelDel(${r.id}, ${personId})" style="border:none;background:none;color:#c0392b;cursor:pointer;">✕</button>
      </div>`;
    }).join('');
  }
  window.pvPeopleRelAdd = async function (fromId) {
    const rel = document.getElementById('pple-rel-type').value;
    const to = parseInt(document.getElementById('pple-rel-to').value);
    if (!to) return;
    await fetch(`${API}/relations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from_person_id: fromId, to_person_id: to, rel_type: rel }) });
    const rels = await (await fetch(`${API}/relations?person_id=${fromId}`)).json();
    document.getElementById('pple-rels').innerHTML = _relsHtml(fromId, Array.isArray(rels) ? rels : []);
  };
  window.pvPeopleRelDel = async function (relId, personId) {
    await fetch(`${API}/relations/${relId}`, { method: 'DELETE' });
    const rels = await (await fetch(`${API}/relations?person_id=${personId}`)).json();
    document.getElementById('pple-rels').innerHTML = _relsHtml(personId, Array.isArray(rels) ? rels : []);
  };
})();
