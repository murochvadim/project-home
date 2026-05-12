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
  let dragging      = null;   // { id, startX, startY, origX, origY } for furniture drag
  let labelDrag     = null;   // { slug, startPx, startPy, origOx, origOy, moved } for room-name label drag
  let suppressClick = false;  // set true after a drag ends to swallow the synthetic click
  let clipboard     = null;   // copied furniture item (for paste on next click)
  let undoStack    = [];
  let cellPx       = 30;
  let viewOriginX  = 0;
  let viewOriginY  = 0;
  let _showHiddenLabels = false;
  let _showZones        = (localStorage.getItem('apt_show_zones') !== '0'); // V6 — default ON
  let roomDims     = {};            // { slug: {w, l, h} } — dims for undrawn rooms
  let roomDevCounts = {};           // { roomName: count } — from /api/rooms
  let roomPlacements = [];          // V5: [{id, slug, device_id, device_type, x, y, rotation, params, label, label_offset, label_hidden, device_name, last_state, last_seen}]
  let _allDevices = [];             // cached device list for picker
  let _devicePicker = null;         // {x_m, y_m, slug, suggested_ids} while popover is open
  let _lightPicker  = null;         // V7 Lights: {x_m, y_m, slug} while the light picker is open
  let _pollTimer = null;            // state polling timer
  let _zoneSel    = [];             // V6 Zones: list of cellIds currently selected (unsaved)
  let _zoneEditId = null;           // id of existing zone being edited (null = creating new)
  let _showLights = (localStorage.getItem('apt_show_lights') !== '0'); // V7 — default ON
  let _showParameters = (localStorage.getItem('apt_show_parameters') !== '0'); // V10 — default ON
  let _paramPicker  = null;         // V10 Parameters: {x_m, y_m, slug} while the parameter picker is open

  function svg() { return document.getElementById('apt-svg'); }
  function activeData() { return allRooms[activeSlug] || { walls:[], windows:[], doors:[], dividers:[] }; }
  function canvasW() { return parseFloat(document.getElementById('apt-canvas-w').value) || 25; }
  function canvasH() { return parseFloat(document.getElementById('apt-canvas-h').value) || 18; }

  // Apartment-level meter↔pixel conversion (uses apartment canvas, not room grid)
  function mToPx(m)  { return m * cellPx; }
  function pxToM(px) { return px / cellPx; }

  // Snap walls/dividers/glass to the active room's cell_m grid; Shift disables
  function snapM(m, noSnap) {
    if (noSnap) return m;
    const grid = (allRooms[activeSlug] || {}).grid || {};
    const step = grid.cell_m || 0.5;
    return Math.round(m / step) * step;
  }

  function setStatus(msg) {
    const el = document.getElementById('apt-status');
    if (el) el.textContent = msg;
  }

  function pushUndo(entry, reason) {
    // Legacy call pushUndo() — snapshot the active room's layout.
    // Tagged call pushUndo({type:'dev_...', ...}) — server-side device action.
    // Optional reason string logs a breadcrumb to the console for debugging
    // when walls/devices go missing.
    if (entry === undefined) {
      const walls = ((allRooms[activeSlug] || {}).walls || []).length;
      const doors = ((allRooms[activeSlug] || {}).doors || []).length;
      console.debug('[undo-push]', reason || '(no-reason)', 'slug=', activeSlug,
        'walls=', walls, 'doors=', doors, 'stack-depth=', undoStack.length + 1);
      undoStack.push({ type: 'layout', slug: activeSlug, snapshot: JSON.stringify(allRooms[activeSlug] || {}) });
    } else {
      console.debug('[undo-push]', entry.type, reason || '', 'id=', entry.id ?? entry.row?.id, 'stack-depth=', undoStack.length + 1);
      undoStack.push(entry);
    }
    if (undoStack.length > 50) undoStack.shift();
  }

  // ── Wall helpers ───────────────────────────────────────────────────────────
  function wallById(id) {
    return (activeData().walls || []).find(w => w.id === id);
  }

  // Returns the NEAREST wall within tolerance, not the first one. Critical
  // near corners where multiple walls overlap in the hit radius — picking the
  // closest one is what the user actually aimed at.
  function findWallAt(xLocal, yLocal, tol) {
    let best = null;
    let bestD = Infinity;
    for (const w of (activeData().walls || [])) {
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
      const len2 = dx*dx + dy*dy;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((xLocal - w.x1)*dx + (yLocal - w.y1)*dy) / len2));
      const px = w.x1 + t*dx, py = w.y1 + t*dy;
      const d = Math.hypot(xLocal - px, yLocal - py);
      if (d <= tol && d < bestD) { best = { wall: w, t, d }; bestD = d; }
    }
    return best;
  }

  // ── V2: Auto-positioning helpers ─────────────────────────────────────────

  // Compute bounding box of a room from its walls (local coords).
  function getRoomBounds(layout) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const w of (layout.walls || [])) {
      minX = Math.min(minX, w.x1, w.x2); minY = Math.min(minY, w.y1, w.y2);
      maxX = Math.max(maxX, w.x1, w.x2); maxY = Math.max(maxY, w.y1, w.y2);
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 8, maxY: 6 };
    return { minX, minY, maxX, maxY };
  }

  // ── V6 Zones: 1m grid helpers ──────────────────────────────────────────────
  // Zones are a numbered 1m grid overlay. Each cell is 1.0m × 1.0m, row-major,
  // 1-based. cellIdForPoint() snaps a point to its cell id; cellIdToRect()
  // returns the cell's bbox in room-local meters.
  const ZONE_CELL_M = 1.0;
  function zoneGridSize(layout) {
    const b = getRoomBounds(layout);
    const cols = Math.max(1, Math.ceil(b.maxX - b.minX));
    const rows = Math.max(1, Math.ceil(b.maxY - b.minY));
    return { cols, rows, minX: b.minX, minY: b.minY };
  }
  function cellIdForPoint(layout, x, y) {
    const g = zoneGridSize(layout);
    const col = Math.floor(x - g.minX);
    const row = Math.floor(y - g.minY);
    if (col < 0 || col >= g.cols || row < 0 || row >= g.rows) return null;
    return row * g.cols + col + 1;
  }
  function cellIdToRect(layout, cellId) {
    const g = zoneGridSize(layout);
    const col = (cellId - 1) % g.cols;
    const row = Math.floor((cellId - 1) / g.cols);
    return {
      col, row,
      minXm: g.minX + col, minYm: g.minY + row,
      maxXm: g.minX + col + 1, maxYm: g.minY + row + 1,
    };
  }
  // Returns { cellId, zoneName, zoneId } — zoneName/zoneId are null for unnamed cells.
  function resolveCellForPoint(layout, x, y) {
    const cellId = cellIdForPoint(layout, x, y);
    if (cellId == null) return null;
    for (const z of (layout.zones || [])) {
      if ((z.cells || []).includes(cellId)) return { cellId, zoneName: z.name, zoneId: z.id };
    }
    return { cellId, zoneName: null, zoneId: null };
  }

  // Determine which side of the room a wall is on (north/south/east/west).
  // Walk the wall segments end-to-end to build a closed polygon (ordered
  // vertices). Returns null if walls don't form a single closed loop — caller
  // should fall back to bbox polygon.
  function buildRoomPolygon(walls) {
    if (!walls || walls.length < 3) return null;
    const TOL = 1e-3;
    const match = (a, b) => Math.abs(a.x - b.x) < TOL && Math.abs(a.y - b.y) < TOL;
    const used = new Set();
    const first = walls[0];
    const start = { x: first.x1, y: first.y1 };
    const poly = [start];
    let cur = { x: first.x2, y: first.y2 };
    used.add(first.id || 0);
    while (!match(cur, start)) {
      poly.push(cur);
      let nxt = null;
      for (const w of walls) {
        const id = w.id || walls.indexOf(w);
        if (used.has(id)) continue;
        if (match({ x: w.x1, y: w.y1 }, cur)) { nxt = { x: w.x2, y: w.y2 }; used.add(id); break; }
        if (match({ x: w.x2, y: w.y2 }, cur)) { nxt = { x: w.x1, y: w.y1 }; used.add(id); break; }
      }
      if (!nxt) return null;        // walls don't form a closed loop
      cur = nxt;
      if (poly.length > walls.length + 2) return null;  // safety — something went wrong
    }
    return poly;
  }

  // Standard east-ray point-in-polygon test (odd-crossing rule). Poly is an
  // array of {x, y} vertices in traversal order, with the closing edge implicit.
  function pointInPolygon(p, poly) {
    if (!poly || poly.length < 3) return false;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect = ((yi > p.y) !== (yj > p.y)) &&
        (p.x < (xj - xi) * (p.y - yi) / (yj - yi + 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function getWallSide(wall, bounds, walls) {
    const isVert  = Math.abs(wall.x1 - wall.x2) < 0.2;
    const isHoriz = Math.abs(wall.y1 - wall.y2) < 0.2;
    // Boundary fast-path — cheap and correct when wall sits on the bbox edge.
    if (isVert && Math.abs(wall.x1 - bounds.minX) < 0.3) return 'west';
    if (isVert && Math.abs(wall.x1 - bounds.maxX) < 0.3) return 'east';
    if (isHoriz && Math.abs(wall.y1 - bounds.minY) < 0.3) return 'north';
    if (isHoriz && Math.abs(wall.y1 - bounds.maxY) < 0.3) return 'south';
    // Interior wall — probe 0.3 m perpendicular to each side; the side that
    // lands OUTSIDE the room polygon is the wall's "outward" face. Needed for
    // non-rectangular rooms (L-shapes, notches) where the bbox-center rule
    // gives the wrong side (see rooms.js plan 2026-04-20 — Bedroom flip fix).
    const mx = (wall.x1 + wall.x2) / 2, my = (wall.y1 + wall.y2) / 2;
    if (walls) {
      const len = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
      if (len > 1e-6) {
        const dx = (wall.x2 - wall.x1) / len, dy = (wall.y2 - wall.y1) / len;
        const nx = -dy, ny = dx;              // perpendicular unit vector
        const probe = 0.3;
        const pA = { x: mx + probe * nx, y: my + probe * ny };
        const pB = { x: mx - probe * nx, y: my - probe * ny };
        const poly = buildRoomPolygon(walls);
        if (poly) {
          const inA = pointInPolygon(pA, poly);
          const inB = pointInPolygon(pB, poly);
          if (inA !== inB) {
            // Exactly one probe is outside → that's the outward face.
            const outside = inA ? pB : pA;
            if (isHoriz) return outside.y < my ? 'north' : 'south';
            if (isVert)  return outside.x < mx ? 'west'  : 'east';
            // Diagonal wall — pick the dominant component.
            return Math.abs(outside.y - my) > Math.abs(outside.x - mx)
              ? (outside.y < my ? 'north' : 'south')
              : (outside.x < mx ? 'west'  : 'east');
          }
        }
      }
    }
    // Fallback: bbox-center rule (legacy behaviour).
    const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
    if (isHoriz) return my < cy ? 'north' : 'south';
    if (isVert)  return mx < cx ? 'west'  : 'east';
    const dx = Math.abs(mx - cx), dy = Math.abs(my - cy);
    if (dx > dy) return mx < cx ? 'west' : 'east';
    return my < cy ? 'north' : 'south';
  }

  // Compute the midpoint of a door/window on its parent wall (local coords).
  function getDoorMidpoint(door, walls) {
    const w = (walls || []).find(ww => ww.id === door.wall);
    if (!w) return null;
    const wallLen = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    if (wallLen < 1e-6) return null;
    const ux = (w.x2 - w.x1) / wallLen, uy = (w.y2 - w.y1) / wallLen;
    const mid = door.offset_m + door.width_m / 2;
    return { x: w.x1 + ux * mid, y: w.y1 + uy * mid, wall: w, side: null };
  }

  // Compute midpoint of a divider (local coords).
  function getDividerMidpoint(div) {
    return { x: (div.x1 + div.x2) / 2, y: (div.y1 + div.y2) / 2 };
  }

  // Infer side for a divider from its position relative to room bounds.
  function getDividerSide(div, bounds) {
    const mx = (div.x1 + div.x2) / 2, my = (div.y1 + div.y2) / 2;
    const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
    const distW = Math.abs(mx - bounds.minX), distE = Math.abs(mx - bounds.maxX);
    const distN = Math.abs(my - bounds.minY), distS = Math.abs(my - bounds.maxY);
    const minDist = Math.min(distW, distE, distN, distS);
    if (minDist === distW) return 'west';
    if (minDist === distE) return 'east';
    if (minDist === distN) return 'north';
    return 'south';
  }

  const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
  // 90° CW cycle: each step advances one index.
  const SIDE_IDX = { north: 0, east: 1, south: 2, west: 3 };

  // Rotate all coordinates in a layout 90° clockwise around the room center.
  // Returns a deep copy with transformed coordinates — original untouched.
  function rotateLayout90CW(layout) {
    const bounds = getRoomBounds(layout);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    function rot(x, y) {
      return { x: +(cx + (y - cy)).toFixed(3), y: +(cy - (x - cx)).toFixed(3) };
    }
    const out = JSON.parse(JSON.stringify(layout)); // deep copy
    for (const w of (out.walls || [])) {
      const r1 = rot(w.x1, w.y1), r2 = rot(w.x2, w.y2);
      w.x1 = r1.x; w.y1 = r1.y; w.x2 = r2.x; w.y2 = r2.y;
    }
    for (const d of (out.dividers || [])) {
      const r1 = rot(d.x1, d.y1), r2 = rot(d.x2, d.y2);
      d.x1 = r1.x; d.y1 = r1.y; d.x2 = r2.x; d.y2 = r2.y;
    }
    // Recompute shape from rotated walls
    const nb = getRoomBounds(out);
    out.shape = { type: 'rect', width_m: +(nb.maxX - nb.minX).toFixed(1), length_m: +(nb.maxY - nb.minY).toFixed(1) };
    return out;
  }

  // Rotate N × 90° CW (N ∈ {0, 1, 2, 3}). Used for perpendicular door-side
  // mismatches (e.g. parent.south → target.east). N=0 returns the original.
  function rotateLayoutN90CW(layout, n) {
    const steps = ((n | 0) % 4 + 4) % 4;
    let out = layout;
    for (let i = 0; i < steps; i++) out = rotateLayout90CW(out);
    return out;
  }

  // Reflect a layout across its centre. Used for PARALLEL door-side mismatches
  // (e.g. parent.south ↔ target.south), where a 180° rotation would also
  // mirror the perpendicular axis, destroying the room's left/right handedness
  // for asymmetric layouts (partial walls, L-shapes, notches).
  //   axis: 'x' → mirror across the horizontal centre line (flip y).
  //             → fixes north↔north and south↔south mismatches.
  //   axis: 'y' → mirror across the vertical centre line (flip x).
  //             → fixes east↔east and west↔west mismatches.
  // Door offset_m is preserved because reflection flips the wall's endpoint
  // labels in lock-step, keeping the door at the same physical location.
  function reflectLayout(layout, axis) {
    const bounds = getRoomBounds(layout);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    function ref(x, y) {
      if (axis === 'x') return { x: +x.toFixed(3),          y: +(2*cy - y).toFixed(3) };
      return                   { x: +(2*cx - x).toFixed(3), y: +y.toFixed(3) };
    }
    const out = JSON.parse(JSON.stringify(layout));
    for (const w of (out.walls || [])) {
      const r1 = ref(w.x1, w.y1), r2 = ref(w.x2, w.y2);
      w.x1 = r1.x; w.y1 = r1.y; w.x2 = r2.x; w.y2 = r2.y;
    }
    for (const d of (out.dividers || [])) {
      const r1 = ref(d.x1, d.y1), r2 = ref(d.x2, d.y2);
      d.x1 = r1.x; d.y1 = r1.y; d.x2 = r2.x; d.y2 = r2.y;
    }
    // Shape dimensions unchanged by reflection
    return out;
  }

  // Map of slug → display layout (may be rotated). Built by autoPositionRooms.
  let displayRooms = {};

  // V2 core: BFS auto-position rooms so shared doors/passages align.
  // Returns { slug: {x_m, y_m} } for each positioned room.
  let computedOrigins = {};

  function autoPositionRooms(visibleSlugs) {
    computedOrigins = {};
    displayRooms = {};
    // Start with unrotated layouts for all rooms
    for (const sl of visibleSlugs) displayRooms[sl] = displayRooms[sl] || allRooms[sl];
    if (visibleSlugs.length === 0) return;

    // Find anchor (first visible room with walls)
    let anchor = visibleSlugs.find(sl => ((allRooms[sl] || {}).walls || []).length > 0);
    if (!anchor) anchor = visibleSlugs[0];
    computedOrigins[anchor] = { x_m: 0, y_m: 0 };

    const queue = [anchor];
    const visited = new Set([anchor]);

    while (queue.length > 0) {
      const curSlug = queue.shift();
      // Use rotated/reflected layout if parent placed it with a transform —
      // otherwise its children get classified against stale original geometry.
      const curLayout = displayRooms[curSlug] || allRooms[curSlug];
      if (!curLayout) continue;
      const curBounds = getRoomBounds(curLayout);
      const curOrigin = computedOrigins[curSlug];

      // Collect all outgoing connections (doors + dividers with leads_to)
      const connections = [];
      for (const door of (curLayout.doors || [])) {
        if (!door.leads_to) continue;
        const mid = getDoorMidpoint(door, curLayout.walls);
        if (!mid) continue;
        const wall = mid.wall;
        const side = getWallSide(wall, curBounds, curLayout.walls);
        connections.push({ target: door.leads_to, side, mid, type: 'door', width: door.width_m });
      }
      for (const div of (curLayout.dividers || [])) {
        if (!div.leads_to) continue;
        const mid = getDividerMidpoint(div);
        const side = getDividerSide(div, curBounds);
        connections.push({ target: div.leads_to, side, mid, type: 'divider', width: Math.hypot(div.x2 - div.x1, div.y2 - div.y1) });
      }

      for (const conn of connections) {
        const targetSlug = conn.target;
        if (visited.has(targetSlug)) continue;
        if (!visibleSlugs.includes(targetSlug)) continue;
        const targetLayout = allRooms[targetSlug];
        if (!targetLayout || !(targetLayout.walls || []).length) continue;

        // Check if target's matching connection is perpendicular → needs rotation.
        // Try unrotated first; if the matching element's side doesn't face
        // back toward us (opposite side), rotate 90° CW and retry.
        let usedLayout = targetLayout;
        let targetBounds = getRoomBounds(usedLayout);
        const expectedSide = OPPOSITE[conn.side];

        // Find matching connection in target room (door/divider that leads_to current)
        let targetMid = null;
        let targetSide = expectedSide;
        for (const td of (targetLayout.doors || [])) {
          if (td.leads_to !== curSlug) continue;
          targetMid = getDoorMidpoint(td, targetLayout.walls);
          if (targetMid) targetSide = getWallSide(targetMid.wall, targetBounds, targetLayout.walls);
          break;
        }
        if (!targetMid) {
          for (const td of (targetLayout.dividers || [])) {
            if (td.leads_to !== curSlug) continue;
            targetMid = getDividerMidpoint(td);
            targetSide = getDividerSide(td, targetBounds);
            break;
          }
        }

        // If target's matching connection isn't on the expected side, pick
        // the transform that aligns it:
        //   parallel mismatch (target.side === parent.side)       → reflect
        //   perpendicular mismatch (90° off)                      → rotate
        // Reflection preserves left/right handedness for asymmetric rooms;
        // rotation handles the remaining perpendicular cases. Combined, this
        // covers every side combination with no room-specific logic.
        if (targetSide && targetSide !== expectedSide) {
          const parallelMismatch = (targetSide === conn.side);
          if (parallelMismatch) {
            const axis = (conn.side === 'north' || conn.side === 'south') ? 'x' : 'y';
            usedLayout = reflectLayout(targetLayout, axis);
          } else {
            const steps = (SIDE_IDX[expectedSide] - SIDE_IDX[targetSide] + 4) % 4;
            usedLayout = rotateLayoutN90CW(targetLayout, steps);
          }
          targetBounds = getRoomBounds(usedLayout);
          // Re-find matching connection in transformed layout
          targetMid = null;
          for (const td of (usedLayout.doors || [])) {
            if (td.leads_to !== curSlug) continue;
            targetMid = getDoorMidpoint(td, usedLayout.walls);
            if (targetMid) targetSide = getWallSide(targetMid.wall, targetBounds, usedLayout.walls);
            break;
          }
          if (!targetMid) {
            for (const td of (usedLayout.dividers || [])) {
              if (td.leads_to !== curSlug) continue;
              targetMid = getDividerMidpoint(td);
              targetSide = getDividerSide(td, targetBounds);
              break;
            }
          }
        }
        // Store rotated layout for display
        displayRooms[targetSlug] = usedLayout;

        // Align door-to-divider directly: place target so its connection
        // midpoint matches source's door midpoint in global space.
        // This makes the sliding door touch the dashed divider exactly.
        const curMidGlobal = { x: curOrigin.x_m + conn.mid.x, y: curOrigin.y_m + conn.mid.y };
        let ox, oy;

        if (targetMid) {
          ox = curMidGlobal.x - targetMid.x;
          oy = curMidGlobal.y - targetMid.y;
        } else {
          // No matching connection — fall back to edge alignment
          if (conn.side === 'west') {
            ox = curOrigin.x_m + curBounds.minX - targetBounds.maxX;
          } else if (conn.side === 'east') {
            ox = curOrigin.x_m + curBounds.maxX - targetBounds.minX;
          } else if (conn.side === 'north') {
            oy = curOrigin.y_m + curBounds.minY - targetBounds.maxY;
          } else {
            oy = curOrigin.y_m + curBounds.maxY - targetBounds.minY;
          }
          const tMid = (conn.side === 'west' || conn.side === 'east')
            ? (targetBounds.minY + targetBounds.maxY) / 2
            : (targetBounds.minX + targetBounds.maxX) / 2;
          if (conn.side === 'west' || conn.side === 'east') oy = curMidGlobal.y - tMid;
          else ox = curMidGlobal.x - tMid;
        }

        computedOrigins[targetSlug] = { x_m: +ox.toFixed(2), y_m: +oy.toFixed(2) };
        visited.add(targetSlug);
        queue.push(targetSlug);
      }
    }

    // Fallback: rooms with no connections keep stored origin
    for (const sl of visibleSlugs) {
      if (!computedOrigins[sl]) {
        const o = (displayRooms[sl] || allRooms[sl] || {}).origin || { x_m: 0, y_m: 0 };
        computedOrigins[sl] = { x_m: o.x_m, y_m: o.y_m };
      }
    }
  }

  // Get computed origin for a slug (used by draw + click handlers)
  function getComputedOrigin(slug) {
    return computedOrigins[slug] || (allRooms[slug] || {}).origin || { x_m: 0, y_m: 0 };
  }

  function wallGeom(item, walls) {
    const wallsArr = walls || (activeData().walls || []);
    const w = wallsArr.find(ww => ww.id === item.wall);
    if (!w) return null;
    const wallLen = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    if (wallLen < 1e-6) return null;
    const ux = (w.x2 - w.x1)/wallLen, uy = (w.y2 - w.y1)/wallLen;
    const nx = -uy, ny = ux;
    const sx = w.x1 + ux*item.offset_m, sy = w.y1 + uy*item.offset_m;
    const ex = sx + ux*item.width_m,    ey = sy + uy*item.width_m;
    return { ux, uy, nx, ny, sx, sy, ex, ey };
  }

  // ── V2: Shared room renderer (full detail) ─────────────────────────────────
  // Renders all elements of a room into an SVG group. Used for both active and
  // non-active visible rooms so every checked room shows at full detail.
  // ── V3: Furniture presets ────────────────────────────────────────────────────
  const FURN_FILL     = '#f5f3ef';
  const FURN_FILL_ALT = '#faf9f6';
  const FURN_STROKE   = '#ccc';
  const FURN_STROKE_SEL = '#27ae60';

  // Default sizes (meters) per preset when user single-clicks without dragging
  const FURN_DEFAULTS = {
    'sofa': {w:2.2, h:0.85}, 'armchair': {w:0.85, h:0.85}, 'coffee-table': {w:1.2, h:0.6},
    'tv-unit': {w:1.8, h:0.4}, 'dining-table': {w:1.4, h:0.9}, 'chair': {w:0.45, h:0.45},
    'bed': {w:1.6, h:2.0}, 'nightstand': {w:0.5, h:0.4}, 'wardrobe': {w:1.5, h:0.6},
    'desk': {w:1.2, h:0.6}, 'counter': {w:2.0, h:0.6}, 'fridge': {w:0.7, h:0.7},
    'stove': {w:0.6, h:0.6}, 'sink': {w:0.6, h:0.5}, 'bathtub': {w:1.7, h:0.75},
    'toilet': {w:0.4, h:0.65}, 'shower': {w:0.9, h:0.9}, 'washing-machine': {w:0.6, h:0.6},
    'bookshelf': {w:1.0, h:0.35}, 'planter': {w:0.5, h:0.5},
    'microwave': {w:0.5, h:0.35}, 'hood': {w:0.9, h:0.55}, 'hob': {w:0.6, h:0.52},
    'oven': {w:0.6, h:0.6}, 'fireplace': {w:1.2, h:0.3}, 'lamp': {w:0.4, h:0.4},
  };

  function _svgRect(x, y, w, h, rx, fill, stroke, sw) {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', x); r.setAttribute('y', y);
    r.setAttribute('width', w); r.setAttribute('height', h);
    if (rx) r.setAttribute('rx', rx);
    r.setAttribute('fill', fill || FURN_FILL);
    r.setAttribute('stroke', stroke || FURN_STROKE);
    r.setAttribute('stroke-width', sw || 1);
    return r;
  }
  function _svgCircle(cx, cy, r, fill, stroke) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
    c.setAttribute('fill', fill || FURN_FILL);
    c.setAttribute('stroke', stroke || FURN_STROKE);
    c.setAttribute('stroke-width', 1);
    return c;
  }
  function _svgLine(x1, y1, x2, y2, stroke, sw) {
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1);
    l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    l.setAttribute('stroke', stroke || FURN_STROKE);
    l.setAttribute('stroke-width', sw || 1);
    return l;
  }
  function _svgEllipse(cx, cy, rx, ry, fill, stroke) {
    const e = document.createElementNS(NS, 'ellipse');
    e.setAttribute('cx', cx); e.setAttribute('cy', cy);
    e.setAttribute('rx', rx); e.setAttribute('ry', ry);
    e.setAttribute('fill', fill || FURN_FILL);
    e.setAttribute('stroke', stroke || FURN_STROKE);
    e.setAttribute('stroke-width', 1);
    return e;
  }

  function _svgPath(d, fill, stroke, sw) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', fill || 'none');
    p.setAttribute('stroke', stroke || FURN_STROKE); p.setAttribute('stroke-width', sw || 1);
    return p;
  }

  function drawFurniturePreset(g, type, x, y, w, h, sel) {
    const sk = sel ? FURN_STROKE_SEL : FURN_STROKE;
    const sw = sel ? 2 : 1;
    switch (type) {
      case 'sofa': {
        // Outer frame with rounded back
        const r = Math.min(w,h)*0.15;
        g.appendChild(_svgPath(`M${x+r},${y} h${w-2*r} q${r},0 ${r},${r} v${h-2*r} q0,${r} -${r},${r} h-${w-2*r} q-${r},0 -${r},-${r} v-${h-2*r} q0,-${r} ${r},-${r}z`, FURN_FILL, sk, sw));
        // Back cushion bumps (scalloped)
        const seats = w > 40 ? 3 : 2;
        const seatW = (w - 4) / seats;
        const backH = h * 0.22;
        for (let i = 0; i < seats; i++) {
          const sx = x + 2 + i * seatW;
          g.appendChild(_svgPath(`M${sx+1},${y+h-backH} q${seatW/2},-${backH*0.5} ${seatW-2},0`, 'none', sk, 0.5));
        }
        // Seat cushion lines
        for (let i = 1; i < seats; i++) {
          const lx = x + 2 + i * seatW;
          g.appendChild(_svgLine(lx, y+3, lx, y+h-backH-2, '#ccc', 0.4));
        }
        // Armrests (rounded bumps)
        const aw = Math.max(3, w*0.08);
        g.appendChild(_svgPath(`M${x},${y+2} q-${aw*0.3},${h/2-2} 0,${h-4}`, 'none', sk, 0.8));
        g.appendChild(_svgPath(`M${x+w},${y+2} q${aw*0.3},${h/2-2} 0,${h-4}`, 'none', sk, 0.8));
        break;
      }
      case 'armchair': {
        const r = Math.min(w,h)*0.18;
        g.appendChild(_svgPath(`M${x+r},${y} h${w-2*r} q${r},0 ${r},${r} v${h-2*r} q0,${r} -${r},${r} h-${w-2*r} q-${r},0 -${r},-${r} v-${h-2*r} q0,-${r} ${r},-${r}z`, FURN_FILL, sk, sw));
        // Seat
        const pad = Math.min(w,h)*0.18;
        g.appendChild(_svgRect(x+pad, y+2, w-pad*2, h*0.65, r*0.5, FURN_FILL_ALT, sk, 0.4));
        // Armrest curves
        g.appendChild(_svgPath(`M${x+1},${y+3} q-${pad*0.4},${h/2} 0,${h-6}`, 'none', sk, 0.8));
        g.appendChild(_svgPath(`M${x+w-1},${y+3} q${pad*0.4},${h/2} 0,${h-6}`, 'none', sk, 0.8));
        break;
      }
      case 'coffee-table': {
        g.appendChild(_svgRect(x, y, w, h, 2, FURN_FILL, sk, sw));
        const lr = Math.min(w, h) * 0.06;
        g.appendChild(_svgCircle(x+lr*2.5, y+lr*2.5, lr, '#bbb', sk));
        g.appendChild(_svgCircle(x+w-lr*2.5, y+lr*2.5, lr, '#bbb', sk));
        g.appendChild(_svgCircle(x+lr*2.5, y+h-lr*2.5, lr, '#bbb', sk));
        g.appendChild(_svgCircle(x+w-lr*2.5, y+h-lr*2.5, lr, '#bbb', sk));
        break;
      }
      case 'dining-table': {
        g.appendChild(_svgRect(x, y, w, h, 3, FURN_FILL, sk, sw));
        g.appendChild(_svgRect(x+3, y+3, w-6, h-6, 2, FURN_FILL_ALT, '#ccc', 0.5));
        break;
      }
      case 'tv-unit': {
        g.appendChild(_svgRect(x, y, w, h, 1, FURN_FILL, sk, sw));
        // Screen
        g.appendChild(_svgRect(x+w*0.1, y+2, w*0.8, h*0.35, 1, '#555', sk, 0.5));
        break;
      }
      case 'chair': {
        // Seat
        g.appendChild(_svgRect(x, y+h*0.22, w, h*0.78, 2, FURN_FILL, sk, sw));
        // Backrest (thicker bar)
        g.appendChild(_svgRect(x, y, w, h*0.22, 2, '#d0c8bc', sk, sw));
        break;
      }
      case 'bed': {
        // Mattress with rounded corners
        g.appendChild(_svgRect(x, y, w, h, 3, FURN_FILL, sk, sw));
        // Headboard (thick, darker)
        g.appendChild(_svgRect(x-1, y-1, w+2, h*0.07, 2, '#a89888', sk, sw));
        // Pillows (rounded, puffy)
        const pw = w*0.42, ph = h*0.09, py = y+h*0.09, pr = Math.min(pw,ph)*0.4;
        g.appendChild(_svgRect(x+w*0.04, py, pw, ph, pr, '#fff', '#ddd', 0.5));
        g.appendChild(_svgRect(x+w*0.54, py, pw, ph, pr, '#fff', '#ddd', 0.5));
        // Duvet outline (curved)
        g.appendChild(_svgPath(`M${x+3},${y+h*0.55} q${w/2-3},-${h*0.04} ${w-6},0`, 'none', '#ddd', 0.6));
        g.appendChild(_svgPath(`M${x+3},${y+h*0.9} q${w/2-3},${h*0.03} ${w-6},0`, 'none', '#ddd', 0.4));
        break;
      }
      case 'nightstand': {
        g.appendChild(_svgRect(x, y, w, h, 2, FURN_FILL, sk, sw));
        g.appendChild(_svgLine(x+2, y+h*0.45, x+w-2, y+h*0.45, sk, 0.5));
        // Handle dot
        g.appendChild(_svgCircle(x+w*0.5, y+h*0.7, 1.5, sk, sk));
        break;
      }
      case 'wardrobe': {
        g.appendChild(_svgRect(x, y, w, h, 1, FURN_FILL, sk, sw));
        // Double doors
        g.appendChild(_svgLine(x+w*0.5, y+2, x+w*0.5, y+h-2, sk, 1));
        // Handles
        g.appendChild(_svgCircle(x+w*0.42, y+h*0.5, 1.5, sk, sk));
        g.appendChild(_svgCircle(x+w*0.58, y+h*0.5, 1.5, sk, sk));
        break;
      }
      case 'desk': {
        g.appendChild(_svgRect(x, y, w, h, 1, FURN_FILL, sk, sw));
        // Front panel (thicker edge)
        g.appendChild(_svgRect(x, y+h*0.85, w, h*0.15, 0, '#ccc5b8', sk, sw));
        // Drawer line
        g.appendChild(_svgLine(x+w*0.6, y+2, x+w*0.6, y+h*0.83, '#ccc', 0.5));
        break;
      }
      case 'counter': {
        g.appendChild(_svgRect(x, y, w, h, 0, FURN_FILL, sk, sw));
        // Surface edge
        g.appendChild(_svgRect(x, y, w, h*0.12, 0, '#d0c8bc', sk, 0.5));
        // Hatch pattern
        const step = Math.max(8, w*0.08);
        for (let i = step; i < w; i += step) {
          g.appendChild(_svgLine(x+i, y+h*0.15, x+i, y+h-1, '#ddd', 0.3));
        }
        break;
      }
      case 'fridge': {
        g.appendChild(_svgRect(x, y, w, h, 2, FURN_FILL, sk, sw));
        // Two compartments
        g.appendChild(_svgLine(x+2, y+h*0.35, x+w-2, y+h*0.35, sk, 0.5));
        // Handle
        g.appendChild(_svgLine(x+w*0.82, y+h*0.1, x+w*0.82, y+h*0.3, sk, 1.5));
        g.appendChild(_svgLine(x+w*0.82, y+h*0.42, x+w*0.82, y+h*0.62, sk, 1.5));
        break;
      }
      case 'stove': {
        g.appendChild(_svgRect(x, y, w, h, 0, FURN_FILL, sk, sw));
        // 4 burner rings (double circles)
        const br = Math.min(w, h) * 0.14, bri = br * 0.6;
        const positions = [[0.3,0.3],[0.7,0.3],[0.3,0.7],[0.7,0.7]];
        for (const [px, py] of positions) {
          g.appendChild(_svgCircle(x+w*px, y+h*py, br, 'none', sk));
          g.appendChild(_svgCircle(x+w*px, y+h*py, bri, 'none', '#bbb'));
        }
        break;
      }
      case 'sink': {
        g.appendChild(_svgRect(x, y, w, h, 2, FURN_FILL, sk, sw));
        // Basin (inner rounded rect)
        const pad = Math.min(w,h)*0.15;
        g.appendChild(_svgRect(x+pad, y+pad, w-pad*2, h-pad*2, 4, '#f5f2ed', sk, 0.5));
        // Faucet
        g.appendChild(_svgCircle(x+w*0.5, y+pad*0.6, 2, sk, sk));
        break;
      }
      case 'bathtub': {
        // Outer tub wall (thick rounded)
        const rx = Math.min(w,h)*0.35;
        g.appendChild(_svgRect(x, y, w, h, rx, FURN_FILL, sk, sw));
        // Inner basin (deeper inset, curved)
        const p = Math.min(w,h)*0.14;
        g.appendChild(_svgRect(x+p, y+p, w-p*2, h-p*2, rx*0.65, '#f8f6f2', '#ccc', 0.5));
        // Water line shimmer
        g.appendChild(_svgPath(`M${x+p+4},${y+h*0.5} q${(w-p*2)/4},-3 ${(w-p*2)/2},0 q${(w-p*2)/4},3 ${(w-p*2)/2-8},0`, 'none', '#d8e8f0', 0.6));
        // Drain
        g.appendChild(_svgCircle(x+w*0.5, y+h*0.82, 2.5, '#aaa', sk));
        // Faucet (small rect + handles)
        g.appendChild(_svgRect(x+w*0.43, y+p*0.3, w*0.14, p*0.6, 2, '#ccc', sk, 0.5));
        break;
      }
      case 'toilet': {
        // Tank (rounded rect)
        g.appendChild(_svgRect(x+w*0.08, y, w*0.84, h*0.28, 3, FURN_FILL, sk, sw));
        // Seat outline (oval path)
        const cx0 = x+w*0.5, cy0 = y+h*0.64, rr = w*0.46, ry0 = h*0.34;
        g.appendChild(_svgEllipse(cx0, cy0, rr, ry0, FURN_FILL, sk));
        // Inner bowl (smaller oval)
        g.appendChild(_svgEllipse(cx0, cy0+h*0.02, rr*0.65, ry0*0.65, '#f8f6f2', '#ccc'));
        // Lid hinge
        g.appendChild(_svgPath(`M${x+w*0.2},${y+h*0.32} q${w*0.3},-${h*0.04} ${w*0.6},0`, 'none', sk, 0.5));
        // Flush button
        g.appendChild(_svgCircle(x+w*0.5, y+h*0.12, Math.min(w,h)*0.06, '#ddd', sk));
        break;
      }
      case 'shower': {
        // Glass enclosure (dashed)
        const r = _svgRect(x, y, w, h, 0, 'rgba(200,225,245,0.2)', sk, sw);
        r.setAttribute('stroke-dasharray', '5,3');
        g.appendChild(r);
        // Shower tray (inner)
        g.appendChild(_svgRect(x+3, y+3, w-6, h-6, 3, '#f0f0f0', '#ccc', 0.5));
        // Shower head
        g.appendChild(_svgCircle(x+w*0.5, y+h*0.25, Math.min(w,h)*0.1, '#ddd', sk));
        // Drain
        g.appendChild(_svgCircle(x+w*0.5, y+h*0.75, 2, sk, sk));
        break;
      }
      case 'washing-machine': {
        g.appendChild(_svgRect(x, y, w, h, 2, FURN_FILL, sk, sw));
        // Control panel strip
        g.appendChild(_svgRect(x+2, y+2, w-4, h*0.15, 1, '#d0d0d0', sk, 0.5));
        // Drum door (circle)
        const dr = Math.min(w,h)*0.3;
        g.appendChild(_svgCircle(x+w*0.5, y+h*0.58, dr, FURN_FILL_ALT, sk));
        g.appendChild(_svgCircle(x+w*0.5, y+h*0.58, dr*0.6, '#f5f2ed', '#ccc'));
        break;
      }
      case 'bookshelf': {
        g.appendChild(_svgRect(x, y, w, h, 0, FURN_FILL, sk, sw));
        // Shelf lines (5 shelves)
        const shelves = 5;
        for (let i = 1; i < shelves; i++) {
          const sy = y + (h / shelves) * i;
          g.appendChild(_svgLine(x+1, sy, x+w-1, sy, sk, 0.7));
        }
        // Side panels
        g.appendChild(_svgLine(x+1, y+1, x+1, y+h-1, sk, 0.5));
        g.appendChild(_svgLine(x+w-1, y+1, x+w-1, y+h-1, sk, 0.5));
        break;
      }
      case 'planter': {
        // Pot (outer)
        g.appendChild(_svgEllipse(x+w*0.5, y+h*0.55, w*0.48, h*0.45, '#c8b8a0', sk));
        // Soil/plant (inner)
        g.appendChild(_svgEllipse(x+w*0.5, y+h*0.45, w*0.38, h*0.35, '#8ab07a', '#6a9060'));
        // Leaf highlight
        g.appendChild(_svgCircle(x+w*0.4, y+h*0.35, Math.min(w,h)*0.1, '#a0c890', '#6a9060'));
        break;
      }
      case 'microwave': {
        g.appendChild(_svgRect(x, y, w, h, 2, FURN_FILL, sk, sw));
        // Door window (left 70% of face)
        g.appendChild(_svgRect(x+2, y+2, w*0.68, h-4, 1, '#555', sk, 0.5));
        // Control panel strip (right 30%)
        g.appendChild(_svgRect(x+w*0.72, y+2, w*0.26, h-4, 1, '#d0d0d0', sk, 0.5));
        // A couple of tiny button dots on the panel
        g.appendChild(_svgCircle(x+w*0.85, y+h*0.35, Math.min(w,h)*0.05, '#888', sk));
        g.appendChild(_svgCircle(x+w*0.85, y+h*0.65, Math.min(w,h)*0.05, '#888', sk));
        break;
      }
      case 'hood': {
        // Trapezoidal-ish silhouette (wider top, narrower bottom slot)
        const inset = w*0.12;
        g.appendChild(_svgPath(`M${x},${y} L${x+w},${y} L${x+w-inset},${y+h} L${x+inset},${y+h} Z`, FURN_FILL, sk, sw));
        // Vent grille lines on the bottom third
        const ventY = y + h*0.55;
        for (let i = 1; i <= 4; i++) {
          g.appendChild(_svgLine(x+inset+i*2, ventY, x+w-inset-i*2, ventY, '#bbb', 0.4));
        }
        break;
      }
      case 'hob': {
        // Flat cooktop (like stove but shallower rings, suggests induction/ceramic)
        g.appendChild(_svgRect(x, y, w, h, 1, FURN_FILL, sk, sw));
        const br = Math.min(w, h) * 0.13;
        const positions = [[0.27,0.3],[0.73,0.3],[0.27,0.7],[0.73,0.7]];
        for (const [px, py] of positions) {
          g.appendChild(_svgCircle(x+w*px, y+h*py, br, 'none', sk));
        }
        // Control slider strip along bottom
        g.appendChild(_svgRect(x+w*0.15, y+h*0.88, w*0.7, h*0.08, 1, '#d0d0d0', '#ccc', 0.3));
        break;
      }
      case 'oven': {
        g.appendChild(_svgRect(x, y, w, h, 1, FURN_FILL, sk, sw));
        // Control panel strip on top
        g.appendChild(_svgRect(x+2, y+2, w-4, h*0.18, 1, '#d0d0d0', sk, 0.5));
        // Dial
        g.appendChild(_svgCircle(x+w*0.85, y+h*0.11, Math.min(w,h)*0.06, '#888', sk));
        // Oven door window
        g.appendChild(_svgRect(x+4, y+h*0.28, w-8, h*0.55, 2, '#555', sk, 0.5));
        // Door handle (horizontal bar)
        g.appendChild(_svgRect(x+w*0.18, y+h*0.88, w*0.64, h*0.06, 1, '#aaa', sk, 0.3));
        break;
      }
      case 'fireplace': {
        // Mantel/frame
        g.appendChild(_svgRect(x, y, w, h, 1, '#c9bfae', sk, sw));
        // Inner firebox (dark cavity)
        const p = Math.min(w, h) * 0.18;
        g.appendChild(_svgRect(x+p, y+p, w-p*2, h-p*2, 2, '#3a2d24', '#6a5548', 0.5));
        // Flames (stylised triangles)
        const cx0 = x + w*0.5, by = y + h - p - 1;
        const fh = (h - p*2) * 0.6;
        g.appendChild(_svgPath(`M${cx0-w*0.12},${by} Q${cx0-w*0.04},${by-fh*0.7} ${cx0},${by-fh} Q${cx0+w*0.04},${by-fh*0.7} ${cx0+w*0.12},${by} Z`, '#e07a2a', '#c06020', 0.5));
        break;
      }
      case 'lamp': {
        // Top-down lamp: shade as circle with crosshair, small base dot
        const r = Math.min(w, h) * 0.45;
        const cx0 = x + w*0.5, cy0 = y + h*0.5;
        g.appendChild(_svgCircle(cx0, cy0, r, '#f2e6b0', sk));
        g.appendChild(_svgLine(cx0-r*0.7, cy0, cx0+r*0.7, cy0, sk, 0.4));
        g.appendChild(_svgLine(cx0, cy0-r*0.7, cx0, cy0+r*0.7, sk, 0.4));
        // Bulb/base centre
        g.appendChild(_svgCircle(cx0, cy0, r*0.18, '#fff8d0', sk));
        break;
      }
      default: {
        g.appendChild(_svgRect(x, y, w, h, 2, FURN_FILL, sk, sw));
      }
    }
  }

  // multiView: true when multiple rooms visible — hides connection labels/dividers
  // between rooms that are both on screen (redundant when rooms touch physically)
  let _multiView = false;
  let _visibleSet = new Set();

  function renderRoomElements(g, layout, slug, isActive) {
    const walls = layout.walls || [];
    const selId = isActive ? selectedId : null;

    // Walls + glass barriers
    for (const w of walls) {
      const isGlass = w.type === 'glass_barrier';
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', mToPx(w.x1)); line.setAttribute('y1', mToPx(w.y1));
      line.setAttribute('x2', mToPx(w.x2)); line.setAttribute('y2', mToPx(w.y2));
      line.setAttribute('stroke', isGlass ? '#5bb8d4' : COLOR_WALL);
      line.setAttribute('stroke-width', w.id === selId ? 7 : (isGlass ? 5 : 3));
      line.setAttribute('stroke-linecap', 'square');
      if (isGlass) line.setAttribute('stroke-dasharray', '10,4');
      g.appendChild(line);
    }

    // Dividers — skip if both rooms visible (connection obvious from layout)
    for (const d of (layout.dividers || [])) {
      const hasLeads = !!d.leads_to;
      const peerVisible = hasLeads && _multiView && _visibleSet.has(d.leads_to);
      if (peerVisible) continue; // both rooms on screen — don't draw the divider between them
      const color = hasLeads ? COLOR_WIN : '#888';
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', mToPx(d.x1)); line.setAttribute('y1', mToPx(d.y1));
      line.setAttribute('x2', mToPx(d.x2)); line.setAttribute('y2', mToPx(d.y2));
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', d.id === selId ? 3 : 2);
      line.setAttribute('stroke-dasharray', '6,4');
      g.appendChild(line);
      if (hasLeads) {
        const hiddenLbl = !!d.label_hidden;
        if (!hiddenLbl || _showHiddenLabels) {
          const mx = (d.x1 + d.x2) / 2, my = (d.y1 + d.y2) / 2;
          const lo = d.label_offset || {};
          const lbl = document.createElementNS(NS, 'text');
          lbl.setAttribute('x', mToPx(mx + (lo.x || 0)) + 4);
          lbl.setAttribute('y', mToPx(my + (lo.y || 0)) - 4);
          lbl.setAttribute('font-size', '10'); lbl.setAttribute('font-weight', 'bold');
          lbl.setAttribute('fill', FURN_STROKE);
          lbl.setAttribute('opacity', hiddenLbl ? '0.3' : '1');
          lbl.setAttribute('style', 'cursor:move;user-select:none;');
          lbl.dataset.dividerLabelSlug = slug;
          lbl.dataset.dividerLabelId = d.id;
          lbl.textContent = '→ ' + d.leads_to;
          g.appendChild(lbl);
        }
      }
    }

    // Windows
    for (const item of (layout.windows || [])) {
      const wg = wallGeom(item, walls);
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
      poly.setAttribute('stroke-width', item.id === selId ? 2 : 1);
      g.appendChild(poly);
      const mid = document.createElementNS(NS, 'line');
      mid.setAttribute('x1', mToPx(wg.sx)); mid.setAttribute('y1', mToPx(wg.sy));
      mid.setAttribute('x2', mToPx(wg.ex)); mid.setAttribute('y2', mToPx(wg.ey));
      mid.setAttribute('stroke', COLOR_WIN); mid.setAttribute('stroke-width', 1);
      g.appendChild(mid);
    }

    // Doors
    for (const item of (layout.doors || [])) {
      const wg = wallGeom(item, walls);
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
        glass.setAttribute('stroke-width', item.id === selId ? 2 : 1);
        g.appendChild(glass);
      } else if (item.door_type === 'opening') {
        // Open archway — wall gap with no physical door. Erase the wall
        // segment and overlay a brown dashed line (same style as dividers).
        const t = 0.06;
        const corners = [
          [wg.sx - wg.nx*t, wg.sy - wg.ny*t], [wg.ex - wg.nx*t, wg.ey - wg.ny*t],
          [wg.ex + wg.nx*t, wg.ey + wg.ny*t], [wg.sx + wg.nx*t, wg.sy + wg.ny*t],
        ];
        const erase = document.createElementNS(NS, 'polygon');
        erase.setAttribute('points', corners.map(p => `${mToPx(p[0])},${mToPx(p[1])}`).join(' '));
        erase.setAttribute('fill', '#fafaf7'); erase.setAttribute('stroke', 'none');
        g.appendChild(erase);
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', mToPx(wg.sx)); line.setAttribute('y1', mToPx(wg.sy));
        line.setAttribute('x2', mToPx(wg.ex)); line.setAttribute('y2', mToPx(wg.ey));
        line.setAttribute('stroke', COLOR_DOOR);
        line.setAttribute('stroke-width', item.id === selId ? 3 : 2);
        line.setAttribute('stroke-dasharray', '6,4');
        g.appendChild(line);
      } else {
        const t = 0.08;
        const corners = [
          [wg.sx - wg.nx*t, wg.sy - wg.ny*t], [wg.ex - wg.nx*t, wg.ey - wg.ny*t],
          [wg.ex + wg.nx*t, wg.ey + wg.ny*t], [wg.sx + wg.nx*t, wg.sy + wg.ny*t],
        ];
        const erase = document.createElementNS(NS, 'polygon');
        erase.setAttribute('points', corners.map(p => `${mToPx(p[0])},${mToPx(p[1])}`).join(' '));
        erase.setAttribute('fill', '#fafaf7'); erase.setAttribute('stroke', 'none');
        g.appendChild(erase);
        // Hinge position: 'start' → pivot at (sx,sy); 'end' → pivot at (ex,ey).
        // Swing direction: 'inward' → default wall-normal; 'outward' → flipped normal.
        const hingeSide = item.hinge_side === 'end' ? 'end' : 'start';
        const swingDir  = item.swing_dir  === 'outward' ? 'outward' : 'inward';
        const signN = swingDir === 'outward' ? -1 : 1;
        const pivotX = hingeSide === 'end' ? wg.ex : wg.sx;
        const pivotY = hingeSide === 'end' ? wg.ey : wg.sy;
        const tipAnchorX = hingeSide === 'end' ? wg.sx : wg.ex;
        const tipAnchorY = hingeSide === 'end' ? wg.sy : wg.ey;
        const leafEndX = pivotX + wg.nx * signN * item.width_m;
        const leafEndY = pivotY + wg.ny * signN * item.width_m;
        const leaf = document.createElementNS(NS, 'line');
        leaf.setAttribute('x1', mToPx(pivotX)); leaf.setAttribute('y1', mToPx(pivotY));
        leaf.setAttribute('x2', mToPx(leafEndX)); leaf.setAttribute('y2', mToPx(leafEndY));
        leaf.setAttribute('stroke', COLOR_DOOR);
        leaf.setAttribute('stroke-width', item.id === selId ? 3 : 2);
        g.appendChild(leaf);
        const arc = document.createElementNS(NS, 'path');
        const rPx = mToPx(item.width_m);
        // Arc sweep flag: end→leafEnd direction depends on hinge side × swing dir
        // so the arc bows toward the swing half-space.
        const sweep = (hingeSide === 'start') === (swingDir === 'inward') ? 0 : 1;
        arc.setAttribute('d', `M ${mToPx(leafEndX)} ${mToPx(leafEndY)} A ${rPx} ${rPx} 0 0 ${sweep} ${mToPx(tipAnchorX)} ${mToPx(tipAnchorY)}`);
        arc.setAttribute('fill', 'none'); arc.setAttribute('stroke', COLOR_DOOR);
        arc.setAttribute('stroke-width', 1); arc.setAttribute('stroke-dasharray', '3,3');
        g.appendChild(arc);
        const hinge = document.createElementNS(NS, 'circle');
        hinge.setAttribute('cx', mToPx(pivotX)); hinge.setAttribute('cy', mToPx(pivotY));
        hinge.setAttribute('r', 3); hinge.setAttribute('fill', COLOR_DOOR);
        g.appendChild(hinge);
      }
      if (item.leads_to && !(_multiView && _visibleSet.has(item.leads_to))) {
        const hiddenLbl = !!item.label_hidden;
        if (!hiddenLbl || _showHiddenLabels) {
          const midX = (wg.sx + wg.ex) / 2, midY = (wg.sy + wg.ey) / 2;
          const lo = item.label_offset || {};
          // hinged + opening both brown; sliding teal
          const color = item.door_type === 'sliding' ? COLOR_SLIDING : COLOR_DOOR;
          const lbl = document.createElementNS(NS, 'text');
          lbl.setAttribute('x', mToPx(midX + wg.nx * 0.25 + (lo.x || 0)));
          lbl.setAttribute('y', mToPx(midY + wg.ny * 0.25 + (lo.y || 0)));
          lbl.setAttribute('font-size', '10'); lbl.setAttribute('font-weight', 'bold');
          lbl.setAttribute('fill', color); lbl.setAttribute('text-anchor', 'middle');
          lbl.setAttribute('opacity', hiddenLbl ? '0.3' : '1');
          lbl.setAttribute('style', 'cursor:move;user-select:none;');
          lbl.dataset.doorLabelSlug = slug;
          lbl.dataset.doorLabelId = item.id;
          lbl.textContent = '→ ' + item.leads_to;
          g.appendChild(lbl);
        }
      }
    }

    // Furniture — light grey architectural preset shapes (toggleable layer)
    const showFurn = document.getElementById('apt-show-furniture');
    if (showFurn && showFurn.checked) for (const f of (layout.furniture || [])) {
      const fg = document.createElementNS(NS, 'g');
      const cx = mToPx(f.x), cy = mToPx(f.y);
      const fw = mToPx(f.w), fh = mToPx(f.h);
      if (f.rotation) fg.setAttribute('transform', `rotate(${f.rotation}, ${cx}, ${cy})`);
      drawFurniturePreset(fg, f.type, cx - fw/2, cy - fh/2, fw, fh, f.id === selId);
      g.appendChild(fg);

      // Label (optional): shows f.label if set, otherwise the preset type
      const labelText = (f.label && f.label.trim()) ? f.label.trim() : f.type;
      const hiddenLbl = !!f.label_hidden;
      if (labelText && (!hiddenLbl || _showHiddenLabels)) {
        const lo = f.label_offset || {};
        const lbl = document.createElementNS(NS, 'text');
        lbl.setAttribute('x', mToPx(f.x + (lo.x || 0)));
        lbl.setAttribute('y', mToPx(f.y + (lo.y || 0)));
        lbl.setAttribute('font-size', '9');
        lbl.setAttribute('fill', '#444');
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('dominant-baseline', 'middle');
        lbl.setAttribute('opacity', hiddenLbl ? '0.3' : '0.75');
        lbl.setAttribute('style', 'cursor:move;user-select:none;pointer-events:all;');
        lbl.dataset.furnLabelSlug = slug;
        lbl.dataset.furnLabelId = f.id;
        lbl.textContent = labelText;
        g.appendChild(lbl);
      }
    }

    // V6 Zones: 1m grid overlay + cell numbers shown while the Zones tool is
    // active (on the active room only). Named-zone labels render always so the
    // spatial anchors for AI stay visible. Rendered between furniture and
    // devices so devices sit on top. Gated by the "Zones" toolbar checkbox;
    // also suppressed by _showHiddenLabels (clean-screenshot mode). While the
    // Zones tool is active, we always render so the user can keep editing.
    if (tool === 'zone' || (_showZones && !_showHiddenLabels)) {
      renderZoneOverlay(g, layout, slug, isActive);
    }

    // V5 device placements (triangles, cones, labels)
    renderPlacementsForRoom(g, slug, selId);

    // Room name label (supports optional label_offset {x,y} in room data)
    // Hidden if layout.label_hidden is true, unless "Show hidden labels" is on.
    const bounds = getRoomBounds(layout);
    const lo = layout.label_offset || {};
    const cx = (bounds.minX + bounds.maxX) / 2 + (lo.x || 0);
    const cy = (bounds.minY + bounds.maxY) / 2 + (lo.y || 0);
    const nameObj = roomSlugs.find(r => r.slug === slug);
    const hidden = !!layout.label_hidden;
    if (!hidden || _showHiddenLabels) {
      const lbl = document.createElementNS(NS, 'text');
      lbl.setAttribute('x', mToPx(cx)); lbl.setAttribute('y', mToPx(cy));
      lbl.setAttribute('font-size', isActive ? '14' : '12');
      lbl.setAttribute('font-weight', 'bold');
      lbl.setAttribute('fill', isActive ? '#333' : '#666');
      lbl.setAttribute('text-anchor', 'middle');
      lbl.setAttribute('dominant-baseline', 'middle');
      lbl.setAttribute('opacity', hidden ? '0.2' : '0.4');
      lbl.setAttribute('style', 'cursor:move;user-select:none;');
      lbl.dataset.labelSlug = slug;
      lbl.textContent = nameObj ? nameObj.name : slug;
      g.appendChild(lbl);
    }
  }

  // ── Tool selection ─────────────────────────────────────────────────────────
  window.aptSetTool = function (t) {
    tool = t;
    pending = null; pendingWall = null; selectedId = null;
    // V6: leaving the zone tool clears any unsaved cell selection. Editing an
    // existing zone is exited cleanly.
    if (t !== 'zone') { _zoneSel = []; _zoneEditId = null; }
    // V7: leaving the light tool closes any open light-picker popover.
    if (t !== 'light') {
      _lightPicker = null;
      const lp = document.getElementById('apt-light-picker');
      if (lp) lp.style.display = 'none';
    }
    // V10: leaving the parameter tool closes any open parameter-picker popover.
    if (t !== 'parameter') {
      _paramPicker = null;
      const pp = document.getElementById('apt-param-picker');
      if (pp) pp.style.display = 'none';
    }
    document.querySelectorAll('.apt-tool').forEach(b => {
      b.style.outline = b.dataset.tool === t ? '2px solid #27ae60' : 'none';
    });
    const hints = {
      wall:    'Click two points to draw a wall (on active room). Shift = free angle.',
      glass:   'Click two points for a glass barrier (balcony railing, glass partition).',
      window:  'Click start + end on a wall.',
      door:    'Click start + end on a wall.',
      sliding: 'Sliding glass door — click start + end on a wall.',
      opening: 'Open archway (no door) — click start + end on a wall. Target room becomes drawable.',
      divider: 'Click two points for open-plan boundary.',
      device:  'Click inside a room to place a presence/motion device.',
      furniture: 'Click to place furniture. Click again to set size, or single-click for default size.',
      zone:    'Click cells to toggle selection. Then type a name in the edit panel + Apply to save. Click a named zone to edit it.',
      light:   'Click inside a room to place a light. Pick its controller (switch/light entity) + channel + fixture type + intensity.',
      parameter: 'Click inside a room to place a sensor parameter label (temperature / humidity / illuminance). Pick the parameter type, source sensor(s), font size, and color.',
      select:  'Click an element to select.',
    };
    setStatus(hints[t] || '');
    refreshEditPanel();
    draw();
  };

  // ── Click handler ──────────────────────────────────────────────────────────
  function onSvgClick(ev) {
    if (suppressClick) { suppressClick = false; return; }
    if (!activeSlug || activeSlug === '_apartment') return;
    const rect = svg().getBoundingClientRect();
    const co = getComputedOrigin(activeSlug);
    const skipSnap = !!ev.shiftKey || tool === 'window' || tool === 'door' || tool === 'sliding' || tool === 'opening';
    // Convert click to active room's local coordinates:
    // pixel → meter (add viewBox origin offset) → subtract room's computed origin
    let xM = viewOriginX + pxToM(ev.clientX - rect.left) - co.x_m;
    let yM = viewOriginY + pxToM(ev.clientY - rect.top) - co.y_m;
    xM = snapM(xM, skipSnap);
    yM = snapM(yM, skipSnap);

    const data = activeData();

    if (tool === 'wall' || tool === 'glass' || tool === 'divider') {
      if (!pending) {
        pending = { x1: xM, y1: yM };
        setStatus(`${tool} start at ${xM.toFixed(1)}, ${yM.toFixed(1)} — click end point`);
      } else {
        if (pending.x1 === xM && pending.y1 === yM) { pending = null; return; }
        pushUndo(undefined, 'draw-' + tool);
        if (tool === 'wall' || tool === 'glass') {
          data.walls = data.walls || [];
          data.walls.push({
            id: 'w' + (data.walls.length + 1) + '_' + Date.now().toString(36),
            x1: pending.x1, y1: pending.y1, x2: xM, y2: yM,
            type: tool === 'glass' ? 'glass_barrier' : 'exterior',
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
    } else if (tool === 'window' || tool === 'door' || tool === 'sliding' || tool === 'opening') {
      // Two-tier hit: prefer nearest wall within 0.3m. Once pendingWall is set,
      // additionally accept clicks up to 0.6m of the pendingWall's wall — this
      // forgives small misses on the second click near corners instead of
      // cancelling the whole placement with "Both points must be on the same
      // wall". Clicks far from pendingWall still fall through to the normal
      // nearest-wall logic (which acts as cancel if wall differs).
      let hit = findWallAt(xM, yM, 0.3);
      if (pendingWall) {
        const lockWall = (activeData().walls || []).find(ww => ww.id === pendingWall.wallId);
        if (lockWall) {
          const dx = lockWall.x2 - lockWall.x1, dy = lockWall.y2 - lockWall.y1;
          const len2 = dx*dx + dy*dy;
          if (len2 > 1e-6) {
            const t = Math.max(0, Math.min(1, ((xM - lockWall.x1)*dx + (yM - lockWall.y1)*dy) / len2));
            const px = lockWall.x1 + t*dx, py = lockWall.y1 + t*dy;
            const dLock = Math.hypot(xM - px, yM - py);
            // If nearest-hit is a DIFFERENT wall but we're still within 0.6m of
            // pendingWall, lock to pendingWall. Keeps user on the same wall
            // instead of losing the placement to a corner neighbor.
            if (dLock <= 0.6 && (!hit || hit.wall.id !== pendingWall.wallId)) {
              hit = { wall: lockWall, t, d: dLock };
            }
          }
        }
      }
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
        pushUndo(undefined, 'place-' + tool + '-on-wall');
        const t1 = Math.min(pendingWall.t1, snappedT);
        const t2 = Math.max(pendingWall.t1, snappedT);
        const offset = t1 * wallLen;
        const width = (t2 - t1) * wallLen;
        const isDoor = (tool === 'door' || tool === 'sliding' || tool === 'opening');
        const target = tool === 'window' ? (data.windows = data.windows || []) : (data.doors = data.doors || []);
        const dtype = tool === 'sliding' ? 'sliding' : tool === 'opening' ? 'opening' : 'hinged';
        const doorExtra = isDoor ? { leads_to: null, door_type: dtype } : {};
        if (isDoor && dtype === 'hinged') {
          doorExtra.hinge_side = 'start';
          doorExtra.swing_dir  = 'inward';
        }
        target.push({
          id: tool[0] + (target.length + 1) + '_' + Date.now().toString(36),
          wall: pendingWall.wallId,
          offset_m: +offset.toFixed(2),
          width_m: +width.toFixed(2),
          ...doorExtra,
        });
        pendingWall = null;
        setStatus(`${tool} added (offset ${offset.toFixed(2)}m, width ${width.toFixed(2)}m).`);
      } else {
        setStatus('Both points must be on the same wall.');
        pendingWall = null;
      }
    } else if (tool === 'device') {
      // Open the device picker popover at the click position inside the active room.
      aptDevicePickerOpen(ev, xM, yM);
      return;
    } else if (tool === 'light') {
      // V7: open light picker — user picks controller (switch/light entity) + channel.
      aptLightPickerOpen(ev, xM, yM);
      return;
    } else if (tool === 'parameter') {
      // V10: open parameter picker — user picks parameter type (temp/humidity/illuminance),
      // source sensor(s), font size, and color.
      aptParamPickerOpen(ev, xM, yM);
      return;
    } else if (tool === 'zone') {
      // V6 Zones: click a cell to toggle selection. Clicking a cell inside an
      // existing named zone loads that zone into the edit panel (its cells +
      // name), allowing rename / add cells / delete. Saving is done via Apply.
      const layout = allRooms[activeSlug];
      if (!layout) return;
      const hit = resolveCellForPoint(layout, xM, yM);
      if (!hit) { setStatus('Click inside the room bounds.'); return; }
      const cellId = hit.cellId;
      if (hit.zoneId && hit.zoneId !== _zoneEditId) {
        // Load existing zone for editing
        const z = (layout.zones || []).find(zz => zz.id === hit.zoneId);
        if (z) {
          _zoneEditId = z.id;
          _zoneSel = [...(z.cells || [])];
          selectedId = null;
          setStatus(`Editing zone "${z.name}" (${_zoneSel.length} cells). Shift-click or plain-click cells to add/remove. Apply saves.`);
          draw(); refreshEditPanel();
          return;
        }
      }
      // Plain toggle (whether creating new or editing current)
      const idx = _zoneSel.indexOf(cellId);
      if (idx >= 0) _zoneSel.splice(idx, 1);
      else _zoneSel.push(cellId);
      // If toggling cells for a new zone (not editing existing), ensure edit panel is open
      if (!_zoneEditId) selectedId = null;
      setStatus(`${_zoneSel.length} cell${_zoneSel.length === 1 ? '' : 's'} selected — type a name in the edit panel + Apply.`);
      draw(); refreshEditPanel();
      return;
    } else if (tool === 'paste' && clipboard) {
      // V7: clipboard is {kind: 'furniture'|'light', data: ...}.
      if (clipboard.kind === 'light') {
        const src = clipboard.data;
        const body = {
          slug: activeSlug,
          device_id: src.device_id,
          device_type: 'light',
          x: +xM.toFixed(2), y: +yM.toFixed(2),
          rotation: src.rotation || 0,
          params: { ...(src.params || {}) },
          label: src.label || null,
        };
        fetch('/api/room-device-placements', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify(body),
        }).then(r => r.ok ? r.json() : r.json().then(err => Promise.reject(err))).then(row => {
          const dev = (_allDevices || []).find(d => d.id === src.device_id) || {};
          row.device_name = dev.name; row.last_state = dev.last_state; row.last_seen = dev.last_seen;
          roomPlacements.push(row);
          pushUndo({ type: 'dev_create', row: { ...row } });
          draw();
          renderZoneInformationTable();
          setStatus('Light pasted. Click again to paste another, or switch tool.');
        }).catch(e => setStatus('Paste failed: ' + (e && e.error ? e.error : e.message || e)));
        return;
      }
      // Furniture paste (kind === 'furniture')
      const furnSrc = clipboard.data || clipboard;
      pushUndo(undefined, 'paste-furniture');
      const dataF = activeData();
      dataF.furniture = dataF.furniture || [];
      dataF.furniture.push({
        ...furnSrc,
        id: 'furn_' + (dataF.furniture.length + 1) + '_' + Date.now().toString(36),
        x: +xM.toFixed(2),
        y: +yM.toFixed(2),
      });
      setStatus((furnSrc.type || 'item') + ' pasted. Click again to paste another, or switch tool.');
    } else if (tool === 'furniture') {
      const preset = (document.getElementById('apt-furn-preset') || {}).value;
      if (!preset) { setStatus('Select a furniture type from the dropdown first.'); return; }
      if (!pending) {
        pending = { x1: xM, y1: yM };
        setStatus(`Click again to set size, or click same spot for default ${preset} size.`);
      } else {
        pushUndo(undefined, 'furniture-sized');
        const dx = Math.abs(xM - pending.x1), dy = Math.abs(yM - pending.y1);
        const def = FURN_DEFAULTS[preset] || { w: 1, h: 1 };
        const fw = dx > 0.2 ? dx : def.w;
        const fh = dy > 0.2 ? dy : def.h;
        const cx = dx > 0.2 ? (pending.x1 + xM) / 2 : pending.x1;
        const cy = dy > 0.2 ? (pending.y1 + yM) / 2 : pending.y1;
        data.furniture = data.furniture || [];
        data.furniture.push({
          id: 'furn_' + (data.furniture.length + 1) + '_' + Date.now().toString(36),
          type: preset, x: +cx.toFixed(2), y: +cy.toFixed(2),
          w: +fw.toFixed(2), h: +fh.toFixed(2), rotation: 0, label: '',
        });
        pending = null;
        setStatus(`${preset} placed. Select another from dropdown or switch tool.`);
      }
    } else if (tool === 'select') {
      // Dataset-first hit test — if the user actually clicked a placement icon
      // (any fixture glyph part, sensor triangle, etc.), use dataset.devPlacementId.
      // Fixes off-centre fixture glyphs (lamp base, strip axis, sconce arc)
      // falling outside the 0.25m geometric hit radius below.
      const tgt = ev.target;
      if (tgt && tgt.dataset && tgt.dataset.devPlacementId) {
        const pid = parseInt(tgt.dataset.devPlacementId, 10);
        const hit = roomPlacements.find(pp => pp.id === pid);
        if (hit) {
          selectedId = hit.id;
          setStatus(`Selected ${hit.device_type === 'light' ? 'light' : 'device'} ${hit.device_name || hit.device_id}.`);
          draw(); refreshEditPanel();
          return;
        }
      }
      // Respect visibility toggles: Select should not hit elements that aren't drawn.
      const showFurn = !!(document.getElementById('apt-show-furniture') || {}).checked;
      // Check furniture first (on top visually) — skip if Furniture checkbox is off.
      if (showFurn) for (const f of (data.furniture || [])) {
        if (Math.abs(xM - f.x) <= f.w/2 + 0.1 && Math.abs(yM - f.y) <= f.h/2 + 0.1) {
          selectedId = f.id;
          setStatus(`Selected ${f.type}${f.label ? ' "'+f.label+'"' : ''}. Edit below or Delete.`);
          draw(); refreshEditPanel();
          return;
        }
      }
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
      // Check device placements (triangles + light glyphs) — in this room.
      // Lights get a slightly larger hit radius to accommodate fixture glyphs
      // like lamp base / strip / sconce that extend beyond the centre point.
      // Respect the Lights visibility checkbox: hidden lights are not selectable.
      for (const p of roomPlacements) {
        if (p.slug !== activeSlug) continue;
        if (p.device_type === 'light' && !_showLights) continue;
        const hitR = p.device_type === 'light' ? 0.4 : 0.25;
        if (Math.hypot(xM - p.x, yM - p.y) < hitR) {
          selectedId = p.id;
          setStatus(`Selected ${p.device_type === 'light' ? 'light' : 'device'} ${p.device_name || p.device_id}.`);
          draw(); refreshEditPanel();
          return;
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
      // V6: Check zones — click inside a named zone's cells to select it for
      // editing. Skip if the Zones checkbox is off (hidden elements must not
      // be selectable).
      if (_showZones) {
        const zHit = resolveCellForPoint(data, xM, yM);
        if (zHit && zHit.zoneId) {
          selectedId = zHit.zoneId;
          const z = (data.zones || []).find(zz => zz.id === zHit.zoneId);
          setStatus(`Selected zone "${z ? z.name : zHit.zoneId}". Rename + Apply, or Delete.`);
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
  // Highlight the wall under the cursor in door/window/sliding/archway tools.
  // Uses a dedicated persistent SVG layer — does NOT call draw() per mouse
  // event, keeping hover cheap (no full canvas rebuild at 60fps).
  function _hoverLayer() {
    const s = svg();
    if (!s) return null;
    let g = document.getElementById('apt-hover-hint');
    if (!g) {
      g = document.createElementNS(NS, 'g');
      g.setAttribute('id', 'apt-hover-hint');
      g.setAttribute('pointer-events', 'none');
      s.appendChild(g);
    }
    return g;
  }
  function _clearHover() {
    const g = document.getElementById('apt-hover-hint');
    if (g) g.innerHTML = '';
  }
  function onSvgMove(ev) {
    if (!activeSlug || activeSlug === '_apartment') { _clearHover(); return; }
    const rect = svg().getBoundingClientRect();
    const co = getComputedOrigin(activeSlug);
    const xM = viewOriginX + pxToM(ev.clientX - rect.left) - co.x_m;
    const yM = viewOriginY + pxToM(ev.clientY - rect.top) - co.y_m;
    let msg = `cursor: ${xM.toFixed(2)}m, ${yM.toFixed(2)}m (room-local)`;
    const isWallTool = (tool === 'window' || tool === 'door' || tool === 'sliding' || tool === 'opening');
    if (isWallTool) {
      const hit = findWallAt(xM, yM, 0.3);
      const g = _hoverLayer();
      if (g) g.innerHTML = '';
      if (hit) {
        const w = hit.wall;
        const wallLen = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
        const rawOff = hit.t * wallLen;
        const snapped = ev.shiftKey ? rawOff : Math.round(rawOff / OPENING_SNAP) * OPENING_SNAP;
        const fromEnd = wallLen - snapped;
        const nearer = snapped <= fromEnd ? { d: snapped, from: 'S' } : { d: fromEnd, from: 'E' };
        msg += `  ·  ${nearer.d.toFixed(2)}m from ${nearer.from}`;
        // Render highlight: thick orange translucent line along the wall +
        // small dot at the snapped click point so user sees exactly where
        // the opening will be placed.
        if (g) {
          const coNow = getComputedOrigin(activeSlug);
          const ox = coNow.x_m, oy = coNow.y_m;
          const highlight = document.createElementNS(NS, 'line');
          highlight.setAttribute('x1', mToPx(ox + w.x1));
          highlight.setAttribute('y1', mToPx(oy + w.y1));
          highlight.setAttribute('x2', mToPx(ox + w.x2));
          highlight.setAttribute('y2', mToPx(oy + w.y2));
          highlight.setAttribute('stroke', '#e67e22');
          highlight.setAttribute('stroke-width', 5);
          highlight.setAttribute('stroke-opacity', 0.35);
          highlight.setAttribute('stroke-linecap', 'round');
          g.appendChild(highlight);
          const snappedT = Math.max(0, Math.min(1, snapped / wallLen));
          const spx = w.x1 + snappedT * (w.x2 - w.x1);
          const spy = w.y1 + snappedT * (w.y2 - w.y1);
          const dot = document.createElementNS(NS, 'circle');
          dot.setAttribute('cx', mToPx(ox + spx));
          dot.setAttribute('cy', mToPx(oy + spy));
          dot.setAttribute('r', 4);
          dot.setAttribute('fill', '#e67e22');
          dot.setAttribute('stroke', '#fff');
          dot.setAttribute('stroke-width', 1);
          g.appendChild(dot);
        }
      }
    } else {
      _clearHover();
    }
    setStatus(msg);
  }

  // ── Edit panel ─────────────────────────────────────────────────────────────
  function refreshEditPanel() {
    const panel = document.getElementById('apt-edit-panel');
    if (!panel) return;
    // V6 Zones: special case — zone-edit mode doesn't use selectedId. Show the
    // zone wrap whenever we have cells selected OR are editing an existing zone.
    const zoneMode = (tool === 'zone') && (_zoneSel.length > 0 || _zoneEditId);
    if (zoneMode) {
      const layout = allRooms[activeSlug] || {};
      const z = _zoneEditId ? (layout.zones || []).find(zz => zz.id === _zoneEditId) : null;
      panel.style.display = 'block';
      document.getElementById('apt-edit-id').textContent = z ? ('zone "' + z.name + '"') : 'new zone';
      document.getElementById('apt-edit-offset-wrap').style.display  = 'none';
      document.getElementById('apt-edit-width-wrap').style.display   = 'none';
      document.getElementById('apt-edit-leads-wrap').style.display   = 'none';
      document.getElementById('apt-edit-hinge-wrap').style.display   = 'none';
      document.getElementById('apt-edit-furn-wrap').style.display    = 'none';
      document.getElementById('apt-edit-dev-wrap').style.display     = 'none';
      const zw = document.getElementById('apt-edit-zone-wrap');
      zw.style.display = 'inline';
      const cellList = _zoneSel.slice().sort((a, b) => a - b).join(',');
      document.getElementById('apt-edit-zone-info').textContent =
        `cells: ${cellList || '(none — click cells to select)'} · `;
      document.getElementById('apt-edit-zone-name').value = z ? (z.name || '') : '';
      document.getElementById('apt-edit-zone-desc').value = z ? (z.description || '') : '';
      return;
    }
    // Hide zone wrap when leaving zone tool
    const zw = document.getElementById('apt-edit-zone-wrap');
    if (zw) zw.style.display = 'none';
    if (!selectedId) { panel.style.display = 'none'; return; }
    const data = activeData();
    const win = (data.windows || []).find(x => x.id === selectedId);
    const dor = (data.doors || []).find(x => x.id === selectedId);
    const div = (data.dividers || []).find(x => x.id === selectedId);
    const furn = (data.furniture || []).find(x => x.id === selectedId);
    const placement = roomPlacements.find(p => p.id === selectedId);
    const zone = (data.zones || []).find(z => z.id === selectedId);
    // V6 zone selected via Select tool: show zone wrap with name/desc (no cell editing).
    if (zone) {
      panel.style.display = 'block';
      document.getElementById('apt-edit-id').textContent = `zone "${zone.name}" · ${(zone.cells || []).length} cells`;
      document.getElementById('apt-edit-offset-wrap').style.display = 'none';
      document.getElementById('apt-edit-width-wrap').style.display  = 'none';
      document.getElementById('apt-edit-leads-wrap').style.display  = 'none';
      document.getElementById('apt-edit-hinge-wrap').style.display  = 'none';
      document.getElementById('apt-edit-furn-wrap').style.display   = 'none';
      document.getElementById('apt-edit-dev-wrap').style.display    = 'none';
      const zw = document.getElementById('apt-edit-zone-wrap');
      zw.style.display = 'inline';
      const cellList = (zone.cells || []).slice().sort((a, b) => a - b).join(',');
      document.getElementById('apt-edit-zone-info').textContent = `cells: ${cellList} · `;
      document.getElementById('apt-edit-zone-name').value = zone.name || '';
      document.getElementById('apt-edit-zone-desc').value = zone.description || '';
      return;
    }
    const item = win || dor || div || furn || placement;
    if (!item) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    const isDivider = !!div;
    const isFurn = !!furn;
    const isParam = !!(placement && placement.device_type === 'parameter_label');
    const isDev   = !!(placement && placement.device_type !== 'light' && !isParam);
    const isLight = !!(placement && placement.device_type === 'light');
    document.getElementById('apt-edit-id').textContent = (isDev || isLight)
      ? (placement.device_name || placement.device_id)
      : (isParam ? (((placement.params || {}).dps_field || 'parameter') + ' label') : (furn ? (furn.type + (furn.label ? ' "'+furn.label+'"' : '')) : item.id));
    document.getElementById('apt-edit-offset-wrap').style.display = (isDivider || isFurn || isDev || isLight || isParam) ? 'none' : 'inline';
    document.getElementById('apt-edit-width-wrap').style.display  = (isDivider || isFurn || isDev || isLight || isParam) ? 'none' : 'inline';
    if (!isDivider && !isFurn && !isDev) {
      document.getElementById('apt-edit-offset').value = item.offset_m;
      document.getElementById('apt-edit-width').value = item.width_m;
    }
    const leadsWrap = document.getElementById('apt-edit-leads-wrap');
    leadsWrap.style.display = (dor || div) ? 'inline' : 'none';
    if (dor || div) document.getElementById('apt-edit-leads').value = item.leads_to || '';
    // Hinge side + swing direction — only for hinged doors
    const hingeWrap = document.getElementById('apt-edit-hinge-wrap');
    const isHinged = !!(dor && item.door_type !== 'sliding' && item.door_type !== 'opening');
    hingeWrap.style.display = isHinged ? 'inline' : 'none';
    if (isHinged) {
      document.getElementById('apt-edit-hinge').value = (item.hinge_side === 'end') ? 'end' : 'start';
      document.getElementById('apt-edit-swing').value = (item.swing_dir === 'outward') ? 'outward' : 'inward';
    }
    const furnWrap = document.getElementById('apt-edit-furn-wrap');
    furnWrap.style.display = isFurn ? 'inline' : 'none';
    if (isFurn) {
      document.getElementById('apt-edit-furn-label').value = furn.label || '';
      document.getElementById('apt-edit-furn-w').value = furn.w;
      document.getElementById('apt-edit-furn-h').value = furn.h;
      document.getElementById('apt-edit-furn-rot').value = furn.rotation || 0;
    }
    const devWrap = document.getElementById('apt-edit-dev-wrap');
    devWrap.style.display = isDev ? 'inline' : 'none';
    if (isDev) {
      const isDoor = placement && DEV_DOOR_TYPES.has(placement.device_type);
      document.getElementById('apt-edit-dev-info').textContent =
        `${placement.device_type || 'device'} · `;
      // Cone geometry + rotation + wall-barrier only meaningful for
      // presence/motion sensors. Door sensors show only Enabled + Label.
      const coneWrap = document.getElementById('apt-edit-dev-cone-wrap');
      const wbWrap   = document.getElementById('apt-edit-dev-wb-wrap');
      if (coneWrap) coneWrap.style.display = isDoor ? 'none' : '';
      if (wbWrap)   wbWrap.style.display   = isDoor ? 'none' : 'inline-flex';
      const pr = placement.params || {};
      if (!isDoor) {
        document.getElementById('apt-edit-dev-rot').value = placement.rotation || 0;
        // Backward-compat: fall back to legacy symmetric fields.
        const legacyAng = Number(pr.beam_angle_deg);
        const legacyLen = Number(pr.beam_length_m);
        const angL = pr.beam_angle_left_deg  != null ? pr.beam_angle_left_deg  : (isFinite(legacyAng) ? +(legacyAng/2).toFixed(1) : 45);
        const angR = pr.beam_angle_right_deg != null ? pr.beam_angle_right_deg : (isFinite(legacyAng) ? +(legacyAng/2).toFixed(1) : 45);
        const lenL = pr.beam_length_left_m   != null ? pr.beam_length_left_m   : (isFinite(legacyLen) ? legacyLen : 4);
        const lenR = pr.beam_length_right_m  != null ? pr.beam_length_right_m  : (isFinite(legacyLen) ? legacyLen : 4);
        document.getElementById('apt-edit-dev-angle-l').value = angL;
        document.getElementById('apt-edit-dev-angle-r').value = angR;
        document.getElementById('apt-edit-dev-length-l').value = lenL;
        document.getElementById('apt-edit-dev-length-r').value = lenR;
        document.getElementById('apt-edit-dev-hold').value = pr.hold_s ?? 120;
        document.getElementById('apt-edit-dev-wallbarrier').checked = !!pr.wall_barrier;
      }
      // 'enabled' defaults to true when absent — only false if explicitly set.
      document.getElementById('apt-edit-dev-enabled').checked = pr.enabled !== false;
      document.getElementById('apt-edit-dev-label').value = placement.label || '';
    }
    // V7 Light edit wrap
    const lightWrap = document.getElementById('apt-edit-light-wrap');
    if (lightWrap) lightWrap.style.display = isLight ? 'inline' : 'none';
    if (isLight) {
      const pr = placement.params || {};
      const intensity = pr.intensity || 'mid';
      const fixture = pr.fixture_type || 'lamp';
      const ctrlId = pr.controller_device_id || placement.device_id;
      document.getElementById('apt-edit-light-fixture').value = fixture;
      document.getElementById('apt-edit-light-intensity').value = intensity;
      const ctrlSel = document.getElementById('apt-edit-light-controller');
      _populateLightControllerDropdown(ctrlSel, ctrlId);
      const dpsSel = document.getElementById('apt-edit-light-dps');
      _populateLightDpsDropdown(dpsSel, ctrlId, pr.controller_dps_key);
      // Spread fields — FIXTURE drives the shape, so inputs follow fixture:
      //   spot   → angle (°) + length (m)  — cone
      //   strip  → length (m) + width (m)  — half-rect along strip axis
      //   other  → radius (m)              — omni circle (sa disabled)
      const sa = document.getElementById('apt-edit-light-spread-a');
      const sb = document.getElementById('apt-edit-light-spread-b');
      if (fixture === 'spot') {
        sa.value = pr.beam_angle_deg != null ? pr.beam_angle_deg : 30;
        sb.value = pr.beam_length_m  != null ? pr.beam_length_m  : 2.5;
        sa.disabled = false;
        sa.title = 'Cone half-angle (degrees)';
        sb.title = 'Cone length (m)';
      } else if (fixture === 'strip') {
        sa.value = pr.strip_length_m != null ? pr.strip_length_m : 2.0;
        sb.value = pr.strip_width_m  != null ? pr.strip_width_m
                   : (pr.radius_m != null ? pr.radius_m : 1.5);
        sa.disabled = false;
        sa.title = 'Strip length along orientation (m)';
        sb.title = 'Emission width outward from strip (m) — 180° one-sided';
      } else {
        sa.value = '';
        sa.disabled = true;
        sa.title = 'Only used for spot or strip fixtures';
        const defaultR = intensity === 'high' ? 4.0 : (intensity === 'ambient' ? 3.0 : 1.5);
        sb.value = pr.radius_m != null ? pr.radius_m : defaultR;
        sb.title = 'Illuminated radius (m) — omni';
      }
      document.getElementById('apt-edit-light-rot').value = placement.rotation || 0;
      document.getElementById('apt-edit-light-enabled').checked = pr.enabled !== false;
      document.getElementById('apt-edit-light-label').value = placement.label || '';
    }
    // V10 Parameter label edit panel
    const paramWrap = document.getElementById('apt-edit-param-wrap');
    if (paramWrap) paramWrap.style.display = isParam ? 'inline' : 'none';
    if (isParam) {
      const pr = placement.params || {};
      document.getElementById('apt-edit-param-field').textContent = pr.dps_field || '—';
      document.getElementById('apt-edit-param-agg').value    = pr.agg || 'avg';
      document.getElementById('apt-edit-param-font').value   = pr.font_size || 14;
      document.getElementById('apt-edit-param-color').value  = pr.color || '#333';
      document.getElementById('apt-edit-param-format').value = pr.format || '%.1f';
      document.getElementById('apt-edit-param-unit').value   = pr.unit || '';
      document.getElementById('apt-edit-param-label').value  = placement.label || '';
      // Populate sources dropdown — in-room first, then cross-room.
      const srcSel = document.getElementById('apt-edit-param-sources');
      const { inRoom, other } = _paramSourceCandidates(pr.dps_field || 'temperature');
      const cands = [...inRoom, ...other];
      const selSet = new Set(pr.sources || []);
      // Ensure currently-selected sources appear even if no longer in cands
      for (const id of (pr.sources || [])) {
        if (!cands.find(c => c.id === id)) {
          const dev = (_allDevices || []).find(d => d.id === id);
          if (dev) cands.push(dev);
        }
      }
      srcSel.innerHTML = cands.map(d => {
        const slug = (d.room || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const folded = SUBROOM_FOLD[d.room || ''] || slug;
        const inThisRoom = (slug === activeSlug || folded === activeSlug);
        const tag = inThisRoom ? '' : ' [' + (d.room || 'other') + ']';
        return `<option value="${d.id}" ${selSet.has(d.id) ? 'selected' : ''}>${d.name}${tag}</option>`;
      }).join('');
    }
  }

  window.aptApplyEdit = async function () {
    // V6 Zones: if we're in zone-edit mode, Apply saves the zone (create / edit /
    // delete) into the active room's layout, then snapshots the room for undo.
    if (tool === 'zone' && (_zoneSel.length > 0 || _zoneEditId)) {
      const layout = allRooms[activeSlug];
      if (!layout) { setStatus('No active room.'); return; }
      const name = (document.getElementById('apt-edit-zone-name').value || '').trim();
      const desc = (document.getElementById('apt-edit-zone-desc').value || '').trim();
      pushUndo(undefined, 'zone-apply');
      layout.zones = layout.zones || [];
      if (_zoneEditId) {
        const idx = layout.zones.findIndex(z => z.id === _zoneEditId);
        if (idx < 0) {
          // Stale id — zone was deleted elsewhere. Clear state so purple outlines vanish.
          _zoneSel = []; _zoneEditId = null;
          setStatus('Zone was already removed. Cleared editor.');
          draw(); refreshEditPanel(); renderZoneInformationTable();
          return;
        }
        if (!name) {
          // Empty name on an existing zone → delete it. Clear editing state.
          layout.zones.splice(idx, 1);
          _zoneSel = []; _zoneEditId = null;
          setStatus('Zone deleted.');
        } else {
          if (!_zoneSel.length) {
            setStatus('At least one cell required. Click cells first, or leave the name blank to delete the zone.');
            return;
          }
          // Update existing: cells = current selection (allows adding/removing), rename
          layout.zones[idx].cells = _zoneSel.slice().sort((a, b) => a - b);
          layout.zones[idx].name = name;
          layout.zones[idx].description = desc;
          setStatus(`Zone "${name}" updated (${_zoneSel.length} cells). Hit Save to persist.`);
        }
      } else {
        if (!name) { setStatus('Type a name to create a zone (or empty name on an existing zone to delete).'); return; }
        if (!_zoneSel.length) { setStatus('Click at least one cell first.'); return; }
        const id = 'z_' + activeSlug + '_' + Date.now().toString(36);
        layout.zones.push({
          id, name, description: desc,
          cells: _zoneSel.slice().sort((a, b) => a - b),
        });
        _zoneEditId = id;
        setStatus(`Zone "${name}" created (${_zoneSel.length} cells). Save to persist.`);
      }
      draw();
      refreshEditPanel();
      renderZoneInformationTable();
      return;
    }
    if (!selectedId) return;
    const data = activeData();
    // V6: zone selected via Select — Apply renames / updates description.
    const zoneSel = (data.zones || []).find(z => z.id === selectedId);
    if (zoneSel) {
      const name = (document.getElementById('apt-edit-zone-name').value || '').trim();
      const desc = (document.getElementById('apt-edit-zone-desc').value || '').trim();
      if (!name) { setStatus('Name required. Use Delete to remove the zone.'); return; }
      pushUndo(undefined, 'zone-rename');
      zoneSel.name = name;
      zoneSel.description = desc;
      draw(); refreshEditPanel(); renderZoneInformationTable();
      setStatus(`Zone renamed to "${name}".`);
      return;
    }
    let item = (data.windows || []).find(x => x.id === selectedId);
    let kind = 'windows';
    if (!item) { item = (data.doors || []).find(x => x.id === selectedId); kind = 'doors'; }
    if (!item) { item = (data.dividers || []).find(x => x.id === selectedId); kind = 'dividers'; }
    if (!item) { item = (data.furniture || []).find(x => x.id === selectedId); kind = 'furniture'; }
    if (!item) {
      const placement = roomPlacements.find(p => p.id === selectedId);
      // V7 Light branch — distinct from the sensor device branch below.
      if (placement && placement.device_type === 'light') {
        const fixture   = document.getElementById('apt-edit-light-fixture').value;
        const intensity = document.getElementById('apt-edit-light-intensity').value;
        const ctrlId    = document.getElementById('apt-edit-light-controller').value;
        const rawDps    = document.getElementById('apt-edit-light-dps').value;
        const dpsKey    = rawDps === '' ? null : rawDps;
        const rot       = parseInt(document.getElementById('apt-edit-light-rot').value, 10) || 0;
        const enabled   = !!document.getElementById('apt-edit-light-enabled').checked;
        const lbl       = (document.getElementById('apt-edit-light-label').value || '').trim() || null;
        const sa        = parseFloat(document.getElementById('apt-edit-light-spread-a').value);
        const sb        = parseFloat(document.getElementById('apt-edit-light-spread-b').value);
        const params = { ...(placement.params || {}) };
        // Drop stale spread keys so fixture switch doesn't leak cone/strip/radius values into each other.
        delete params.beam_angle_deg; delete params.beam_length_m;
        delete params.radius_m;
        delete params.strip_length_m; delete params.strip_width_m;
        params.fixture_type = fixture;
        params.intensity    = intensity;
        params.controller_device_id = ctrlId;
        params.controller_dps_key   = dpsKey;
        params.enabled = enabled;
        // Fixture-specific spread — sa / sb labels change accordingly (see refreshEditPanel).
        if (fixture === 'spot') {
          if (isFinite(sa) && sa > 0) params.beam_angle_deg = sa;
          if (isFinite(sb) && sb > 0) params.beam_length_m  = sb;
        } else if (fixture === 'strip') {
          if (isFinite(sa) && sa > 0) params.strip_length_m = sa;
          if (isFinite(sb) && sb > 0) params.strip_width_m  = sb;
        } else {
          if (isFinite(sb) && sb > 0) params.radius_m = sb;
        }
        const prev_fields = {
          device_id: placement.device_id,
          rotation: placement.rotation,
          params: { ...(placement.params || {}) },
          label: placement.label,
        };
        // Retarget device_id when controller changed so state polling + FK CASCADE
        // point at the real controller. Server validates the device exists.
        const controllerChanged = placement.device_id !== ctrlId;
        const patchBody = controllerChanged
          ? { device_id: ctrlId, rotation: rot, params, label: lbl }
          : { rotation: rot, params, label: lbl };
        try {
          const r = await fetch('/api/room-device-placements/' + placement.id, {
            method: 'PATCH', headers: {'Content-Type':'application/json'},
            body: JSON.stringify(patchBody),
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const updated = await r.json();
          pushUndo({ type: 'dev_update', id: placement.id, prev_fields });
          Object.assign(placement, updated);
          if (controllerChanged) {
            const dev = (_allDevices || []).find(d => d.id === ctrlId) || {};
            placement.device_name = dev.name;
            placement.last_state  = dev.last_state;
            placement.last_seen   = dev.last_seen;
          }
          draw(); setStatus('Light updated.');
          renderZoneInformationTable();
        } catch (e) { setStatus('Update failed: ' + e.message); }
        return;
      }
      // V10 Parameter label branch — distinct from sensor device branch below.
      if (placement && placement.device_type === 'parameter_label') {
        const agg     = document.getElementById('apt-edit-param-agg').value;
        const fontSz  = parseInt(document.getElementById('apt-edit-param-font').value, 10) || 14;
        const color   = document.getElementById('apt-edit-param-color').value || '#333';
        const fmtStr  = (document.getElementById('apt-edit-param-format').value || '%.1f').trim();
        const unit    = document.getElementById('apt-edit-param-unit').value || '';
        const lbl     = (document.getElementById('apt-edit-param-label').value || '').trim() || null;
        const srcSel  = document.getElementById('apt-edit-param-sources');
        const sources = Array.from(srcSel.selectedOptions).map(o => o.value);
        if (sources.length === 0) { setStatus('Select at least one source sensor.'); return; }
        const params = {
          ...(placement.params || {}),
          agg, font_size: fontSz, color,
          format: fmtStr, unit, sources,
        };
        const prev_fields = {
          device_id: placement.device_id,
          params:    JSON.parse(JSON.stringify(placement.params || {})),
          label:     placement.label,
        };
        const sourceChanged = (sources[0] !== placement.device_id);
        const patchBody = sourceChanged
          ? { device_id: sources[0], params, label: lbl }
          : { params, label: lbl };
        try {
          const r = await fetch('/api/room-device-placements/' + placement.id, {
            method: 'PATCH', headers: {'Content-Type':'application/json'},
            body: JSON.stringify(patchBody),
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const updated = await r.json();
          pushUndo({ type: 'dev_update', id: placement.id, prev_fields });
          Object.assign(placement, updated);
          if (sourceChanged) {
            const dev = (_allDevices || []).find(d => d.id === sources[0]) || {};
            placement.device_name = dev.name;
            placement.last_state  = dev.last_state;
            placement.last_seen   = dev.last_seen;
          }
          draw(); setStatus('Parameter label updated.');
        } catch (e) { setStatus('Update failed: ' + e.message); }
        return;
      }
      if (placement) {
        const isDoor = DEV_DOOR_TYPES.has(placement.device_type);
        const enabled = !!document.getElementById('apt-edit-dev-enabled').checked;
        const lbl = (document.getElementById('apt-edit-dev-label').value || '').trim() || null;
        // Door sensors: only label + enabled are meaningful. Don't pollute
        // params with cone geometry that the render path ignores anyway.
        // Rotation preserved from the existing placement (drag-to-rotate still
        // works via pointer handlers; the hidden Rot dropdown isn't read).
        let params, rot;
        if (isDoor) {
          params = { ...(placement.params || {}) };
          params.enabled = enabled;
          rot = placement.rotation || 0;
        } else {
          rot = parseInt(document.getElementById('apt-edit-dev-rot').value, 10) || 0;
          const angL = parseFloat(document.getElementById('apt-edit-dev-angle-l').value);
          const angR = parseFloat(document.getElementById('apt-edit-dev-angle-r').value);
          const lenL = parseFloat(document.getElementById('apt-edit-dev-length-l').value);
          const lenR = parseFloat(document.getElementById('apt-edit-dev-length-r').value);
          const hold = parseFloat(document.getElementById('apt-edit-dev-hold').value);
          const wallBarrier = !!document.getElementById('apt-edit-dev-wallbarrier').checked;
          // Build new params; drop legacy symmetric keys so they don't shadow.
          params = { ...(placement.params || {}) };
          delete params.beam_angle_deg;
          delete params.beam_length_m;
          if (isFinite(angL) && angL >= 0) params.beam_angle_left_deg  = angL;
          if (isFinite(angR) && angR >= 0) params.beam_angle_right_deg = angR;
          if (isFinite(lenL) && lenL > 0)  params.beam_length_left_m   = lenL;
          if (isFinite(lenR) && lenR > 0)  params.beam_length_right_m  = lenR;
          if (isFinite(hold) && hold >= 0) params.hold_s = hold;
          params.wall_barrier = wallBarrier;
          params.enabled = enabled;
        }
        const prev_fields = {
          rotation: placement.rotation,
          params: { ...(placement.params || {}) },
          label: placement.label,
        };
        try {
          const r = await fetch('/api/room-device-placements/' + placement.id, {
            method: 'PATCH', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ rotation: rot, params, label: lbl }),
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const updated = await r.json();
          pushUndo({ type: 'dev_update', id: placement.id, prev_fields });
          Object.assign(placement, updated);
          draw(); setStatus('Device updated.');
        } catch (e) { setStatus('Update failed: ' + e.message); }
      }
      return;
    }
    if (kind === 'furniture') {
      item.label = (document.getElementById('apt-edit-furn-label').value || '').trim();
      const fw = parseFloat(document.getElementById('apt-edit-furn-w').value);
      const fh = parseFloat(document.getElementById('apt-edit-furn-h').value);
      if (!isNaN(fw) && fw > 0) item.w = +fw.toFixed(2);
      if (!isNaN(fh) && fh > 0) item.h = +fh.toFixed(2);
      item.rotation = parseInt(document.getElementById('apt-edit-furn-rot').value) || 0;
      pushUndo(undefined, 'edit-furniture'); draw(); setStatus('Updated ' + item.type);
      return;
    }
    if (kind !== 'dividers') {
      const off = parseFloat(document.getElementById('apt-edit-offset').value);
      const wid = parseFloat(document.getElementById('apt-edit-width').value);
      if (!isNaN(off)) item.offset_m = +off.toFixed(2);
      if (!isNaN(wid) && wid > 0) item.width_m = +wid.toFixed(2);
    }
    if (kind === 'doors' || kind === 'dividers') {
      item.leads_to = (document.getElementById('apt-edit-leads').value || '').trim() || null;
      rebuildActiveRoomDropdown();
      renderPassageDimsTable();
    }
    if (kind === 'doors' && item.door_type !== 'sliding' && item.door_type !== 'opening') {
      item.hinge_side = document.getElementById('apt-edit-hinge').value === 'end' ? 'end' : 'start';
      item.swing_dir  = document.getElementById('apt-edit-swing').value === 'outward' ? 'outward' : 'inward';
    }
    pushUndo(undefined, 'edit-' + (kind || '?'));
    draw();
    setStatus('Updated ' + item.id);
  };

  // ── Undo / Delete ──────────────────────────────────────────────────────────
  window.aptUndo = async function () {
    const prev = undoStack.pop();
    if (!prev) return;
    // Legacy string entries (defensive — old stacks)
    if (typeof prev === 'string') {
      allRooms[activeSlug] = JSON.parse(prev);
      selectedId = null; pending = null; pendingWall = null;
      rebuildActiveRoomDropdown(); renderPassageDimsTable(); draw();
      return;
    }
    if (prev.type === 'layout') {
      allRooms[prev.slug || activeSlug] = JSON.parse(prev.snapshot);
      selectedId = null; pending = null; pendingWall = null;
      _zoneSel = []; _zoneEditId = null; // V6: undo also clears zone editor state
      rebuildActiveRoomDropdown(); renderPassageDimsTable(); draw();
      return;
    }
    if (prev.type === 'dev_create') {
      try {
        const r = await fetch('/api/room-device-placements/' + prev.row.id, { method: 'DELETE' });
        if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
        roomPlacements = roomPlacements.filter(p => p.id !== prev.row.id);
        selectedId = null; draw(); refreshEditPanel();
        setStatus('Undid device placement.');
      } catch (e) { setStatus('Undo failed: ' + e.message); }
      return;
    }
    if (prev.type === 'dev_delete') {
      try {
        const r = await fetch('/api/room-device-placements', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            slug: prev.row.slug, device_id: prev.row.device_id,
            device_type: prev.row.device_type,  // V7: preserve device_type on undo (light vs sensor)
            x: prev.row.x, y: prev.row.y, rotation: prev.row.rotation,
            params: prev.row.params, label: prev.row.label,
            label_offset: prev.row.label_offset, label_hidden: prev.row.label_hidden,
          }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const row = await r.json();
        row.device_name = prev.row.device_name;
        row.last_state  = prev.row.last_state;
        row.last_seen   = prev.row.last_seen;
        roomPlacements.push(row);
        draw();
        setStatus('Undid device deletion.');
      } catch (e) { setStatus('Undo failed: ' + e.message); }
      return;
    }
    if (prev.type === 'dev_update') {
      try {
        const r = await fetch('/api/room-device-placements/' + prev.id, {
          method: 'PATCH', headers: {'Content-Type':'application/json'},
          body: JSON.stringify(prev.prev_fields),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const updated = await r.json();
        const p = roomPlacements.find(x => x.id === prev.id);
        if (p) Object.assign(p, updated);
        draw(); refreshEditPanel();
        setStatus('Undid device change.');
      } catch (e) { setStatus('Undo failed: ' + e.message); }
      return;
    }
  };

  window.aptCopySelected = function () {
    if (!selectedId) { setStatus('Select a furniture item or light first.'); return; }
    const data = activeData();
    const f = (data.furniture || []).find(ff => ff.id === selectedId);
    if (f) {
      clipboard = { kind: 'furniture', data: JSON.parse(JSON.stringify(f)) };
      tool = 'paste';
      setStatus('Click to paste ' + f.type + '. Press Esc or switch tool to cancel.');
      return;
    }
    const placement = roomPlacements.find(p => p.id === selectedId);
    if (placement && placement.device_type === 'light') {
      clipboard = { kind: 'light', data: JSON.parse(JSON.stringify(placement)) };
      tool = 'paste';
      const name = placement.device_name || placement.device_id;
      setStatus('Click to paste light (' + name + '). Press Esc or switch tool to cancel.');
      return;
    }
    setStatus('Copy works on furniture or lights only.');
  };

  window.aptDeleteSelected = async function () {
    if (!selectedId) return;
    // Device placement delete (server-side)
    const placement = roomPlacements.find(p => p.id === selectedId);
    if (placement) {
      try {
        const r = await fetch('/api/room-device-placements/' + placement.id, { method: 'DELETE' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        pushUndo({ type: 'dev_delete', row: { ...placement } });
        roomPlacements = roomPlacements.filter(p => p.id !== placement.id);
        selectedId = null;
        draw(); refreshEditPanel();
        setStatus(`Removed ${placement.device_name || placement.device_id}.`);
      } catch (e) { setStatus('Delete failed: ' + e.message); }
      return;
    }
    const data = activeData();
    pushUndo(undefined, 'delete-selected:' + selectedId);
    data.walls = (data.walls || []).filter(w => w.id !== selectedId);
    data.windows = (data.windows || []).filter(x => x.id !== selectedId && x.wall !== selectedId);
    data.doors = (data.doors || []).filter(x => x.id !== selectedId && x.wall !== selectedId);
    data.dividers = (data.dividers || []).filter(d => d.id !== selectedId);
    data.furniture = (data.furniture || []).filter(f => f.id !== selectedId);
    data.zones = (data.zones || []).filter(z => z.id !== selectedId); // V6 zone delete via Select
    selectedId = null;
    // Deleting a divider/door can change the passage set — refresh UI affordances.
    rebuildActiveRoomDropdown();
    renderPassageDimsTable();
    draw(); refreshEditPanel();
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  window.aptSave = async function () {
    if (!activeSlug) return;
    const data = allRooms[activeSlug] || {};
    // Store computed origin (auto-positioned from adjacency graph)
    const co = getComputedOrigin(activeSlug);
    data.origin = { x_m: co.x_m, y_m: co.y_m };
    // Store view W/L from inputs (persists per room in DB)
    data.view_w = parseFloat(document.getElementById('apt-canvas-w').value) || null;
    data.view_h = parseFloat(document.getElementById('apt-canvas-h').value) || null;
    // Compute shape from walls bounding box (accurate dimensions)
    const cm = (data.grid || {}).cell_m || 0.5;
    if ((data.walls || []).length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const w of data.walls) {
        minX = Math.min(minX, w.x1, w.x2); minY = Math.min(minY, w.y1, w.y2);
        maxX = Math.max(maxX, w.x1, w.x2); maxY = Math.max(maxY, w.y1, w.y2);
      }
      const compW = +(maxX - minX).toFixed(1);
      const compH = +(maxY - minY).toFixed(1);
      data.shape = { type: 'rect', width_m: compW, length_m: compH };
      data.grid = { cell_m: cm, cols: Math.ceil(compW / cm), rows: Math.ceil(compH / cm) };
    } else {
      const saveW = parseFloat(document.getElementById('apt-canvas-w').value) || 8;
      const saveH = parseFloat(document.getElementById('apt-canvas-h').value) || 6;
      data.shape = { type: 'rect', width_m: saveW, length_m: saveH };
      data.grid = { cell_m: cm, cols: Math.ceil(saveW / cm), rows: Math.ceil(saveH / cm) };
    }
    try {
      // Safety guard: before overwriting the room layout, compare the walls
      // we're about to send with what's currently in the DB. If we'd shrink
      // walls/doors/dividers/furniture counts, confirm with the user first so
      // we don't silently destroy their design via a stale in-memory state
      // (e.g. after undo/delete loops).
      try {
        const cur = await fetch('/api/room-layouts/' + activeSlug).then(r => r.ok ? r.json() : null);
        if (cur) {
          const before = {
            walls: (cur.walls || []).length,
            doors: (cur.doors || []).length,
            dividers: (cur.dividers || []).length,
            furniture: (cur.furniture || []).length,
          };
          const after = {
            walls: (data.walls || []).length,
            doors: (data.doors || []).length,
            dividers: (data.dividers || []).length,
            furniture: (data.furniture || []).length,
          };
          const shrunk = Object.keys(before).filter(k => after[k] < before[k]);
          if (shrunk.length) {
            const diffs = shrunk.map(k => `${k}: ${before[k]} → ${after[k]}`).join('\n  ');
            const ok = confirm(
              `Save will REDUCE ${activeSlug}:\n  ${diffs}\n\n` +
              `This usually means an undo/delete happened. Continue save?\n\n` +
              `(Cancel keeps the DB intact and refuses this save.)`
            );
            if (!ok) {
              setStatus('Save cancelled. DB unchanged.');
              return;
            }
          }
        }
      } catch (e) { /* non-fatal — proceed with save */ }

      console.debug('[save] POST room-layouts/' + activeSlug,
        'walls=', (data.walls || []).length,
        'doors=', (data.doors || []).length,
        'dividers=', (data.dividers || []).length,
        'furniture=', (data.furniture || []).length);
      const r = await fetch(`/api/room-layouts/${activeSlug}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // Save apartment config (visibility + active room only — NOT canvas W/L
      // which is per-room and stored in localStorage)
      await fetch('/api/apartment-layout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layer_visibility: aptConfig.layer_visibility || {},
          active_room: activeSlug,
        }),
      });
      // Also save view_w/view_h + label + divider-label changes for other rooms
      for (const [sl, rd] of Object.entries(allRooms)) {
        if (sl === activeSlug) continue;
        const body = {};
        if (rd.view_w != null) body.view_w = rd.view_w;
        if (rd.view_h != null) body.view_h = rd.view_h;
        if (rd.label_offset != null) body.label_offset = rd.label_offset;
        if (rd.label_hidden != null) body.label_hidden = !!rd.label_hidden;
        if (rd._divider_dirty) body.dividers = rd.dividers || [];
        if (rd._door_dirty) body.doors = rd.doors || [];
        if (rd._furn_dirty) body.furniture = rd.furniture || [];
        if (Object.keys(body).length === 0) continue;
        console.debug('[save-partial] POST room-layouts/' + sl, 'keys=', Object.keys(body),
          'doors=', body.doors ? body.doors.length : '-',
          'dividers=', body.dividers ? body.dividers.length : '-',
          'furniture=', body.furniture ? body.furniture.length : '-');
        await fetch('/api/room-layouts/' + sl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => {});
        delete rd._divider_dirty;
        delete rd._door_dirty;
        delete rd._furn_dirty;
      }
      renderZoneInformationTable();
      // V6: clear zone editing state so the purple cell-selection outline
      // vanishes after commit. Zone name + faint grey cell borders stay.
      _zoneSel = [];
      _zoneEditId = null;
      refreshEditPanel();
      draw();
      setStatus('Saved all rooms.');
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

    // Determine visible rooms, auto-position them, then compute viewBox.
    const vis = aptConfig.layer_visibility || {};
    const visibleSlugs = Object.keys(allRooms).filter(sl =>
      vis[sl] !== false && allRooms[sl] && ((allRooms[sl].walls || []).length > 0 || sl === activeSlug)
    );

    // V2: auto-position rooms from door adjacency graph
    autoPositionRooms(visibleSlugs);
    // Show computed origin for active room
    const coInfo = document.getElementById('apt-origin-info');
    if (coInfo && activeSlug) {
      const co = getComputedOrigin(activeSlug);
      coInfo.textContent = `Origin: (${co.x_m}, ${co.y_m}) auto`;
    }

    // ViewBox: compute from visible rooms' wall bounds, then expand to
    // at least W/L (user's zoom preference). Works in both single + multi mode.
    let viewX = 0, viewY = 0, viewW = cW, viewH = cH;
    if (visibleSlugs.length >= 1) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const sl of visibleSlugs) {
        const lay = displayRooms[sl] || allRooms[sl];
        const o = getComputedOrigin(sl);
        if ((lay.walls || []).length) {
          for (const w of lay.walls) {
            minX = Math.min(minX, o.x_m + w.x1, o.x_m + w.x2);
            minY = Math.min(minY, o.y_m + w.y1, o.y_m + w.y2);
            maxX = Math.max(maxX, o.x_m + w.x1, o.x_m + w.x2);
            maxY = Math.max(maxY, o.y_m + w.y1, o.y_m + w.y2);
          }
        } else {
          const sh = lay.shape || {};
          minX = Math.min(minX, o.x_m);
          minY = Math.min(minY, o.y_m);
          maxX = Math.max(maxX, o.x_m + (sh.width_m || 8));
          maxY = Math.max(maxY, o.y_m + (sh.length_m || 6));
        }
      }
      const pad = 0.5;
      viewX = minX - pad; viewY = minY - pad;
      // W/L directly controls the view — user sets the zoom level
      viewW = cW || (maxX - minX) + 2*pad;
      viewH = cH || (maxY - minY) + 2*pad;
    }
    const pxPerM = Math.max(15, Math.floor(avail / viewW));
    cellPx = pxPerM;
    const widthPx = Math.ceil(viewW * pxPerM);
    const heightPx = Math.ceil(viewH * pxPerM);
    s.setAttribute('width', widthPx);
    s.setAttribute('height', heightPx);
    viewOriginX = viewX; viewOriginY = viewY;  // store for click handlers
    s.setAttribute('viewBox', `${viewX * pxPerM} ${viewY * pxPerM} ${widthPx} ${heightPx}`);
    s.innerHTML = '';

    // Grid always uses active room's cell_m for the fine grid the user expects.
    // When multiple rooms visible, the fine grid still renders so editing
    // the active room feels identical to the single-room editor.
    const activeGrid = (allRooms[activeSlug] || {}).grid || {};
    const gridStep = activeGrid.cell_m || 0.5;
    const majorEvery = Math.max(1, Math.round(1 / gridStep));
    const gStartX = Math.floor(viewX / gridStep) * gridStep;
    const gStartY = Math.floor(viewY / gridStep) * gridStep;
    const gEndX = viewX + viewW, gEndY = viewY + viewH;

    const gridMinor = document.createElementNS(NS, 'g');
    gridMinor.setAttribute('stroke', '#e8e4dc'); gridMinor.setAttribute('stroke-width', 0.5);
    const gridMajor = document.createElementNS(NS, 'g');
    gridMajor.setAttribute('stroke', '#b8b1a5'); gridMajor.setAttribute('stroke-width', 1);
    for (let x = gStartX; x <= gEndX; x = +(x + gridStep).toFixed(4)) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', mToPx(x)); line.setAttribute('y1', mToPx(viewY));
      line.setAttribute('x2', mToPx(x)); line.setAttribute('y2', mToPx(gEndY));
      (Math.round((x - gStartX) / gridStep) % majorEvery === 0 ? gridMajor : gridMinor).appendChild(line);
    }
    for (let y = gStartY; y <= gEndY; y = +(y + gridStep).toFixed(4)) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', mToPx(viewX)); line.setAttribute('y1', mToPx(y));
      line.setAttribute('x2', mToPx(gEndX)); line.setAttribute('y2', mToPx(y));
      (Math.round((y - gStartY) / gridStep) % majorEvery === 0 ? gridMajor : gridMinor).appendChild(line);
    }
    s.appendChild(gridMinor); s.appendChild(gridMajor);

    // Meter labels
    const labelsG = document.createElementNS(NS, 'g');
    labelsG.setAttribute('font-family', 'system-ui, sans-serif');
    labelsG.setAttribute('font-size', '9'); labelsG.setAttribute('fill', '#aaa');
    const labelStep = 1;
    for (let x = Math.ceil(viewX); x <= gEndX; x += labelStep) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', mToPx(x) + 2); t.setAttribute('y', mToPx(viewY) + 11);
      t.textContent = x + 'm'; labelsG.appendChild(t);
    }
    for (let y = Math.ceil(viewY) + 1; y <= gEndY; y += labelStep) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', mToPx(viewX) + 2); t.setAttribute('y', mToPx(y) - 2);
      t.textContent = y + 'm'; labelsG.appendChild(t);
    }
    s.appendChild(labelsG);

    // Set multi-view flags so renderRoomElements knows to hide connection labels
    _multiView = visibleSlugs.length > 1;
    _visibleSet = new Set(visibleSlugs);

    // ── V2: Render ALL visible rooms at full detail ─────────────────────────
    // Active room = full opacity + green border. Others = 0.7 opacity.
    // All rooms use COMPUTED origins from autoPositionRooms().
    // We render non-active first, then active on top (so active is clickable).

    for (const sl of visibleSlugs) {
      if (sl === activeSlug) continue; // active rendered last (on top)
      const layout = displayRooms[sl] || allRooms[sl];
      if (!layout || !(layout.walls || []).length) continue;
      const o = getComputedOrigin(sl);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('transform', `translate(${mToPx(o.x_m)}, ${mToPx(o.y_m)})`);
      g.setAttribute('opacity', '0.7');
      renderRoomElements(g, layout, sl, false);
      s.appendChild(g);
    }

    // Active room on top (editable, full opacity, green border)
    if (activeSlug && displayRooms[activeSlug] && vis[activeSlug] !== false) {
      const layout = displayRooms[activeSlug] || allRooms[activeSlug];
      const o = getComputedOrigin(activeSlug);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('transform', `translate(${mToPx(o.x_m)}, ${mToPx(o.y_m)})`);


      renderRoomElements(g, layout, activeSlug, true);

      // Pending marker
      if (pending) {
        const mk = document.createElementNS(NS, 'circle');
        mk.setAttribute('cx', mToPx(pending.x1)); mk.setAttribute('cy', mToPx(pending.y1));
        mk.setAttribute('r', 4); mk.setAttribute('fill', '#27ae60');
        g.appendChild(mk);
      }

      s.appendChild(g);
    }

    // V2: Connection highlights — only in single-room view (multi-view rooms
    // are physically touching so connection is obvious from the layout)
    if (_multiView) return; // skip connector lines in combined view
    const connG = document.createElementNS(NS, 'g');
    connG.setAttribute('pointer-events', 'none');
    const drawnConns = new Set();
    for (const sl of visibleSlugs) {
      const layout = displayRooms[sl] || allRooms[sl];
      if (!layout) continue;
      const o = getComputedOrigin(sl);
      for (const door of (layout.doors || [])) {
        if (!door.leads_to || !visibleSlugs.includes(door.leads_to)) continue;
        const connKey = [sl, door.leads_to].sort().join('|');
        if (drawnConns.has(connKey)) continue;
        drawnConns.add(connKey);
        const mid = getDoorMidpoint(door, layout.walls);
        if (!mid) continue;
        const targetO = getComputedOrigin(door.leads_to);
        const targetLayout = allRooms[door.leads_to];
        if (!targetLayout) continue;
        // Find matching connection in target
        let targetMid = null;
        for (const td of (targetLayout.doors || [])) {
          if (td.leads_to !== sl) continue;
          targetMid = getDoorMidpoint(td, targetLayout.walls);
          break;
        }
        if (!targetMid) {
          for (const td of (targetLayout.dividers || [])) {
            if (td.leads_to !== sl) continue;
            targetMid = getDividerMidpoint(td);
            break;
          }
        }
        if (!targetMid) continue;
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', mToPx(o.x_m + mid.x));
        line.setAttribute('y1', mToPx(o.y_m + mid.y));
        line.setAttribute('x2', mToPx(targetO.x_m + targetMid.x));
        line.setAttribute('y2', mToPx(targetO.y_m + targetMid.y));
        line.setAttribute('stroke', '#27ae60');
        line.setAttribute('stroke-width', 3);
        line.setAttribute('stroke-dasharray', '4,4');
        line.setAttribute('opacity', '0.6');
        connG.appendChild(line);
      }
      for (const div of (layout.dividers || [])) {
        if (!div.leads_to || !visibleSlugs.includes(div.leads_to)) continue;
        const connKey = [sl, div.leads_to].sort().join('|');
        if (drawnConns.has(connKey)) continue;
        drawnConns.add(connKey);
        const mid = getDividerMidpoint(div);
        const targetO = getComputedOrigin(div.leads_to);
        const targetLayout = allRooms[div.leads_to];
        if (!targetLayout) continue;
        let targetMid = null;
        for (const td of (targetLayout.doors || [])) {
          if (td.leads_to !== sl) continue;
          targetMid = getDoorMidpoint(td, targetLayout.walls);
          break;
        }
        if (!targetMid) {
          for (const td of (targetLayout.dividers || [])) {
            if (td.leads_to !== sl) continue;
            targetMid = getDividerMidpoint(td);
            break;
          }
        }
        if (!targetMid) continue;
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', mToPx(o.x_m + mid.x));
        line.setAttribute('y1', mToPx(o.y_m + mid.y));
        line.setAttribute('x2', mToPx(targetO.x_m + targetMid.x));
        line.setAttribute('y2', mToPx(targetO.y_m + targetMid.y));
        line.setAttribute('stroke', '#27ae60');
        line.setAttribute('stroke-width', 3);
        line.setAttribute('stroke-dasharray', '4,4');
        line.setAttribute('opacity', '0.6');
        connG.appendChild(line);
      }
    }
    s.appendChild(connG);
  }

  // Collect slugs referenced by any drawn room's door OR divider leads_to.
  // Used to decide which rooms are "part of the apartment" at all.
  function getReferencedSlugs() {
    const s = new Set();
    for (const layout of Object.values(allRooms)) {
      for (const arr of [layout.doors || [], layout.dividers || []]) {
        for (const it of arr) if (it.leads_to) s.add(it.leads_to);
      }
    }
    return s;
  }
  // Collect slugs reached ONLY via a divider (true passage rooms — sub-zones
  // of the parent's open-plan space, not drawn as separate rooms). Door
  // targets are NOT passages — they're separate adjacent rooms that should
  // be drawn independently (like Balcony, Corridor, etc.).
  function getDividerTargetSlugs() {
    const s = new Set();
    for (const layout of Object.values(allRooms)) {
      for (const it of (layout.dividers || [])) if (it.leads_to) s.add(it.leads_to);
    }
    return s;
  }
  function isPassageOnly(slug) {
    const dts = getDividerTargetSlugs();
    if (!dts.has(slug)) return false;
    const layout = allRooms[slug];
    return !layout || !((layout.walls || []).length > 0);
  }

  // Render the Passage Room Dimensions table. One row per passage-only slug
  // (divider/door target without its own walls). Card hides when empty.
  // Compute status label for a room: Drawn / Drawn, open-plan with X /
  // Passage from X / Adjacent to X (door|archway) / Not in layout.
  function roomStatusLabel(slug) {
    const layout = allRooms[slug];
    const hasWalls = !!(layout && (layout.walls || []).length > 0);
    const passageFrom = [];
    const doorFrom = {};
    for (const [sl, lay] of Object.entries(allRooms)) {
      if (sl === slug) continue;
      for (const d of (lay.dividers || [])) if (d.leads_to === slug) passageFrom.push(sl);
      for (const d of (lay.doors || [])) {
        if (d.leads_to !== slug) continue;
        const dtype = d.door_type === 'sliding' ? 'sliding'
                    : d.door_type === 'opening' ? 'archway'
                    : 'door';
        (doorFrom[sl] ||= new Set()).add(dtype);
      }
    }
    const parts = [];
    if (hasWalls) {
      const shared = (layout.shared_with || []).map(s => (roomSlugs.find(r => r.slug === s) || {}).name || s);
      parts.push(shared.length ? `Drawn, open-plan with ${shared.join(' + ')}` : 'Drawn');
    }
    if (passageFrom.length) {
      const names = [...new Set(passageFrom.map(s => (roomSlugs.find(r => r.slug === s) || {}).name || s))];
      parts.push(`Passage from ${names.join(', ')}`);
    }
    if (Object.keys(doorFrom).length) {
      const pieces = Object.entries(doorFrom).map(([sl, types]) => {
        const name = (roomSlugs.find(r => r.slug === sl) || {}).name || sl;
        return `${name} (${[...types].join('/')})`;
      });
      parts.push(`Adjacent to ${pieces.join(', ')}`);
    }
    if (!parts.length) parts.push('Not in layout');
    return parts.join('; ');
  }

  // Shoelace tracer on walls — same logic as server's computeRoomAreaFromWalls.
  function polygonAreaFromWalls(walls) {
    if (!Array.isArray(walls) || walls.length < 3) return null;
    const SNAP = 0.08;
    const pts = [];
    walls.forEach((w, i) => { pts.push({ x:+w.x1, y:+w.y1 }); pts.push({ x:+w.x2, y:+w.y2 }); });
    const rep = pts.map((_, i) => i);
    const find = (i) => { while (rep[i] !== i) { rep[i] = rep[rep[i]]; i = rep[i]; } return i; };
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      if (Math.abs(pts[i].x - pts[j].x) < SNAP && Math.abs(pts[i].y - pts[j].y) < SNAP) {
        const a = find(i), b = find(j); if (a !== b) rep[a] = b;
      }
    }
    const groups = new Map(), groupXY = new Map();
    for (let i = 0; i < pts.length; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(pts[i]); }
    for (const [r, g] of groups) groupXY.set(r, { x: g.reduce((a,b)=>a+b.x,0)/g.length, y: g.reduce((a,b)=>a+b.y,0)/g.length });
    const ptG = pts.map((_, i) => find(i));
    const adj = new Map();
    walls.forEach((w, i) => {
      const a = ptG[i*2], b = ptG[i*2+1]; if (a === b) return;
      if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push({ i, other: b }); adj.get(b).push({ i, other: a });
    });
    const singles = []; for (const [g, list] of adj) if (list.length === 1) singles.push(g);
    while (singles.length >= 2) {
      const a = singles.shift(), pa = groupXY.get(a);
      let best = -1, bestD = Infinity;
      for (let k = 0; k < singles.length; k++) { const pb = groupXY.get(singles[k]); const d = Math.hypot(pa.x-pb.x, pa.y-pb.y); if (d < bestD) { bestD = d; best = k; } }
      if (best < 0) break;
      const b = singles.splice(best, 1)[0], s = 'syn_'+a+'_'+b;
      adj.get(a).push({ i:s, other:b }); adj.get(b).push({ i:s, other:a });
    }
    const startG = ptG[0]; const used = new Set(); const verts = [groupXY.get(startG)];
    let cur = startG, prev = null;
    for (let step = 0; step < walls.length + 10; step++) {
      const ns = adj.get(cur) || [];
      let next = ns.find(n => !used.has(n.i) && n.other !== prev) || ns.find(n => !used.has(n.i));
      if (!next) return null; used.add(next.i); if (next.other === startG) break;
      verts.push(groupXY.get(next.other)); prev = cur; cur = next.other;
    }
    if (verts.length < 3) return null;
    let sum = 0;
    for (let i = 0; i < verts.length; i++) { const a = verts[i], b = verts[(i+1) % verts.length]; sum += a.x*b.y - b.x*a.y; }
    return Math.abs(sum) / 2;
  }

  function computeDrawnArea(slug) {
    const layout = allRooms[slug];
    if (!layout || !(layout.walls || []).length) return null;
    const poly = polygonAreaFromWalls(layout.walls);
    if (poly != null) return +poly.toFixed(1);
    const s = layout.shape || {};
    if (s.width_m && s.length_m) return +(s.width_m * s.length_m).toFixed(1);
    return null;
  }

  function _fmtArea(a) { return (a > 0) ? `${(+a).toFixed(1)} m²` : '—'; }
  function _fmtVolume(area, h) { return (area > 0 && h > 0) ? `${(area * h).toFixed(1)} m³` : '—'; }

  // Render the full "Room Information" table — one row per DB room.
  function renderRoomInfoTable() {
    const card = document.getElementById('apt-passage-card');
    const tbody = card && card.querySelector('tbody');
    if (!card || !tbody) return;
    if (!roomSlugs.length) { card.style.display = 'none'; tbody.innerHTML = ''; return; }
    card.style.display = '';
    tbody.innerHTML = '';
    const disabledStyle = 'width:54px;padding:2px 4px;border:1px solid #e8e3d8;background:#f5f2ea;color:#999;border-radius:3px;font-size:0.78rem;text-align:right;';
    const editStyle = 'width:54px;padding:2px 4px;border:1px solid #d0cbc4;border-radius:3px;font-size:0.78rem;text-align:right;';
    // Sort by physical position in apartment (top-to-bottom via y, then left-to-right via x).
    // Rooms without layout fall to the end, alphabetical.
    const sortedRooms = roomSlugs.slice().sort((a, b) => {
      const aHas = !!(allRooms[a.slug] && (allRooms[a.slug].walls || []).length);
      const bHas = !!(allRooms[b.slug] && (allRooms[b.slug].walls || []).length);
      if (aHas !== bHas) return aHas ? -1 : 1;        // drawn rooms first
      if (!aHas && !bHas) return a.name.localeCompare(b.name);
      const ao = getComputedOrigin(a.slug);
      const bo = getComputedOrigin(b.slug);
      if (ao.y_m !== bo.y_m) return ao.y_m - bo.y_m;   // top to bottom
      if (ao.x_m !== bo.x_m) return ao.x_m - bo.x_m;   // left to right
      return a.name.localeCompare(b.name);
    });
    for (const r of sortedRooms) {
      const layout = allRooms[r.slug];
      const hasWalls = !!(layout && (layout.walls || []).length > 0);
      const drawnArea = hasWalls ? computeDrawnArea(r.slug) : null;
      const drawnShape = hasWalls ? (layout.shape || {}) : null;
      const dims = roomDims[r.slug] || {};
      const w = hasWalls ? (drawnShape.width_m ?? '') : (dims.w != null ? dims.w : '');
      const l = hasWalls ? (drawnShape.length_m ?? '') : (dims.l != null ? dims.l : '');
      const h = hasWalls ? (layout.height_m ?? '') : (dims.h != null ? dims.h : '');
      const status = roomStatusLabel(r.slug);
      const devices = roomDevCounts[r.name] || 0;
      const wAttrs = hasWalls
        ? `disabled style="${disabledStyle}"`
        : `data-rd-slug="${r.slug}" data-rd-axis="w" style="${editStyle}"`;
      const lAttrs = hasWalls
        ? `disabled style="${disabledStyle}"`
        : `data-rd-slug="${r.slug}" data-rd-axis="l" style="${editStyle}"`;
      const hAttrs = hasWalls
        ? `data-rd-slug="${r.slug}" data-rd-axis="h" data-rd-target="layout" style="${editStyle}"`
        : `data-rd-slug="${r.slug}" data-rd-axis="h" style="${editStyle}"`;
      const areaDisplay = hasWalls ? _fmtArea(drawnArea) : _fmtArea(parseFloat(w) * parseFloat(l));
      const volDisplay  = hasWalls ? _fmtVolume(drawnArea, parseFloat(h)) : _fmtVolume(parseFloat(w) * parseFloat(l), parseFloat(h));
      const tr = document.createElement('tr');
      tr.style.borderTop = '1px solid #e8e3d8';
      // Score cells — filled by aptApplyScoresToRoomInfoTable after fetch.
      tr.innerHTML = `
        <td style="padding:3px 6px;">${r.name}</td>
        <td style="padding:3px 4px;text-align:right;color:#aaa;border-right:2px solid #e8e3d8;" data-rd-score-new="${r.name}">—</td>
        <td style="padding:3px 6px 3px 14px;font-size:0.72rem;color:#666;">${status}</td>
        <td style="padding:3px 6px;text-align:right;"><input type="number" step="0.1" min="0" value="${w}" ${wAttrs}></td>
        <td style="padding:3px 6px;text-align:right;"><input type="number" step="0.1" min="0" value="${l}" ${lAttrs}></td>
        <td style="padding:3px 6px;text-align:right;"><input type="number" step="0.1" min="0" value="${h}" ${hAttrs}></td>
        <td style="padding:3px 6px;text-align:right;" data-rd-area="${r.slug}">${areaDisplay}</td>
        <td style="padding:3px 6px;text-align:right;" data-rd-vol="${r.slug}">${volDisplay}</td>
        <td style="padding:3px 6px;text-align:right;">${devices || '—'}</td>
      `;
      tbody.appendChild(tr);
    }
    // Fire-and-forget fetch to populate score columns; also keeps _scoreboardData fresh for the modal.
    aptApplyScoresToRoomInfoTable();
    tbody.querySelectorAll('input[data-rd-slug]').forEach(inp => {
      inp.addEventListener('input', function () {
        const slug = inp.dataset.rdSlug;
        const axis = inp.dataset.rdAxis;
        const isLayout = inp.dataset.rdTarget === 'layout';
        const val = parseFloat(inp.value);
        const num = isFinite(val) && val > 0 ? val : null;
        if (isLayout) {
          const lay = allRooms[slug];
          if (lay) { if (num) lay.height_m = num; else delete lay.height_m; lay._height_dirty = true; }
        } else {
          (roomDims[slug] ||= {})[axis] = num;
        }
        const lay = allRooms[slug];
        const hasWalls = !!(lay && (lay.walls || []).length > 0);
        const rowInputs = tbody.querySelectorAll(`input[data-rd-slug="${slug}"]`);
        const wVal = hasWalls ? (lay.shape || {}).width_m : parseFloat(rowInputs[0]?.value);
        const lVal = hasWalls ? (lay.shape || {}).length_m : parseFloat(rowInputs[1]?.value);
        const hVal = parseFloat(rowInputs[2]?.value);
        const area = hasWalls ? computeDrawnArea(slug) : (wVal > 0 && lVal > 0 ? +(wVal * lVal).toFixed(1) : null);
        const aCell = tbody.querySelector(`[data-rd-area="${slug}"]`);
        const vCell = tbody.querySelector(`[data-rd-vol="${slug}"]`);
        if (aCell) aCell.textContent = _fmtArea(area);
        if (vCell) vCell.textContent = _fmtVolume(area, hVal);
      });
    });
    _pdApplyCollapsed(localStorage.getItem('apt_passage_collapsed') === '1');
  }

  // Legacy alias for callers that still use the old name. Also refreshes the
  // V6 Zone Information card so every room-info refresh keeps zones in sync.
  function renderPassageDimsTable() {
    renderRoomInfoTable();
    renderZoneInformationTable();
  }

  // Collapse/expand the Passage Room Dimensions card. Persists in localStorage.
  function _pdApplyCollapsed(collapsed) {
    const body = document.getElementById('apt-passage-body');
    const btn  = document.getElementById('apt-passage-toggle');
    if (body) body.style.display = collapsed ? 'none' : '';
    if (btn) btn.textContent = collapsed ? '▸' : '▾';
  }
  window.aptTogglePassageCard = function () {
    const cur = localStorage.getItem('apt_passage_collapsed') === '1';
    const next = !cur;
    try { localStorage.setItem('apt_passage_collapsed', next ? '1' : '0'); } catch (e) {}
    _pdApplyCollapsed(next);
  };

  // ── V6 Zone Information card ───────────────────────────────────────────────
  // One table summarising every room's zones: zone name, cell list, area, and
  // the devices placed inside. Rooms without zones show one "(no zones)" row.
  function renderZoneInformationTable() {
    const card = document.getElementById('apt-zone-card');
    const tbody = card && card.querySelector('tbody');
    if (!card || !tbody) return;
    if (!roomSlugs.length) { card.style.display = 'none'; tbody.innerHTML = ''; return; }
    card.style.display = '';
    tbody.innerHTML = '';
    for (const r of roomSlugs) {
      const layout = allRooms[r.slug];
      if (!layout || !(layout.walls || []).length) continue; // only drawn rooms have a grid
      const zones = layout.zones || [];
      const placements = roomPlacements.filter(p => p.slug === r.slug);
      if (!zones.length) {
        const tr = document.createElement('tr');
        tr.style.borderTop = '1px solid #e8e3d8';
        tr.innerHTML = `
          <td style="padding:3px 6px;">${r.name}</td>
          <td colspan="5" style="padding:3px 6px;color:#999;font-style:italic;">(no zones)</td>`;
        tbody.appendChild(tr);
        continue;
      }
      for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        const cellCount = (z.cells || []).length;
        const area = cellCount; // 1m² per cell
        // Split placements inside this zone into lights vs non-lights (V7).
        const inZone = placements.filter(p => (z.cells || []).includes(cellIdForPoint(layout, p.x, p.y)));
        const lightsInZone = inZone.filter(p => p.device_type === 'light');
        const devsInZone   = inZone.filter(p => p.device_type !== 'light');
        const lightNames = lightsInZone.map(p => {
          const name = p.label || p.device_name || p.device_id;
          const intensity = (p.params || {}).intensity || 'mid';
          return `${name} (${intensity})`;
        });
        const devNames = devsInZone.map(p => p.device_name || p.label || p.device_id).filter(Boolean);
        const cellList = (z.cells || []).slice().sort((a, b) => a - b).join(', ');
        const tr = document.createElement('tr');
        tr.style.borderTop = '1px solid #e8e3d8';
        tr.innerHTML = `
          <td style="padding:3px 6px;">${i === 0 ? r.name : ''}</td>
          <td style="padding:3px 6px;color:#6c4f9f;font-weight:600;">${z.name}</td>
          <td style="padding:3px 6px;font-size:0.72rem;color:#555;">${cellList}</td>
          <td style="padding:3px 6px;text-align:right;">${area} m²</td>
          <td style="padding:3px 6px;font-size:0.72rem;color:#a67a14;">${lightNames.length ? lightNames.join(', ') : '—'}</td>
          <td style="padding:3px 6px;font-size:0.72rem;color:#555;">${devNames.length ? devNames.join(', ') : '—'}</td>`;
        tbody.appendChild(tr);
      }
    }
    _zcApplyCollapsed(localStorage.getItem('apt_zone_collapsed') === '1');
  }
  function _zcApplyCollapsed(collapsed) {
    const body = document.getElementById('apt-zone-body');
    const btn  = document.getElementById('apt-zone-toggle');
    if (body) body.style.display = collapsed ? 'none' : '';
    if (btn) btn.textContent = collapsed ? '▸' : '▾';
  }
  window.aptToggleZoneCard = function () {
    const cur = localStorage.getItem('apt_zone_collapsed') === '1';
    const next = !cur;
    try { localStorage.setItem('apt_zone_collapsed', next ? '1' : '0'); } catch (e) {}
    _zcApplyCollapsed(next);
  };

  // ── Rooms Scoreboard — AI observability score per room ────────────────────
  // Baseline (ai_score_old) is written once (2026-04-20 Phase 1). Future
  // ai_score_new comes from the /review-rooms-score skill. Inline table here
  // shows compact scores per room; the 📊 Scoreboard button opens a detail
  // modal with reason text explaining why each room isn't at 10.
  let _scoreboardData = [];

  function _fmtDdMmYy(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}-${mm}-${yy}`;
  }

  function _scoreColor(s) {
    if (s == null) return '#aaa';
    if (s >= 8) return '#2e7d32';
    if (s >= 6) return '#e67e22';
    if (s >= 1) return '#c0392b';
    return '#888';
  }

  // Fetch scoreboard + populate the two score columns in the Room Information
  // table. Also updates the two header labels with the most recent date.
  async function aptApplyScoresToRoomInfoTable() {
    try {
      const r = await fetch('/api/rooms/scoreboard');
      _scoreboardData = await r.json();
    } catch (e) {
      console.warn('[score] fetch failed', e);
      return;
    }
    if (!Array.isArray(_scoreboardData)) { _scoreboardData = []; return; }

    // Update header date — only the new score is shown in the table; the modal
    // still surfaces old vs new via _scoreboardData (preserved from the API).
    const mostRecentNew = _scoreboardData.map(x => x.ai_score_new_at).filter(Boolean).sort().reverse()[0];
    const mostRecentOld = _scoreboardData.map(x => x.ai_score_old_at).filter(Boolean).sort().reverse()[0];
    const thNew = document.getElementById('apt-passage-th-score-new');
    if (thNew) thNew.textContent = `Score ${_fmtDdMmYy(mostRecentNew)}`;

    // Scoreboard button label: date = whichever score was most recently written.
    const btn = document.getElementById('apt-scoreboard-btn');
    if (btn) {
      const latest = mostRecentNew || mostRecentOld;
      btn.textContent = `📊 Scoreboard ${_fmtDdMmYy(latest)}`;
    }

    // Fill per-room cells (match by name)
    for (const row of _scoreboardData) {
      const newCell = document.querySelector(`[data-rd-score-new="${CSS.escape(row.name)}"]`);
      if (newCell) {
        if (row.ai_score_new != null) {
          newCell.innerHTML = `<span style="color:${_scoreColor(row.ai_score_new)};font-weight:600;">${row.ai_score_new}</span>`;
        } else {
          newCell.textContent = '—';
          newCell.style.color = '#aaa';
        }
      }
    }
  }

  // Compute per-room capability ratings (0–10) from live placement/device data.
  // Diagnostic only — NOT used to compute the overall score. Shown in the
  // modal so the user sees which observability dimensions are weak.
  function _computeRoomCapabilities(roomName) {
    // Derive the slug from name (rooms table keys by name; placements by slug).
    const slug = roomName.toLowerCase().replace(/\s+/g, '-');
    const placements = roomPlacements.filter(p => p.slug === slug);
    const sensors = placements.filter(p => p.device_type === 'presence' || p.device_type === 'motion');
    const lights = placements.filter(p => p.device_type === 'light');
    const hasMmWave = sensors.some(p => {
      const d = _allDevices.find(d => d.id === p.device_id) || {};
      // MTD086 / Human presence sensor / LD2410 family / FP2 — all mmWave
      return /MTD086|Human presence|LD241|LD245|FP2/i.test(d.product_name || '');
    });
    const hasMultiTargetTracker = sensors.some(p => {
      const d = _allDevices.find(d => d.id === p.device_id) || {};
      return /LD2450|FP2/i.test(d.product_name || '');
    });
    const hasIndividualId = false; // no BLE tags / camera in house today
    const zones = (allRooms[slug] || {}).zones || [];
    const zoneCount = zones.length;
    const sensorCount = sensors.length;

    const cap = [];
    // 1. Presence yes/no
    let presence = sensorCount === 0 ? 0 : sensorCount === 1 ? 6 : sensorCount === 2 ? 8 : 9;
    if (hasMmWave) presence = Math.min(10, presence + 1);
    cap.push({ name: 'Presence yes/no', rating: presence,
               note: sensorCount === 0 ? 'no sensors' : `${sensorCount} sensor${sensorCount>1?'s':''}${hasMmWave?' incl. mmWave (stationary)':''}` });
    // 2. Which zone
    let zone = zoneCount === 0 ? 0 : zoneCount <= 2 ? 4 : 6;
    if (sensorCount >= 3 && zoneCount >= 3) zone = Math.min(10, zone + 2);
    cap.push({ name: 'Which zone', rating: zone,
               note: zoneCount === 0 ? 'no zones defined' : `${zoneCount} zones${sensorCount>=3?' + multi-sensor overlap':''}` });
    // 3. People count
    let count = sensorCount === 0 ? 0 : hasMultiTargetTracker ? 9 : 5;
    cap.push({ name: 'People count', rating: count,
               note: hasMultiTargetTracker ? 'multi-target tracker present' : 'binary sensors cannot count reliably' });
    // 4. 2D position
    let pos2d = sensorCount === 0 ? 0 : hasMultiTargetTracker ? 9 : (sensorCount >= 2 && hasMmWave ? 6 : 3);
    cap.push({ name: '2D position', rating: pos2d,
               note: hasMultiTargetTracker ? 'LD2450/FP2 gives native XY' : (sensorCount >= 2 && hasMmWave ? '1D distance per mmWave, partial triangulation' : 'single sensor / PIR only') });
    // 5. Individual ID
    cap.push({ name: 'Individual ID', rating: hasIndividualId ? 7 : 0,
               note: 'no BLE tags, no camera' });
    // 6. Activity classification
    let activity = sensorCount === 0 ? 0 : hasMmWave ? 3 : 1;
    cap.push({ name: 'Activity classification', rating: activity,
               note: hasMmWave ? 'mmWave binary — stillness vs motion only' : 'PIR motion only — cannot detect stillness' });
    // 7. Light state control
    let lightState = lights.length === 0 ? 0 : 9;
    cap.push({ name: 'Light state control', rating: lightState,
               note: lights.length === 0 ? 'no lights placed' : `${lights.length} light placement${lights.length>1?'s':''} with controller` });
    return cap;
  }

  window.aptOpenScoreboard = function () {
    const modal = document.getElementById('apt-score-modal');
    const body  = document.getElementById('apt-score-modal-body');
    if (!modal || !body) return;
    if (!_scoreboardData.length) {
      body.innerHTML = '<div style="color:#888;">No scoreboard data loaded yet.</div>';
    } else {
      const blocks = _scoreboardData.map(r => {
        const scoreColor = (s) => s == null ? '#aaa' : (s >= 8 ? '#2e7d32' : s >= 6 ? '#e67e22' : s >= 1 ? '#c0392b' : '#888');
        const capColor = (s) => s >= 8 ? '#2e7d32' : s >= 5 ? '#e67e22' : s >= 1 ? '#c0392b' : '#888';
        const oldScore = r.ai_score_old != null
          ? `<span style="color:${scoreColor(r.ai_score_old)};font-weight:600;">${r.ai_score_old}</span>`
          : '<span style="color:#aaa;">—</span>';
        const newScore = r.ai_score_new != null
          ? `<span style="color:${scoreColor(r.ai_score_new)};font-weight:600;">${r.ai_score_new}</span>`
          : '<span style="color:#aaa;">— (not yet rescored)</span>';
        const oldReason = r.ai_score_old_reason ? r.ai_score_old_reason.replace(/</g, '&lt;') : '';
        const newReason = r.ai_score_new_reason ? r.ai_score_new_reason.replace(/</g, '&lt;') : '';
        // Per-room capability diagnostic table (rubric v2.1).
        const caps = _computeRoomCapabilities(r.name);
        const capRows = caps.map(c => `
          <tr>
            <td style="padding:2px 6px;font-size:0.72rem;">${c.name}</td>
            <td style="padding:2px 6px;font-size:0.72rem;text-align:right;color:${capColor(c.rating)};font-weight:600;">${c.rating}</td>
            <td style="padding:2px 6px;font-size:0.72rem;color:#666;">${c.note}</td>
          </tr>`).join('');
        return `
          <div style="border-top:1px solid #e8e3d8;padding:8px 0;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:4px;">
              <strong>${r.name}</strong>
              <div style="font-size:0.82rem;">
                <span style="color:#666;">New:</span> ${newScore}
                <span style="color:#666;margin-left:10px;">${r.ai_score_new_at ? 'from ' + _fmtDdMmYy(r.ai_score_new_at) : ''}</span>
                <span style="color:#666;margin-left:16px;">Old:</span> ${oldScore}
                <span style="color:#666;margin-left:10px;">${r.ai_score_old_at ? 'from ' + _fmtDdMmYy(r.ai_score_old_at) : ''}</span>
              </div>
            </div>
            ${oldReason ? `<div style="font-size:0.78rem;color:#555;padding-left:8px;"><em>Old:</em> ${oldReason}</div>` : ''}
            ${newReason ? `<div style="font-size:0.78rem;color:#333;padding-left:8px;"><em>New:</em> ${newReason}</div>` : ''}
            <table style="margin-top:6px;margin-left:8px;border-collapse:collapse;font-size:0.72rem;">
              <thead>
                <tr style="background:#f0ece3;">
                  <th style="text-align:left;padding:2px 6px;">Capability</th>
                  <th style="text-align:right;padding:2px 6px;width:42px;">Rating</th>
                  <th style="text-align:left;padding:2px 6px;">Why</th>
                </tr>
              </thead>
              <tbody>${capRows}</tbody>
            </table>
          </div>`;
      }).join('');
      body.innerHTML = blocks;
    }
    modal.style.display = 'flex';
  };

  window.aptCloseScoreboard = function () {
    const modal = document.getElementById('apt-score-modal');
    if (modal) modal.style.display = 'none';
  };

  // ── V5 Device placements ───────────────────────────────────────────────────
  // Offline threshold is transport-aware: polled devices advance last_seen on
  // every poll cycle (~30 s) so 10 min of silence = genuinely offline. Push
  // devices only advance last_seen on a state change, so an empty quiet room
  // freezes the timestamp — use 30 min to avoid false grey halos.
  const DEV_STATE_OFFLINE_MS_POLL = 10 * 60 * 1000;
  const DEV_STATE_OFFLINE_MS_PUSH = 30 * 60 * 1000;
  const DEV_PUSH_SOURCES = new Set(['tcp_push', 'ha_api', 'zigbee', 'zwave', 'ring', 'home_connect']);
  const DEV_COLORS = { active: '#d83030', clear: '#27ae60', offline: '#888', disabled: '#e8b43a' };
  const DEV_PRESENCE_TYPES = new Set(['presence', 'motion']);
  // V9 — door sensors are placeable alongside presence/motion. They render as
  // a small square on the wall (no cone), red when open, grey when closed.
  const DEV_DOOR_TYPES = new Set(['door_sensor']);
  const DEV_PLACEABLE_TYPES = new Set([...DEV_PRESENCE_TYPES, ...DEV_DOOR_TYPES]);

  // true = open, false = closed, null = unknown (offline or odd payload).
  // Aeotec Z-wave door sensors report `door: true/false` (true = open).
  // Z2M uses `contact: true/false` (false = open). Tuya uses `"1": bool`.
  function _doorSensorIsOpen(p) {
    const ls = p.last_state || {};
    if (ls.door === true) return true;
    if (ls.door === false) return false;
    if (ls.contact === false) return true;
    if (ls.contact === true) return false;
    if (ls['1'] === true) return true;
    if (ls['1'] === false) return false;
    return null;
  }

  // Line-segment intersection in room-local meter coords. Returns true if
  // segment (a,b) crosses segment (c,d). Ignores pure-touch endpoint cases.
  function _segCross(a, b, c, d) {
    const d1 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
    const d2 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
    const d3 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const d4 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  // Ray-cast from origin at angle (rad). Returns the shortest distance (m)
  // to any wall segment hit, clamped to maxDist. Self-blocking on the mount
  // wall is avoided by the caller pushing origin forward by a small epsilon.
  // Solves origin + t*(dx,dy) = w.x1 + s*(wx,wy) via Cramer's rule where
  // the 2x2 system is [[dx, -wx], [dy, -wy]] [t, s]^T = [ox, oy]^T.
  function _raycastWall(origin, angleRad, maxDist, walls) {
    let best = maxDist;
    const dx = Math.cos(angleRad), dy = Math.sin(angleRad);
    for (const w of walls) {
      const wx = w.x2 - w.x1, wy = w.y2 - w.y1;
      const denom = wx * dy - wy * dx;
      if (Math.abs(denom) < 1e-9) continue; // parallel
      const ox = w.x1 - origin.x, oy = w.y1 - origin.y;
      const t = (wx * oy - wy * ox) / denom;  // distance along ray
      const s = (dx * oy - dy * ox) / denom;  // parametric pos on wall [0..1]
      if (t > 1e-6 && s >= -1e-6 && s <= 1 + 1e-6 && t < best) best = t;
    }
    return best;
  }

  function _devActiveHold(p) {
    // true if live state indicates active, OR within hold_s of last known active.
    // Protocol-aware: Tuya presence sensors report field "1" (bool/string);
    // Aeotec/HA motion sensors report 'motion' (bool); Z2M occupancy sensors
    // report 'occupancy' (bool). Fall back to any common truthy field name.
    const ls = p.last_state || {};
    let liveOn = false;
    const v1 = ls['1'];
    if (v1 === true || v1 === 1) liveOn = true;
    else if (typeof v1 === 'string' && v1 && v1 !== 'none' && v1 !== 'None') liveOn = true;
    if (!liveOn) {
      liveOn = ls.motion === true || ls.presence === true
            || ls.occupancy === true || ls.occupied === true
            || ls.motion_detected === true;
    }
    if (liveOn) { p._last_active_ts = Date.now(); return true; }
    const hold = Number((p.params || {}).hold_s) || 0;
    if (hold > 0 && p._last_active_ts && (Date.now() - p._last_active_ts) < hold * 1000) return true;
    return false;
  }

  function _devState(p) {
    const lastSeen = p.last_seen ? new Date(p.last_seen).getTime() : 0;
    if (!lastSeen) return 'offline';
    const dev = (_allDevices || []).find(d => d.id === p.device_id);
    const src = dev && dev.last_source;
    const threshold = DEV_PUSH_SOURCES.has(src) ? DEV_STATE_OFFLINE_MS_PUSH : DEV_STATE_OFFLINE_MS_POLL;
    if ((Date.now() - lastSeen) > threshold) return 'offline';
    return _devActiveHold(p) ? 'active' : 'clear';
  }

  // V6 Zones — 1m grid overlay on a single room's <g>.
  //   Active room (single-room focus):    grid borders + cell numbers (Zones tool)
  //                                       + selection highlight + named zone labels.
  //   Non-active rooms (multi-room view): only the named zone labels.
  // This keeps the apartment view clean: zones are visible as anchors but
  // the per-cell grid stays in the room the user is actually editing.
  function renderZoneOverlay(g, layout, slug, isActive) {
    const zGrid = zoneGridSize(layout);
    if (!zGrid.cols || !zGrid.rows) return;
    const zones = layout.zones || [];

    if (isActive) {
      const showNumbers = tool === 'zone';
      const selSet = new Set(_zoneSel);
      const cellToZone = {};
      for (const z of zones) {
        for (const c of (z.cells || [])) cellToZone[c] = z.id;
      }
      // Faint cell borders
      const borderG = document.createElementNS(NS, 'g');
      borderG.setAttribute('stroke', 'rgba(40,40,40,0.09)');
      borderG.setAttribute('stroke-width', '0.5');
      borderG.setAttribute('fill', 'none');
      borderG.setAttribute('pointer-events', 'none');
      for (let r = 0; r < zGrid.rows; r++) {
        for (let c = 0; c < zGrid.cols; c++) {
          const x0 = zGrid.minX + c, y0 = zGrid.minY + r;
          const rect = document.createElementNS(NS, 'rect');
          rect.setAttribute('x', mToPx(x0));
          rect.setAttribute('y', mToPx(y0));
          rect.setAttribute('width', mToPx(1));
          rect.setAttribute('height', mToPx(1));
          borderG.appendChild(rect);
        }
      }
      g.appendChild(borderG);
      // Cell numbers (only in Zones tool; named-zone cells show the zone name instead)
      if (showNumbers) {
        for (let r = 0; r < zGrid.rows; r++) {
          for (let c = 0; c < zGrid.cols; c++) {
            const cellId = r * zGrid.cols + c + 1;
            if (cellToZone[cellId]) continue;
            const x0 = zGrid.minX + c, y0 = zGrid.minY + r;
            const t = document.createElementNS(NS, 'text');
            t.setAttribute('x', mToPx(x0) + 3);
            t.setAttribute('y', mToPx(y0) + 11);
            t.setAttribute('font-size', '9');
            t.setAttribute('fill', 'rgba(80,80,80,0.45)');
            t.setAttribute('pointer-events', 'none');
            t.setAttribute('style', 'user-select:none;');
            t.textContent = String(cellId);
            g.appendChild(t);
          }
        }
        // Highlight currently-selected cells (Zones Set edit mode)
        if (selSet.size) {
          for (const cellId of selSet) {
            const rect = cellIdToRect(layout, cellId);
            if (!rect) continue;
            const hl = document.createElementNS(NS, 'rect');
            hl.setAttribute('x', mToPx(rect.minXm));
            hl.setAttribute('y', mToPx(rect.minYm));
            hl.setAttribute('width', mToPx(1));
            hl.setAttribute('height', mToPx(1));
            hl.setAttribute('fill', 'none');
            hl.setAttribute('stroke', '#6c4f9f');
            hl.setAttribute('stroke-width', '2');
            hl.setAttribute('pointer-events', 'none');
            g.appendChild(hl);
          }
        }
      }
      // Highlight the cells of a zone currently selected via Select tool (any tool active)
      if (selectedId) {
        const selZone = zones.find(z => z.id === selectedId);
        if (selZone) {
          for (const cellId of (selZone.cells || [])) {
            const rect = cellIdToRect(layout, cellId);
            if (!rect) continue;
            const hl = document.createElementNS(NS, 'rect');
            hl.setAttribute('x', mToPx(rect.minXm));
            hl.setAttribute('y', mToPx(rect.minYm));
            hl.setAttribute('width', mToPx(1));
            hl.setAttribute('height', mToPx(1));
            hl.setAttribute('fill', 'rgba(108,79,159,0.12)');
            hl.setAttribute('stroke', '#6c4f9f');
            hl.setAttribute('stroke-width', '2');
            hl.setAttribute('pointer-events', 'none');
            g.appendChild(hl);
          }
        }
      }
    }
    // Named-zone labels — one text node at the group's centroid (cells average)
    for (const z of zones) {
      if (!(z.cells || []).length) continue;
      let sx = 0, sy = 0, n = 0;
      for (const cellId of z.cells) {
        const rect = cellIdToRect(layout, cellId);
        if (!rect) continue;
        sx += (rect.minXm + rect.maxXm) / 2;
        sy += (rect.minYm + rect.maxYm) / 2;
        n++;
      }
      if (!n) continue;
      const lo = z.label_offset || {};
      const cxm = sx / n + (lo.x || 0);
      const cym = sy / n + (lo.y || 0);
      const hiddenLbl = !!z.label_hidden;
      if (!hiddenLbl || _showHiddenLabels) {
        const lbl = document.createElementNS(NS, 'text');
        lbl.setAttribute('x', mToPx(cxm));
        lbl.setAttribute('y', mToPx(cym));
        // Non-active rooms: larger, bolder, darker purple so zones pop as
        // anchors in the apartment view. Active room keeps the gentler tone.
        lbl.setAttribute('font-size', isActive ? '11' : '13');
        lbl.setAttribute('font-weight', isActive ? '600' : '800');
        lbl.setAttribute('fill', isActive ? '#6c4f9f' : '#3d2a5c');
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('dominant-baseline', 'middle');
        lbl.setAttribute('opacity', hiddenLbl ? '0.3' : '1');
        // Zone labels are always interactive — drag to move, right-click to
        // hide — matching furniture/divider/door label UX regardless of the
        // active tool. Clicks on the label still propagate to onSvgClick so
        // tool actions (furniture placement etc.) keep working; only dragging
        // the label itself intercepts a mousedown+drag gesture.
        lbl.setAttribute('pointer-events', 'all');
        lbl.setAttribute('style', 'cursor:move;user-select:none;');
        lbl.dataset.zoneLabelSlug = slug;
        lbl.dataset.zoneLabelId = z.id;
        lbl.textContent = z.name;
        g.appendChild(lbl);
      }
    }
  }

  // Render all placements for one room (called inside renderRoomElements after furniture)
  // V7: map controller's last_state (by dps_key) → ON / OFF / unknown for lights.
  function _lightState(p) {
    const pr = p.params || {};
    if (pr.enabled === false) return 'disabled';
    const ls = p.last_state || {};
    const key = pr.controller_dps_key != null ? String(pr.controller_dps_key) : null;
    const raw = key != null ? ls[key] : (ls.on !== undefined ? ls.on : ls['20']);
    if (raw === true || raw === 1 || raw === '1' || raw === 'on' || raw === 'ON' || raw === 'true' || raw === 'True') return 'on';
    if (raw === false || raw === 0 || raw === '0' || raw === 'off' || raw === 'OFF' || raw === 'false' || raw === 'False') return 'off';
    return 'unknown';
  }

  // V7 Light colour palette — ON = warm yellow, OFF = grey, DISABLED = muted yellow, UNKNOWN = pale grey.
  const LIGHT_COLORS = { on: '#f4b400', off: '#888', disabled: '#e8b43a', unknown: '#bbb' };

  function renderPlacementsForRoom(g, slug, selId) {
    const list = roomPlacements.filter(p => p.slug === slug);
    for (const p of list) {
      const cx = mToPx(p.x), cy = mToPx(p.y);

      // V7 Lights — distinct render branch. Gated by the Lights checkbox.
      if (p.device_type === 'light') {
        if (!_showLights) continue;
        _renderLight(g, p, cx, cy, slug, selId);
        continue;
      }

      // V10 Parameter labels — render only the formatted value (no icon).
      // Reads each source's last_state[dps_field], applies aggregation, formats
      // with sprintf-like format string + unit, draws as a draggable SVG <text>.
      // Wrapped in try/catch so a single broken param row doesn't halt
      // the rest of the placement-rendering loop (motion sensors etc.).
      if (p.device_type === 'parameter_label') {
        if (!_showParameters) { continue; }
        try { _renderParamLabel(g, p, cx, cy, slug, selId); }
        catch (e) { console.error('parameter_label render failed for', p.id, e); }
        continue;
      }

      // V9 Door sensors — small square icon, red when open, grey when closed.
      // Same drag/select/edit handles as other placements.
      if (DEV_DOOR_TYPES.has(p.device_type)) {
        const isEnabled = (p.params || {}).enabled !== false;
        const open = _doorSensorIsOpen(p);
        const fill = !isEnabled ? DEV_COLORS.disabled
                   : open === true  ? DEV_COLORS.active   // red
                   : open === false ? DEV_COLORS.offline  // grey
                                    : DEV_COLORS.offline; // unknown → grey
        const sideM = 0.18;
        const half = sideM / 2;
        const rotRad = (Math.PI / 180) * (p.rotation || 0);
        const rot = (ox, oy) => ({
          x: cx + mToPx(ox) * Math.cos(rotRad) - mToPx(oy) * Math.sin(rotRad),
          y: cy + mToPx(ox) * Math.sin(rotRad) + mToPx(oy) * Math.cos(rotRad),
        });
        const a = rot(-half, -half), b = rot( half, -half);
        const c = rot( half,  half), d = rot(-half,  half);
        const sq = document.createElementNS(NS, 'polygon');
        sq.setAttribute('points', `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`);
        sq.setAttribute('fill', fill);
        sq.setAttribute('stroke', '#222');
        sq.setAttribute('stroke-width', p.id === selId ? 2 : 1);
        sq.setAttribute('style', 'cursor:pointer;');
        sq.dataset.devPlacementId = p.id;
        g.appendChild(sq);

        // Label — same UX as presence sensors (drag to move, right-click hide).
        const lblText = (p.label && p.label.trim()) || p.device_name || p.device_id;
        const hidden = !!p.label_hidden;
        if (lblText && (!hidden || _showHiddenLabels)) {
          const lo = p.label_offset || {};
          const lbl = document.createElementNS(NS, 'text');
          lbl.setAttribute('x', mToPx(p.x + (lo.x || 0)));
          lbl.setAttribute('y', mToPx(p.y + (lo.y || 0)) - mToPx(0.28));
          lbl.setAttribute('font-size', '9');
          lbl.setAttribute('fill', '#333');
          lbl.setAttribute('text-anchor', 'middle');
          lbl.setAttribute('opacity', hidden ? '0.3' : (isEnabled ? '0.85' : '0.5'));
          lbl.setAttribute('style', 'cursor:move;user-select:none;pointer-events:all;');
          lbl.dataset.devLabelId = p.id;
          lbl.dataset.devLabelSlug = slug;
          lbl.textContent = lblText;
          g.appendChild(lbl);
        }
        continue;
      }

      // 'enabled' defaults to true when absent. Disabled placements: yellow
      // triangle, no cone, no dots, dim label — AI also sees DISABLED in scene.
      const isEnabled = (p.params || {}).enabled !== false;
      const state = isEnabled ? _devState(p) : 'disabled';
      const fill = DEV_COLORS[state];

      // Cone + dot field — only for presence/motion when active AND enabled.
      // V5.1: support asymmetric left/right halves. Params resolved with
      // backward-compat: legacy (beam_angle_deg, beam_length_m) splits into
      // equal halves; new fields (beam_angle_left/right_deg, beam_length_
      // left/right_m) override per side if set.
      if (isEnabled && state === 'active' && DEV_PRESENCE_TYPES.has(p.device_type)) {
        const pr = p.params || {};
        const legacyAng = Number(pr.beam_angle_deg);
        const legacyLen = Number(pr.beam_length_m);
        const angL = (pr.beam_angle_left_deg  != null ? Number(pr.beam_angle_left_deg)  : (isFinite(legacyAng) ? legacyAng / 2 : 45));
        const angR = (pr.beam_angle_right_deg != null ? Number(pr.beam_angle_right_deg) : (isFinite(legacyAng) ? legacyAng / 2 : 45));
        const lenL = (pr.beam_length_left_m   != null ? Number(pr.beam_length_left_m)   : (isFinite(legacyLen) ? legacyLen : 4));
        const lenR = (pr.beam_length_right_m  != null ? Number(pr.beam_length_right_m)  : (isFinite(legacyLen) ? legacyLen : 4));
        const wallBarrier = !!pr.wall_barrier;
        const rotRad = (Math.PI / 180) * (p.rotation || 0);
        const angLRad = (Math.PI / 180) * angL;
        const angRRad = (Math.PI / 180) * angR;

        const roomLayout = allRooms[slug] || {};
        const walls = wallBarrier ? (roomLayout.walls || []) : null;
        const apexM = wallBarrier
          ? { x: p.x + 0.01 * Math.cos(rotRad), y: p.y + 0.01 * Math.sin(rotRad) }
          : { x: p.x, y: p.y };

        // Sample angles — LEFT side goes from (rot - angL) to rot; RIGHT side
        // goes from rot to (rot + angR). Each side independently samples + hits.
        function buildSide(angStart, angSpan, lenMax) {
          const nSamp = Math.max(8, Math.ceil((angSpan * 180 / Math.PI) / 3));
          const out = [];
          for (let k = 0; k <= nSamp; k++) {
            const frac = k / nSamp;
            const a = angStart + frac * angSpan;
            const hit = wallBarrier ? _raycastWall(apexM, a, lenMax, walls) : lenMax;
            out.push({ a, r: hit, frac });
          }
          return out;
        }
        const leftSide  = buildSide(rotRad - angLRad, angLRad, lenL);
        const rightSide = buildSide(rotRad,           angRRad, lenR);

        // Outline polygon: apex → left samples (aim-angL → aim) → right
        // samples (aim → aim+angR) → apex (auto-closed).
        const pts = [`${cx},${cy}`];
        for (const s of leftSide)  pts.push(`${mToPx(p.x + s.r * Math.cos(s.a))},${mToPx(p.y + s.r * Math.sin(s.a))}`);
        for (const s of rightSide) pts.push(`${mToPx(p.x + s.r * Math.cos(s.a))},${mToPx(p.y + s.r * Math.sin(s.a))}`);
        const outline = document.createElementNS(NS, 'polygon');
        outline.setAttribute('points', pts.join(' '));
        outline.setAttribute('fill', 'rgba(216,48,48,0.08)');
        outline.setAttribute('stroke', '#d83030');
        outline.setAttribute('stroke-width', 0.7);
        outline.setAttribute('stroke-dasharray', '4,3');
        g.appendChild(outline);

        // Dot field — one pass per side, each using its own length + samples.
        const stepM = 0.3;
        function drawDots(angStart, angSpan, lenMax, sideSamples) {
          const nSamp = sideSamples.length - 1;
          for (let r = stepM; r < lenMax; r += stepM) {
            const arcLen = r * (angSpan);
            const nSteps = Math.max(2, Math.round(arcLen / stepM));
            for (let i = 0; i <= nSteps; i++) {
              const frac = i / nSteps;
              const a = angStart + frac * angSpan;
              if (wallBarrier) {
                const idxF = frac * nSamp;
                const i0 = Math.floor(idxF), i1 = Math.min(i0 + 1, nSamp);
                const lerp = idxF - i0;
                const hit = sideSamples[i0].r * (1 - lerp) + sideSamples[i1].r * lerp;
                if (r > hit - 0.02) continue;
              }
              const dx = mToPx(p.x + r * Math.cos(a));
              const dy = mToPx(p.y + r * Math.sin(a));
              const d = document.createElementNS(NS, 'circle');
              d.setAttribute('cx', dx); d.setAttribute('cy', dy);
              d.setAttribute('r', 1.5);
              d.setAttribute('fill', '#ff8080');
              d.setAttribute('opacity', 0.65);
              g.appendChild(d);
            }
          }
        }
        drawDots(rotRad - angLRad, angLRad, lenL, leftSide);
        drawDots(rotRad,           angRRad, lenR, rightSide);
      }

      // Triangle icon — equilateral, 0.18 m side (half of prior 0.35 m), apex along rotation
      const sideM = 0.18;
      const altM = sideM * Math.sqrt(3) / 2;      // apex-to-base altitude
      const backM = altM * 2 / 3;                  // centroid-to-base
      const frontM = altM - backM;                 // centroid-to-apex
      const halfBaseM = sideM / 2;
      const rotRad = (Math.PI / 180) * (p.rotation || 0);
      const rot = (ox, oy) => ({
        x: cx + mToPx(ox) * Math.cos(rotRad) - mToPx(oy) * Math.sin(rotRad),
        y: cy + mToPx(ox) * Math.sin(rotRad) + mToPx(oy) * Math.cos(rotRad),
      });
      const apex = rot( frontM, 0);
      const bl   = rot(-backM, -halfBaseM);
      const br   = rot(-backM,  halfBaseM);
      const tri = document.createElementNS(NS, 'polygon');
      tri.setAttribute('points', `${apex.x},${apex.y} ${bl.x},${bl.y} ${br.x},${br.y}`);
      tri.setAttribute('fill', fill);
      tri.setAttribute('stroke', '#222');
      tri.setAttribute('stroke-width', p.id === selId ? 2 : 1);
      tri.setAttribute('style', 'cursor:pointer;');
      tri.dataset.devPlacementId = p.id;
      g.appendChild(tri);
      // Detection-direction indicator — short "nose" line extending from the
      // apex outward, same color as the triangle, so the user knows which way
      // the sensor is aimed when picking a rotation.
      const noseTip = rot(frontM + 0.15, 0);
      const nose = document.createElementNS(NS, 'line');
      nose.setAttribute('x1', apex.x); nose.setAttribute('y1', apex.y);
      nose.setAttribute('x2', noseTip.x); nose.setAttribute('y2', noseTip.y);
      nose.setAttribute('stroke', fill);
      nose.setAttribute('stroke-width', 1.5);
      nose.setAttribute('stroke-linecap', 'round');
      g.appendChild(nose);
      // Tiny dot at the far tip of the nose for extra clarity
      const noseDot = document.createElementNS(NS, 'circle');
      noseDot.setAttribute('cx', noseTip.x); noseDot.setAttribute('cy', noseTip.y);
      noseDot.setAttribute('r', 1.8);
      noseDot.setAttribute('fill', fill);
      noseDot.setAttribute('stroke', '#222');
      noseDot.setAttribute('stroke-width', 0.5);
      g.appendChild(noseDot);

      // Label (drag + hide, same UX as furniture labels)
      const lblText = (p.label && p.label.trim()) || p.device_name || p.device_id;
      const hidden = !!p.label_hidden;
      if (lblText && (!hidden || _showHiddenLabels)) {
        const lo = p.label_offset || {};
        const lbl = document.createElementNS(NS, 'text');
        lbl.setAttribute('x', mToPx(p.x + (lo.x || 0)));
        lbl.setAttribute('y', mToPx(p.y + (lo.y || 0)) - mToPx(0.28));
        lbl.setAttribute('font-size', '9');
        lbl.setAttribute('fill', '#333');
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('opacity', hidden ? '0.3' : (isEnabled ? '0.85' : '0.5'));
        lbl.setAttribute('style', 'cursor:move;user-select:none;pointer-events:all;');
        lbl.dataset.devLabelId = p.id;
        lbl.dataset.devLabelSlug = slug;
        lbl.textContent = lblText;
        g.appendChild(lbl);
      }
    }
  }

  // ── Device picker popover ──────────────────────────────────────────────────
  function aptDevicePickerOpen(ev, xM, yM) {
    if (!activeSlug || activeSlug === '_apartment') {
      setStatus('Pick an active room first (not Apartment view).');
      return;
    }
    // Only sensor-type placements (presence/motion/door_sensor) count as
    // "already placed" for this picker. Lights and parameter_labels reference
    // sensors but don't claim them — a sensor used as a parameter_label source
    // is still available to be placed as an actual sensor too.
    const placedIds = new Set(
      roomPlacements
        .filter(p => DEV_PLACEABLE_TYPES.has(p.device_type))
        .map(p => p.device_id)
    );
    const candidates = (_allDevices || []).filter(d =>
      DEV_PLACEABLE_TYPES.has(d.device_type) &&
      d.enabled !== false &&
      !placedIds.has(d.id)
    );
    if (!candidates.length) {
      setStatus('No unplaced presence / motion / door sensors available.');
      return;
    }
    const pop = document.getElementById('apt-device-picker');
    const sel = document.getElementById('apt-device-picker-sel');
    sel.innerHTML = '';
    for (const d of candidates) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name} (${d.device_type}${d.room ? ' · ' + d.room : ''})`;
      sel.appendChild(opt);
    }
    const rect = svg().getBoundingClientRect();
    pop.style.left = Math.min(rect.width - 230, Math.max(4, ev.clientX - rect.left)) + 'px';
    pop.style.top  = Math.min(rect.height - 120, Math.max(4, ev.clientY - rect.top))  + 'px';
    pop.style.display = '';
    _devicePicker = { slug: activeSlug, x_m: xM, y_m: yM };
  }
  window.aptDevicePickerCancel = function () {
    _devicePicker = null;
    document.getElementById('apt-device-picker').style.display = 'none';
    setStatus('');
  };
  window.aptDevicePickerConfirm = async function () {
    if (!_devicePicker) return;
    const { slug, x_m, y_m } = _devicePicker;
    const sel = document.getElementById('apt-device-picker-sel');
    const device_id = sel.value;
    if (!device_id) return aptDevicePickerCancel();
    // Default params depend on device type. Presence/motion get the cone
    // geometry; door sensors have no cone — empty params + `enabled:true`
    // (implicit) so the render branch picks the square form.
    const pickedDev = (_allDevices || []).find(d => d.id === device_id) || {};
    const isDoor = DEV_DOOR_TYPES.has(pickedDev.device_type);
    const body = {
      slug, device_id,
      x: x_m, y: y_m,
      rotation: 0,
      params: isDoor ? {} : { beam_angle_deg: 90, beam_length_m: 4.0, hold_s: 120 },
    };
    try {
      const r = await fetch('/api/room-device-placements', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const row = await r.json();
      // Merge in device name + state if available
      const dev = (_allDevices || []).find(d => d.id === device_id) || {};
      row.device_name = dev.name; row.last_state = dev.last_state; row.last_seen = dev.last_seen;
      roomPlacements.push(row);
      selectedId = row.id;
      pushUndo({ type: 'dev_create', row: { ...row } });
      aptDevicePickerCancel();
      // Auto-switch to Select so the user can immediately grab / edit the new one.
      if (window.aptSetTool) window.aptSetTool('select');
      draw(); refreshEditPanel();
      setStatus(`Placed ${row.device_name || row.device_id}.`);
    } catch (e) {
      setStatus('Place failed: ' + e.message);
    }
  };

  // ── V7 Fixture-specific light icons ────────────────────────────────────────
  // Each icon is a compact glyph (~12–14 px) distinct enough to tell fixture
  // types apart at a glance. `placementId` goes on the primary pointer-
  // receiving element so Select / drag hit-tests work regardless of fixture.
  function _drawLightIcon(g, cx, cy, fixture, bodyFill, strokeFill, strokeW, rotDeg, rotRad, placementId) {
    const hit = (el) => { el.dataset.devPlacementId = placementId; el.setAttribute('style', 'cursor:pointer;'); return el; };
    const mk = (tag) => document.createElementNS(NS, tag);
    const common = (el, extras = {}) => {
      el.setAttribute('fill', bodyFill);
      el.setAttribute('stroke', strokeFill);
      el.setAttribute('stroke-width', strokeW);
      for (const [k, v] of Object.entries(extras)) el.setAttribute(k, v);
      return el;
    };
    switch (fixture) {
      case 'spot': {
        // Triangle pointing along rotation (aim = downlight beam direction).
        // Apex forward, base behind, small equilateral footprint.
        const frontPx = 7, backPx = 5, halfBase = 5;
        const rot = (ox, oy) => ({
          x: cx + ox * Math.cos(rotRad) - oy * Math.sin(rotRad),
          y: cy + ox * Math.sin(rotRad) + oy * Math.cos(rotRad),
        });
        const apex = rot(frontPx, 0);
        const bl = rot(-backPx, -halfBase), br = rot(-backPx, halfBase);
        const tri = common(mk('polygon'));
        tri.setAttribute('points', `${apex.x},${apex.y} ${bl.x},${bl.y} ${br.x},${br.y}`);
        g.appendChild(hit(tri));
        break;
      }
      case 'ceiling': {
        // Filled disc, no stem — recessed ceiling light.
        const disc = common(mk('circle'), { cx, cy, r: 6 });
        g.appendChild(hit(disc));
        // Inner ring for visual distinction from a bare bulb
        const inner = mk('circle');
        inner.setAttribute('cx', cx); inner.setAttribute('cy', cy); inner.setAttribute('r', 2.5);
        inner.setAttribute('fill', 'none');
        inner.setAttribute('stroke', strokeFill);
        inner.setAttribute('stroke-width', 0.8);
        inner.setAttribute('pointer-events', 'none');
        g.appendChild(inner);
        break;
      }
      case 'pendant': {
        // Hanging disc + short cord going up.
        const cord = mk('line');
        cord.setAttribute('x1', cx); cord.setAttribute('y1', cy - 10);
        cord.setAttribute('x2', cx); cord.setAttribute('y2', cy - 5);
        cord.setAttribute('stroke', strokeFill);
        cord.setAttribute('stroke-width', 1);
        cord.setAttribute('pointer-events', 'none');
        g.appendChild(cord);
        const disc = common(mk('circle'), { cx, cy, r: 5.5 });
        g.appendChild(hit(disc));
        break;
      }
      case 'chandelier': {
        // Central disc + 3 satellite dots (branched).
        const main = common(mk('circle'), { cx, cy, r: 4 });
        g.appendChild(hit(main));
        const satR = 2, d = 7;
        const sats = [
          { x: cx,          y: cy - d },        // top
          { x: cx - d * 0.87, y: cy + d * 0.5 }, // bottom-left
          { x: cx + d * 0.87, y: cy + d * 0.5 }, // bottom-right
        ];
        for (const s of sats) {
          const arm = mk('line');
          arm.setAttribute('x1', cx); arm.setAttribute('y1', cy);
          arm.setAttribute('x2', s.x); arm.setAttribute('y2', s.y);
          arm.setAttribute('stroke', strokeFill);
          arm.setAttribute('stroke-width', 0.8);
          arm.setAttribute('pointer-events', 'none');
          g.appendChild(arm);
          const dot = common(mk('circle'), { cx: s.x, cy: s.y, r: satR });
          dot.setAttribute('stroke-width', 1);
          dot.setAttribute('pointer-events', 'none');
          g.appendChild(dot);
        }
        break;
      }
      case 'lamp': {
        // Disc on top of a trapezoidal base (table-lamp silhouette).
        const shade = mk('polygon');
        // Base trapezoid with top narrower than bottom
        const baseTop = cy + 4, baseBot = cy + 9;
        shade.setAttribute('points', `${cx - 4},${baseTop} ${cx + 4},${baseTop} ${cx + 6},${baseBot} ${cx - 6},${baseBot}`);
        shade.setAttribute('fill', bodyFill);
        shade.setAttribute('stroke', strokeFill);
        shade.setAttribute('stroke-width', strokeW);
        g.appendChild(hit(shade));
        const bulb = common(mk('circle'), { cx, cy: cy - 2, r: 4 });
        g.appendChild(bulb);
        break;
      }
      case 'sconce': {
        // Half-disc attached to a short wall bar, oriented so the half-disc
        // faces the rotation direction and the bar is behind it.
        const dirX = Math.cos(rotRad), dirY = Math.sin(rotRad);
        const nX = -dirY, nY = dirX;
        const baseX = cx - dirX * 2, baseY = cy - dirY * 2;
        // Wall bar perpendicular to aim, short
        const bar = mk('line');
        bar.setAttribute('x1', baseX + nX * 6); bar.setAttribute('y1', baseY + nY * 6);
        bar.setAttribute('x2', baseX - nX * 6); bar.setAttribute('y2', baseY - nY * 6);
        bar.setAttribute('stroke', strokeFill);
        bar.setAttribute('stroke-width', 1.5);
        bar.setAttribute('stroke-linecap', 'round');
        bar.setAttribute('pointer-events', 'none');
        g.appendChild(bar);
        // Half-disc (semicircle) via SVG path with arc
        const r = 5;
        const p1x = baseX + nX * r, p1y = baseY + nY * r;
        const p2x = baseX - nX * r, p2y = baseY - nY * r;
        // Move to p1, arc to p2 forward (bulge in rotation direction), close
        const half = mk('path');
        const sweep = 1; // arc outward (into aim direction)
        half.setAttribute('d', `M ${p1x} ${p1y} A ${r} ${r} 0 0 ${sweep} ${p2x} ${p2y} Z`);
        half.setAttribute('fill', bodyFill);
        half.setAttribute('stroke', strokeFill);
        half.setAttribute('stroke-width', strokeW);
        g.appendChild(hit(half));
        break;
      }
      case 'strip': {
        // Long thin pill oriented along rotation.
        const lenPx = 18, wPx = 4, hPx = wPx / 2;
        const dirX = Math.cos(rotRad), dirY = Math.sin(rotRad);
        const nX = -dirY, nY = dirX;
        const half = lenPx / 2;
        const a = { x: cx - dirX * half, y: cy - dirY * half };
        const b = { x: cx + dirX * half, y: cy + dirY * half };
        // Two side-corner pairs via normal offset = hPx
        const p1 = { x: a.x + nX * hPx, y: a.y + nY * hPx };
        const p2 = { x: b.x + nX * hPx, y: b.y + nY * hPx };
        const p3 = { x: b.x - nX * hPx, y: b.y - nY * hPx };
        const p4 = { x: a.x - nX * hPx, y: a.y - nY * hPx };
        const poly = mk('polygon');
        poly.setAttribute('points', `${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y} ${p4.x},${p4.y}`);
        poly.setAttribute('fill', bodyFill);
        poly.setAttribute('stroke', strokeFill);
        poly.setAttribute('stroke-width', strokeW);
        poly.setAttribute('stroke-linejoin', 'round');
        g.appendChild(hit(poly));
        break;
      }
      default: {
        // Fallback = bulb with stem (legacy).
        const bulb = common(mk('circle'), { cx, cy, r: 6 });
        g.appendChild(hit(bulb));
        const stem = mk('line');
        stem.setAttribute('x1', cx - 2.5); stem.setAttribute('y1', cy + 6.5);
        stem.setAttribute('x2', cx + 2.5); stem.setAttribute('y2', cy + 6.5);
        stem.setAttribute('stroke', strokeFill);
        stem.setAttribute('stroke-width', 1.5);
        stem.setAttribute('stroke-linecap', 'round');
        stem.setAttribute('pointer-events', 'none');
        g.appendChild(stem);
      }
    }
  }

  // ── V7 Light renderer ──────────────────────────────────────────────────────
  // Icon = small bulb (circle with a stem). Spread shape:
  //   spot      → cone (like sensor, but yellow)
  //   mid/high/ambient → soft radius circle; ambient stroke dashed.
  // Active room renders icon + spread + label. Non-active rooms render
  // icon + label only (parity with V6 zone non-active treatment).
  function _renderLight(g, p, cx, cy, slug, selId) {
    const isActive = slug === activeSlug;
    const pr = p.params || {};
    const intensity = pr.intensity || 'mid';
    const fixture = pr.fixture_type || 'lamp';
    const state = _lightState(p);
    const fill = LIGHT_COLORS[state];
    // Hoist rotation values to the top — the strip spread branch references
    // rotRad before the later icon-drawing block re-declared it, producing a
    // TDZ crash on strip fixtures.
    const rotDeg = (p.rotation || 0);
    const rotRad = (Math.PI / 180) * rotDeg;

    // Spread — only visible when the light is ON and we're on the active room.
    // No stroke / border (user wants only yellow glow). Opacity scales by
    // intensity class so at-a-glance the user can tell how bright each light
    // is: high > mid > ambient. Spot uses its cone (with its own opacity).
    // Strip fixtures emit along their length — rendered as a rotated rounded
    // rectangle rather than a point-sourced circle.
    const YELLOW_BY_INTENSITY = {
      high:    0.28,
      mid:     0.16,
      ambient: 0.08,
      spot:    0.22,  // used by cone fill
    };
    // Spread is visible in every room (not just active) so the ON/OFF state
    // can be read at a glance in the apartment view.
    if (state === 'on') {
      const alpha = YELLOW_BY_INTENSITY[intensity] ?? 0.16;
      const yellow = `rgba(244,180,0,${alpha})`;
      // Spread shape is FIXTURE-driven (not intensity-driven). Intensity only
      // controls the yellow opacity. spot = cone. strip = 180° half-rect along
      // the strip axis, emitted on the forward-normal side only (real LED
      // strips emit outward, not through the wall behind them). All other
      // fixtures = omni radius circle.
      if (fixture === 'spot') {
        const ang = (pr.beam_angle_deg != null ? Number(pr.beam_angle_deg) : 30);
        const len = (pr.beam_length_m  != null ? Number(pr.beam_length_m)  : 2.5);
        if (ang > 0 && len > 0) {
          const halfRad = (Math.PI / 180) * (ang / 2);
          const nSamp = Math.max(8, Math.ceil(ang / 3));
          const pts = [`${cx},${cy}`];
          for (let k = 0; k <= nSamp; k++) {
            const a = (rotRad - halfRad) + (k / nSamp) * (halfRad * 2);
            pts.push(`${mToPx(p.x + len * Math.cos(a))},${mToPx(p.y + len * Math.sin(a))}`);
          }
          const poly = document.createElementNS(NS, 'polygon');
          poly.setAttribute('points', pts.join(' '));
          poly.setAttribute('fill', yellow);
          poly.setAttribute('stroke', 'none');
          poly.setAttribute('pointer-events', 'none');
          g.appendChild(poly);
        }
      } else if (fixture === 'strip') {
        // 180° emission: rectangle from strip axis outward on the forward-
        // normal side only (length along rotation, width = strip_width_m).
        const width = (pr.strip_width_m != null ? Number(pr.strip_width_m)
                        : (pr.radius_m != null ? Number(pr.radius_m) : 1.5));
        const stripLen = (pr.strip_length_m != null ? Number(pr.strip_length_m) : 2.0);
        if (width > 0 && stripLen > 0) {
          const dirX = Math.cos(rotRad), dirY = Math.sin(rotRad);
          const nX = -dirY, nY = dirX;
          const halfL = stripLen / 2;
          // 4 corners: a and b are on the strip axis; a' and b' are projected
          // outward on the positive-normal side only (one-sided emission).
          const a  = { x: p.x - dirX * halfL,          y: p.y - dirY * halfL };
          const b  = { x: p.x + dirX * halfL,          y: p.y + dirY * halfL };
          const ap = { x: a.x + nX * width,            y: a.y + nY * width };
          const bp = { x: b.x + nX * width,            y: b.y + nY * width };
          const poly = document.createElementNS(NS, 'polygon');
          poly.setAttribute('points', [a, b, bp, ap].map(c => `${mToPx(c.x)},${mToPx(c.y)}`).join(' '));
          poly.setAttribute('fill', yellow);
          poly.setAttribute('stroke', 'none');
          poly.setAttribute('stroke-linejoin', 'round');
          poly.setAttribute('pointer-events', 'none');
          g.appendChild(poly);
        }
      } else {
        const defaultR = intensity === 'high' ? 4.0 : (intensity === 'ambient' ? 3.0 : 1.5);
        const radius = (pr.radius_m != null ? Number(pr.radius_m) : defaultR);
        if (radius > 0) {
          const circ = document.createElementNS(NS, 'circle');
          circ.setAttribute('cx', cx); circ.setAttribute('cy', cy);
          circ.setAttribute('r', mToPx(radius));
          circ.setAttribute('fill', yellow);
          circ.setAttribute('stroke', 'none');
          circ.setAttribute('pointer-events', 'none');
          g.appendChild(circ);
        }
      }
    }

    // V7 fixture-specific icons. Each has a distinct glyph so the user can
    // tell at a glance what kind of light is there. One element per icon
    // carries dataset.devPlacementId for click/select hit-testing.
    const sw = p.id === selId ? 2.5 : 1.5;
    const on = (state === 'on');
    const body = on ? fill : '#fff';
    _drawLightIcon(g, cx, cy, fixture, body, fill, sw, rotDeg, rotRad, p.id);

    // Label — placed below bulb, same drag/hide UX as sensors.
    const lblText = (p.label && p.label.trim()) || p.device_name || fixture;
    const hidden = !!p.label_hidden;
    if (lblText && (!hidden || _showHiddenLabels)) {
      const lo = p.label_offset || {};
      const lbl = document.createElementNS(NS, 'text');
      lbl.setAttribute('x', mToPx(p.x + (lo.x || 0)));
      lbl.setAttribute('y', mToPx(p.y + (lo.y || 0)) + mToPx(0.28));
      lbl.setAttribute('font-size', '9');
      lbl.setAttribute('fill', '#555');
      lbl.setAttribute('text-anchor', 'middle');
      lbl.setAttribute('opacity', hidden ? '0.3' : (state === 'on' ? '0.9' : '0.7'));
      lbl.setAttribute('style', 'cursor:move;user-select:none;pointer-events:all;');
      lbl.dataset.devLabelId = p.id;
      lbl.dataset.devLabelSlug = slug;
      lbl.textContent = lblText;
      g.appendChild(lbl);
    }
  }

  // ── V10 Parameter-label rendering ──────────────────────────────────────────
  // Cache of source-state by id. Built fresh in _renderParamLabel from devices
  // since `roomPlacements` row only stores last_state for device_id (the first
  // source); the OTHER sources' last_state must come from _allDevices.
  function _paramSourceState(srcId) {
    // Try roomPlacements first (the placement may have been polled already)
    for (const pp of roomPlacements) {
      if (pp.device_id === srcId && pp.last_state) return pp.last_state;
    }
    const dev = (_allDevices || []).find(d => d.id === srcId);
    return (dev && dev.last_state) || null;
  }

  // sprintf-like format for a single number with %.Nf or %d. Falls back to
  // String(n) on any unrecognised format.
  function _fmtNumber(n, fmt) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (!fmt) return n.toString();
    const m = fmt.match(/%\.(\d+)f/);
    if (m) return n.toFixed(parseInt(m[1], 10));
    if (fmt === '%d') return Math.round(n).toString();
    return n.toString();
  }

  function _renderParamLabel(g, p, cx, cy, slug, selId) {
    const params = p.params || {};
    const dpsField = params.dps_field;
    const sources = Array.isArray(params.sources) ? params.sources : [];
    const agg = params.agg || 'avg';
    const fontSize = parseInt(params.font_size, 10) || 14;
    const color = params.color || '#333';
    const fmt  = params.format || '%.1f';
    const unit = params.unit   || '';
    const lo = p.label_offset || { x: 0, y: 0 };
    const hidden = !!p.label_hidden;

    // Aggregate the live values from all sources that have the field.
    let displayText = '—';
    if (dpsField && sources.length) {
      const values = [];
      for (const sid of sources) {
        const ls = _paramSourceState(sid);
        if (!ls) continue;
        const raw = ls[dpsField];
        const num = typeof raw === 'number' ? raw : parseFloat(raw);
        if (typeof num === 'number' && isFinite(num)) values.push(num);
      }
      if (values.length) {
        let val;
        if      (agg === 'max')  val = Math.max(...values);
        else if (agg === 'min')  val = Math.min(...values);
        else if (agg === 'last') val = values[values.length - 1];
        else                     val = values.reduce((a, b) => a + b, 0) / values.length; // avg
        displayText = (p.label || '') + _fmtNumber(val, fmt) + (unit || '');
      }
    }

    // Selected: bold + outline; otherwise normal weight.
    const isSel = (p.id === selId);

    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', cx + mToPx(lo.x || 0));
    t.setAttribute('y', cy + mToPx(lo.y || 0));
    t.setAttribute('font-size', String(fontSize));
    t.setAttribute('fill', color);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'middle');
    t.setAttribute('font-weight', isSel ? '700' : '500');
    t.setAttribute('opacity', hidden ? '0.3' : '1');
    t.setAttribute('style', 'cursor:pointer;user-select:none;pointer-events:all;' + (isSel ? 'paint-order:stroke;stroke:#27ae60;stroke-width:1.5;' : ''));
    t.dataset.devPlacementId = p.id;       // selectable via existing handlers
    t.dataset.devLabelId   = p.id;          // draggable via existing handlers
    t.dataset.devLabelSlug = slug;
    t.textContent = displayText;
    g.appendChild(t);
  }

  // ── V7 Light picker ────────────────────────────────────────────────────────
  // Controller candidates: every enabled switch / circuit_breaker / light — from
  // ANY room (cross-room supported, e.g. Bedroom Balcony Switch DPS 2 lights My
  // Bathroom). Controller's dps_labels populates the channel sub-dropdown.
  const LIGHT_CONTROLLER_TYPES = new Set(['switch', 'circuit_breaker', 'light']);
  const LIGHT_INTENSITY_DEFAULTS = {
    spot:    { beam_angle_deg: 30, beam_length_m: 2.5 },
    mid:     { radius_m: 1.5 },
    high:    { radius_m: 4.0 },
    ambient: { radius_m: 3.0 },
  };

  function _lightControllerCandidates() {
    return (_allDevices || [])
      .filter(d => LIGHT_CONTROLLER_TYPES.has(d.device_type) && d.enabled !== false)
      .slice()
      .sort((a, b) => (a.room || '').localeCompare(b.room || '') || a.name.localeCompare(b.name));
  }

  function _populateLightControllerDropdown(selectEl, preselectDeviceId) {
    selectEl.innerHTML = '';
    const grouped = {};
    for (const d of _lightControllerCandidates()) {
      const room = d.room || '—';
      (grouped[room] ||= []).push(d);
    }
    for (const room of Object.keys(grouped).sort()) {
      const og = document.createElement('optgroup');
      og.label = room;
      for (const d of grouped[room]) {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = `${d.name} (${d.device_type})`;
        if (d.id === preselectDeviceId) opt.selected = true;
        og.appendChild(opt);
      }
      selectEl.appendChild(og);
    }
  }

  function _populateLightDpsDropdown(dpsSelect, deviceId, preselectKey) {
    dpsSelect.innerHTML = '';
    const dev = (_allDevices || []).find(d => d.id === deviceId);
    const labels = (dev && dev.dps_labels) || {};
    const keys = Object.keys(labels);
    if (!keys.length) {
      // Direct light entity or switch without labelled channels — single "direct" option
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = dev && dev.device_type === 'light' ? 'direct (no channel)' : 'channel 1 (default)';
      dpsSelect.appendChild(opt);
      return;
    }
    for (const k of keys) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = `${k}: ${labels[k]}`;
      if (k === preselectKey) opt.selected = true;
      dpsSelect.appendChild(opt);
    }
  }

  function aptLightPickerOpen(ev, xM, yM) {
    if (!activeSlug || activeSlug === '_apartment') {
      setStatus('Pick an active room first (not Apartment view).');
      return;
    }
    if (!_lightControllerCandidates().length) {
      setStatus('No switch / light devices found to use as controller.');
      return;
    }
    const pop = document.getElementById('apt-light-picker');
    const ctrl = document.getElementById('apt-light-picker-controller');
    const dps  = document.getElementById('apt-light-picker-dps');
    _populateLightControllerDropdown(ctrl);
    _populateLightDpsDropdown(dps, ctrl.value);
    document.getElementById('apt-light-picker-fixture').value = 'ceiling';
    document.getElementById('apt-light-picker-intensity').value = 'high';
    const rect = svg().getBoundingClientRect();
    pop.style.left = Math.min(rect.width - 280, Math.max(4, ev.clientX - rect.left)) + 'px';
    pop.style.top  = Math.min(rect.height - 220, Math.max(4, ev.clientY - rect.top))  + 'px';
    pop.style.display = '';
    _lightPicker = { slug: activeSlug, x_m: xM, y_m: yM };
  }
  window.aptLightPickerCancel = function () {
    _lightPicker = null;
    const p = document.getElementById('apt-light-picker');
    if (p) p.style.display = 'none';
    setStatus('');
  };
  window.aptLightPickerControllerChanged = function () {
    const ctrl = document.getElementById('apt-light-picker-controller');
    const dps  = document.getElementById('apt-light-picker-dps');
    if (ctrl && dps) _populateLightDpsDropdown(dps, ctrl.value);
  };
  window.aptLightPickerConfirm = async function () {
    if (!_lightPicker) return;
    const { slug, x_m, y_m } = _lightPicker;
    const controller_device_id = document.getElementById('apt-light-picker-controller').value;
    const rawDps = document.getElementById('apt-light-picker-dps').value;
    const controller_dps_key = rawDps === '' ? null : rawDps;
    const fixture_type = document.getElementById('apt-light-picker-fixture').value;
    const intensity    = document.getElementById('apt-light-picker-intensity').value;
    if (!controller_device_id) { aptLightPickerCancel(); return; }
    const defaults = LIGHT_INTENSITY_DEFAULTS[intensity] || {};
    const params = {
      fixture_type,
      intensity,
      controller_device_id,
      controller_dps_key,
      enabled: true,
      ...defaults,
    };
    const body = {
      slug,
      device_id: controller_device_id,    // poll path: controller's last_state
      device_type: 'light',               // overrides devices.device_type on the placement row
      x: x_m, y: y_m,
      rotation: 0,
      params,
    };
    try {
      const r = await fetch('/api/room-device-placements', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const row = await r.json();
      const dev = (_allDevices || []).find(d => d.id === controller_device_id) || {};
      row.device_name = dev.name; row.last_state = dev.last_state; row.last_seen = dev.last_seen;
      roomPlacements.push(row);
      selectedId = row.id;
      pushUndo({ type: 'dev_create', row: { ...row } });
      aptLightPickerCancel();
      if (window.aptSetTool) window.aptSetTool('select');
      draw(); refreshEditPanel();
      renderZoneInformationTable();
      setStatus(`Placed light via ${dev.name || controller_device_id}${controller_dps_key != null ? ':' + controller_dps_key : ''}.`);
    } catch (e) {
      setStatus('Place failed: ' + e.message);
    }
  };

  // ── V10 Parameters ─────────────────────────────────────────────────────────
  // Sub-rooms that are part of an open-plan parent room. Devices tagged with
  // these `devices.room` values are physically inside the parent's drawn
  // layout, even though they don't have their own `room_layouts.<slug>`.
  // Mirrors people_home.py's DEFAULT_MANUAL_SUBROOM_MERGE for consistency.
  const SUBROOM_FOLD = {
    'Kitchen':     'living-room',
    'Dining Room': 'living-room',
  };

  // Defaults per parameter type — pre-fill the picker when the user changes
  // the type dropdown.
  const PARAM_DEFAULTS = {
    temperature: { agg: 'avg', color: '#c0392b', format: '%.1f', unit: '°C',  font_size: 14 },
    humidity:    { agg: 'avg', color: '#2980b9', format: '%.0f', unit: '%',   font_size: 14 },
    illuminance: { agg: 'max', color: '#e67e22', format: '%.0f', unit: ' lx', font_size: 14 },
  };

  // ALL sensors whose `last_state` exposes `dpsField`. Sensors in the active
  // room are returned first (pre-checked in the UI); cross-room sensors come
  // after (door sensors typically tagged to one room are useful as the other
  // side's temperature source — e.g. Balcony Door is in the Living Room ↔
  // Balcony wall, so it's a valid Living Room temperature source too).
  function _paramSourceCandidates(dpsField) {
    const inRoom = [];
    const other  = [];
    for (const dev of (_allDevices || [])) {
      const ls = dev.last_state || {};
      if (ls[dpsField] === undefined || ls[dpsField] === null) continue;
      const devSlug = (dev.room || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      // Open-plan fold: Kitchen / Dining Room sensors render INSIDE the
      // Living Room layout, so they belong to the parent room for picker UX.
      const foldedSlug = SUBROOM_FOLD[dev.room || ''] || devSlug;
      if (activeSlug && (devSlug === activeSlug || foldedSlug === activeSlug)) inRoom.push(dev);
      else other.push(dev);
    }
    return { inRoom, other };
  }

  function _renderParamSources(dpsField) {
    const box = document.getElementById('apt-param-picker-sources');
    if (!box) return;
    const { inRoom, other } = _paramSourceCandidates(dpsField);
    if (!inRoom.length && !other.length) {
      box.innerHTML = '<div style="color:#999;padding:4px;">No sensors expose <code>' + dpsField + '</code>.</div>';
      return;
    }
    const renderOne = (d, checked) =>
      `<label style="display:flex;align-items:center;gap:5px;padding:2px 0;cursor:pointer;">
        <input type="checkbox" class="apt-param-source" value="${d.id}"${checked ? ' checked' : ''}>
        <span><strong>${d.name}</strong> <span style="color:#888;">(${d.room || '—'} · ${d.last_state[dpsField]})</span></span>
      </label>`;
    let html = '';
    if (inRoom.length) {
      html += '<div style="font-size:0.7rem;color:#666;font-weight:600;padding:2px 0 2px 0;">In this room (pre-checked):</div>';
      html += inRoom.map(d => renderOne(d, true)).join('');
    }
    if (other.length) {
      html += '<div style="font-size:0.7rem;color:#666;font-weight:600;padding:6px 0 2px 0;">Other rooms (door sensors etc.):</div>';
      html += other.map(d => renderOne(d, false)).join('');
    }
    box.innerHTML = html;
  }

  function aptParamPickerOpen(ev, xM, yM) {
    if (!activeSlug || activeSlug === '_apartment') {
      setStatus('Pick an active room first (not Apartment view).');
      return;
    }
    const pop = document.getElementById('apt-param-picker');
    if (!pop) { setStatus('Picker UI missing.'); return; }
    // Default the picker to Temperature with Aeotec sensors pre-checked.
    document.getElementById('apt-param-picker-type').value = 'temperature';
    const defs = PARAM_DEFAULTS.temperature;
    document.getElementById('apt-param-picker-agg').value = defs.agg;
    document.getElementById('apt-param-picker-font').value = defs.font_size;
    document.getElementById('apt-param-picker-color').value = defs.color;
    _renderParamSources('temperature');
    const rect = svg().getBoundingClientRect();
    pop.style.left = Math.min(rect.width  - 300, Math.max(4, ev.clientX - rect.left)) + 'px';
    pop.style.top  = Math.min(rect.height - 300, Math.max(4, ev.clientY - rect.top))  + 'px';
    pop.style.display = '';
    _paramPicker = { slug: activeSlug, x_m: xM, y_m: yM };
  }

  window.aptParamPickerCancel = function () {
    _paramPicker = null;
    const p = document.getElementById('apt-param-picker');
    if (p) p.style.display = 'none';
    setStatus('');
  };

  window.aptParamPickerTypeChanged = function () {
    const dpsField = document.getElementById('apt-param-picker-type').value;
    const defs = PARAM_DEFAULTS[dpsField] || PARAM_DEFAULTS.temperature;
    document.getElementById('apt-param-picker-agg').value = defs.agg;
    document.getElementById('apt-param-picker-font').value = defs.font_size;
    document.getElementById('apt-param-picker-color').value = defs.color;
    _renderParamSources(dpsField);
  };

  window.aptParamPickerConfirm = async function () {
    if (!_paramPicker) return;
    const { slug, x_m, y_m } = _paramPicker;
    const dpsField  = document.getElementById('apt-param-picker-type').value;
    const agg       = document.getElementById('apt-param-picker-agg').value;
    const font_size = parseInt(document.getElementById('apt-param-picker-font').value, 10) || 14;
    const color     = document.getElementById('apt-param-picker-color').value || '#333';
    const sources   = Array.from(document.querySelectorAll('.apt-param-source:checked')).map(cb => cb.value);
    if (sources.length === 0) { setStatus('Select at least one source sensor.'); return; }
    const defs = PARAM_DEFAULTS[dpsField] || {};
    const params = {
      dps_field: dpsField,
      sources,
      agg,
      font_size,
      color,
      format: defs.format || '%.1f',
      unit:   defs.unit   || '',
    };
    const body = {
      slug,
      device_id: sources[0],            // poll path: first source's last_state
      device_type: 'parameter_label',
      x: x_m, y: y_m,
      rotation: 0,
      params,
    };
    try {
      const r = await fetch('/api/room-device-placements', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const row = await r.json();
      const dev = (_allDevices || []).find(d => d.id === sources[0]) || {};
      row.device_name = dev.name; row.last_state = dev.last_state; row.last_seen = dev.last_seen;
      roomPlacements.push(row);
      selectedId = row.id;
      pushUndo({ type: 'dev_create', row: { ...row } });
      aptParamPickerCancel();
      if (window.aptSetTool) window.aptSetTool('select');
      draw(); refreshEditPanel();
      setStatus(`Placed ${dpsField} label (${sources.length} source${sources.length > 1 ? 's' : ''}, agg=${agg}).`);
    } catch (e) {
      setStatus('Place failed: ' + e.message);
    }
  };

  // ── Device state polling (5s) ──────────────────────────────────────────────
  // For lights the controller may be a different device than `device_id`
  // (e.g., a switch drives multiple light placements). Use
  // `params.controller_device_id` when present — falls back to device_id.
  function _pollSourceId(p) {
    if (p.device_type === 'light') {
      const cid = (p.params || {}).controller_device_id;
      return cid || p.device_id;
    }
    return p.device_id;
  }

  function _startStatePolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(async () => {
      if (!roomPlacements.length) return;
      const idSet = new Set(roomPlacements.map(_pollSourceId).filter(Boolean));
      const ids = [...idSet].join(',');
      try {
        const r = await fetch('/api/devices/states?ids=' + encodeURIComponent(ids));
        const states = await r.json();
        const byId = {};
        for (const s of states) byId[s.id] = s;
        let changed = false;
        for (const p of roomPlacements) {
          const s = byId[_pollSourceId(p)];
          if (!s) continue;
          const prevState = p.device_type === 'light' ? _lightState(p) : _devState(p);
          p.last_state = s.last_state;
          p.last_seen = s.last_seen;
          const nextState = p.device_type === 'light' ? _lightState(p) : _devState(p);
          if (prevState !== nextState) changed = true;
        }
        if (changed) draw();
      } catch (e) { /* silent */ }
    }, 5000);
  }

  // Save room_dims for undrawn rooms + height_m for drawn rooms.
  window.aptSavePassageDims = async function () {
    // 1. Undrawn rooms → /api/room-dims
    const body = {};
    for (const [slug, d] of Object.entries(roomDims)) {
      if (!d) continue;
      const lay = allRooms[slug];
      if (lay && (lay.walls || []).length > 0) continue; // drawn — height saved separately
      const out = {};
      if (d.w > 0) out.w = d.w;
      if (d.l > 0) out.l = d.l;
      if (d.h > 0) out.h = d.h;
      if (Object.keys(out).length) body[slug] = out;
    }
    try {
      const r = await fetch('/api/room-dims', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      // 2. Drawn rooms with changed height → per-layout POST
      let heightSaves = 0;
      const proms = [];
      for (const [sl, lay] of Object.entries(allRooms)) {
        if (!lay || !lay._height_dirty) continue;
        heightSaves++;
        proms.push(fetch('/api/room-layouts/' + sl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ height_m: lay.height_m ?? null }),
        }).then(() => { delete lay._height_dirty; }).catch(() => {}));
      }
      await Promise.all(proms);
      const total = (j.saved || 0) + heightSaves;
      setStatus(`Saved room info (${total} update${total === 1 ? '' : 's'}).`);
    } catch (e) {
      setStatus('Save failed: ' + e.message);
    }
  };

  // Rebuild the "Active room" dropdown. Passage rooms (divider/door targets
  // without their own walls) appear disabled — they can't be drawn separately.
  function rebuildActiveRoomDropdown() {
    const sel = document.getElementById('apt-active-room');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    const aptOpt = document.createElement('option');
    aptOpt.value = '_apartment';
    aptOpt.textContent = '— Apartment (all rooms) —';
    sel.appendChild(aptOpt);
    const dts = getDividerTargetSlugs();
    for (const r of roomSlugs) {
      const opt = document.createElement('option');
      opt.value = r.slug;
      const layout = allRooms[r.slug];
      const hasWalls = !!(layout && (layout.walls || []).length > 0);
      const isPassage = dts.has(r.slug) && !hasWalls;
      if (isPassage) {
        opt.textContent = r.name + ' (passage)';
        opt.disabled = true;
      } else {
        opt.textContent = r.name + (hasWalls ? '' : ' (empty)');
      }
      sel.appendChild(opt);
    }
    if (prev) sel.value = prev;
  }

  // ── Room switching ─────────────────────────────────────────────────────────
  window.aptSetActiveRoom = function (slug) {
    // Passage rooms (divider/door targets with no walls) are not drawable —
    // they're part of their parent room's open-plan space.
    if (slug !== '_apartment' && isPassageOnly(slug)) {
      const nameObj = roomSlugs.find(r => r.slug === slug);
      setStatus(`${nameObj ? nameObj.name : slug} is a passage room — drawn via the divider in its parent room. Not independently drawable.`);
      const sel = document.getElementById('apt-active-room');
      if (sel && activeSlug) sel.value = activeSlug;
      return;
    }
    // Save outgoing room's view W/L into memory
    if (activeSlug && activeSlug !== slug && activeSlug !== '_apartment' && allRooms[activeSlug]) {
      allRooms[activeSlug].view_w = parseFloat(document.getElementById('apt-canvas-w').value) || null;
      allRooms[activeSlug].view_h = parseFloat(document.getElementById('apt-canvas-h').value) || null;
    }

    activeSlug = slug;
    pending = null; pendingWall = null; selectedId = null;
    // V6: clear zone-editing state — different room has its own grid + zones.
    _zoneSel = []; _zoneEditId = null;
    undoStack = [];

    // Set visibility: Apartment = all rooms ON; single room = only that room ON
    if (!aptConfig.layer_visibility) aptConfig.layer_visibility = {};
    if (slug === '_apartment') {
      for (const sl of Object.keys(allRooms)) aptConfig.layer_visibility[sl] = true;
    } else {
      for (const sl of Object.keys(allRooms)) aptConfig.layer_visibility[sl] = (sl === slug);
    }
    try { localStorage.setItem('apt_layer_vis', JSON.stringify(aptConfig.layer_visibility)); } catch (e) {}
    buildLayers();

    if (slug === '_apartment') {
      // Apartment view: all rooms visible, no editing
      const saved = JSON.parse(localStorage.getItem('apt_wl__apartment') || 'null');
      document.getElementById('apt-canvas-w').value = (saved && saved.w) || 20;
      document.getElementById('apt-canvas-h').value = (saved && saved.h) || 15;
      document.getElementById('apt-cell-m').value = '0.5';
      draw();
      refreshEditPanel();
      setStatus('Apartment view — all rooms. Select a specific room to edit.');
    } else {
      // Single room view
      if (!allRooms[slug]) {
        allRooms[slug] = {
          walls: [], windows: [], doors: [], dividers: [], furniture: [],
          origin: { x_m: 0, y_m: 0 },
          shape: { type: 'rect', width_m: 8, length_m: 6 },
          grid: { cell_m: 0.5, cols: 16, rows: 12 },
        };
      }
      const data = allRooms[slug];
      const shape = data.shape || { width_m: 8, length_m: 6 };
      const saved = JSON.parse(localStorage.getItem('apt_wl_' + slug) || 'null');
      document.getElementById('apt-canvas-w').value = (saved && saved.w) || shape.width_m || 8;
      document.getElementById('apt-canvas-h').value = (saved && saved.h) || shape.length_m || 6;
      const cellSel = document.getElementById('apt-cell-m');
      const roomCell = (data.grid || {}).cell_m || 0.5;
      cellSel.value = roomCell;
      if (cellSel.value !== String(roomCell)) cellSel.value = '0.5';
      draw();
      refreshEditPanel();
      const name = roomSlugs.find(r => r.slug === slug);
      setStatus('Active: ' + (name ? name.name : slug) + ((data.walls || []).length ? '' : ' (empty — draw walls to start)'));
    }

    try {
      localStorage.setItem('apt_active_room', slug);
      localStorage.setItem('apt_layer_vis', JSON.stringify(aptConfig.layer_visibility || {}));
    } catch (e) {}
  };

  // ── Layer toggles ──────────────────────────────────────────────────────────
  function buildLayers() {
    const panel = document.getElementById('apt-layers');
    if (!panel) return;
    panel.innerHTML = '';
    const vis = aptConfig.layer_visibility || {};
    // Collect slugs referenced by any drawn room's door/divider leads_to.
    const referenced = new Set();
    for (const layout of Object.values(allRooms)) {
      for (const arr of [layout.doors || [], layout.dividers || []]) {
        for (const it of arr) if (it.leads_to) referenced.add(it.leads_to);
      }
    }
    for (const r of roomSlugs) {
      const layout = allRooms[r.slug];
      const hasWalls = !!(layout && (layout.walls || []).length > 0);
      // Show only rooms that are part of the apartment: walls drawn, or
      // referenced as a leads_to target from a drawn room (passage rooms).
      if (!hasWalls && !referenced.has(r.slug)) continue;
      const lbl = document.createElement('label');
      lbl.style.cssText = 'display:inline-flex;align-items:center;gap:3px;cursor:pointer;' +
        (hasWalls ? '' : 'opacity:0.4;');
      if (!hasWalls) lbl.title = 'No walls drawn — open this room and add walls';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = vis[r.slug] !== false && hasWalls;
      cb.disabled = !hasWalls;
      cb.onchange = function () {
        if (!aptConfig.layer_visibility) aptConfig.layer_visibility = {};
        aptConfig.layer_visibility[r.slug] = cb.checked;
        draw();
        try { localStorage.setItem('apt_layer_vis', JSON.stringify(aptConfig.layer_visibility)); } catch (e) {}
      };
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(r.name));
      panel.appendChild(lbl);
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    try {
      const [roomsR, allR, aptR, rdR, devCountsR, placementsR, devicesR] = await Promise.all([
        fetch('/api/room-slugs').then(r => r.json()),
        fetch('/api/room-layouts/all').then(r => r.json()),
        fetch('/api/apartment-layout').then(r => r.json()),
        fetch('/api/room-dims').then(r => r.json()).catch(() => ({})),
        fetch('/api/rooms').then(r => r.json()).catch(() => []),
        fetch('/api/room-device-placements').then(r => r.json()).catch(() => []),
        fetch('/api/devices').then(r => r.json()).catch(() => []),
      ]);
      roomSlugs = roomsR || [];
      allRooms = allR || {};
      aptConfig = aptR || {};
      roomDims = rdR || {};
      roomDevCounts = {};
      for (const row of (devCountsR || [])) roomDevCounts[row.room] = row.device_count;
      roomPlacements = placementsR || [];
      _allDevices = devicesR || [];
      // V7: for lights, server's JOIN uses placement.device_id. When
      // controller_device_id differs (e.g. historical mismatch or just-changed),
      // hydrate last_state from the real controller so the initial render
      // reflects reality immediately (without waiting for the 5-s poll).
      for (const p of roomPlacements) {
        if (p.device_type !== 'light') continue;
        const cid = (p.params || {}).controller_device_id;
        if (!cid || cid === p.device_id) continue;
        const ctrl = _allDevices.find(d => d.id === cid);
        if (ctrl) {
          p.device_name = ctrl.name;
          p.last_state  = ctrl.last_state;
          p.last_seen   = ctrl.last_seen;
        }
      }
      _startStatePolling();

      rebuildActiveRoomDropdown();

      // Populate leads_to dropdown
      const leadsSel = document.getElementById('apt-edit-leads');
      leadsSel.innerHTML = '<option value="">— none —</option>';
      for (const r of roomSlugs) {
        const opt = document.createElement('option');
        opt.value = r.slug;
        opt.textContent = r.name + ' (' + r.slug + ')';
        leadsSel.appendChild(opt);
      }

      // Restore state from localStorage
      try {
        const savedVis = JSON.parse(localStorage.getItem('apt_layer_vis') || '{}');
        if (Object.keys(savedVis).length) aptConfig.layer_visibility = savedVis;
      } catch (e) {}

      // Set active room. localStorage = current session state (zero-latency,
      // always up-to-date from the last click). DB = cold-start fallback (a
      // different browser, after a storage clear). Auto-sync to DB happens
      // in aptSetActiveRoom so both stay aligned.
      const savedActive = localStorage.getItem('apt_active_room');
      activeSlug = savedActive || aptConfig.active_room || (roomSlugs[0] || {}).slug || '';
      console.log('[init] active_room resolved:', { localActive: savedActive, dbActive: aptConfig.active_room, final: activeSlug });
      if (activeSlug) {
        const sel = document.getElementById('apt-active-room');
        if (sel) sel.value = activeSlug;
        aptSetActiveRoom(activeSlug);
      }

      buildLayers();
      renderPassageDimsTable();
      draw();
      aptSetTool('wall');
      setStatus(`Loaded: ${Object.keys(allRooms).length} room layout(s). Pick a room to edit.`);
    } catch (e) {
      setStatus('Failed to load: ' + e.message);
    }
  }

  window.aptSetShowHiddenLabels = function (v) {
    _showHiddenLabels = !!v;
    draw();
  };

  window.aptSetShowZones = function (v) {
    _showZones = !!v;
    try { localStorage.setItem('apt_show_zones', _showZones ? '1' : '0'); } catch (e) {}
    draw();
  };

  window.aptSetShowLights = function (v) {
    _showLights = !!v;
    try { localStorage.setItem('apt_show_lights', _showLights ? '1' : '0'); } catch (e) {}
    draw();
  };

  window.aptSetShowParameters = function (v) {
    _showParameters = !!v;
    try { localStorage.setItem('apt_show_parameters', _showParameters ? '1' : '0'); } catch (e) {}
    draw();
  };

  window.aptRedraw = function () {
    const w = parseFloat(document.getElementById('apt-canvas-w').value) || null;
    const h = parseFloat(document.getElementById('apt-canvas-h').value) || null;
    // Save W/L to its own localStorage key — separate per room, no cross-contamination
    if (activeSlug) {
      try { localStorage.setItem('apt_wl_' + activeSlug, JSON.stringify({w, h})); } catch (e) {}
    }
    draw();
  };

  window.aptCellChanged = function () {
    if (!activeSlug || !allRooms[activeSlug]) return;
    const cm = parseFloat(document.getElementById('apt-cell-m').value) || 0.5;
    const data = allRooms[activeSlug];
    if (!data.grid) data.grid = {};
    data.grid.cell_m = cm;
    const shape = data.shape || {};
    data.grid.cols = Math.ceil((shape.width_m || 8) / cm);
    data.grid.rows = Math.ceil((shape.length_m || 6) / cm);
    draw();
  };


  window.refreshPage = function () {
    const el = document.getElementById('last-refresh');
    if (el) el.textContent = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
    init();
  };

  window.addEventListener('DOMContentLoaded', () => {
    svg().addEventListener('click', onSvgClick);
    svg().addEventListener('mousemove', onSvgMove);
    // V6: sync Zones checkbox with persisted localStorage state
    const zonesCb = document.getElementById('apt-show-zones');
    if (zonesCb) zonesCb.checked = _showZones;
    // V7: sync Lights checkbox
    const lightsCb = document.getElementById('apt-show-lights');
    if (lightsCb) lightsCb.checked = _showLights;
    // V10: sync Parameters checkbox
    const paramsCb = document.getElementById('apt-show-parameters');
    if (paramsCb) paramsCb.checked = _showParameters;

    // Label drag (any tool, any room): left-click on room-name OR divider label
    // starts drag. Right-click toggles hide (label_hidden=true). "Show hidden
    // labels" toggle in the toolbar reveals hidden ones so they can be restored.
    svg().addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return; // left-click only
      const t = ev.target;
      if (!(t && t.dataset)) return;
      // Room-name label
      if (t.dataset.labelSlug) {
        const sl = t.dataset.labelSlug;
        const layout = allRooms[sl];
        if (!layout) return;
        pushUndo();
        const lo = layout.label_offset || {};
        labelDrag = {
          kind: 'room',
          slug: sl,
          startPx: ev.clientX, startPy: ev.clientY,
          origOx: +lo.x || 0, origOy: +lo.y || 0,
          moved: false,
        };
        ev.preventDefault(); ev.stopPropagation();
        return;
      }
      // Divider label
      if (t.dataset.dividerLabelId) {
        const sl = t.dataset.dividerLabelSlug;
        const did = t.dataset.dividerLabelId;
        const layout = allRooms[sl];
        if (!layout) return;
        const div = (layout.dividers || []).find(x => x.id === did);
        if (!div) return;
        pushUndo();
        const lo = div.label_offset || {};
        labelDrag = {
          kind: 'divider',
          slug: sl, divId: did,
          startPx: ev.clientX, startPy: ev.clientY,
          origOx: +lo.x || 0, origOy: +lo.y || 0,
          moved: false,
        };
        ev.preventDefault(); ev.stopPropagation();
        return;
      }
      // Door/archway label
      if (t.dataset.doorLabelId) {
        const sl = t.dataset.doorLabelSlug;
        const did = t.dataset.doorLabelId;
        const layout = allRooms[sl];
        if (!layout) return;
        const dor = (layout.doors || []).find(x => x.id === did);
        if (!dor) return;
        pushUndo();
        const lo = dor.label_offset || {};
        labelDrag = {
          kind: 'door',
          slug: sl, doorId: did,
          startPx: ev.clientX, startPy: ev.clientY,
          origOx: +lo.x || 0, origOy: +lo.y || 0,
          moved: false,
        };
        ev.preventDefault(); ev.stopPropagation();
        return;
      }
      // Furniture label
      if (t.dataset.furnLabelId) {
        const sl = t.dataset.furnLabelSlug;
        const fid = t.dataset.furnLabelId;
        const layout = allRooms[sl];
        if (!layout) return;
        const furn = (layout.furniture || []).find(x => x.id === fid);
        if (!furn) return;
        pushUndo();
        const lo = furn.label_offset || {};
        labelDrag = {
          kind: 'furn',
          slug: sl, furnId: fid,
          startPx: ev.clientX, startPy: ev.clientY,
          origOx: +lo.x || 0, origOy: +lo.y || 0,
          moved: false,
        };
        ev.preventDefault(); ev.stopPropagation();
        return;
      }
      // V6 Zone label — drag to reposition, right-click (handled elsewhere) to hide
      if (t.dataset.zoneLabelId) {
        const sl = t.dataset.zoneLabelSlug;
        const zid = t.dataset.zoneLabelId;
        const layout = allRooms[sl];
        if (!layout) return;
        const zone = (layout.zones || []).find(x => x.id === zid);
        if (!zone) return;
        pushUndo();
        const lo = zone.label_offset || {};
        labelDrag = {
          kind: 'zone',
          slug: sl, zoneId: zid,
          startPx: ev.clientX, startPy: ev.clientY,
          origOx: +lo.x || 0, origOy: +lo.y || 0,
          moved: false,
        };
        ev.preventDefault(); ev.stopPropagation();
        return;
      }
      // Device placement label
      if (t.dataset.devLabelId) {
        const pid = parseInt(t.dataset.devLabelId, 10);
        const p = roomPlacements.find(x => x.id === pid);
        if (!p) return;
        const lo = p.label_offset || {};
        labelDrag = {
          kind: 'dev',
          devId: pid,
          startPx: ev.clientX, startPy: ev.clientY,
          origOx: +lo.x || 0, origOy: +lo.y || 0,
          origLabelOffset: p.label_offset ? { ...p.label_offset } : null,
          moved: false,
        };
        ev.preventDefault(); ev.stopPropagation();
      }
    });
    svg().addEventListener('contextmenu', function (ev) {
      const t = ev.target;
      if (!(t && t.dataset)) return;
      if (t.dataset.labelSlug) {
        ev.preventDefault();
        const sl = t.dataset.labelSlug;
        const layout = allRooms[sl];
        if (!layout) return;
        pushUndo();
        layout.label_hidden = !layout.label_hidden;
        draw();
        setStatus(layout.label_hidden
          ? `Label hidden for ${sl}. Toggle "Hidden labels" to restore.`
          : `Label shown for ${sl}.`);
        return;
      }
      if (t.dataset.dividerLabelId) {
        ev.preventDefault();
        const sl = t.dataset.dividerLabelSlug;
        const did = t.dataset.dividerLabelId;
        const layout = allRooms[sl];
        if (!layout) return;
        const div = (layout.dividers || []).find(x => x.id === did);
        if (!div) return;
        pushUndo();
        div.label_hidden = !div.label_hidden;
        layout._divider_dirty = true;
        draw();
        setStatus(div.label_hidden
          ? `Divider label hidden. Toggle "Hidden labels" to restore.`
          : `Divider label shown.`);
        return;
      }
      if (t.dataset.doorLabelId) {
        ev.preventDefault();
        const sl = t.dataset.doorLabelSlug;
        const did = t.dataset.doorLabelId;
        const layout = allRooms[sl];
        if (!layout) return;
        const dor = (layout.doors || []).find(x => x.id === did);
        if (!dor) return;
        pushUndo();
        dor.label_hidden = !dor.label_hidden;
        layout._door_dirty = true;
        draw();
        setStatus(dor.label_hidden
          ? `Door label hidden. Toggle "Hidden labels" to restore.`
          : `Door label shown.`);
        return;
      }
      if (t.dataset.furnLabelId) {
        ev.preventDefault();
        const sl = t.dataset.furnLabelSlug;
        const fid = t.dataset.furnLabelId;
        const layout = allRooms[sl];
        if (!layout) return;
        const furn = (layout.furniture || []).find(x => x.id === fid);
        if (!furn) return;
        pushUndo();
        furn.label_hidden = !furn.label_hidden;
        layout._furn_dirty = true;
        draw();
        setStatus(furn.label_hidden
          ? `Furniture label hidden. Toggle "Hidden labels" to restore.`
          : `Furniture label shown.`);
        return;
      }
      if (t.dataset.zoneLabelId) {
        ev.preventDefault();
        const sl = t.dataset.zoneLabelSlug;
        const zid = t.dataset.zoneLabelId;
        const layout = allRooms[sl];
        if (!layout) return;
        const z = (layout.zones || []).find(x => x.id === zid);
        if (!z) return;
        pushUndo();
        z.label_hidden = !z.label_hidden;
        draw();
        setStatus(z.label_hidden
          ? `Zone label "${z.name}" hidden. Toggle "Hidden labels" to restore.`
          : `Zone label shown.`);
        return;
      }
      if (t.dataset.devLabelId) {
        ev.preventDefault();
        const pid = parseInt(t.dataset.devLabelId, 10);
        const p = roomPlacements.find(x => x.id === pid);
        if (!p) return;
        const prev = !!p.label_hidden;
        p.label_hidden = !prev;
        pushUndo({ type: 'dev_update', id: p.id, prev_fields: { label_hidden: prev } });
        draw();
        fetch('/api/room-device-placements/' + p.id, {
          method: 'PATCH', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ label_hidden: p.label_hidden }),
        }).catch(() => {});
        setStatus(p.label_hidden
          ? `Device label hidden. Toggle "Hidden labels" to restore.`
          : `Device label shown.`);
      }
    });

    // Furniture drag-to-move: mousedown starts, mousemove updates, mouseup finalizes
    svg().addEventListener('mousedown', function (ev) {
      if (labelDrag) return;
      if (tool !== 'select' || !activeSlug || activeSlug === '_apartment') return;
      const rect = svg().getBoundingClientRect();
      const co = getComputedOrigin(activeSlug);
      const xM = viewOriginX + pxToM(ev.clientX - rect.left) - co.x_m;
      const yM = viewOriginY + pxToM(ev.clientY - rect.top) - co.y_m;
      const data = activeData();
      // Device placements first. Dataset-first hit test lets drag-start work
      // on any part of a fixture glyph (lamp base, strip body, sconce arc)
      // regardless of geometric offset from the centre point.
      const tgt = ev.target;
      if (tgt && tgt.dataset && tgt.dataset.devPlacementId) {
        const pid = parseInt(tgt.dataset.devPlacementId, 10);
        const p = roomPlacements.find(pp => pp.id === pid && pp.slug === activeSlug);
        if (p) {
          dragging = { kind: 'dev', id: p.id, startX: xM, startY: yM, origX: p.x, origY: p.y, moved: false };
          selectedId = p.id;
          refreshEditPanel();
          draw();
          ev.preventDefault();
          return;
        }
      }
      // Geometric fallback. Lights get a slightly larger radius for offset glyphs.
      for (const p of roomPlacements) {
        if (p.slug !== activeSlug) continue;
        const hitR = p.device_type === 'light' ? 0.4 : 0.25;
        if (Math.hypot(xM - p.x, yM - p.y) < hitR) {
          dragging = { kind: 'dev', id: p.id, startX: xM, startY: yM, origX: p.x, origY: p.y, moved: false };
          selectedId = p.id;
          refreshEditPanel();
          draw();
          ev.preventDefault();
          return;
        }
      }
      for (const f of (data.furniture || [])) {
        if (Math.abs(xM - f.x) <= f.w/2 + 0.1 && Math.abs(yM - f.y) <= f.h/2 + 0.1) {
          pushUndo();
          dragging = { id: f.id, startX: xM, startY: yM, origX: f.x, origY: f.y };
          selectedId = f.id;
          refreshEditPanel();
          ev.preventDefault();
          return;
        }
      }
    });
    svg().addEventListener('mousemove', function (ev) {
      if (labelDrag) {
        const dx = pxToM(ev.clientX - labelDrag.startPx);
        const dy = pxToM(ev.clientY - labelDrag.startPy);
        if (!labelDrag.moved && Math.hypot(dx, dy) > 0.05) labelDrag.moved = true;
        const newOff = {
          x: +(labelDrag.origOx + dx).toFixed(2),
          y: +(labelDrag.origOy + dy).toFixed(2),
        };
        const layout = allRooms[labelDrag.slug];
        if (labelDrag.kind !== 'dev' && !layout) return;
        if (labelDrag.kind === 'divider') {
          const div = (layout.dividers || []).find(x => x.id === labelDrag.divId);
          if (div) { div.label_offset = newOff; layout._divider_dirty = true; }
        } else if (labelDrag.kind === 'door') {
          const dor = (layout.doors || []).find(x => x.id === labelDrag.doorId);
          if (dor) { dor.label_offset = newOff; layout._door_dirty = true; }
        } else if (labelDrag.kind === 'furn') {
          const furn = (layout.furniture || []).find(x => x.id === labelDrag.furnId);
          if (furn) { furn.label_offset = newOff; layout._furn_dirty = true; }
        } else if (labelDrag.kind === 'zone') {
          const z = (layout.zones || []).find(x => x.id === labelDrag.zoneId);
          if (z) { z.label_offset = newOff; }
        } else if (labelDrag.kind === 'dev') {
          const p = roomPlacements.find(x => x.id === labelDrag.devId);
          if (p) { p.label_offset = newOff; p._dirty = true; }
        } else {
          layout.label_offset = newOff;
        }
        draw();
        return;
      }
      if (!dragging) return;
      const rect = svg().getBoundingClientRect();
      const co = getComputedOrigin(activeSlug);
      const xM = viewOriginX + pxToM(ev.clientX - rect.left) - co.x_m;
      const yM = viewOriginY + pxToM(ev.clientY - rect.top) - co.y_m;
      if (dragging.kind === 'dev') {
        const p = roomPlacements.find(pp => pp.id === dragging.id);
        if (p) {
          const nx = +snapM(xM, !!ev.shiftKey).toFixed(2);
          const ny = +snapM(yM, !!ev.shiftKey).toFixed(2);
          if (nx !== p.x || ny !== p.y) dragging.moved = true;
          p.x = nx; p.y = ny;
          draw();
        }
        return;
      }
      const data = activeData();
      const f = (data.furniture || []).find(ff => ff.id === dragging.id);
      if (f) {
        f.x = +snapM(xM, !!ev.shiftKey).toFixed(2);
        f.y = +snapM(yM, !!ev.shiftKey).toFixed(2);
        draw();
      }
    });
    window.addEventListener('mouseup', function () {
      if (labelDrag) {
        if (labelDrag.moved) {
          const what = labelDrag.kind === 'divider' ? 'Divider label'
                     : labelDrag.kind === 'door' ? 'Door label'
                     : labelDrag.kind === 'furn' ? 'Furniture label'
                     : labelDrag.kind === 'zone' ? 'Zone label'
                     : labelDrag.kind === 'dev'  ? 'Device label'
                     : labelDrag.kind === 'room' ? 'Room label'
                     : 'Label';
          if (labelDrag.kind === 'dev') {
            const p = roomPlacements.find(x => x.id === labelDrag.devId);
            if (p) {
              pushUndo({ type: 'dev_update', id: p.id, prev_fields: { label_offset: labelDrag.origLabelOffset } });
              fetch('/api/room-device-placements/' + p.id, {
                method: 'PATCH', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ label_offset: p.label_offset }),
              }).catch(() => {});
            }
            setStatus('Device label moved.');
          } else if (labelDrag.slug) {
            // Auto-save label_offset for room/divider/door/furn/zone to the
            // affected room's layout. Partial POST — only the changed field's
            // array/object, never touches walls. Works in apartment view
            // (no activeSlug required).
            const sl = labelDrag.slug;
            const layout = allRooms[sl];
            if (layout) {
              const body = {};
              if (labelDrag.kind === 'room')    body.label_offset = layout.label_offset;
              if (labelDrag.kind === 'divider') body.dividers  = layout.dividers  || [];
              if (labelDrag.kind === 'door')    body.doors     = layout.doors     || [];
              if (labelDrag.kind === 'furn')    body.furniture = layout.furniture || [];
              if (labelDrag.kind === 'zone')    body.zones     = layout.zones     || [];
              fetch('/api/room-layouts/' + sl, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify(body),
              }).catch(() => {});
            }
            setStatus(`${what} moved for ${sl} — saved.`);
          } else {
            setStatus(`${what} moved.`);
          }
          suppressClick = true;
        }
        labelDrag = null;
      }
      if (dragging) {
        if (dragging.kind === 'dev') {
          if (dragging.moved) {
            const p = roomPlacements.find(x => x.id === dragging.id);
            if (p) {
              pushUndo({ type: 'dev_update', id: p.id, prev_fields: { x: dragging.origX, y: dragging.origY } });
              fetch('/api/room-device-placements/' + p.id, {
                method: 'PATCH', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ x: p.x, y: p.y }),
              }).catch(() => {});
            }
            setStatus('Device moved.');
          }
        } else {
          setStatus('Furniture moved.');
        }
        dragging = null;
      }
    });
    let _resizeT;
    window.addEventListener('resize', () => { clearTimeout(_resizeT); _resizeT = setTimeout(draw, 100); });
    init();
  });

  // On bfcache restore, the page comes back alive but scripts don't re-run.
  // Only redraw — NEVER overwrite in-memory state from the server, because
  // in-memory may contain unsaved drawings that the user wants to keep.
  // (A prior version here did an auto-resync that wiped unsaved edits —
  // removed. Tab switch now keeps your in-memory state exactly as it was.)
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) draw();
  });

})();
