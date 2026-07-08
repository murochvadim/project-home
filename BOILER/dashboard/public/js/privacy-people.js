// People / Heritage — Directory + relationship graph (Privacy → People tab).
// Phase 1: draggable snap-grid canvas of figures (icon + name), add/edit window.
// Phase 2: two views (Network / Groups). Network = person↔person relation lines styled per relation
//   type. Groups = people clustered into draggable labeled boxes by category, with user-defined
//   group↔group + person→group connections (each its own line style), a "gray unconnected" toggle,
//   click icon → window / click name → highlight. Settings editors manage categories, relation types,
//   the two connection-line styles, and the two kinds of connections.
// Config in dashboard_settings.people =
//   {categories, rel_types, group_link, pg_link, group_pos, group_edges, person_group_edges}.
(function () {
  const API = '/api/people';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const PPL_DEFAULT_CATS = [
    { id: 'family_mine',   name: 'My family',     color: '#2563eb' },
    { id: 'family_spouse', name: "Wife's family", color: '#7c3aed' },
    { id: 'friend',        name: 'Friends',       color: '#16a34a' },
    { id: 'other',         name: 'People I know',  color: '#9ca3af' },
  ];
  const DEFAULT_RELS = [
    { id: 'parent',  name: 'parent',  color: '#b91c1c', style: 'solid' },
    { id: 'child',   name: 'child',   color: '#f87171', style: 'solid' },
    { id: 'spouse',  name: 'spouse',  color: '#db2777', style: 'solid' },
    { id: 'sibling', name: 'sibling', color: '#f59e0b', style: 'dashed' },
    { id: 'friend',  name: 'friend',  color: '#16a34a', style: 'dashed' },
    { id: 'other',   name: 'other',   color: '#9ca3af', style: 'dotted' },
  ];
  const DEFAULT_GROUP_LINK = { color: '#64748b', style: 'solid' };    // group ↔ group connection line
  const DEFAULT_PG_LINK = { color: '#0ea5e9', style: 'dashed' };      // person → group connection line
  const DASH = { solid: '', dashed: '6 4', dotted: '2 4' };
  const GENDERS = ['', 'female', 'male', 'other'];

  // shared grid so figures stay aligned in rows/columns (auto-layout AND after a drag snaps to it)
  const GRID = { COLW: 104, ROWH: 118, PAD: 14, PAD_TOP: 56 };
  const _snap = (v, origin, cell) => Math.max(0, origin + Math.round((v - origin) / cell) * cell);

  let _cats = PPL_DEFAULT_CATS, _relTypes = DEFAULT_RELS, _groupLink = DEFAULT_GROUP_LINK, _pgLink = DEFAULT_PG_LINK, _groupPos = {}, _groupEdges = [], _personGroupEdges = [], _people = [], _users = [], _rels = [];
  let _regionById = {};   // set on each Group-view render; used by group-box drag to re-anchor lines
  const _corners = (r) => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y + r.h }];
  // the closest corner-pair between two boxes → a short, clean connector
  function _nearestCorners(ra, rb) {
    const A = _corners(ra), B = _corners(rb); let best = { a: A[0], b: B[0] }, bd = Infinity;
    A.forEach(p => B.forEach(q => { const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2; if (d < bd) { bd = d; best = { a: p, b: q }; } }));
    return best;
  }
  const _nearestCornerToPoint = (r, px, py) => { const C = _corners(r); let best = C[0], bd = Infinity; C.forEach(q => { const d = (q.x - px) ** 2 + (q.y - py) ** 2; if (d < bd) { bd = d; best = q; } }); return best; };
  let _view = (localStorage.getItem('people.view') === 'group') ? 'group' : 'network';
  let _focusId = null;
  let _dimUnconnected = localStorage.getItem('people.dimUnconnected') === '1';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const catBy = (id) => _cats.find(c => c.id === id) || { id: id || 'other', name: id || '—', color: '#9ca3af' };
  const relTypeBy = (id) => _relTypes.find(r => r.id === id) || { id: id, name: id, color: '#9ca3af', style: 'dotted' };
  const nameOf = (p) => ([p.given_name, p.family_name].filter(Boolean).join(' ') || p.maiden_name || ('#' + p.id));
  const _svg = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  window.pvPeopleOnShow = async function () {
    await _loadConfig(); await _loadUsers(); await _loadRels(); await _loadPeople();
    _syncViewButtons();
    const d = document.getElementById('ppl-dim-unconn'); if (d) d.checked = _dimUnconnected;
  };
  async function _loadConfig() {
    try {
      const j = await (await fetch('/api/dashboard-settings/people')).json(); const v = (j && j.value) || {};
      _cats = (Array.isArray(v.categories) && v.categories.length) ? v.categories : PPL_DEFAULT_CATS;
      _relTypes = (Array.isArray(v.rel_types) && v.rel_types.length) ? v.rel_types : DEFAULT_RELS;
      _groupLink = (v.group_link && v.group_link.color) ? v.group_link : DEFAULT_GROUP_LINK;
      _pgLink = (v.pg_link && v.pg_link.color) ? v.pg_link : DEFAULT_PG_LINK;
      _groupPos = (v.group_pos && typeof v.group_pos === 'object') ? v.group_pos : {};
      _groupEdges = Array.isArray(v.group_edges) ? v.group_edges : [];
      _personGroupEdges = Array.isArray(v.person_group_edges) ? v.person_group_edges : [];
    } catch (e) { _cats = PPL_DEFAULT_CATS; _relTypes = DEFAULT_RELS; _groupLink = DEFAULT_GROUP_LINK; _pgLink = DEFAULT_PG_LINK; _groupPos = {}; _groupEdges = []; _personGroupEdges = []; }
  }
  async function _loadUsers() {
    try { _users = await (await fetch('/api/household-users')).json(); } catch (e) { _users = []; }
    if (!Array.isArray(_users)) _users = [];
  }
  async function _loadRels() {
    try { _rels = await (await fetch(`${API}/relations`)).json(); } catch (e) { _rels = []; }
    if (!Array.isArray(_rels)) _rels = [];
  }
  async function _loadPeople() {
    try { _people = await (await fetch(API)).json(); } catch (e) { _people = []; }
    if (!Array.isArray(_people)) _people = [];
    _fillFilterCats(); pvPeopleRender();
  }

  function _fillFilterCats() {
    const sel = document.getElementById('ppl-filter-cat'); if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All categories</option>' + _cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    sel.value = cur;
  }

  // ── view toggle (Network / Tree) ──
  window.pvPeopleSetView = function (v) { _view = v; localStorage.setItem('people.view', v); _focusId = null; _syncViewButtons(); pvPeopleRender(); };
  function _syncViewButtons() {
    ['network', 'group'].forEach(v => { const b = document.getElementById('ppl-view-' + v); if (b) { b.style.background = (_view === v) ? '#0f766e' : '#eee'; b.style.color = (_view === v) ? '#fff' : '#555'; } });
  }
  window.pvPeopleHighlight = function (id) { _focusId = (_focusId === id) ? null : id; pvPeopleRender(); };
  window.pvPeopleToggleDim = function (on) { _dimUnconnected = !!on; localStorage.setItem('people.dimUnconnected', on ? '1' : '0'); pvPeopleRender(); };
  function _connectedSet(id) {
    const s = new Set([id]);
    _rels.forEach(r => { if (r.from_person_id === id) s.add(r.to_person_id); if (r.to_person_id === id) s.add(r.from_person_id); });
    return s;
  }
  // "connected outside their group" = has a person→group edge, or a relation to someone in a different group
  function _connectedOutside(pid, cat) {
    if (_personGroupEdges.some(e => e.p == pid)) return true;
    return _rels.some(r => {
      const other = r.from_person_id === pid ? r.to_person_id : (r.to_person_id === pid ? r.from_person_id : null);
      if (other == null) return false;
      const op = _people.find(x => x.id === other);
      return op && (op.category || 'other') !== cat;
    });
  }
  const _peopleById = () => { const m = {}; _people.forEach(p => m[p.id] = p); return m; };
  // Group view: cluster people into labeled region-boxes by their category. Boxes with a
  // saved position (_groupPos, drag-persisted) use it; the rest auto-flow. Returns {pos, regions, members}.
  const GC = 3, GPAD = 16, GHEAD = 30, GGAP = 26;
  function _groupLayout(rows, canvasW) {
    const order = _cats.map(c => c.id);
    const groups = {}; rows.forEach(p => { const k = p.category || 'other'; (groups[k] = groups[k] || []).push(p); });
    const keys = Object.keys(groups).sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
    const dims = {}; keys.forEach(k => { const n = groups[k].length, cols = Math.min(GC, Math.max(1, n)), gr = Math.ceil(n / cols); dims[k] = { cols, w: cols * GRID.COLW + GPAD, h: GHEAD + gr * GRID.ROWH + GPAD }; });
    // origins: saved positions win; the remainder auto-flow in reading order
    const origin = {}; let cx = GPAD, cy = GPAD, rowH = 0;
    keys.forEach(k => {
      if (_groupPos[k]) { origin[k] = { x: _groupPos[k].x, y: _groupPos[k].y }; return; }
      const w = dims[k].w, h = dims[k].h;
      if (cx + w > (canvasW - GPAD) && cx > GPAD) { cx = GPAD; cy += rowH + GGAP; rowH = 0; }
      origin[k] = { x: cx, y: cy }; cx += w + GGAP; rowH = Math.max(rowH, h);
    });
    const pos = {}, regions = [], members = {};
    keys.forEach(k => {
      const o = origin[k], cols = dims[k].cols;
      groups[k].forEach((p, i) => { pos[p.id] = { x: o.x + GPAD / 2 + (i % cols) * GRID.COLW, y: o.y + GHEAD + Math.floor(i / cols) * GRID.ROWH }; });
      regions.push({ id: k, x: o.x, y: o.y, w: dims[k].w, h: dims[k].h, cx: o.x + dims[k].w / 2, cy: o.y + dims[k].h / 2 });
      members[k] = groups[k].map(p => p.id);
    });
    return { pos, regions, members };
  }

  // ── main render: SVG line layer + draggable figures ──
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

    const isGroup = _view === 'group';
    const posMap = {}; let regions = [], groupMembers = {};
    if (isGroup) { const g = _groupLayout(rows, box.clientWidth || 900); Object.assign(posMap, g.pos); regions = g.regions; groupMembers = g.members; _regionById = {}; regions.forEach(r => _regionById[r.id] = r); }
    else {
      const cols = Math.max(1, Math.floor((box.clientWidth - GRID.PAD) / GRID.COLW)) || 6;
      let gi = 0;
      rows.forEach(p => {
        let x = p.pos_x, y = p.pos_y;
        if (x == null || y == null) { x = GRID.PAD + (gi % cols) * GRID.COLW; y = GRID.PAD_TOP + Math.floor(gi / cols) * GRID.ROWH; gi++; }
        else { x = _snap(x, GRID.PAD, GRID.COLW); y = _snap(y, GRID.PAD_TOP, GRID.ROWH); }
        posMap[p.id] = { x, y };
      });
    }
    const visible = new Set(rows.map(p => p.id));
    const focusSet = (_focusId != null) ? _connectedSet(_focusId) : null;

    // group region boxes (behind everything)
    let maxX = box.clientWidth || 600, maxY = 400;
    if (isGroup) regions.forEach(r => {
      const c = catBy(r.id);
      const b = document.createElement('div');
      b.style.cssText = `position:absolute; left:${r.x}px; top:${r.y}px; width:${r.w}px; height:${r.h}px; border:2px solid ${c.color}; border-radius:12px; background:${c.color}0d; z-index:0; cursor:grab; touch-action:none;`;
      b.innerHTML = `<div style="position:absolute; top:-11px; left:12px; background:#fbfaf8; padding:0 8px; font-size:0.8rem; font-weight:700; color:${c.color};">⠿ ${esc(c.name)}</div>`;
      box.appendChild(b);
      _makeGroupDraggable(b, r.id, r, groupMembers[r.id] || []);
      maxX = Math.max(maxX, r.x + r.w + 20); maxY = Math.max(maxY, r.y + r.h + 20);
    });
    rows.forEach(p => { const q = posMap[p.id]; if (q) { maxX = Math.max(maxX, q.x + 120); maxY = Math.max(maxY, q.y + 150); } });

    // SVG line layer
    const svg = _svg('svg', { id: 'ppl-svg', style: `position:absolute;left:0;top:0;width:${maxX}px;height:${maxY}px;pointer-events:none;z-index:0;` });
    if (isGroup) {
      // draw ONLY the user-defined group connections, from each box's nearest corner
      const byId = _peopleById();
      const focusGroups = focusSet ? new Set([...focusSet].map(id => (byId[id] || {}).category)) : null;
      _groupEdges.forEach(e => {
        const ra = _regionById[e.a], rb = _regionById[e.b]; if (!ra || !rb) return;   // both groups must be on screen
        const nc = _nearestCorners(ra, rb);
        const dimmed = focusGroups && !(focusGroups.has(e.a) && focusGroups.has(e.b));
        const line = _svg('line', { x1: nc.a.x, y1: nc.a.y, x2: nc.b.x, y2: nc.b.y, stroke: _groupLink.color, 'stroke-width': 3, 'stroke-dasharray': DASH[_groupLink.style] || '', 'stroke-linecap': 'round' });
        line.dataset.g1 = e.a; line.dataset.g2 = e.b;
        if (dimmed) line.setAttribute('opacity', '0.12');
        svg.appendChild(line);
      });
      // person → group connections (a person's figure to a group box's nearest corner)
      _personGroupEdges.forEach(e => {
        const f = posMap[e.p], region = _regionById[e.g]; if (!f || !region) return;   // person visible + group on screen
        const px = f.x + 44, py = f.y + 32, c = _nearestCornerToPoint(region, px, py);
        const line = _svg('line', { x1: px, y1: py, x2: c.x, y2: c.y, stroke: _pgLink.color, 'stroke-width': 2, 'stroke-dasharray': DASH[_pgLink.style] || '', 'stroke-linecap': 'round' });
        line.dataset.person = e.p; line.dataset.group = e.g;
        if (focusSet && !focusSet.has(e.p)) line.setAttribute('opacity', '0.12');
        svg.appendChild(line);
      });
    } else {
      _rels.forEach(r => {
        if (!visible.has(r.from_person_id) || !visible.has(r.to_person_id)) return;
        const a = posMap[r.from_person_id], b = posMap[r.to_person_id]; if (!a || !b) return;
        const rt = relTypeBy(r.rel_type);
        const line = _svg('line', { x1: a.x + 44, y1: a.y + 32, x2: b.x + 44, y2: b.y + 32, stroke: rt.color, 'stroke-width': 2, 'stroke-dasharray': DASH[rt.style] || '', 'stroke-linecap': 'round' });
        line.dataset.from = r.from_person_id; line.dataset.to = r.to_person_id;
        if (focusSet && !(focusSet.has(r.from_person_id) && focusSet.has(r.to_person_id))) line.setAttribute('opacity', '0.12');
        svg.appendChild(line);
      });
    }
    box.appendChild(svg);

    // figures
    rows.forEach(p => {
      const q = posMap[p.id]; const c = catBy(p.category);
      const focusDim = focusSet && !focusSet.has(p.id);
      const grayDim = isGroup && _dimUnconnected && !_connectedOutside(p.id, p.category || 'other');
      const dimStyle = focusDim ? ' opacity:0.15;' : (grayDim ? ' filter:grayscale(1); opacity:0.5;' : '');
      const avInner = p.photo
        ? `<img src="${API}/${p.id}/photo?t=${Date.now()}" draggable="false" style="display:block;margin:0 auto;width:64px;height:64px;border-radius:50%;object-fit:cover;border:3px solid ${c.color};pointer-events:none;">`
        : `<div style="margin:0 auto;width:64px;height:64px;border-radius:50%;background:${c.color}22;border:3px solid ${c.color};display:flex;align-items:center;justify-content:center;font-size:1.9rem;pointer-events:none;">👤</div>`;
      const el = document.createElement('div');
      el.dataset.id = p.id;
      el.style.cssText = `position:absolute; left:${q.x}px; top:${q.y}px; width:88px; text-align:center; z-index:1; user-select:none;${dimStyle}`;
      el.innerHTML =
        `<div class="ppl-av" title="${esc(nameOf(p))} — ${esc(c.name)} · open" style="cursor:${isGroup ? 'pointer' : 'grab'};">${avInner}</div>` +
        `<div class="ppl-nm" title="highlight connections" style="font-size:0.82rem; margin-top:5px; line-height:1.2; word-break:break-word; cursor:pointer;">${esc(nameOf(p))}</div>`;
      box.appendChild(el);
      const avEl = el.querySelector('.ppl-av'), nmEl = el.querySelector('.ppl-nm');
      if (isGroup) { avEl.addEventListener('click', () => pvPeopleEdit(p.id)); }
      else { _makeDraggable(el, avEl, p); }
      nmEl.addEventListener('click', (e) => { e.stopPropagation(); pvPeopleHighlight(p.id); });
    });
    box.onclick = (e) => { if (e.target === box && _focusId != null) { _focusId = null; pvPeopleRender(); } };
  };

  function _updateLines(id, cx, cy) {
    const svg = document.getElementById('ppl-svg'); if (!svg) return;
    svg.querySelectorAll(`line[data-from="${id}"]`).forEach(l => { l.setAttribute('x1', cx); l.setAttribute('y1', cy); });
    svg.querySelectorAll(`line[data-to="${id}"]`).forEach(l => { l.setAttribute('x2', cx); l.setAttribute('y2', cy); });
  }
  function _makeDraggable(figureEl, handleEl, p) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragging = false;
    handleEl.style.touchAction = 'none';
    handleEl.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY; ox = parseFloat(figureEl.style.left) || 0; oy = parseFloat(figureEl.style.top) || 0;
      handleEl.setPointerCapture(e.pointerId); figureEl.style.zIndex = 1000; handleEl.style.cursor = 'grabbing';
    });
    handleEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      const nx = Math.max(0, ox + dx), ny = Math.max(0, oy + dy);
      figureEl.style.left = nx + 'px'; figureEl.style.top = ny + 'px';
      _updateLines(p.id, nx + 44, ny + 32);
    });
    const end = () => {
      if (!dragging) return; dragging = false; figureEl.style.zIndex = 1; handleEl.style.cursor = 'grab';
      if (moved) {
        const nx = _snap(parseFloat(figureEl.style.left) || 0, GRID.PAD, GRID.COLW);
        const ny = _snap(parseFloat(figureEl.style.top) || 0, GRID.PAD_TOP, GRID.ROWH);
        figureEl.style.left = nx + 'px'; figureEl.style.top = ny + 'px';
        _updateLines(p.id, nx + 44, ny + 32);
        p.pos_x = nx; p.pos_y = ny;
        fetch(`${API}/${p.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pos_x: nx, pos_y: ny }) }).catch(() => {});
      } else { pvPeopleEdit(p.id); }   // click on the icon → open the window
    };
    handleEl.addEventListener('pointerup', end);
    handleEl.addEventListener('pointercancel', end);
  }

  // ── drag a whole GROUP box (Group view): the box + its people + its lines move together, snap to grid, persist ──
  function _updateGroupLines(gid, movedRegion) {
    const svg = document.getElementById('ppl-svg'); if (!svg) return;
    svg.querySelectorAll(`line[data-g1="${gid}"], line[data-g2="${gid}"]`).forEach(l => {
      const otherId = (l.dataset.g1 === gid) ? l.dataset.g2 : l.dataset.g1;
      const other = _regionById[otherId]; if (!other) return;
      const nc = _nearestCorners(movedRegion, other);   // nc.a = moved box corner, nc.b = other box corner
      if (l.dataset.g1 === gid) { l.setAttribute('x1', nc.a.x); l.setAttribute('y1', nc.a.y); l.setAttribute('x2', nc.b.x); l.setAttribute('y2', nc.b.y); }
      else { l.setAttribute('x2', nc.a.x); l.setAttribute('y2', nc.a.y); l.setAttribute('x1', nc.b.x); l.setAttribute('y1', nc.b.y); }
    });
    // person→group lines: person figures already moved (if members), boxes updated → recompute all
    svg.querySelectorAll('line[data-person]').forEach(l => {
      const f = document.querySelector(`#ppl-canvas [data-id="${l.dataset.person}"]`); if (!f) return;
      const px = (parseFloat(f.style.left) || 0) + 44, py = (parseFloat(f.style.top) || 0) + 32;
      const region = (l.dataset.group === gid) ? movedRegion : _regionById[l.dataset.group]; if (!region) return;
      const c = _nearestCornerToPoint(region, px, py);
      l.setAttribute('x1', px); l.setAttribute('y1', py); l.setAttribute('x2', c.x); l.setAttribute('y2', c.y);
    });
  }
  async function _saveGroupPos() {
    const value = { categories: _cats, rel_types: _relTypes, group_link: _groupLink, pg_link: _pgLink, group_pos: _groupPos, group_edges: _groupEdges, person_group_edges: _personGroupEdges };
    try { await fetch('/api/dashboard-settings/people', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) }); } catch (e) {}
  }
  function _makeGroupDraggable(boxEl, gid, region, memberIds) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragging = false, mem = [];
    boxEl.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY; ox = parseFloat(boxEl.style.left) || 0; oy = parseFloat(boxEl.style.top) || 0;
      mem = memberIds.map(id => { const f = document.querySelector(`#ppl-canvas [data-id="${id}"]`); return f ? { f, x: parseFloat(f.style.left) || 0, y: parseFloat(f.style.top) || 0 } : null; }).filter(Boolean);
      boxEl.setPointerCapture(e.pointerId); boxEl.style.cursor = 'grabbing'; boxEl.style.zIndex = 2;
    });
    boxEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      const nx = Math.max(0, ox + dx), ny = Math.max(0, oy + dy);
      boxEl.style.left = nx + 'px'; boxEl.style.top = ny + 'px';
      mem.forEach(m => { m.f.style.left = (m.x + (nx - ox)) + 'px'; m.f.style.top = (m.y + (ny - oy)) + 'px'; });
      _updateGroupLines(gid, { id: gid, x: nx, y: ny, w: region.w, h: region.h });   // re-anchor to nearest corners
    });
    const end = () => {
      if (!dragging) return; dragging = false; boxEl.style.cursor = 'grab'; boxEl.style.zIndex = 0;
      if (moved) {
        const nx = _snap(parseFloat(boxEl.style.left) || 0, GPAD, GRID.COLW);
        const ny = _snap(parseFloat(boxEl.style.top) || 0, GPAD, GRID.ROWH);
        _groupPos[gid] = { x: nx, y: ny };
        _saveGroupPos(); pvPeopleRender();
      }
    };
    boxEl.addEventListener('pointerup', end);
    boxEl.addEventListener('pointercancel', end);
  }

  // search icon → toggle the search box (same click-to-open pattern as ＋); closing clears the filter
  window.pvPeopleSearchToggle = function () {
    const inp = document.getElementById('ppl-filter-q'); if (!inp) return;
    const shown = inp.style.display !== 'none';
    if (shown) { inp.style.display = 'none'; inp.value = ''; pvPeopleRender(); }
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
          <select id="pple-rel-type" style="padding:5px 8px; border:1px solid #ccc; border-radius:4px;">${_relTypes.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select>
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
      await _loadRels(); await _loadPeople();
      setTimeout(() => { const ov = document.getElementById('ppl-edit'); if (ov) ov.remove(); }, 400);
    } catch (e) { if (st) { st.style.color = '#c0392b'; st.textContent = 'Error: ' + (e.message || e); } }
  };
  window.pvPeopleDel = async function (id) {
    const p = _people.find(x => x.id === id);
    if (!confirm(`Delete ${p ? nameOf(p) : 'this person'}? (their relationship links are removed too)`)) return;
    await fetch(`${API}/${id}`, { method: 'DELETE' });
    const ov = document.getElementById('ppl-edit'); if (ov) ov.remove();
    await _loadRels(); await _loadPeople();
  };

  // ── relations sub-section (Edit window) ──
  function _relsHtml(personId, rels) {
    if (!rels.length) return '<div style="color:#aaa; font-size:0.85rem;">No relations yet.</div>';
    return rels.map(r => {
      const otherId = r.from_person_id === personId ? r.to_person_id : r.from_person_id;
      const other = _people.find(x => x.id === otherId);
      const dir = r.from_person_id === personId ? '→' : '←';
      const rt = relTypeBy(r.rel_type);
      return `<div style="display:flex; gap:8px; align-items:center; font-size:0.86rem; padding:3px 0;">
        <span style="color:${rt.color}; font-weight:600;">${esc(rt.name)}</span> <span style="color:#888;">${dir}</span>
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
    await _loadRels();
    const rels = await (await fetch(`${API}/relations?person_id=${fromId}`)).json();
    document.getElementById('pple-rels').innerHTML = _relsHtml(fromId, Array.isArray(rels) ? rels : []);
    pvPeopleRender();
  };
  window.pvPeopleRelDel = async function (relId, personId) {
    await fetch(`${API}/relations/${relId}`, { method: 'DELETE' });
    await _loadRels();
    const rels = await (await fetch(`${API}/relations?person_id=${personId}`)).json();
    document.getElementById('pple-rels').innerHTML = _relsHtml(personId, Array.isArray(rels) ? rels : []);
    pvPeopleRender();
  };

  // ── Settings editors (Privacy → Settings → 👥 People) ──
  window.pvPeopleSettingsLoad = async function () {
    await _loadConfig();
    if (!_people.length) { try { _people = await (await fetch(API)).json(); } catch (e) {} if (!Array.isArray(_people)) _people = []; }
    _renderSettings();
  };
  function _renderSettings() {
    const cbox = document.getElementById('pplset-cats');
    if (cbox) cbox.innerHTML = _cats.map((c, i) => `<div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
      <input value="${esc(c.name || '')}" data-pplc-i="${i}" placeholder="category" style="flex:1; padding:5px 8px; border:1px solid #ccc; border-radius:4px;">
      <input type="color" value="${esc(c.color || '#9ca3af')}" data-pplcc-i="${i}" title="color" style="width:38px; height:30px; border:1px solid #ccc; border-radius:4px; padding:1px; cursor:pointer;">
      <button onclick="pvPeopleCatRemove(${i})" title="Remove" style="padding:3px 9px; border:1px solid #c0392b; color:#c0392b; background:#fff; border-radius:4px; cursor:pointer;">✕</button>
    </div>`).join('');
    const rbox = document.getElementById('pplset-rels');
    if (rbox) rbox.innerHTML = _relTypes.map((r, i) => `<div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
      <input value="${esc(r.name || '')}" data-pplr-i="${i}" placeholder="relation" style="flex:1; padding:5px 8px; border:1px solid #ccc; border-radius:4px;">
      <input type="color" value="${esc(r.color || '#9ca3af')}" data-pplrc-i="${i}" title="line color" style="width:38px; height:30px; border:1px solid #ccc; border-radius:4px; padding:1px; cursor:pointer;">
      <select data-pplrs-i="${i}" style="padding:5px; border:1px solid #ccc; border-radius:4px;">${['solid', 'dashed', 'dotted'].map(s => `<option value="${s}"${(r.style || 'solid') === s ? ' selected' : ''}>${s}</option>`).join('')}</select>
      <button onclick="pvPeopleRelTypeRemove(${i})" title="Remove" style="padding:3px 9px; border:1px solid #c0392b; color:#c0392b; background:#fff; border-radius:4px; cursor:pointer;">✕</button>
    </div>`).join('');
    const glc = document.getElementById('pplset-gl-color'); if (glc) glc.value = _groupLink.color || '#64748b';
    const gls = document.getElementById('pplset-gl-style'); if (gls) gls.value = _groupLink.style || 'solid';
    const pglc = document.getElementById('pplset-pgl-color'); if (pglc) pglc.value = _pgLink.color || '#0ea5e9';
    const pgls = document.getElementById('pplset-pgl-style'); if (pgls) pgls.value = _pgLink.style || 'dashed';
    // group-connections editor: two group dropdowns + the current list
    const opts = _cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const gea = document.getElementById('pplset-ge-a'), geb = document.getElementById('pplset-ge-b');
    if (gea && geb) { const va = gea.value, vb = geb.value; gea.innerHTML = opts; geb.innerHTML = opts; gea.value = va; geb.value = vb; }
    const gebox = document.getElementById('pplset-gedges');
    if (gebox) gebox.innerHTML = _groupEdges.length
      ? _groupEdges.map((e, i) => `<div style="display:flex; gap:8px; align-items:center; font-size:0.85rem; padding:2px 0;"><span style="flex:1;">${esc(catBy(e.a).name)} — ${esc(catBy(e.b).name)}</span><button onclick="pvPeopleGroupEdgeRemove(${i})" style="border:none;background:none;color:#c0392b;cursor:pointer;">✕</button></div>`).join('')
      : '<div style="color:#aaa; font-size:0.82rem;">No group connections yet — pick two groups and Add.</div>';
    // person → group editor
    const pgp = document.getElementById('pplset-pg-p'), pgg = document.getElementById('pplset-pg-g');
    if (pgp) { const vp = pgp.value; pgp.innerHTML = _people.map(p => `<option value="${p.id}">${esc(nameOf(p))}</option>`).join(''); pgp.value = vp; }
    if (pgg) { const vg = pgg.value; pgg.innerHTML = _cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(''); pgg.value = vg; }
    const pgbox = document.getElementById('pplset-pgedges');
    if (pgbox) pgbox.innerHTML = _personGroupEdges.length
      ? _personGroupEdges.map((e, i) => { const p = _people.find(x => x.id == e.p); return `<div style="display:flex; gap:8px; align-items:center; font-size:0.85rem; padding:2px 0;"><span style="flex:1;">${esc(p ? nameOf(p) : '#' + e.p)} → ${esc(catBy(e.g).name)}</span><button onclick="pvPeoplePGEdgeRemove(${i})" style="border:none;background:none;color:#c0392b;cursor:pointer;">✕</button></div>`; }).join('')
      : '<div style="color:#aaa; font-size:0.82rem;">No person → group connections yet.</div>';
  }
  window.pvPeopleGroupEdgeAdd = function () {
    const a = (document.getElementById('pplset-ge-a') || {}).value, b = (document.getElementById('pplset-ge-b') || {}).value;
    if (!a || !b || a === b) return;
    if (!_groupEdges.some(e => (e.a === a && e.b === b) || (e.a === b && e.b === a))) _groupEdges.push({ a, b });
    _renderSettings();
  };
  window.pvPeopleGroupEdgeRemove = function (i) { _groupEdges.splice(i, 1); _renderSettings(); };
  window.pvPeoplePGEdgeAdd = function () {
    const p = parseInt((document.getElementById('pplset-pg-p') || {}).value), g = (document.getElementById('pplset-pg-g') || {}).value;
    if (!p || !g) return;
    if (!_personGroupEdges.some(e => e.p == p && e.g === g)) _personGroupEdges.push({ p, g });
    _renderSettings();
  };
  window.pvPeoplePGEdgeRemove = function (i) { _personGroupEdges.splice(i, 1); _renderSettings(); };
  function _collectCats() {
    const cats = _cats.map(c => ({ ...c }));
    document.querySelectorAll('[data-pplc-i]').forEach(inp => { const i = +inp.dataset.pplcI; while (cats.length <= i) cats.push({}); cats[i].name = inp.value; });
    document.querySelectorAll('[data-pplcc-i]').forEach(inp => { const i = +inp.dataset.pplccI; while (cats.length <= i) cats.push({}); cats[i].color = inp.value; });
    return cats.filter(c => (c.name || '').trim()).map(c => ({ id: c.id || ('c' + Math.random().toString(36).slice(2, 9)), name: (c.name || '').trim(), color: c.color || '#9ca3af' }));
  }
  function _collectRels() {
    const rt = _relTypes.map(r => ({ ...r }));
    document.querySelectorAll('[data-pplr-i]').forEach(inp => { const i = +inp.dataset.pplrI; while (rt.length <= i) rt.push({}); rt[i].name = inp.value; });
    document.querySelectorAll('[data-pplrc-i]').forEach(inp => { const i = +inp.dataset.pplrcI; while (rt.length <= i) rt.push({}); rt[i].color = inp.value; });
    document.querySelectorAll('[data-pplrs-i]').forEach(inp => { const i = +inp.dataset.pplrsI; while (rt.length <= i) rt.push({}); rt[i].style = inp.value; });
    return rt.filter(r => (r.name || '').trim()).map(r => ({ id: r.id || ('r' + Math.random().toString(36).slice(2, 9)), name: (r.name || '').trim(), color: r.color || '#9ca3af', style: r.style || 'solid' }));
  }
  window.pvPeopleCatAdd = function () { _cats = _collectCats(); _relTypes = _collectRels(); _cats.push({ id: 'c' + Math.random().toString(36).slice(2, 9), name: '', color: '#2563eb' }); _renderSettings(); };
  window.pvPeopleCatRemove = function (i) { _cats = _collectCats(); _relTypes = _collectRels(); _cats.splice(i, 1); _renderSettings(); };
  window.pvPeopleRelTypeAdd = function () { _cats = _collectCats(); _relTypes = _collectRels(); _relTypes.push({ id: 'r' + Math.random().toString(36).slice(2, 9), name: '', color: '#16a34a', style: 'solid' }); _renderSettings(); };
  window.pvPeopleRelTypeRemove = function (i) { _cats = _collectCats(); _relTypes = _collectRels(); _relTypes.splice(i, 1); _renderSettings(); };
  window.pvPeopleSettingsSave = async function () {
    const st = document.getElementById('pplset-status');
    const glColor = (document.getElementById('pplset-gl-color') || {}).value || '#64748b';
    const glStyle = (document.getElementById('pplset-gl-style') || {}).value || 'solid';
    const pglColor = (document.getElementById('pplset-pgl-color') || {}).value || '#0ea5e9';
    const pglStyle = (document.getElementById('pplset-pgl-style') || {}).value || 'dashed';
    const value = { categories: _collectCats(), rel_types: _collectRels(), group_link: { color: glColor, style: glStyle }, pg_link: { color: pglColor, style: pglStyle }, group_pos: _groupPos, group_edges: _groupEdges, person_group_edges: _personGroupEdges };
    try {
      const r = await fetch('/api/dashboard-settings/people', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
      if (!r.ok) throw new Error(r.status);
      _cats = value.categories; _relTypes = value.rel_types; _groupLink = value.group_link; _pgLink = value.pg_link; _renderSettings();
      if (st) { st.style.color = '#2e7d32'; st.textContent = '✓ Saved'; setTimeout(() => { if (st) st.textContent = ''; }, 2000); }
    } catch (e) { if (st) { st.style.color = '#c0392b'; st.textContent = 'Error: ' + (e.message || e); } }
  };
})();
