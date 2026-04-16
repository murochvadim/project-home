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
  let clipboard     = null;   // copied furniture item (for paste on next click)
  let undoStack    = [];
  let cellPx       = 30;
  let viewOriginX  = 0;
  let viewOriginY  = 0;

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

  // Determine which side of the room a wall is on (north/south/east/west).
  function getWallSide(wall, bounds) {
    const isVert  = Math.abs(wall.x1 - wall.x2) < 0.2;
    const isHoriz = Math.abs(wall.y1 - wall.y2) < 0.2;
    if (isVert && Math.abs(wall.x1 - bounds.minX) < 0.3) return 'west';
    if (isVert && Math.abs(wall.x1 - bounds.maxX) < 0.3) return 'east';
    if (isHoriz && Math.abs(wall.y1 - bounds.minY) < 0.3) return 'north';
    if (isHoriz && Math.abs(wall.y1 - bounds.maxY) < 0.3) return 'south';
    // Not on a boundary wall — infer from position relative to center
    const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
    const mx = (wall.x1 + wall.x2) / 2, my = (wall.y1 + wall.y2) / 2;
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
      const curLayout = allRooms[curSlug];
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
        const side = getWallSide(wall, curBounds);
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
          if (targetMid) targetSide = getWallSide(targetMid.wall, targetBounds);
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

        // If target's matching connection isn't on the expected side,
        // try rotating the target 90° CW to align it.
        if (targetSide && targetSide !== expectedSide) {
          usedLayout = rotateLayout90CW(targetLayout);
          targetBounds = getRoomBounds(usedLayout);
          // Re-find matching connection in rotated layout
          targetMid = null;
          for (const td of (usedLayout.doors || [])) {
            if (td.leads_to !== curSlug) continue;
            targetMid = getDoorMidpoint(td, usedLayout.walls);
            if (targetMid) targetSide = getWallSide(targetMid.wall, targetBounds);
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
        const mx = (d.x1 + d.x2) / 2, my = (d.y1 + d.y2) / 2;
        const lbl = document.createElementNS(NS, 'text');
        lbl.setAttribute('x', mToPx(mx) + 4); lbl.setAttribute('y', mToPx(my) - 4);
        lbl.setAttribute('font-size', '10'); lbl.setAttribute('font-weight', 'bold');
        lbl.setAttribute('fill', FURN_STROKE);
        lbl.textContent = '→ ' + d.leads_to;
        g.appendChild(lbl);
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
        const lx = wg.nx, ly = wg.ny;
        const leafEndX = wg.sx + lx*item.width_m, leafEndY = wg.sy + ly*item.width_m;
        const leaf = document.createElementNS(NS, 'line');
        leaf.setAttribute('x1', mToPx(wg.sx)); leaf.setAttribute('y1', mToPx(wg.sy));
        leaf.setAttribute('x2', mToPx(leafEndX)); leaf.setAttribute('y2', mToPx(leafEndY));
        leaf.setAttribute('stroke', COLOR_DOOR);
        leaf.setAttribute('stroke-width', item.id === selId ? 3 : 2);
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
      if (item.leads_to && !(_multiView && _visibleSet.has(item.leads_to))) {
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

    // Furniture — light grey architectural preset shapes (toggleable layer)
    const showFurn = document.getElementById('apt-show-furniture');
    if (showFurn && showFurn.checked) for (const f of (layout.furniture || [])) {
      const fg = document.createElementNS(NS, 'g');
      const cx = mToPx(f.x), cy = mToPx(f.y);
      const fw = mToPx(f.w), fh = mToPx(f.h);
      if (f.rotation) fg.setAttribute('transform', `rotate(${f.rotation}, ${cx}, ${cy})`);
      drawFurniturePreset(fg, f.type, cx - fw/2, cy - fh/2, fw, fh, f.id === selId);
      g.appendChild(fg);
    }

    // Room name label (supports optional label_offset {x,y} in room data)
    const bounds = getRoomBounds(layout);
    const lo = layout.label_offset || {};
    const cx = (bounds.minX + bounds.maxX) / 2 + (lo.x || 0);
    const cy = (bounds.minY + bounds.maxY) / 2 + (lo.y || 0);
    const nameObj = roomSlugs.find(r => r.slug === slug);
    const lbl = document.createElementNS(NS, 'text');
    lbl.setAttribute('x', mToPx(cx)); lbl.setAttribute('y', mToPx(cy));
    lbl.setAttribute('font-size', isActive ? '14' : '12');
    lbl.setAttribute('font-weight', 'bold');
    lbl.setAttribute('fill', isActive ? '#333' : '#666');
    lbl.setAttribute('text-anchor', 'middle');
    lbl.setAttribute('dominant-baseline', 'middle');
    lbl.setAttribute('opacity', '0.4');
    lbl.textContent = nameObj ? nameObj.name : slug;
    g.appendChild(lbl);
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
      glass:   'Click two points for a glass barrier (balcony railing, glass partition).',
      window:  'Click start + end on a wall.',
      door:    'Click start + end on a wall.',
      sliding: 'Sliding glass door — click start + end on a wall.',
      divider: 'Click two points for open-plan boundary.',
      furniture: 'Click to place furniture. Click again to set size, or single-click for default size.',
      select:  'Click an element to select.',
    };
    setStatus(hints[t] || '');
    refreshEditPanel();
    draw();
  };

  // ── Click handler ──────────────────────────────────────────────────────────
  function onSvgClick(ev) {
    if (!activeSlug || activeSlug === '_apartment') return;
    const rect = svg().getBoundingClientRect();
    const co = getComputedOrigin(activeSlug);
    const skipSnap = !!ev.shiftKey || tool === 'window' || tool === 'door' || tool === 'sliding';
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
        pushUndo();
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
    } else if (tool === 'paste' && clipboard) {
      pushUndo();
      const data = activeData();
      data.furniture = data.furniture || [];
      data.furniture.push({
        ...clipboard,
        id: 'furn_' + (data.furniture.length + 1) + '_' + Date.now().toString(36),
        x: +xM.toFixed(2),
        y: +yM.toFixed(2),
      });
      setStatus(clipboard.type + ' pasted. Click again to paste another, or switch tool.');
    } else if (tool === 'furniture') {
      const preset = (document.getElementById('apt-furn-preset') || {}).value;
      if (!preset) { setStatus('Select a furniture type from the dropdown first.'); return; }
      if (!pending) {
        pending = { x1: xM, y1: yM };
        setStatus(`Click again to set size, or click same spot for default ${preset} size.`);
      } else {
        pushUndo();
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
      // Check furniture first (on top visually)
      for (const f of (data.furniture || [])) {
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
    if (!activeSlug || activeSlug === '_apartment') return;
    const rect = svg().getBoundingClientRect();
    const co = getComputedOrigin(activeSlug);
    const xM = viewOriginX + pxToM(ev.clientX - rect.left) - co.x_m;
    const yM = viewOriginY + pxToM(ev.clientY - rect.top) - co.y_m;
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
    const furn = (data.furniture || []).find(x => x.id === selectedId);
    const item = win || dor || div || furn;
    if (!item) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    document.getElementById('apt-edit-id').textContent = furn ? (furn.type + (furn.label ? ' "'+furn.label+'"' : '')) : item.id;
    const isDivider = !!div;
    const isFurn = !!furn;
    document.getElementById('apt-edit-offset-wrap').style.display = (isDivider || isFurn) ? 'none' : 'inline';
    document.getElementById('apt-edit-width-wrap').style.display = (isDivider || isFurn) ? 'none' : 'inline';
    if (!isDivider && !isFurn) {
      document.getElementById('apt-edit-offset').value = item.offset_m;
      document.getElementById('apt-edit-width').value = item.width_m;
    }
    const leadsWrap = document.getElementById('apt-edit-leads-wrap');
    leadsWrap.style.display = (dor || div) ? 'inline' : 'none';
    if (dor || div) document.getElementById('apt-edit-leads').value = item.leads_to || '';
    const furnWrap = document.getElementById('apt-edit-furn-wrap');
    furnWrap.style.display = isFurn ? 'inline' : 'none';
    if (isFurn) {
      document.getElementById('apt-edit-furn-label').value = furn.label || '';
      document.getElementById('apt-edit-furn-w').value = furn.w;
      document.getElementById('apt-edit-furn-h').value = furn.h;
      document.getElementById('apt-edit-furn-rot').value = furn.rotation || 0;
    }
  }

  window.aptApplyEdit = function () {
    if (!selectedId) return;
    const data = activeData();
    let item = (data.windows || []).find(x => x.id === selectedId);
    let kind = 'windows';
    if (!item) { item = (data.doors || []).find(x => x.id === selectedId); kind = 'doors'; }
    if (!item) { item = (data.dividers || []).find(x => x.id === selectedId); kind = 'dividers'; }
    if (!item) { item = (data.furniture || []).find(x => x.id === selectedId); kind = 'furniture'; }
    if (!item) return;
    if (kind === 'furniture') {
      item.label = (document.getElementById('apt-edit-furn-label').value || '').trim();
      const fw = parseFloat(document.getElementById('apt-edit-furn-w').value);
      const fh = parseFloat(document.getElementById('apt-edit-furn-h').value);
      if (!isNaN(fw) && fw > 0) item.w = +fw.toFixed(2);
      if (!isNaN(fh) && fh > 0) item.h = +fh.toFixed(2);
      item.rotation = parseInt(document.getElementById('apt-edit-furn-rot').value) || 0;
      pushUndo(); draw(); setStatus('Updated ' + item.type);
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

  window.aptCopySelected = function () {
    if (!selectedId) { setStatus('Select a furniture item first.'); return; }
    const data = activeData();
    const f = (data.furniture || []).find(ff => ff.id === selectedId);
    if (!f) { setStatus('Copy works on furniture only.'); return; }
    clipboard = JSON.parse(JSON.stringify(f));
    tool = 'paste';
    setStatus('Click to paste ' + f.type + '. Press Esc or switch tool to cancel.');
  };

  window.aptDeleteSelected = function () {
    if (!selectedId) return;
    const data = activeData();
    pushUndo();
    data.walls = (data.walls || []).filter(w => w.id !== selectedId);
    data.windows = (data.windows || []).filter(x => x.id !== selectedId && x.wall !== selectedId);
    data.doors = (data.doors || []).filter(x => x.id !== selectedId && x.wall !== selectedId);
    data.dividers = (data.dividers || []).filter(d => d.id !== selectedId);
    data.furniture = (data.furniture || []).filter(f => f.id !== selectedId);
    selectedId = null;
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
      // Also save view_w/view_h for ALL other rooms that have unsaved changes
      for (const [sl, rd] of Object.entries(allRooms)) {
        if (sl === activeSlug) continue;
        if (rd.view_w != null || rd.view_h != null) {
          await fetch('/api/room-layouts/' + sl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ view_w: rd.view_w, view_h: rd.view_h }),
          }).catch(() => {});
        }
      }
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

  // ── Room switching ─────────────────────────────────────────────────────────
  window.aptSetActiveRoom = function (slug) {
    // Save outgoing room's view W/L into memory
    if (activeSlug && activeSlug !== slug && activeSlug !== '_apartment' && allRooms[activeSlug]) {
      allRooms[activeSlug].view_w = parseFloat(document.getElementById('apt-canvas-w').value) || null;
      allRooms[activeSlug].view_h = parseFloat(document.getElementById('apt-canvas-h').value) || null;
    }

    activeSlug = slug;
    pending = null; pendingWall = null; selectedId = null;
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
      const [roomsR, allR, aptR] = await Promise.all([
        fetch('/api/room-slugs').then(r => r.json()),
        fetch('/api/room-layouts/all').then(r => r.json()),
        fetch('/api/apartment-layout').then(r => r.json()),
      ]);
      roomSlugs = roomsR || [];
      allRooms = allR || {};
      aptConfig = aptR || {};

      // Populate active room dropdown — "Apartment" shows all rooms together
      const sel = document.getElementById('apt-active-room');
      sel.innerHTML = '';
      const aptOpt = document.createElement('option');
      aptOpt.value = '_apartment';
      aptOpt.textContent = '— Apartment (all rooms) —';
      sel.appendChild(aptOpt);
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

      // Restore state from localStorage
      try {
        const savedVis = JSON.parse(localStorage.getItem('apt_layer_vis') || '{}');
        if (Object.keys(savedVis).length) aptConfig.layer_visibility = savedVis;
      } catch (e) {}

      // Set active room (localStorage > DB > first room)
      const savedActive = localStorage.getItem('apt_active_room');
      activeSlug = savedActive || aptConfig.active_room || (roomSlugs[0] || {}).slug || '';
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

    // Furniture drag-to-move: mousedown starts, mousemove updates, mouseup finalizes
    svg().addEventListener('mousedown', function (ev) {
      if (tool !== 'select' || !activeSlug || activeSlug === '_apartment') return;
      const rect = svg().getBoundingClientRect();
      const co = getComputedOrigin(activeSlug);
      const xM = viewOriginX + pxToM(ev.clientX - rect.left) - co.x_m;
      const yM = viewOriginY + pxToM(ev.clientY - rect.top) - co.y_m;
      const data = activeData();
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
      if (!dragging) return;
      const rect = svg().getBoundingClientRect();
      const co = getComputedOrigin(activeSlug);
      const xM = viewOriginX + pxToM(ev.clientX - rect.left) - co.x_m;
      const yM = viewOriginY + pxToM(ev.clientY - rect.top) - co.y_m;
      const data = activeData();
      const f = (data.furniture || []).find(ff => ff.id === dragging.id);
      if (f) {
        f.x = +snapM(xM, !!ev.shiftKey).toFixed(2);
        f.y = +snapM(yM, !!ev.shiftKey).toFixed(2);
        draw();
      }
    });
    window.addEventListener('mouseup', function () {
      if (dragging) {
        dragging = null;
        setStatus('Furniture moved.');
      }
    });
    let _resizeT;
    window.addEventListener('resize', () => { clearTimeout(_resizeT); _resizeT = setTimeout(draw, 100); });
    init();
  });

  // Handle bfcache: browser may restore page from memory without re-running
  // scripts, so _vs would be stale. Re-read localStorage on pageshow.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      const fresh = JSON.parse(localStorage.getItem('apt_view_sizes') || '{}');
      for (const k of Object.keys(fresh)) _vs[k] = fresh[k];
      if (activeSlug) {
        const s = _vs[activeSlug] || {};
        const data = allRooms[activeSlug] || {};
        const shape = data.shape || {};
        document.getElementById('apt-canvas-w').value = s.w || shape.width_m || 8;
        document.getElementById('apt-canvas-h').value = s.h || shape.length_m || 6;
        draw();
      }
    }
  });

})();
