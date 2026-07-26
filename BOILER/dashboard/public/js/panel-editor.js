/* Smart Tablet editor — Balcony agent → "Smart Tablet" tab.
 *
 * Authors the wall-tablet layout: pages -> tiles -> bindings, stored in
 * dashboard_settings.panel (read/written via the generic /api/dashboard-settings/panel
 * endpoint — no new server code). Each tile's bindings are the SAME shape the OpenHASP
 * balcony panel uses ({device_id,channel,name,label,action,...} + {type:'scene'|'curtain'|
 * 'pixoo_preset'|'media'|'hasp_command'}), so the Panel Commands rule (LXC 105) dispatches
 * them exactly like a balcony button. The tablet PWA renders whatever is saved here.
 *
 * The binding picker mirrors balcony.js's bc* picker (device/channel toggle-on-off,
 * page-select, Alexa speak/play, Vacuum verbs) + adds Scenes and Curtains.
 */
(function () {
  const CFG_KEY = 'panel';
  const PANEL_URL = 'http://192.168.1.138:8771/';
  const ACTIONS = [
    { v: 'turn_on', label: 'Turn On', tag: 'on' },
    { v: 'turn_off', label: 'Turn Off', tag: 'off' },
    { v: 'toggle', label: 'Toggle', tag: 'toggle' },
  ];
  const CURTAIN_ACTIONS = [
    { v: 'open', label: 'Open' }, { v: 'close', label: 'Close' }, { v: 'stop', label: 'Stop' },
  ];
  const CONTROLLABLE_TYPES = new Set(['switch', 'light', 'circuit_breaker', 'water_heater',
    'curtain', 'valve', 'esp_board', 'panel', 'display', 'media_player', 'vacuum']);
  const MAX_ROWS = 3, MAX_COLS = 5;   // the tablet fits at most 3 rows × 5 positions

  let cfg = { pages: [] };
  let activePage = 0;
  let dirty = false;
  let loaded = false;
  let controllable = [];
  let scenes = [], alexaAnns = [], alexaStations = [];
  let pick = null;             // {tileId, snapshot}
  let overlay = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = (p) => p + Math.random().toString(36).slice(2, 8);
  const $ = (id) => document.getElementById(id);

  function alexaVal(action, name) { return name ? `${action}:${name}` : action; }
  function parseAlexaVal(v) { const i = v.indexOf(':'); return i < 0 ? { action: v } : { action: v.slice(0, i), name: v.slice(i + 1) }; }
  function actionTag(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.tag : 'toggle'; }
  function bindingTag(b) {
    if (b.type === 'scene') return 'scene';
    if (b.type === 'curtain') return b.action || 'stop';
    if (b.page_num != null) return `P${b.page_num}`;
    if (b.action === 'speak' && b.template_name) return `say:${b.template_name}`;
    if (b.action === 'play' && b.station_name) return `play:${b.station_name}`;
    if (['stop', 'start', 'dock', 'locate'].includes(b.action)) return b.action;
    return actionTag(b.action);
  }
  function bindingName(b) {
    if (b.type === 'scene') return '🎬 ' + (b.target || '?');
    return b.label ? `${b.name}:${b.label}` : (b.name || '?');
  }

  function markDirty() { dirty = true; const d = $('pe-dirty'); if (d) d.style.display = 'inline'; }

  // ── load ──────────────────────────────────────────────────────────
  async function loadControllable() {
    if (controllable.length) return;
    try {
      const [devs, anns, stations, scn] = await Promise.all([
        fetch('/api/devices').then(r => r.json()),
        fetch('/api/dashboard-settings/media-agents.alexa_announcements').then(r => r.json()).catch(() => ({ value: [] })),
        fetch('/api/dashboard-settings/media-agents.alexa_quick_music').then(r => r.json()).catch(() => ({ value: [] })),
        fetch('/api/dashboard-settings/apartment.scenes').then(r => r.json()).catch(() => ({ value: [] })),
      ]);
      alexaAnns = Array.isArray(anns && anns.value) ? anns.value : [];
      alexaStations = Array.isArray(stations && stations.value) ? stations.value : [];
      scenes = Array.isArray(scn && scn.value) ? scn.value.filter(s => s && s.name && s.active !== false) : [];
      const list = Array.isArray(devs) ? devs : (devs.devices || []);
      controllable = [];
      for (const d of list) {
        if (d.enabled === false) continue;
        if (!CONTROLLABLE_TYPES.has(d.device_type)) continue;
        const chanCfg = d.channel_config || {}, dpsLabels = d.dps_labels || {}, dpsCfg = d.dps_config || {};
        const tuya = Object.keys(chanCfg).filter(k => k && !isNaN(parseInt(k))).sort();
        const zig = Object.keys(dpsLabels).filter(k => /^state_l\d+$/i.test(k))
          .sort((a, b) => parseInt(a.replace(/\D/g, '')) - parseInt(b.replace(/\D/g, '')));
        const esp = (d.protocol === 'esp') ? Object.keys(dpsCfg).filter(k => (dpsCfg[k] || {}).action_on) : [];
        const isCurtain = d.device_type === 'curtain';
        if (tuya.length > 1) {
          for (const ch of tuya) { const ci = chanCfg[ch] || {};
            controllable.push({ device_id: d.id, channel: ch, name: d.name, label: ci.name || `Ch.${ch}`, room: ci.room || d.room || '', protocol: d.protocol, curtain: isCurtain }); }
        } else if (zig.length > 1) {
          for (const ch of zig) controllable.push({ device_id: d.id, channel: ch, name: d.name, label: dpsLabels[ch] || ch, room: d.room || '', protocol: d.protocol, curtain: isCurtain });
        } else if (esp.length) {
          for (const ch of esp) { const cc = dpsCfg[ch] || {};
            controllable.push({ device_id: d.id, channel: ch, name: d.name, label: cc.name || ch, room: cc.room || d.room || '', protocol: d.protocol,
              chan_meta: cc.type ? { type: cc.type, min: cc.min, max: cc.max } : null, has_on: !!cc.action_on, has_off: !!cc.action_off }); }
        } else {
          controllable.push({ device_id: d.id, channel: null, name: d.name, label: '', room: d.room || '', protocol: d.protocol, curtain: isCurtain, dps_config: dpsCfg });
        }
      }
      controllable.sort((a, b) => (a.room || 'zzz').localeCompare(b.room || 'zzz') || a.name.localeCompare(b.name));
    } catch (e) { controllable = []; }
  }

  async function loadConfig() {
    try {
      const r = await fetch('/api/dashboard-settings/' + CFG_KEY);
      const j = await r.json();
      cfg = (j && j.value && Array.isArray(j.value.pages)) ? j.value : { pages: [] };
    } catch (e) { cfg = { pages: [] }; }
    if (!cfg.pages.length) cfg.pages.push({ id: uid('p'), name: 'Page 1', tiles: [] });
    activePage = 0;
  }

  window.peInit = async function () {
    if (loaded) { renderAll(); return; }
    loaded = true;
    const host = $('pe-root'); if (host) host.innerHTML = 'Loading…';
    await Promise.all([loadConfig(), loadControllable()]);
    dirty = false;
    renderAll();
  };

  // ── render editor ─────────────────────────────────────────────────
  function renderAll() {
    const host = $('pe-root'); if (!host) return;
    const pages = cfg.pages;
    host.innerHTML = `
      <div class="pe-toolbar">
        <label>Page:
          <select id="pe-page-sel" onchange="peSelectPage(this.value)">
            ${pages.map((p, i) => `<option value="${i}" ${i === activePage ? 'selected' : ''}>${esc(p.name || 'Page ' + (i + 1))}</option>`).join('')}
          </select>
        </label>
        <button class="pe-btn" onclick="peAddPage()">+ Page</button>
        <button class="pe-btn" onclick="peRenamePage()">Rename</button>
        <button class="pe-btn" onclick="peDeletePage()">Delete page</button>
        <span style="flex:1"></span>
        <span id="pe-dirty" style="display:${dirty ? 'inline' : 'none'};color:#e0a800;font-weight:600;">● Unsaved</span>
        <button class="pe-btn primary" onclick="peSave()">Save</button>
        <a class="pe-btn" href="${PANEL_URL}" target="_blank" rel="noopener">Open panel ↗</a>
      </div>
      <div class="pe-grid" id="pe-grid"></div>
      <div style="margin-top:12px;"><button class="pe-btn" onclick="peAddTile()">+ Add tile</button></div>
    `;
    renderTiles();
  }

  function sortTiles(page) {
    (page.tiles || []).sort((a, b) => (a.row || 1) - (b.row || 1) || (a.pos || 0) - (b.pos || 0));
  }
  function findTile(id) { const p = cfg.pages[activePage]; return p ? (p.tiles || []).find(t => t.id === id) : null; }
  function renumberRow(page, row) {
    (page.tiles || []).filter(t => (t.row || 1) === row).sort((a, b) => (a.pos || 0) - (b.pos || 0))
      .forEach((t, i) => { t.pos = i + 1; });
  }
  function tileCard(t, pageOpts) {
    const binds = (t.bindings && t.bindings.length)
      ? t.bindings.map(b => `${esc(bindingName(b))}<span class="pe-tag ${esc(bindingTag(b))}">${esc(bindingTag(b))}</span>`).join(' · ')
      : '— tap to set what this tile does —';
    return `
      <div class="pe-tile ${t.hidden ? 'pe-tile-hidden' : ''}" draggable="true" data-tid="${t.id}"
           ondragstart="peDragStart(event,'${t.id}')" ondragend="peDragEnd(event)"
           ondragover="peTileOver(event)" ondragleave="peTileLeave(event)" ondrop="peTileDrop(event,'${t.id}')">
        <div class="pe-tile-head">
          <span class="pe-drag" title="Drag to move">⋮⋮</span>
          <input class="pe-tile-icon" maxlength="4" value="${esc(t.icon || '')}" placeholder="🔆"
                 title="Icon (emoji) — leave blank for auto" oninput="peSetIcon('${t.id}', this.value)">
          <input class="pe-tile-label" value="${esc(t.label || '')}" placeholder="Tile label"
                 oninput="peSetLabel('${t.id}', this.value)">
          <button class="pe-x" title="Delete tile" onclick="peDeleteTile('${t.id}')">×</button>
        </div>
        <div class="pe-pos">
          <label>Page <select onchange="peMoveToPage('${t.id}', this.value)">${pageOpts}</select></label>
          <label>Row <input type="number" min="1" max="${MAX_ROWS}" value="${t.row || 1}" onchange="peSetRow('${t.id}', this.value)"></label>
          <label>Pos <input type="number" min="1" max="${MAX_COLS}" value="${t.pos || 1}" onchange="peSetPos('${t.id}', this.value)"></label>
          <label class="pe-hide" title="Render this slot as an empty space (holds the position, invisible on the tablet)"><input type="checkbox" ${t.hidden ? 'checked' : ''} onchange="peSetHidden('${t.id}', this.checked)"> Hidden</label>
        </div>
        <div class="pe-binds ${(t.bindings && t.bindings.length) ? '' : 'empty'}" onclick="peEditTile('${t.id}')">${binds}</div>
        <div class="pe-tile-foot"><button class="pe-btn sm" onclick="peEditTile('${t.id}')">Edit bindings</button></div>
      </div>`;
  }
  function renderTiles() {
    const grid = $('pe-grid'); if (!grid) return;
    const page = cfg.pages[activePage]; if (!page) return;
    sortTiles(page);
    const tiles = page.tiles || [];
    if (!tiles.length) { grid.innerHTML = '<div class="pe-empty">No tiles on this page. Click “+ Add tile”.</div>'; return; }
    const pageOpts = cfg.pages.map((p, pi) =>
      `<option value="${pi}" ${pi === activePage ? 'selected' : ''}>${esc(p.name || 'Page ' + (pi + 1))}</option>`).join('');
    // One band per row (mirrors the tablet). Drag a tile within a band to
    // reorder, into another band to change its row, or onto the new-row drop zone.
    const rows = {};
    tiles.forEach(t => { const r = t.row || 1; (rows[r] = rows[r] || []).push(t); });
    const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
    let html = '';
    for (const rn of rowNums) {
      const rowTiles = rows[rn].sort((a, b) => (a.pos || 0) - (b.pos || 0));
      html += `<div class="pe-rowband">
        <div class="pe-rowband-head">Row ${rn}</div>
        <div class="pe-rowband-tiles" ondragover="peBandOver(event)" ondragleave="peBandLeave(event)" ondrop="peBandDrop(event,${rn})">
          ${rowTiles.map(t => tileCard(t, pageOpts)).join('')}
        </div>
      </div>`;
    }
    html += `<div class="pe-newrow" ondragover="peBandOver(event)" ondragleave="peBandLeave(event)" ondrop="peNewRowDrop(event)">⤓ drop here to start a new row</div>`;
    grid.innerHTML = html;
  }

  // ── page ops ──────────────────────────────────────────────────────
  window.peSelectPage = (v) => { activePage = +v; renderAll(); };
  window.peAddPage = () => { cfg.pages.push({ id: uid('p'), name: 'Page ' + (cfg.pages.length + 1), tiles: [] }); activePage = cfg.pages.length - 1; markDirty(); renderAll(); };
  window.peRenamePage = () => { const p = cfg.pages[activePage]; if (!p) return; const n = prompt('Page name', p.name || ''); if (n != null) { p.name = n.trim() || p.name; markDirty(); renderAll(); } };
  window.peDeletePage = () => {
    if (cfg.pages.length <= 1) { alert('Keep at least one page.'); return; }
    if (!confirm('Delete this page and its tiles?')) return;
    cfg.pages.splice(activePage, 1); activePage = Math.max(0, activePage - 1); markDirty(); renderAll();
  };

  // ── tile ops ──────────────────────────────────────────────────────
  function rowCount(p, row) { return (p.tiles || []).filter(t => (t.row || 1) === row).length; }
  window.peAddTile = () => {
    const p = cfg.pages[activePage]; if (!p) return; p.tiles = p.tiles || [];
    // first row (1..MAX_ROWS) that still has a free position
    let row = 0;
    for (let r = 1; r <= MAX_ROWS; r++) { if (rowCount(p, r) < MAX_COLS) { row = r; break; } }
    if (!row) { alert(`This page is full — the tablet fits at most ${MAX_ROWS} rows × ${MAX_COLS} positions. Use another page.`); return; }
    const pos = rowCount(p, row) + 1;
    p.tiles.push({ id: uid('t'), label: 'New tile', bindings: [], row, pos });
    markDirty(); renderTiles();
  };
  window.peSetLabel = (id, v) => { const t = findTile(id); if (t) { t.label = v; markDirty(); } };
  window.peSetIcon = (id, v) => { const t = findTile(id); if (t) { t.icon = (v || '').trim(); markDirty(); } };
  window.peSetHidden = (id, checked) => { const t = findTile(id); if (t) { t.hidden = !!checked; markDirty(); renderTiles(); } };
  window.peDeleteTile = (id) => {
    const p = cfg.pages[activePage]; const t = findTile(id); if (!p || !t) return;
    if (!confirm('Delete this tile?')) return;
    const old = t.row || 1; p.tiles.splice(p.tiles.indexOf(t), 1); renumberRow(p, old); markDirty(); renderTiles();
  };
  window.peSetRow = (id, v) => {
    const p = cfg.pages[activePage]; const t = findTile(id); if (!t) return;
    const old = t.row || 1;
    const want = Math.min(MAX_ROWS, Math.max(1, parseInt(v, 10) || 1));
    if (want !== old && rowCount(p, want) >= MAX_COLS) { alert(`Row ${want} is full (max ${MAX_COLS} positions).`); renderTiles(); return; }
    t.row = want; renumberRow(p, old); markDirty(); renderTiles();
  };
  window.peSetPos = (id, v) => { const t = findTile(id); if (t) { t.pos = Math.min(MAX_COLS, Math.max(1, parseInt(v, 10) || 1)); markDirty(); renderTiles(); } };
  window.peMoveToPage = (id, v) => {
    const src = cfg.pages[activePage]; const ti = parseInt(v, 10); const t = findTile(id);
    if (!src || ti === activePage || !cfg.pages[ti] || !t) { renderTiles(); return; }
    src.tiles.splice(src.tiles.indexOf(t), 1);
    (cfg.pages[ti].tiles = cfg.pages[ti].tiles || []).push(t);
    markDirty(); renderTiles();
  };

  // ── drag-to-move (HTML5 DnD; ⋮⋮ handle) ───────────────────────────
  let _dragId = null;
  function moveTileTo(dragId, targetRow, beforeId) {
    const p = cfg.pages[activePage]; const t = findTile(dragId); if (!p || !t) return;
    const oldRow = t.row || 1;
    if (targetRow > MAX_ROWS) { alert(`The tablet fits at most ${MAX_ROWS} rows.`); renderTiles(); return; }
    const rowTiles = (p.tiles || []).filter(x => x.id !== dragId && (x.row || 1) === targetRow)
      .sort((a, b) => (a.pos || 0) - (b.pos || 0));
    // Moving into a DIFFERENT row that's already full is not allowed (reordering
    // within the same row always is — the count doesn't grow).
    if (oldRow !== targetRow && rowTiles.length >= MAX_COLS) { alert(`Row ${targetRow} is full (max ${MAX_COLS} positions).`); renderTiles(); return; }
    t.row = targetRow;
    let at = beforeId ? rowTiles.findIndex(x => x.id === beforeId) : rowTiles.length;
    if (at < 0) at = rowTiles.length;
    rowTiles.splice(at, 0, t);
    rowTiles.forEach((x, i) => { x.pos = i + 1; });
    if (oldRow !== targetRow) renumberRow(p, oldRow);
    markDirty(); renderTiles();
  }
  window.peDragStart = (e, id) => {
    // Don't hijack interactions with the card's controls — drag only from the
    // ⋮⋮ handle or the card's plain areas, not its inputs/selects/buttons/bindings.
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' ||
        (e.target.closest && e.target.closest('.pe-binds'))) { e.preventDefault(); return; }
    _dragId = id; e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch (_) {}
    const el = e.currentTarget; setTimeout(() => el && el.classList.add('dragging'), 0);
  };
  window.peDragEnd = () => {
    _dragId = null;
    document.querySelectorAll('.dragging,.pe-drop-before,.pe-band-over')
      .forEach(el => el.classList.remove('dragging', 'pe-drop-before', 'pe-band-over'));
  };
  window.peTileOver = (e) => { if (!_dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (e.currentTarget.dataset.tid !== _dragId) e.currentTarget.classList.add('pe-drop-before'); };
  window.peTileLeave = (e) => { e.currentTarget.classList.remove('pe-drop-before'); };
  window.peTileDrop = (e, targetId) => {
    e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('pe-drop-before');
    if (!_dragId || _dragId === targetId) return;
    const target = findTile(targetId); if (!target) return;
    moveTileTo(_dragId, target.row || 1, targetId);
  };
  window.peBandOver = (e) => { if (!_dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('pe-band-over'); };
  window.peBandLeave = (e) => { e.currentTarget.classList.remove('pe-band-over'); };
  window.peBandDrop = (e, rn) => { e.preventDefault(); e.currentTarget.classList.remove('pe-band-over'); if (_dragId) moveTileTo(_dragId, rn, null); };
  window.peNewRowDrop = (e) => {
    e.preventDefault(); e.currentTarget.classList.remove('pe-band-over'); if (!_dragId) return;
    const p = cfg.pages[activePage];
    const maxRow = Math.max(0, ...(p.tiles || []).map(t => t.row || 1));
    moveTileTo(_dragId, maxRow + 1, null);
  };

  // ── binding picker ────────────────────────────────────────────────
  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'pe-picker';
    overlay.innerHTML = `
      <div class="pe-picker-box">
        <div class="pe-picker-top">
          <b id="pe-picker-title">Tile</b>
          <span id="pe-picker-count" class="pe-picker-count">0 selected</span>
          <input id="pe-picker-search" placeholder="filter…" oninput="pePickerFilter()">
          <button class="pe-btn primary" onclick="pePickerClose(true)">Done</button>
          <button class="pe-btn" onclick="pePickerClose(false)">Cancel</button>
        </div>
        <div id="pe-picker-list" class="pe-picker-list"></div>
      </div>`;
    document.body.appendChild(overlay);
  }
  function curTile() { const p = cfg.pages[activePage]; return p && pick ? p.tiles.find(t => t.id === pick.tileId) : null; }

  window.peEditTile = (id) => {
    const t = findTile(id); if (!t) return;
    if (!t.bindings) t.bindings = [];
    ensureOverlay();
    pick = { tileId: t.id, snapshot: JSON.parse(JSON.stringify(t.bindings)) };
    $('pe-picker-title').textContent = t.label || 'Tile';
    $('pe-picker-search').value = '';
    renderPicker('');
    overlay.classList.add('show');
  };
  window.pePickerFilter = () => renderPicker($('pe-picker-search').value);
  window.pePickerClose = (save) => {
    overlay.classList.remove('show');
    const t = curTile();
    if (t) { if (!save) t.bindings = pick.snapshot; else markDirty(); }
    pick = null; renderTiles();
  };

  function bindKey(b) { return b.type === 'scene' ? 'scene:' + b.target : (b.type === 'curtain' ? 'curtain:' + b.device_id : b.device_id + ':' + (b.channel || '')); }
  function updateCount() { const t = curTile(); const el = $('pe-picker-count'); if (el) el.textContent = `${t && t.bindings ? t.bindings.length : 0} selected`; }

  function renderPicker(filter) {
    const t = curTile(); if (!t) return;
    if (!t.bindings) t.bindings = [];
    const selBy = new Map(t.bindings.map(b => [bindKey(b), b]));
    const f = (filter || '').toLowerCase();
    const list = $('pe-picker-list'); list.innerHTML = '';

    // Scenes section
    const scn = scenes.filter(s => !f || s.name.toLowerCase().includes(f));
    if (scn.length) {
      const h = document.createElement('div'); h.className = 'pe-room'; h.textContent = '🎬 Scenes'; list.appendChild(h);
      for (const s of scn) {
        const key = 'scene:' + s.name, existing = selBy.get(key);
        const item = document.createElement('div'); item.className = 'pe-item';
        item.innerHTML = `<input type="checkbox" ${existing ? 'checked' : ''}><div class="pe-item-name">${esc(s.name)}</div><div class="pe-item-meta">scene</div>`;
        const cb = item.querySelector('input');
        item.addEventListener('click', (e) => { if (e.target !== cb) cb.checked = !cb.checked; toggleScene(s.name, cb.checked); });
        list.appendChild(item);
      }
    }

    // Devices
    let room = null;
    for (const d of controllable) {
      const blob = `${d.name} ${d.label} ${d.room} ${d.protocol}`.toLowerCase();
      if (f && !blob.includes(f)) continue;
      if (d.room !== room) { room = d.room; const rl = document.createElement('div'); rl.className = 'pe-room'; rl.textContent = d.room || '(no room)'; list.appendChild(rl); }
      const key = d.curtain ? 'curtain:' + d.device_id : d.device_id + ':' + (d.channel || '');
      const existing = selBy.get(key), checked = !!existing;
      const isPage = d.chan_meta && d.chan_meta.type === 'page_select';
      const isAlexa = d.protocol === 'alexa', isVac = d.protocol === 'vacuum', isCur = d.curtain;
      let dd;
      if (isCur) {
        const cur = existing ? existing.action : 'open';
        dd = `<select class="pe-sel">${CURTAIN_ACTIONS.map(a => `<option value="${a.v}" ${a.v === cur ? 'selected' : ''}>${a.label}</option>`).join('')}</select>`;
      } else if (isPage) {
        const lo = +(d.chan_meta.min || 1), hi = +(d.chan_meta.max || 12), cur = (existing && existing.page_num) || lo, o = [];
        for (let n = lo; n <= hi; n++) o.push(`<option value="${n}" ${n === cur ? 'selected' : ''}>Page ${n}</option>`);
        dd = `<select class="pe-sel">${o.join('')}</select>`;
      } else if (isVac) {
        const verbs = Object.values(d.dps_config || {}).filter(c => c && c.action_on).map(c => c.action_on);
        const cur = existing ? existing.action : (verbs[0] || 'start');
        dd = `<select class="pe-sel"><optgroup label="Vacuum">${verbs.map(v => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v}</option>`).join('')}</optgroup></select>`;
      } else if (isAlexa) {
        const cur = existing ? alexaVal(existing.action, existing.template_name || existing.station_name || null) : 'stop';
        const sp = alexaAnns.map(t => { const v = alexaVal('speak', t.name); return `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t.name)}</option>`; }).join('');
        const pl = alexaStations.map(s => { const v = alexaVal('play', s.name); return `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(s.name)}</option>`; }).join('');
        dd = `<select class="pe-sel">${sp ? `<optgroup label="Speak">${sp}</optgroup>` : ''}${pl ? `<optgroup label="Play">${pl}</optgroup>` : ''}<optgroup label="Stop"><option value="stop" ${'stop' === cur ? 'selected' : ''}>stop</option></optgroup></select>`;
      } else {
        const act = existing ? existing.action : 'toggle';
        const allowed = (d.has_on !== undefined || d.has_off !== undefined)
          ? ACTIONS.filter(a => (a.v === 'turn_on' && d.has_on) || (a.v === 'turn_off' && d.has_off) || (a.v === 'toggle' && d.has_on && d.has_off))
          : ACTIONS;
        dd = `<select class="pe-sel">${allowed.map(a => `<option value="${a.v}" ${a.v === act ? 'selected' : ''}>${a.label}</option>`).join('')}</select>`;
      }
      const item = document.createElement('div'); item.className = 'pe-item';
      const dn = d.label ? `${d.name} — ${d.label}` : d.name;
      item.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''}><div class="pe-item-name">${esc(dn)}</div>${dd}<div class="pe-item-meta">${esc(d.protocol)}${d.channel ? ' · ' + d.channel : ''}</div>`;
      const cb = item.querySelector('input'), sel = item.querySelector('select');
      item.addEventListener('click', (e) => { if (e.target === sel || sel.contains(e.target)) return; if (e.target !== cb) cb.checked = !cb.checked; toggleDev(d, cb.checked, sel.value, { isPage, isAlexa, isVac, isCur }); });
      sel.addEventListener('change', (e) => { e.stopPropagation(); if (!cb.checked) cb.checked = true; toggleDev(d, cb.checked, sel.value, { isPage, isAlexa, isVac, isCur }); });
      sel.addEventListener('click', (e) => e.stopPropagation());
      list.appendChild(item);
    }
    updateCount();
  }

  function toggleScene(name, checked) {
    const t = curTile(); if (!t) return; if (!t.bindings) t.bindings = [];
    const key = 'scene:' + name, idx = t.bindings.findIndex(b => bindKey(b) === key);
    if (checked && idx < 0) t.bindings.push({ type: 'scene', target: name });
    else if (!checked && idx >= 0) t.bindings.splice(idx, 1);
    updateCount();
  }
  function toggleDev(d, checked, val, k) {
    const t = curTile(); if (!t) return; if (!t.bindings) t.bindings = [];
    const key = d.curtain ? 'curtain:' + d.device_id : d.device_id + ':' + (d.channel || '');
    const idx = t.bindings.findIndex(b => bindKey(b) === key);
    if (!checked) { if (idx >= 0) t.bindings.splice(idx, 1); updateCount(); return; }
    let b;
    if (k.isCur) {
      b = { type: 'curtain', device_id: d.device_id, name: d.name, label: d.label, action: val };
    } else {
      const pageNum = k.isPage ? parseInt(val, 10) : null;
      let action = k.isPage ? 'turn_on' : val, tmpl = null, stn = null;
      if (k.isAlexa) { const p = parseAlexaVal(val); action = p.action; if (p.action === 'speak') tmpl = p.name || ''; if (p.action === 'play') stn = p.name || ''; }
      b = { device_id: d.device_id, channel: d.channel, name: d.name, label: d.label, action };
      if (k.isPage) b.page_num = pageNum;
      if (tmpl) b.template_name = tmpl;
      if (stn) b.station_name = stn;
    }
    if (idx >= 0) t.bindings[idx] = b; else t.bindings.push(b);
    updateCount();
  }

  // ── save ──────────────────────────────────────────────────────────
  window.peSave = async function () {
    const btn = document.querySelector('.pe-toolbar .primary');
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await fetch('/api/dashboard-settings/' + CFG_KEY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: cfg }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      dirty = false; const d = $('pe-dirty'); if (d) d.style.display = 'none';
      if (btn) { btn.textContent = '✓ Saved'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500); }
    } catch (e) {
      if (btn) { btn.textContent = '✗ ' + e.message; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500); }
    }
  };

  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
})();
