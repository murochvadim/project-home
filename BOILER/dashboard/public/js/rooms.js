// ─── Apartment Layout — Multi-Room Canvas ────────────────────────────────────
// Each room is a toggleable layer on one apartment-wide SVG canvas.
// Active room: full detail + editable. Other rooms: dimmed walls only.
// Data lives in dashboard_settings.room_layouts.<slug> per room,
// coordinated by room_layouts._apartment for canvas size + visibility.
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const COLOR_WALL    = '#111';
  const COLOR_WIN     = '#2c5aa0';
  const COLOR_DOOR    = '#8b4513';
  const COLOR_SLIDING = '#2e7d72';
  const OPENING_SNAP  = 0.05;
  const DIM_OPACITY   = 0.3;

  // ── State ──────────────────────────────────────────────────────────────────
  let allRooms     = {};        // slug → layout blob
  let aptConfig    = {};        // canvas, room_order, layer_visibility, active_room
  let roomSlugs    = [];        // [{name, slug}]
  let activeSlug   = '';
  let tool         = 'wall';
  let pending      = null;
  let pendingWall  = null;
  let selectedId   = null;
  let undoStack    = [];
  let cellPx       = 30;

  function svg() { return document.getElementById('apt-svg'); }
  function activeData() { return allRooms[activeSlug] || { walls:[], windows:[], doors:[], dividers:[] }; }
  function canvasW() { return parseFloat(document.getElementById('apt-canvas-w').value) || 25; }
  function canvasH() { return parseFloat(document.getElementById('apt-canvas-h').value) || 18; }
  function originX() { const o = (allRooms[activeSlug] || {}).origin; return o ? (o.x_m || 0) : 0; }
  function originY() { const o = (allRooms[activeSlug] || {}).origin; return o ? (o.y_m || 0) : 0; }

  // Apartment-level meter↔pixel conversion (uses apartment canvas, not room grid)
  function mToPx(m)  { return m * cellPx; }
  function pxToM(px) { return px / cellPx; }

  // Snap: walls/dividers snap to 0.5m grid; openings to OPENING_SNAP; Shift disables
  function snapM(m, noSnap) {
    if (noSnap) return m;
    return Math.round(m / 0.5) * 0.5;
  }

  function setStatus(msg) {
    const el = document.getElementById('apt-status');
    if (el) el.textContent = msg;
  }

  function pushUndo() {
    undoStack.push(JSON.stringify(allRooms[activeSlug] || {}));
    if (undoStack.length > 50) undoStack.shift();
  }

  // ── Wall helpers ───────────────────────────────────────────────────────────
  function wallById(id) {
    return (activeData().walls || []).find(w => w.id === id);
  }

  function findWallAt(xLocal, yLocal, tol) {
    for (const w of (activeData().walls || [])) {
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
      const len2 = dx*dx + dy*dy;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((xLocal - w.x1)*dx + (yLocal - w.y1)*dy) / len2));
      const px = w.x1 + t*dx, py = w.y1 + t*dy;
      const d = Math.hypot(xLocal - px, yLocal - py);
      if (d <= tol) return { wall: w, t };
    }
    return null;
  }

  function wallGeom(item) {
    const w = wallById(item.wall);
    if (!w) return null;
    const wallLen = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    if (wallLen < 1e-6) return null;
    const ux = (w.x2 - w.x1)/wallLen, uy = (w.y2 - w.y1)/wallLen;
    const nx = -uy, ny = ux;
    const sx = w.x1 + ux*item.offset_m, sy = w.y1 + uy*item.offset_m;
    const ex = sx + ux*item.width_m,    ey = sy + uy*item.width_m;
    return { ux, uy, nx, ny, sx, sy, ex, ey };
  }

  // ── Tool selection ─────────────────────────────────────────────────────────
  window.aptSetTool = function (t) {
    tool = t;
    pending = null; pendingWall = null; selectedId = null;
    document.querySelectorAll('.apt-tool').forEach(b => {
      b.style.outline = b.dataset.tool === t ? '2px solid #27ae60' : 'none';
    });
    const hints = {
      wall:    'Click two points to draw a wall (on active room). Shift = free angle.',
      window:  'Click start + end on a wall.',
      door:    'Click start + end on a wall.',
      sliding: 'Sliding glass door — click start + end on a wall.',
      divider: 'Click two points for open-plan boundary.',
      select:  'Click an element to select.',
    };
    setStatus(hints[t] || '');
    refreshEditPanel();
    draw();
  };

  // ── Click handler ──────────────────────────────────────────────────────────
  function onSvgClick(ev) {
    if (!activeSlug) return;
    const rect = svg().getBoundingClientRect();
    const ox = originX(), oy = originY();
    const skipSnap = !!ev.shiftKey || tool === 'window' || tool === 'door' || tool === 'sliding';
    // Convert click to active room's local coordinates
    let xM = pxToM(ev.clientX - rect.left) - ox;
    let yM = pxToM(ev.clientY - rect.top) - oy;
    xM = snapM(xM, skipSnap);
    yM = snapM(yM, skipSnap);

    const data = activeData();

    if (tool === 'wall' || tool === 'divider') {
      if (!pending) {
        pending = { x1: xM, y1: yM };
        setStatus(`${tool} start at ${xM.toFixed(1)}, ${yM.toFixed(1)} — click end point`);
      } else {
        if (pending.x1 === xM && pending.y1 === yM) { pending = null; return; }
        pushUndo();
        if (tool === 'wall') {
          data.walls = data.walls || [];
          data.walls.push({
            id: 'w' + (data.walls.length + 1) + '_' + Date.now().toString(36),
            x1: pending.x1, y1: pending.y1, x2: xM, y2: yM, type: 'exterior',
          });
        } else {
          data.dividers = data.dividers || [];
          data.dividers.push({
            id: 'dv' + (data.dividers.length + 1) + '_' + Date.now().toString(36),
            x1: pending.x1, y1: pending.y1, x2: xM, y2: yM,
          });
        }
        pending = null;
        setStatus(`${tool} added.`);
      }
    } else if (tool === 'window' || tool === 'door' || tool === 'sliding') {
      const hit = findWallAt(xM, yM, 0.3);
      if (!hit) { setStatus('Click on an existing wall.'); return; }
      const w = wallById(hit.wall.id);
      const wallLen = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
      const rawOff = hit.t * wallLen;
      const snappedOff = ev.shiftKey ? rawOff : Math.round(rawOff / OPENING_SNAP) * OPENING_SNAP;
      const snappedT = Math.max(0, Math.min(1, snappedOff / wallLen));
      if (!pendingWall) {
        pendingWall = { wallId: hit.wall.id, t1: snappedT };
        setStatus(`${tool} start at ${snappedOff.toFixed(2)}m — click end point on same wall`);
      } else if (pendingWall.wallId === hit.wall.id) {
        pushUndo();
        const t1 = Math.min(pendingWall.t1, snappedT);
        const t2 = Math.max(pendingWall.t1, snappedT);
        const offset = t1 * wallLen;
        const width = (t2 - t1) * wallLen;
        const isDoor = (tool === 'door' || tool === 'sliding');
        const target = tool === 'window' ? (data.windows = data.windows || []) : (data.doors = data.doors || []);
        target.push({
          id: tool[0] + (target.length + 1) + '_' + Date.now().toString(36),
          wall: pendingWall.wallId,
          offset_m: +offset.toFixed(2),
          width_m: +width.toFixed(2),
          ...(isDoor ? { leads_to: null, door_type: tool === 'sliding' ? 'sliding' : 'hinged' } : {}),
        });
        pendingWall = null;
        setStatus(`${tool} added (offset ${offset.toFixed(2)}m, width ${width.toFixed(2)}m).`);
      } else {
        setStatus('Both points must be on the same wall.');
        pendingWall = null;
      }
    } else if (tool === 'select') {
      // Check doors/windows
      for (const arr of [data.doors || [], data.windows || []]) {
        for (const it of arr) {
          const g = wallGeom(it);
          if (!g) continue;
          const midX = (g.sx + g.ex) / 2, midY = (g.sy + g.ey) / 2;
          if (Math.hypot(xM - midX, yM - midY) < 0.3) {
            selectedId = it.id;
            setStatus(`Selected ${it.id}. Edit below or Delete.`);
            draw(); refreshEditPanel();
            return;
          }
        }
      }
      // Check dividers
      for (const d of (data.dividers || [])) {
        const dx = d.x2 - d.x1, dy = d.y2 - d.y1;
        const len2 = dx*dx + dy*dy;
        if (len2 < 1e-6) continue;
        const tt = Math.max(0, Math.min(1, ((xM - d.x1)*dx + (yM - d.y1)*dy) / len2));
        const px = d.x1 + tt*dx, py = d.y1 + tt*dy;
        if (Math.hypot(xM - px, yM - py) < 0.4) {
          selectedId = d.id;
          setStatus(`Selected divider ${d.id}.`);
          draw(); refreshEditPanel();
          return;
        }
      }
      // Check walls
      const hit = findWallAt(xM, yM, 0.3);
      selectedId = hit ? hit.wall.id : null;
      setStatus(selectedId ? `Selected wall ${selectedId}.` : '');
      refreshEditPanel();
    }
    draw();
  }

  // ── Hover ──────────────────────────────────────────────────────────────────
  function onSvgMove(ev) {
    if (!activeSlug) return;
    const rect = svg().getBoundingClientRect();
    const ox = originX(), oy = originY();
    const xM = pxToM(ev.clientX - rect.left) - ox;
    const yM = pxToM(ev.clientY - rect.top) - oy;
    let msg = `cursor: ${xM.toFixed(2)}m, ${yM.toFixed(2)}m (room-local)`;
    if (tool === 'window' || tool === 'door' || tool === 'sliding') {
      const hit = findWallAt(xM, yM, 0.3);
      if (hit) {
        const w = hit.wall;
        const wallLen = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
        const rawOff = hit.t * wallLen;
        const snapped = ev.shiftKey ? rawOff : Math.round(rawOff / OPENING_SNAP) * OPENING_SNAP;
        const fromEnd = wallLen - snapped;
        const nearer = snapped <= fromEnd ? { d: snapped, from: 'S' } : { d: fromEnd, from: 'E' };
        msg += `  ·  ${nearer.d.toFixed(2)}m from ${nearer.from}`;
      }
    }
    setStatus(msg);
  }

  // ── Edit panel ─────────────────────────────────────────────────────────────
  function refreshEditPanel() {
    const panel = document.getElementById('apt-edit-panel');
    if (!panel) return;
    if (!selectedId) { panel.style.display = 'none'; return; }
    const data = activeData();
    const win = (data.windows || []).find(x => x.id === selectedId);
    const dor = (data.doors || []).find(x => x.id === selectedId);
    const div = (data.dividers || []).find(x => x.id === selectedId);
    const item = win || dor || div;
    if (!item) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    document.getElementById('apt-edit-id').textContent = item.id;
    const isDivider = !!div;
    document.getElementById('apt-edit-offset-wrap').style.display = isDivider ? 'none' : 'inline';
    document.getElementById('apt-edit-width-wrap').style.display = isDivider ? 'none' : 'inline';
    if (!isDivider) {
      document.getElementById('apt-edit-offset').value = item.offset_m;
      document.getElementById('apt-edit-width').value = item.width_m;
    }
    const leadsWrap = document.getElementById('apt-edit-leads-wrap');
    if (dor || div) {
      leadsWrap.style.display = 'inline';
      document.getElementById('apt-edit-leads').value = item.leads_to || '';
    } else {
      leadsWrap.style.display = 'none';
    }
  }

  window.aptApplyEdit = function () {
    if (!selectedId) return;
    const data = activeData();
    let item = (data.windows || []).find(x => x.id === selectedId);
    let kind = 'windows';
    if (!item) { item = (data.doors || []).find(x => x.id === selectedId); kind = 'doors'; }
    if (!item) { item = (data.dividers || []).find(x => x.id === selectedId); kind = 'dividers'; }
    if (!item) return;
    if (kind !== 'dividers') {
      const off = parseFloat(document.getElementById('apt-edit-offset').value);
      const wid = parseFloat(document.getElementById('apt-edit-width').value);
      if (!isNaN(off)) item.offset_m = +off.toFixed(2);
      if (!isNaN(wid) && wid > 0) item.width_m = +wid.toFixed(2);
    }
    if (kind === 'doors' || kind === 'dividers') {
      item.leads_to = (document.getElementById('apt-edit-leads').value || '').trim() || null;
    }
    pushUndo();
    draw();
    setStatus('Updated ' + item.id);
  };

  // ── Undo / Delete ──────────────────────────────────────────────────────────
  window.aptUndo = function () {
    const prev = undoStack.pop();
    if (!prev) return;
    allRooms[activeSlug] = JSON.parse(prev);
    selectedId = null; pending = null; pendingWall = null;
    draw();
  };

  window.aptDeleteSelected = function () {
    if (!selectedId) return;
    const data = activeData();
    pushUndo();
    data.walls = (data.walls || []).filter(w => w.id !== selectedId);
    data.windows = (data.windows || []).filter(x => x.id !== selectedId && x.wall !== selectedId);
    data.doors = (data.doors || []).filter(x => x.id !== selectedId && x.wall !== selectedId);
    data.dividers = (data.dividers || []).filter(d => d.id !== selectedId);
    selectedId = null;
    draw(); refreshEditPanel();
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  window.aptSave = async function () {
    if (!activeSlug) return;
    const data = allRooms[activeSlug] || {};
    // Update origin from inputs
    data.origin = {
      x_m: parseFloat(document.getElementById('apt-origin-x').value) || 0,
      y_m: parseFloat(document.getElementById('apt-origin-y').value) || 0,
    };
    // If room has no shape yet, create default from first walls bbox
    if (!data.shape && (data.walls || []).length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const w of data.walls) {
        minX = Math.min(minX, w.x1, w.x2); minY = Math.min(minY, w.y1, w.y2);
        maxX = Math.max(maxX, w.x1, w.x2); maxY = Math.max(maxY, w.y1, w.y2);
      }
      data.shape = { type: 'rect', width_m: +(maxX - minX).toFixed(1), length_m: +(maxY - minY).toFixed(1) };
      data.grid = { cell_m: 0.5, cols: Math.ceil((maxX - minX) / 0.5), rows: Math.ceil((maxY - minY) / 0.5) };
    }
    try {
      const r = await fetch(`/api/room-layouts/${activeSlug}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // Save apartment config
      await fetch('/api/apartment-layout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canvas: { width_m: canvasW(), height_m: canvasH() },
          layer_visibility: aptConfig.layer_visibility || {},
          active_room: activeSlug,
        }),
      });
      setStatus('Saved ' + activeSlug + '.');
    } catch (e) {
      setStatus('Save failed: ' + e.message);
    }
  };

  // ── Copy Scene ─────────────────────────────────────────────────────────────
  window.aptCopyScene = async function () {
    try {
      const r = await fetch('/api/apartment-scene');
      const text = await r.text();
      await navigator.clipboard.writeText(text);
      setStatus('Scene text copied to clipboard (' + text.length + ' chars).');
    } catch (e) {
      setStatus('Copy failed: ' + e.message);
    }
  };

  // ── Draw ───────────────────────────────────────────────────────────────────
  function draw() {
    const s = svg();
    if (!s) return;
    const container = s.parentElement;
    const avail = Math.max(300, (container.clientWidth || 800) - 4);
    const cW = canvasW(), cH = canvasH();
    cellPx = Math.max(8, Math.floor(avail / (cW / 0.5)));
    // cellPx per meter = cellPx / 0.5 ... actually let's use direct meter→pixel
    // cellPx here means "pixels per 0.5m" — convert to "pixels per meter"
    const pxPerM = Math.max(15, Math.floor(avail / cW));
    cellPx = pxPerM; // overwrite — 1 meter = cellPx pixels
    const widthPx = Math.ceil(cW * pxPerM);
    const heightPx = Math.ceil(cH * pxPerM);
    s.setAttribute('width', widthPx);
    s.setAttribute('height', heightPx);
    s.setAttribute('viewBox', `0 0 ${widthPx} ${heightPx}`);
    s.innerHTML = '';

    // Apartment grid (1m major lines)
    const gridG = document.createElementNS(NS, 'g');
    gridG.setAttribute('stroke', '#e8e4dc');
    gridG.setAttribute('stroke-width', 0.5);
    for (let x = 0; x <= cW; x++) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', mToPx(x)); line.setAttribute('y1', 0);
      line.setAttribute('x2', mToPx(x)); line.setAttribute('y2', mToPx(cH));
      if (x % 5 === 0) { line.setAttribute('stroke', '#ccc'); line.setAttribute('stroke-width', 1); }
      gridG.appendChild(line);
    }
    for (let y = 0; y <= cH; y++) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', 0); line.setAttribute('y1', mToPx(y));
      line.setAttribute('x2', mToPx(cW)); line.setAttribute('y2', mToPx(y));
      if (y % 5 === 0) { line.setAttribute('stroke', '#ccc'); line.setAttribute('stroke-width', 1); }
      gridG.appendChild(line);
    }
    s.appendChild(gridG);

    // Meter labels
    const labelsG = document.createElementNS(NS, 'g');
    labelsG.setAttribute('font-family', 'system-ui, sans-serif');
    labelsG.setAttribute('font-size', '9');
    labelsG.setAttribute('fill', '#aaa');
    for (let x = 0; x <= cW; x += 5) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', mToPx(x) + 2); t.setAttribute('y', 10);
      t.textContent = x + 'm';
      labelsG.appendChild(t);
    }
    for (let y = 5; y <= cH; y += 5) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', 2); t.setAttribute('y', mToPx(y) - 2);
      t.textContent = y + 'm';
      labelsG.appendChild(t);
    }
    s.appendChild(labelsG);

    const vis = aptConfig.layer_visibility || {};

    // Draw non-active rooms first (dimmed)
    for (const [slug, layout] of Object.entries(allRooms)) {
      if (slug === activeSlug) continue;
      if (vis[slug] === false) continue;
      const o = layout.origin || { x_m: 0, y_m: 0 };
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('transform', `translate(${mToPx(o.x_m)}, ${mToPx(o.y_m)})`);
      g.setAttribute('opacity', DIM_OPACITY);
      // Walls only
      for (const w of (layout.walls || [])) {
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', mToPx(w.x1)); line.setAttribute('y1', mToPx(w.y1));
        line.setAttribute('x2', mToPx(w.x2)); line.setAttribute('y2', mToPx(w.y2));
        line.setAttribute('stroke', COLOR_WALL);
        line.setAttribute('stroke-width', 2);
        g.appendChild(line);
      }
      // Room name label
      const shape = layout.shape || {};
      if (shape.width_m && shape.length_m) {
        const lbl = document.createElementNS(NS, 'text');
        const name = roomSlugs.find(r => r.slug === slug);
        lbl.setAttribute('x', mToPx(shape.width_m / 2));
        lbl.setAttribute('y', mToPx(shape.length_m / 2));
        lbl.setAttribute('font-size', '12');
        lbl.setAttribute('fill', '#666');
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('dominant-baseline', 'middle');
        lbl.textContent = name ? name.name : slug;
        g.appendChild(lbl);
      }
      s.appendChild(g);
    }

    // Draw active room (full detail)
    if (activeSlug && allRooms[activeSlug] && vis[activeSlug] !== false) {
      const layout = allRooms[activeSlug];
      const o = layout.origin || { x_m: 0, y_m: 0 };
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('transform', `translate(${mToPx(o.x_m)}, ${mToPx(o.y_m)})`);

      // Walls
      for (const w of (layout.walls || [])) {
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', mToPx(w.x1)); line.setAttribute('y1', mToPx(w.y1));
        line.setAttribute('x2', mToPx(w.x2)); line.setAttribute('y2', mToPx(w.y2));
        line.setAttribute('stroke', COLOR_WALL);
        line.setAttribute('stroke-width', w.id === selectedId ? 5 : 3);
        line.setAttribute('stroke-linecap', 'square');
        g.appendChild(line);
      }

      // Dividers
      for (const d of (layout.dividers || [])) {
        const hasLeads = !!d.leads_to;
        const color = hasLeads ? COLOR_WIN : '#888';
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', mToPx(d.x1)); line.setAttribute('y1', mToPx(d.y1));
        line.setAttribute('x2', mToPx(d.x2)); line.setAttribute('y2', mToPx(d.y2));
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', d.id === selectedId ? 3 : 2);
        line.setAttribute('stroke-dasharray', '6,4');
        g.appendChild(line);
        if (hasLeads) {
          const mx = (d.x1 + d.x2) / 2, my = (d.y1 + d.y2) / 2;
          const lbl = document.createElementNS(NS, 'text');
          lbl.setAttribute('x', mToPx(mx) + 4); lbl.setAttribute('y', mToPx(my) - 4);
          lbl.setAttribute('font-size', '10'); lbl.setAttribute('font-weight', 'bold');
          lbl.setAttribute('fill', color);
          lbl.textContent = '→ ' + d.leads_to;
          g.appendChild(lbl);
        }
      }

      // Windows
      for (const item of (layout.windows || [])) {
        const wg = wallGeom(item);
        if (!wg) continue;
        const t = 0.10;
        const corners = [
          [wg.sx - wg.nx*t, wg.sy - wg.ny*t], [wg.ex - wg.nx*t, wg.ey - wg.ny*t],
          [wg.ex + wg.nx*t, wg.ey + wg.ny*t], [wg.sx + wg.nx*t, wg.sy + wg.ny*t],
        ];
        const poly = document.createElementNS(NS, 'polygon');
        poly.setAttribute('points', corners.map(p => `${mToPx(p[0])},${mToPx(p[1])}`).join(' '));
        poly.setAttribute('fill', '#d8e6f5');
        poly.setAttribute('stroke', COLOR_WIN);
        poly.setAttribute('stroke-width', item.id === selectedId ? 2 : 1);
        g.appendChild(poly);
        const mid = document.createElementNS(NS, 'line');
        mid.setAttribute('x1', mToPx(wg.sx)); mid.setAttribute('y1', mToPx(wg.sy));
        mid.setAttribute('x2', mToPx(wg.ex)); mid.setAttribute('y2', mToPx(wg.ey));
        mid.setAttribute('stroke', COLOR_WIN); mid.setAttribute('stroke-width', 1);
        g.appendChild(mid);
      }

      // Doors
      for (const item of (layout.doors || [])) {
        const wg = wallGeom(item);
        if (!wg) continue;
        if (item.door_type === 'sliding') {
          const t = 0.12;
          const corners = [
            [wg.sx - wg.nx*t, wg.sy - wg.ny*t], [wg.ex - wg.nx*t, wg.ey - wg.ny*t],
            [wg.ex + wg.nx*t, wg.ey + wg.ny*t], [wg.sx + wg.nx*t, wg.sy + wg.ny*t],
          ];
          const glass = document.createElementNS(NS, 'polygon');
          glass.setAttribute('points', corners.map(p => `${mToPx(p[0])},${mToPx(p[1])}`).join(' '));
          glass.setAttribute('fill', '#d4ebe6');
          glass.setAttribute('stroke', COLOR_SLIDING);
          glass.setAttribute('stroke-width', item.id === selectedId ? 2 : 1);
          g.appendChild(glass);
        } else {
          // Hinged door
          const t = 0.08;
          const corners = [
            [wg.sx - wg.nx*t, wg.sy - wg.ny*t], [wg.ex - wg.nx*t, wg.ey - wg.ny*t],
            [wg.ex + wg.nx*t, wg.ey + wg.ny*t], [wg.sx + wg.nx*t, wg.sy + wg.ny*t],
          ];
          const erase = document.createElementNS(NS, 'polygon');
          erase.setAttribute('points', corners.map(p => `${mToPx(p[0])},${mToPx(p[1])}`).join(' '));
          erase.setAttribute('fill', '#fafaf7'); erase.setAttribute('stroke', 'none');
          g.appendChild(erase);
          const lx = wg.nx, ly = wg.ny;
          const leafEndX = wg.sx + lx*item.width_m, leafEndY = wg.sy + ly*item.width_m;
          const leaf = document.createElementNS(NS, 'line');
          leaf.setAttribute('x1', mToPx(wg.sx)); leaf.setAttribute('y1', mToPx(wg.sy));
          leaf.setAttribute('x2', mToPx(leafEndX)); leaf.setAttribute('y2', mToPx(leafEndY));
          leaf.setAttribute('stroke', COLOR_DOOR);
          leaf.setAttribute('stroke-width', item.id === selectedId ? 3 : 2);
          g.appendChild(leaf);
          const arc = document.createElementNS(NS, 'path');
          const rPx = mToPx(item.width_m);
          arc.setAttribute('d', `M ${mToPx(leafEndX)} ${mToPx(leafEndY)} A ${rPx} ${rPx} 0 0 0 ${mToPx(wg.ex)} ${mToPx(wg.ey)}`);
          arc.setAttribute('fill', 'none'); arc.setAttribute('stroke', COLOR_DOOR);
          arc.setAttribute('stroke-width', 1); arc.setAttribute('stroke-dasharray', '3,3');
          g.appendChild(arc);
          const hinge = document.createElementNS(NS, 'circle');
          hinge.setAttribute('cx', mToPx(wg.sx)); hinge.setAttribute('cy', mToPx(wg.sy));
          hinge.setAttribute('r', 3); hinge.setAttribute('fill', COLOR_DOOR);
          g.appendChild(hinge);
        }
        // leads_to label
        if (item.leads_to) {
          const midX = (wg.sx + wg.ex) / 2, midY = (wg.sy + wg.ey) / 2;
          const color = item.door_type === 'sliding' ? COLOR_SLIDING : COLOR_DOOR;
          const lbl = document.createElementNS(NS, 'text');
          lbl.setAttribute('x', mToPx(midX + wg.nx * 0.25));
          lbl.setAttribute('y', mToPx(midY + wg.ny * 0.25));
          lbl.setAttribute('font-size', '10'); lbl.setAttribute('font-weight', 'bold');
          lbl.setAttribute('fill', color); lbl.setAttribute('text-anchor', 'middle');
          lbl.textContent = '→ ' + item.leads_to;
          g.appendChild(lbl);
        }
      }

      // Room name
      const shape = layout.shape || {};
      if (shape.width_m && shape.length_m) {
        const lbl = document.createElementNS(NS, 'text');
        const name = roomSlugs.find(r => r.slug === activeSlug);
        lbl.setAttribute('x', mToPx(shape.width_m / 2));
        lbl.setAttribute('y', mToPx(shape.length_m / 2));
        lbl.setAttribute('font-size', '14'); lbl.setAttribute('font-weight', 'bold');
        lbl.setAttribute('fill', '#333'); lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('dominant-baseline', 'middle'); lbl.setAttribute('opacity', '0.4');
        lbl.textContent = name ? name.name : activeSlug;
        g.appendChild(lbl);
      }

      // Pending marker
      if (pending) {
        const mk = document.createElementNS(NS, 'circle');
        mk.setAttribute('cx', mToPx(pending.x1)); mk.setAttribute('cy', mToPx(pending.y1));
        mk.setAttribute('r', 4); mk.setAttribute('fill', '#27ae60');
        g.appendChild(mk);
      }

      s.appendChild(g);
    }
  }

  // ── Room switching ─────────────────────────────────────────────────────────
  window.aptSetActiveRoom = function (slug) {
    activeSlug = slug;
    pending = null; pendingWall = null; selectedId = null;
    undoStack = [];
    const o = (allRooms[slug] || {}).origin || { x_m: 0, y_m: 0 };
    document.getElementById('apt-origin-x').value = o.x_m;
    document.getElementById('apt-origin-y').value = o.y_m;
    draw();
    refreshEditPanel();
    setStatus('Active room: ' + slug);
  };

  // ── Layer toggles ──────────────────────────────────────────────────────────
  function buildLayers() {
    const panel = document.getElementById('apt-layers');
    if (!panel) return;
    panel.innerHTML = '';
    const vis = aptConfig.layer_visibility || {};
    for (const r of roomSlugs) {
      const hasLayout = !!allRooms[r.slug];
      const lbl = document.createElement('label');
      lbl.style.cssText = 'display:inline-flex;align-items:center;gap:3px;cursor:pointer;' +
        (hasLayout ? '' : 'opacity:0.4;');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = vis[r.slug] !== false && hasLayout;
      cb.disabled = !hasLayout;
      cb.onchange = function () {
        if (!aptConfig.layer_visibility) aptConfig.layer_visibility = {};
        aptConfig.layer_visibility[r.slug] = cb.checked;
        draw();
      };
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(r.name));
      panel.appendChild(lbl);
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    try {
      const [roomsR, allR, aptR] = await Promise.all([
        fetch('/api/room-slugs').then(r => r.json()),
        fetch('/api/room-layouts/all').then(r => r.json()),
        fetch('/api/apartment-layout').then(r => r.json()),
      ]);
      roomSlugs = roomsR || [];
      allRooms = allR || {};
      aptConfig = aptR || {};

      // Populate active room dropdown
      const sel = document.getElementById('apt-active-room');
      sel.innerHTML = '';
      for (const r of roomSlugs) {
        const opt = document.createElement('option');
        opt.value = r.slug;
        opt.textContent = r.name + (allRooms[r.slug] ? '' : ' (empty)');
        sel.appendChild(opt);
      }

      // Populate leads_to dropdown
      const leadsSel = document.getElementById('apt-edit-leads');
      leadsSel.innerHTML = '<option value="">— none —</option>';
      for (const r of roomSlugs) {
        const opt = document.createElement('option');
        opt.value = r.slug;
        opt.textContent = r.name + ' (' + r.slug + ')';
        leadsSel.appendChild(opt);
      }

      // Canvas size
      if (aptConfig.canvas) {
        document.getElementById('apt-canvas-w').value = aptConfig.canvas.width_m || 25;
        document.getElementById('apt-canvas-h').value = aptConfig.canvas.height_m || 18;
      }

      // Set active room
      activeSlug = aptConfig.active_room || (roomSlugs[0] || {}).slug || '';
      if (activeSlug) {
        sel.value = activeSlug;
        aptSetActiveRoom(activeSlug);
      }

      buildLayers();
      draw();
      aptSetTool('wall');
      setStatus(`Loaded: ${Object.keys(allRooms).length} room layout(s). Pick a room to edit.`);
    } catch (e) {
      setStatus('Failed to load: ' + e.message);
    }
  }

  window.aptRedraw = function () { draw(); };

  window.refreshPage = function () {
    const el = document.getElementById('last-refresh');
    if (el) el.textContent = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
    init();
  };

  window.addEventListener('DOMContentLoaded', () => {
    svg().addEventListener('click', onSvgClick);
    svg().addEventListener('mousemove', onSvgMove);
    let _resizeT;
    window.addEventListener('resize', () => { clearTimeout(_resizeT); _resizeT = setTimeout(draw, 100); });
    init();
  });
})();
