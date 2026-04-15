// Living Room Agent — page logic
(function () {
  const WM1_ID = 'e410cc7b-a734-4177-b941-2394dd7a5f7f';
  const WM2_ID = '62f40d30-5c63-4d97-bf55-c602d1e2ee93';

  const CONTROLLABLE_TYPES = new Set(['switch', 'light', 'circuit_breaker', 'water_heater', 'curtain', 'valve']);
  const ACTIONS = [
    { v: 'turn_on',  label: 'Turn On',  tag: 'on'     },
    { v: 'turn_off', label: 'Turn Off', tag: 'off'    },
    { v: 'toggle',   label: 'Toggle',   tag: 'toggle' },
  ];
  const STORAGE_KEY = 'living-room.wallmote_bindings';

  // In-memory bindings state
  // Shape: { 'wm1:button1:pushed': [{device_id, channel, name, label, action}, ...] }
  let bindings = {};

  // Cached device list (built once on load)
  let controllableDevices = [];

  // Active picker context
  let activePicker = null;

  function key(wm, btn, ev) { return `${wm}:${btn}:${ev}`; }
  function defaultActionFor(event) { return event === 'held' ? 'toggle' : 'turn_on'; }
  function actionLabel(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.label : v; }
  function actionTag(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.tag : 'on'; }

  function showTab(name, btn) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    btn.classList.add('active');
  }
  window.showTab = showTab;

  function refreshPage() {
    const el = document.getElementById('last-refresh');
    if (el) el.textContent = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
    loadData();
  }
  window.refreshPage = refreshPage;

  async function loadData() {
    try {
      const [devs, saved] = await Promise.all([
        fetch('/api/devices').then(r => r.json()),
        fetch(`/api/dashboard-settings/${encodeURIComponent(STORAGE_KEY)}`).then(r => r.json()).catch(() => ({ value: null })),
      ]);

      // Wallmote status (both)
      const fmtWm = (devId, prefix) => {
        const d = devs.find(x => x.id === devId);
        if (!d) return;
        const batt = d.last_state?.battery;
        const bEl = document.getElementById(prefix + '-battery');
        if (bEl) bEl.textContent = batt != null ? batt + '%' : '—';
        const lsEl = document.getElementById(prefix + '-last-seen');
        if (lsEl && d.last_seen) {
          lsEl.textContent = new Date(d.last_seen).toLocaleTimeString('he-IL',
            { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
        }
      };
      fmtWm(WM1_ID, 'wm1');
      fmtWm(WM2_ID, 'wm2');

      // Build controllable device list — expand multi-gang switches by channel
      controllableDevices = [];
      for (const d of devs) {
        if (d.enabled === false) continue;
        if (!CONTROLLABLE_TYPES.has(d.device_type)) continue;

        const chanCfg = d.channel_config || {};
        const dpsLabels = d.dps_labels || {};

        // Channel-expansion priority:
        // 1) channel_config with numeric keys (Tuya local/gateway multi-gang)
        // 2) dps_labels with state_l<N> keys (Zigbee multi-gang)
        const tuyaChans = Object.keys(chanCfg).filter(k => k && !isNaN(parseInt(k))).sort();
        const zigbeeChans = Object.keys(dpsLabels).filter(k => /^state_l\d+$/i.test(k))
          .sort((a, b) => parseInt(a.replace(/\D/g,'')) - parseInt(b.replace(/\D/g,'')));

        if (tuyaChans.length > 1) {
          for (const ch of tuyaChans) {
            const chInfo = chanCfg[ch] || {};
            controllableDevices.push({
              device_id: d.id, channel: ch,
              name: d.name, label: chInfo.name || `Ch.${ch}`,
              room: chInfo.room || d.room || '', protocol: d.protocol,
            });
          }
        } else if (zigbeeChans.length > 1) {
          for (const ch of zigbeeChans) {
            controllableDevices.push({
              device_id: d.id, channel: ch,
              name: d.name, label: dpsLabels[ch] || ch,
              room: d.room || '', protocol: d.protocol,
            });
          }
        } else {
          controllableDevices.push({
            device_id: d.id, channel: null,
            name: d.name, label: '',
            room: d.room || '', protocol: d.protocol,
          });
        }
      }
      controllableDevices.sort((a, b) => {
        const rc = (a.room || 'zzz').localeCompare(b.room || 'zzz');
        return rc !== 0 ? rc : a.name.localeCompare(b.name);
      });

      // Load saved bindings
      if (saved && saved.value && typeof saved.value === 'object') {
        bindings = saved.value;
      } else {
        bindings = {};
      }

      // Populate all picker displays from saved state
      document.querySelectorAll('.device-picker').forEach(p => {
        updatePickerDisplay(p, p.dataset.wallmote, p.dataset.button, p.dataset.event);
      });
    } catch (e) {
      console.error('Living Room load error:', e);
    }
  }

  // ─── Picker ──────────────────────────────────────────────────────

  window.openPicker = function (wallmote, button, event, pickerEl) {
    const slotKey = key(wallmote, button, event);
    const currentSelection = bindings[slotKey] || [];
    activePicker = {
      wallmote, button, event, pickerEl,
      selectedBefore: JSON.parse(JSON.stringify(currentSelection)),
    };
    document.getElementById('picker-title').textContent =
      `Wallmote ${wallmote.replace('wm','')} · Button ${button.replace('button','')} · ${event}`;
    document.getElementById('picker-search-input').value = '';
    renderPickerList('');
    document.getElementById('picker-overlay').classList.add('show');
  };

  window.closePicker = function (save) {
    const overlay = document.getElementById('picker-overlay');
    overlay.classList.remove('show');
    if (!save && activePicker) {
      bindings[key(activePicker.wallmote, activePicker.button, activePicker.event)] = activePicker.selectedBefore;
    }
    if (activePicker) updatePickerDisplay(activePicker.pickerEl, activePicker.wallmote, activePicker.button, activePicker.event);
    activePicker = null;
  };

  function renderPickerList(filter) {
    if (!activePicker) return;
    const slotKey = key(activePicker.wallmote, activePicker.button, activePicker.event);
    const selected = bindings[slotKey] || [];
    const selectedByKey = new Map(selected.map(s => [s.device_id + ':' + (s.channel || ''), s]));

    const f = (filter || '').toLowerCase();
    const list = document.getElementById('picker-list');
    list.innerHTML = '';

    let currentRoom = null;
    let visibleCount = 0;
    const defaultAct = defaultActionFor(activePicker.event);

    for (const d of controllableDevices) {
      const rowKey = d.device_id + ':' + (d.channel || '');
      const displayName = d.label ? `${d.name} — ${d.label}` : d.name;
      const searchBlob = `${d.name} ${d.label} ${d.room} ${d.protocol}`.toLowerCase();
      if (f && !searchBlob.includes(f)) continue;

      if (d.room !== currentRoom) {
        currentRoom = d.room;
        const rl = document.createElement('div');
        rl.className = 'picker-room-label';
        rl.textContent = d.room || '(no room)';
        list.appendChild(rl);
      }

      const existing = selectedByKey.get(rowKey);
      const checked = !!existing;
      const act = existing ? existing.action : defaultAct;

      const item = document.createElement('div');
      item.className = 'picker-item';
      item.innerHTML = `
        <input type="checkbox" ${checked ? 'checked' : ''}>
        <div class="picker-item-name">${escHtml(displayName)}</div>
        <select class="picker-action-select">
          ${ACTIONS.map(a => `<option value="${a.v}" ${a.v === act ? 'selected' : ''}>${a.label}</option>`).join('')}
        </select>
        <div class="picker-item-meta">${escHtml(d.protocol)}${d.channel ? ' · Ch.'+d.channel : ''}</div>
      `;
      const cb = item.querySelector('input');
      const sel = item.querySelector('select');

      item.addEventListener('click', (e) => {
        if (e.target === sel || sel.contains(e.target)) return;  // let the select handle its own clicks
        if (e.target !== cb) cb.checked = !cb.checked;
        toggleSelection(d, cb.checked, sel.value);
      });
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        // Changing action implicitly selects the device (if not already)
        if (!cb.checked) cb.checked = true;
        toggleSelection(d, cb.checked, sel.value);
      });
      sel.addEventListener('click', (e) => e.stopPropagation());

      list.appendChild(item);
      visibleCount++;
    }

    if (visibleCount === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:20px;color:#aaa;text-align:center;font-size:0.82rem;';
      empty.textContent = 'No devices match your filter';
      list.appendChild(empty);
    }
    updatePickerCount();
  }

  function toggleSelection(dev, checked, action) {
    if (!activePicker) return;
    const slotKey = key(activePicker.wallmote, activePicker.button, activePicker.event);
    if (!bindings[slotKey]) bindings[slotKey] = [];
    const existingIdx = bindings[slotKey].findIndex(s =>
      s.device_id === dev.device_id && (s.channel || null) === (dev.channel || null));
    if (checked) {
      if (existingIdx >= 0) {
        bindings[slotKey][existingIdx].action = action;
      } else {
        bindings[slotKey].push({
          device_id: dev.device_id, channel: dev.channel,
          name: dev.name, label: dev.label,
          action: action,
        });
      }
    } else if (existingIdx >= 0) {
      bindings[slotKey].splice(existingIdx, 1);
    }
    updatePickerCount();
  }

  function updatePickerCount() {
    if (!activePicker) return;
    const slotKey = key(activePicker.wallmote, activePicker.button, activePicker.event);
    const count = (bindings[slotKey] || []).length;
    document.getElementById('picker-count').textContent = `${count} selected`;
  }

  function updatePickerDisplay(pickerEl, wallmote, button, event) {
    const slotKey = key(wallmote, button, event);
    const sel = bindings[slotKey] || [];
    if (sel.length === 0) {
      pickerEl.classList.add('empty');
      pickerEl.innerHTML = '— select devices —';
      pickerEl.title = '';
    } else {
      pickerEl.classList.remove('empty');
      const makeTag = (s) =>
        `${escHtml(s.label ? s.name + ':' + s.label : s.name)}<span class="action-tag ${actionTag(s.action)}">${actionTag(s.action)}</span>`;
      pickerEl.innerHTML = sel.map(makeTag).join(' · ');
      pickerEl.title = sel.map(s => `${s.name}${s.label?':'+s.label:''} → ${actionLabel(s.action)}`).join('\n');
    }
  }

  window.filterPicker = function () {
    const v = document.getElementById('picker-search-input').value;
    renderPickerList(v);
  };

  // ─── Test — dispatches per-device actions ────────────────────────

  async function fetchDeviceState(device_id, channel) {
    try {
      const devs = await fetch('/api/devices').then(r => r.json());
      const d = devs.find(x => x.id === device_id);
      if (!d || !d.last_state) return null;

      // Channel specified (multi-gang or explicit zigbee state_lN): direct lookup
      let v;
      if (channel) {
        v = d.last_state[channel];
      } else {
        // Single-channel device — dps key varies by protocol/vendor:
        //   Tuya local: '1'
        //   Zigbee single-gang: 'state'
        //   SmartThings/HA-mapped: custom name from dps_labels (e.g., 'spots')
        const keys = Object.keys(d.last_state);
        if ('1' in d.last_state) v = d.last_state['1'];
        else if ('state' in d.last_state) v = d.last_state['state'];
        else if ('power' in d.last_state) v = d.last_state['power'];
        else if (keys.length === 1) v = d.last_state[keys[0]];  // only one key — use it
      }

      if (v === true || v === 1 || v === 'on' || v === 'ON' || v === 'true') return true;
      if (v === false || v === 0 || v === 'off' || v === 'OFF' || v === 'false') return false;
      return null;
    } catch (e) { return null; }
  }

  async function dispatchOne(device_id, channel, state) {
    const body = channel ? { state, channel } : { state };
    const r = await fetch(`/api/devices/${encodeURIComponent(device_id)}/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  window.testBinding = async function (wallmote, button, event, btn) {
    const slotKey = key(wallmote, button, event);
    const sel = bindings[slotKey] || [];
    if (sel.length === 0) {
      alert(`No devices bound to ${wallmote} ${button} ${event}. Select devices first.`);
      return;
    }
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    let ok = 0, fail = 0;
    const errors = [];
    for (const s of sel) {
      try {
        let target;
        if (s.action === 'turn_on') target = true;
        else if (s.action === 'turn_off') target = false;
        else if (s.action === 'toggle') {
          const cur = await fetchDeviceState(s.device_id, s.channel);
          target = (cur === true) ? false : true;
        }
        await dispatchOne(s.device_id, s.channel, target);
        ok++;
      } catch (e) {
        fail++;
        errors.push(`${s.name}${s.label?':'+s.label:''} ${s.action}: ${e.message}`);
      }
    }
    btn.textContent = fail === 0 ? `✓ ${ok}` : `✗ ${fail}/${ok+fail}`;
    btn.style.cssText = `background:${fail===0?'#3a7d44':'#c0392b'};color:#fff;border-color:transparent;`;
    if (fail > 0) {
      console.error('[wallmote test]', errors);
      alert(`Test: ${ok} ok, ${fail} failed:\n\n` + errors.join('\n'));
    }
    setTimeout(() => {
      btn.textContent = original; btn.disabled = false; btn.style.cssText = '';
    }, 2000);
  };

  // ─── Save — POST to dashboard_settings ──────────────────────────

  window.saveBindings = async function () {
    const saveBtn = document.querySelector('.btn-save');
    const originalText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const r = await fetch(`/api/dashboard-settings/${encodeURIComponent(STORAGE_KEY)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: bindings }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      saveBtn.textContent = '✓ Saved';
      saveBtn.style.background = '#3a7d44';
      setTimeout(() => {
        saveBtn.textContent = originalText;
        saveBtn.style.background = '';
        saveBtn.disabled = false;
      }, 1500);
    } catch (e) {
      saveBtn.textContent = '✗ Error';
      saveBtn.style.background = '#c0392b';
      alert(`Save failed: ${e.message}`);
      setTimeout(() => {
        saveBtn.textContent = originalText;
        saveBtn.style.background = '';
        saveBtn.disabled = false;
      }, 2000);
    }
  };

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activePicker) closePicker(false);
  });
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'picker-overlay' && activePicker) closePicker(false);
  });

  window.addEventListener('DOMContentLoaded', refreshPage);
})();

// ─── Room Layout Editor ────────────────────────────────────────────
// Scoped IIFE so symbols don't leak into the wallmote-tab code above.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const COLOR_WALL = '#111';
  const COLOR_WIN  = '#2c5aa0';
  const COLOR_DOOR = '#8b4513';
  const COLOR_SLIDING = '#2e7d72';

  let slug = 'living-room';
  let data = { walls: [], windows: [], doors: [], dividers: [] };
  let undoStack = [];
  let tool = 'wall';
  let pending = null;          // { type, x1, y1 }   for in-progress wall
  let pendingWall = null;      // for window/door placement: { wallId, start }
  let selectedId = null;
  // cellPx is derived from the container width so an 8m-wide room never
  // overflows the dashboard frame. Recomputed on every draw().
  let cellPx = 48;

  function svg() { return document.getElementById('layout-svg'); }
  function params() {
    return {
      cell_m: parseFloat(document.getElementById('layout-cell-m').value) || 0.5,
      w_m:    parseFloat(document.getElementById('layout-w-m').value)    || 8,
      l_m:    parseFloat(document.getElementById('layout-l-m').value)    || 6,
    };
  }
  function cols() { const p = params(); return Math.ceil(p.w_m / p.cell_m); }
  function rows() { const p = params(); return Math.ceil(p.l_m / p.cell_m); }

  // Convert between meters (data) and SVG px (display)
  function mToPx(m)   { return (m / params().cell_m) * cellPx; }
  function pxToM(px)  { return (px / cellPx) * params().cell_m; }

  // Snap `m` to the current cell size, unless noSnap is true (Shift held).
  function snapM(m, noSnap) {
    if (noSnap) return m;
    const p = params();
    return Math.round(m / p.cell_m) * p.cell_m;
  }

  function wallById(id) { return data.walls.find(w => w.id === id); }

  function pushUndo() {
    undoStack.push(JSON.stringify(data));
    if (undoStack.length > 50) undoStack.shift();
  }

  function setStatus(msg) {
    const el = document.getElementById('layout-status');
    if (el) el.textContent = msg;
  }

  window.layoutSetTool = function (t) {
    tool = t;
    pending = null;
    pendingWall = null;
    selectedId = null;
    document.querySelectorAll('.layout-tool').forEach(b => {
      const active = b.dataset.tool === t;
      b.style.outline = active ? '2px solid #27ae60' : 'none';
    });
    const hints = {
      wall:    'Click two points to draw a wall. Hold Shift to disable 90° snap.',
      window:  'Click the start point on a wall, then the end point.',
      door:    'Click the start point on a wall, then the end point.',
      sliding: 'Sliding glass door — click start + end on a wall.',
      divider: 'Click two points to mark an open-plan boundary (no physical wall).',
      select:  'Click an element to select; then Delete button removes it.',
    };
    setStatus(hints[t] || '');
    draw();
  };

  // Find the wall under (xM, yM) within tol meters. Returns wall object or null.
  function findWallAt(xM, yM, tol = 0.3) {
    for (const w of data.walls) {
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
      const len2 = dx*dx + dy*dy;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((xM - w.x1)*dx + (yM - w.y1)*dy) / len2));
      const px = w.x1 + t*dx, py = w.y1 + t*dy;
      const d = Math.hypot(xM - px, yM - py);
      if (d <= tol) return { wall: w, t };
    }
    return null;
  }

  function onSvgClick(ev) {
    const rect = svg().getBoundingClientRect();
    // Grid-snap applies only to walls + dividers (where clean positions
    // matter). Windows, doors, and sliding doors are placed ON an existing
    // wall, so the click is projected onto the wall — snapping there would
    // just prevent fine-offset placements like "0.25 m from corner".
    // Shift also disables snap (for walls/dividers) for ad-hoc free input.
    const skipSnap = !!ev.shiftKey || tool === 'window' || tool === 'door' || tool === 'sliding';
    let xM = pxToM(ev.clientX - rect.left);
    let yM = pxToM(ev.clientY - rect.top);
    xM = snapM(xM, skipSnap); yM = snapM(yM, skipSnap);

    if (tool === 'wall' || tool === 'divider') {
      if (!pending) {
        pending = { x1: xM, y1: yM };
        setStatus(`${tool} start at ${xM.toFixed(1)}, ${yM.toFixed(1)} — click end point`);
      } else {
        if (pending.x1 === xM && pending.y1 === yM) { pending = null; return; }
        pushUndo();
        if (tool === 'wall') {
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
        setStatus(`${tool} added. Click next start or pick another tool.`);
      }
    } else if (tool === 'window' || tool === 'door' || tool === 'sliding') {
      const hit = findWallAt(xM, yM);
      if (!hit) {
        setStatus('Click on an existing wall (within ~0.3 m).');
        return;
      }
      // Soft-snap the projection along the wall to the nearest OPENING_SNAP
      // metre increment so values like 0.25m are reachable predictably.
      // Shift disables this for truly free offsets.
      const OPENING_SNAP = 0.05;
      const w = wallById(hit.wall.id);
      const wallLenNow = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
      const rawOff = hit.t * wallLenNow;
      const snappedOff = ev.shiftKey ? rawOff
        : Math.round(rawOff / OPENING_SNAP) * OPENING_SNAP;
      const snappedT = Math.max(0, Math.min(1, snappedOff / wallLenNow));
      if (!pendingWall) {
        pendingWall = { wallId: hit.wall.id, t1: snappedT };
        setStatus(`${tool} start at ${snappedOff.toFixed(2)}m from S — click end point on the same wall`);
      } else if (pendingWall.wallId === hit.wall.id) {
        pushUndo();
        const t1 = Math.min(pendingWall.t1, snappedT);
        const t2 = Math.max(pendingWall.t1, snappedT);
        const wallLen = wallLenNow;
        const offset = t1 * wallLen;
        const width  = (t2 - t1) * wallLen;
        // Sliding glass doors share the doors[] array — subtype on `door_type`.
        const isDoor = (tool === 'door' || tool === 'sliding');
        const target = tool === 'window' ? data.windows : data.doors;
        target.push({
          id: tool[0] + (target.length + 1) + '_' + Date.now().toString(36),
          wall: pendingWall.wallId,
          offset_m: +offset.toFixed(2),
          width_m:  +width.toFixed(2),
          ...(isDoor ? { leads_to: null, door_type: tool === 'sliding' ? 'sliding' : 'hinged' } : {}),
        });
        pendingWall = null;
        setStatus(`${tool} added (offset ${offset.toFixed(2)}m, width ${width.toFixed(2)}m).`);
      } else {
        setStatus('Both points must be on the same wall — try again.');
        pendingWall = null;
      }
    } else if (tool === 'select') {
      // prefer window/door hits, then walls
      for (const arr of [data.doors, data.windows]) {
        for (const it of arr) {
          const w = wallById(it.wall);
          if (!w) continue;
          const wallLen = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
          const ux = (w.x2 - w.x1) / wallLen, uy = (w.y2 - w.y1) / wallLen;
          const sx = w.x1 + ux * it.offset_m, sy = w.y1 + uy * it.offset_m;
          const ex = sx + ux * it.width_m,    ey = sy + uy * it.width_m;
          const midX = (sx + ex) / 2, midY = (sy + ey) / 2;
          if (Math.hypot(xM - midX, yM - midY) < 0.3) {
            selectedId = it.id;
            setStatus(`Selected ${it.id}. Edit offset/width below, or press Delete.`);
            draw();
            refreshEditPanel();
            return;
          }
        }
      }
      // Dividers (dashed lines). Tolerance ~0.4m — match wall for easy click.
      let bestDiv = null, bestDivDist = Infinity;
      for (const d of (data.dividers || [])) {
        const dx = d.x2 - d.x1, dy = d.y2 - d.y1;
        const len2 = dx*dx + dy*dy;
        if (len2 < 1e-6) continue;
        const tt = Math.max(0, Math.min(1, ((xM - d.x1)*dx + (yM - d.y1)*dy) / len2));
        const px = d.x1 + tt*dx, py = d.y1 + tt*dy;
        const dist = Math.hypot(xM - px, yM - py);
        if (dist < bestDivDist) { bestDivDist = dist; bestDiv = d; }
      }
      if (bestDiv && bestDivDist < 0.4) {
        selectedId = bestDiv.id;
        setStatus(`Selected divider ${bestDiv.id} (${bestDivDist.toFixed(2)}m from click). Fill "Leads to" below (e.g. hallway).`);
        draw();
        refreshEditPanel();
        return;
      }
      const hit = findWallAt(xM, yM, 0.3);
      if (hit) {
        selectedId = hit.wall.id;
        setStatus(`Selected wall ${hit.wall.id}. Press Delete to remove.`);
      } else {
        selectedId = null;
        const nearDiv = bestDiv ? ` (nearest divider: ${bestDivDist.toFixed(2)}m away)` : '';
        setStatus(`No element at (${xM.toFixed(2)}m, ${yM.toFixed(2)}m)${nearDiv}. Click closer to the line.`);
      }
      refreshEditPanel();
    }
    draw();
    refreshEditPanel();
  }

  window.layoutUndo = function () {
    const prev = undoStack.pop();
    if (!prev) return;
    data = JSON.parse(prev);
    selectedId = null; pending = null; pendingWall = null;
    draw();
  };

  // Show/hide the inline edit panel for the current selection.
  // Dividers are editable for leads_to (opening to another room) but have
  // no offset/width — those inputs are hidden in that case.
  function refreshEditPanel() {
    const panel = document.getElementById('layout-edit-panel');
    if (!panel) return;
    if (!selectedId) { panel.style.display = 'none'; return; }
    const win  = (data.windows  || []).find(x => x.id === selectedId);
    const dor  = (data.doors    || []).find(x => x.id === selectedId);
    const div  = (data.dividers || []).find(x => x.id === selectedId);
    const item = win || dor || div;
    if (!item) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    document.getElementById('layout-edit-id').textContent = item.id;
    const isDivider = !!div;
    document.getElementById('layout-edit-offset-wrap').style.display = isDivider ? 'none' : 'inline';
    document.getElementById('layout-edit-width-wrap').style.display  = isDivider ? 'none' : 'inline';
    if (!isDivider) {
      document.getElementById('layout-edit-offset').value = item.offset_m;
      document.getElementById('layout-edit-width').value  = item.width_m;
    }
    const leadsWrap = document.getElementById('layout-edit-leads-wrap');
    // Show leads_to for doors (already has field) AND for dividers (opening to other room)
    if (dor || div) {
      leadsWrap.style.display = 'inline';
      document.getElementById('layout-edit-leads').value = item.leads_to || '';
    } else {
      leadsWrap.style.display = 'none';
    }
  }

  window.layoutApplyEdit = function () {
    if (!selectedId) return;
    let item = (data.windows  || []).find(x => x.id === selectedId);
    let arrName = 'windows';
    if (!item) { item = (data.doors || []).find(x => x.id === selectedId); arrName = 'doors'; }
    if (!item) { item = (data.dividers || []).find(x => x.id === selectedId); arrName = 'dividers'; }
    if (!item) return;
    if (arrName !== 'dividers') {
      const off = parseFloat(document.getElementById('layout-edit-offset').value);
      const wid = parseFloat(document.getElementById('layout-edit-width').value);
      if (!isNaN(off)) item.offset_m = +off.toFixed(2);
      if (!isNaN(wid) && wid > 0) item.width_m = +wid.toFixed(2);
    }
    if (arrName === 'doors' || arrName === 'dividers') {
      const lv = (document.getElementById('layout-edit-leads').value || '').trim();
      item.leads_to = lv || null;
    }
    pushUndo();
    draw();
    const loc = (arrName === 'dividers')
      ? `${item.id}${item.leads_to ? ` → ${item.leads_to}` : ''}`
      : `${item.id}: offset ${item.offset_m}m, width ${item.width_m}m${item.leads_to ? `, leads to ${item.leads_to}` : ''}`;
    setStatus('Updated ' + loc + '.');
  };

  window.layoutDeleteSelected = function () {
    if (!selectedId) return;
    pushUndo();
    data.walls    = data.walls.filter(w => w.id !== selectedId);
    data.windows  = data.windows.filter(x => x.id !== selectedId && x.wall !== selectedId);
    data.doors    = data.doors.filter(x => x.id !== selectedId && x.wall !== selectedId);
    data.dividers = (data.dividers || []).filter(d => d.id !== selectedId);
    selectedId = null;
    draw();
  };

  window.layoutClear = function () {
    if (!confirm('Clear ALL walls, windows, and doors?')) return;
    pushUndo();
    data = { walls: [], windows: [], doors: [], dividers: [] };
    selectedId = null; pending = null; pendingWall = null;
    draw();
  };

  window.layoutRedraw = function () { draw(); };

  async function layoutSave() {
    const p = params();
    const sharedRaw = (document.getElementById('layout-shared-with').value || '').trim();
    const sharedWith = sharedRaw
      ? sharedRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const payload = {
      shape: { type: 'rect', width_m: p.w_m, length_m: p.l_m },
      grid:  { cell_m: p.cell_m, cols: cols(), rows: rows() },
      walls: data.walls,
      windows: data.windows,
      doors: data.doors,
      dividers: data.dividers || [],
      shared_with: sharedWith,
    };
    try {
      const r = await fetch(`/api/room-layouts/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setStatus('Saved.');
    } catch (e) {
      setStatus('Save failed: ' + e.message);
    }
  }
  window.layoutSave = layoutSave;

  async function layoutLoadRoom() {
    slug = document.getElementById('layout-room-select').value || 'living-room';
    try {
      const r = await fetch(`/api/room-layouts/${slug}`);
      if (!r.ok) { data = { walls:[], windows:[], doors:[] }; draw(); return; }
      const body = await r.json();
      if (body && body.shape) {
        if (body.shape.width_m)  document.getElementById('layout-w-m').value = body.shape.width_m;
        if (body.shape.length_m) document.getElementById('layout-l-m').value = body.shape.length_m;
      }
      if (body && body.grid && body.grid.cell_m) {
        document.getElementById('layout-cell-m').value = body.grid.cell_m;
      }
      data = {
        walls:    (body && body.walls)    || [],
        windows:  (body && body.windows)  || [],
        doors:    (body && body.doors)    || [],
        dividers: (body && body.dividers) || [],
      };
      const sharedField = document.getElementById('layout-shared-with');
      if (sharedField) {
        sharedField.value = (body && Array.isArray(body.shared_with))
          ? body.shared_with.join(', ') : '';
      }
      selectedId = null;
      undoStack = [];
      draw();
      setStatus(`Loaded: ${data.walls.length} walls, ${data.windows.length} windows, ${data.doors.length} doors, ${data.dividers.length} dividers.`);
    } catch (e) {
      setStatus('Load failed: ' + e.message);
    }
  }
  window.layoutLoadRoom = layoutLoadRoom;

  function draw() {
    const s = svg();
    if (!s) return;
    const p = params();
    // Fit the canvas to the containing card, capped at 40 px/cell so rooms
    // don't become tiny for small counts. The parent element's clientWidth
    // is the available space; subtract a small padding for the scroll/border.
    // Fit the canvas to the full width of the containing card. Whatever
    // width_m is set to, the canvas fills the available page width exactly.
    // Floor at 10 px/cell so very fine grids remain visible.
    const container = s.parentElement;
    const avail = Math.max(300, (container.clientWidth || 800) - 4);
    cellPx = Math.max(10, Math.floor(avail / cols()));
    const widthPx  = cols() * cellPx;
    const heightPx = rows() * cellPx;
    s.setAttribute('width',  widthPx);
    s.setAttribute('height', heightPx);
    s.setAttribute('viewBox', `0 0 ${widthPx} ${heightPx}`);
    s.innerHTML = '';

    document.getElementById('layout-grid-info').textContent =
      `${p.w_m}m × ${p.l_m}m @ ${p.cell_m}m/cell → ${cols()} × ${rows()} cells`;

    // Grid lines — cell-level thin light, 1-meter major darker.
    // Every cell_m marks a minor gridline; every whole meter marks a major one.
    const cellsPerMeter = Math.max(1, Math.round(1 / p.cell_m));
    const gridMinor = document.createElementNS(NS, 'g');
    const gridMajor = document.createElementNS(NS, 'g');
    gridMinor.setAttribute('stroke', '#e8e4dc');
    gridMinor.setAttribute('stroke-width', 1);
    gridMajor.setAttribute('stroke', '#b8b1a5');
    gridMajor.setAttribute('stroke-width', 1);

    for (let c = 0; c <= cols(); c++) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', c * cellPx);
      line.setAttribute('y1', 0);
      line.setAttribute('x2', c * cellPx);
      line.setAttribute('y2', rows() * cellPx);
      ((c % cellsPerMeter === 0) ? gridMajor : gridMinor).appendChild(line);
    }
    for (let r = 0; r <= rows(); r++) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', 0);
      line.setAttribute('y1', r * cellPx);
      line.setAttribute('x2', cols() * cellPx);
      line.setAttribute('y2', r * cellPx);
      ((r % cellsPerMeter === 0) ? gridMajor : gridMinor).appendChild(line);
    }
    s.appendChild(gridMinor);
    s.appendChild(gridMajor);

    // Meter labels along top + left edges — only at whole-meter lines.
    const labels = document.createElementNS(NS, 'g');
    labels.setAttribute('font-family', 'system-ui, sans-serif');
    labels.setAttribute('font-size', '10');
    labels.setAttribute('fill', '#888');
    for (let c = 0; c <= cols(); c += cellsPerMeter) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', c * cellPx + 2);
      t.setAttribute('y', 11);
      t.textContent = (c * p.cell_m).toFixed(0) + 'm';
      labels.appendChild(t);
    }
    for (let r = 0; r <= rows(); r += cellsPerMeter) {
      if (r === 0) continue;
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', 2);
      t.setAttribute('y', r * cellPx - 2);
      t.textContent = (r * p.cell_m).toFixed(0) + 'm';
      labels.appendChild(t);
    }
    s.appendChild(labels);

    // Walls
    for (const w of data.walls) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', mToPx(w.x1));
      line.setAttribute('y1', mToPx(w.y1));
      line.setAttribute('x2', mToPx(w.x2));
      line.setAttribute('y2', mToPx(w.y2));
      line.setAttribute('stroke', COLOR_WALL);
      line.setAttribute('stroke-width', w.id === selectedId ? 5 : 3);
      line.setAttribute('stroke-linecap', 'square');
      s.appendChild(line);
    }

    // Dividers — dashed lines. Grey = open-plan boundary within same space.
    // Blue = opening / passage to another room (leads_to is set).
    for (const d of (data.dividers || [])) {
      const hasLeads = !!d.leads_to;
      const color = hasLeads ? '#2c5aa0' : '#888';
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', mToPx(d.x1));
      line.setAttribute('y1', mToPx(d.y1));
      line.setAttribute('x2', mToPx(d.x2));
      line.setAttribute('y2', mToPx(d.y2));
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', d.id === selectedId ? 3 : 2);
      line.setAttribute('stroke-dasharray', '6,4');
      s.appendChild(line);
      if (hasLeads) {
        const mx = (d.x1 + d.x2) / 2, my = (d.y1 + d.y2) / 2;
        const lbl = document.createElementNS(NS, 'text');
        lbl.setAttribute('x', mToPx(mx) + 4);
        lbl.setAttribute('y', mToPx(my) - 4);
        lbl.setAttribute('font-size', '10');
        lbl.setAttribute('font-weight', 'bold');
        lbl.setAttribute('fill', color);
        lbl.textContent = '→ ' + d.leads_to;
        s.appendChild(lbl);
      }
    }

    // Windows + doors share geometry setup: derive start/end on parent wall
    function wallGeom(item) {
      const w = wallById(item.wall);
      if (!w) return null;
      const wallLen = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
      if (wallLen < 1e-6) return null;
      const ux = (w.x2 - w.x1) / wallLen, uy = (w.y2 - w.y1) / wallLen;
      const nx = -uy, ny = ux;  // unit normal (choose one consistent side)
      const sx = w.x1 + ux * item.offset_m, sy = w.y1 + uy * item.offset_m;
      const ex = sx + ux * item.width_m,    ey = sy + uy * item.width_m;
      return { ux, uy, nx, ny, sx, sy, ex, ey };
    }

    // Architectural window: white/tinted band with blue outline + centerline.
    // The band overwrites the wall underneath so it looks like an opening.
    data.windows.forEach(item => {
      const g = wallGeom(item);
      if (!g) return;
      const t = 0.10;  // half-thickness (perpendicular) in meters
      const corners = [
        [g.sx - g.nx*t, g.sy - g.ny*t],
        [g.ex - g.nx*t, g.ey - g.ny*t],
        [g.ex + g.nx*t, g.ey + g.ny*t],
        [g.sx + g.nx*t, g.sy + g.ny*t],
      ];
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', corners.map(p => `${mToPx(p[0])},${mToPx(p[1])}`).join(' '));
      poly.setAttribute('fill', '#d8e6f5');
      poly.setAttribute('stroke', COLOR_WIN);
      poly.setAttribute('stroke-width', item.id === selectedId ? 2 : 1);
      s.appendChild(poly);
      // Glass centerline (thin)
      const mid = document.createElementNS(NS, 'line');
      mid.setAttribute('x1', mToPx(g.sx)); mid.setAttribute('y1', mToPx(g.sy));
      mid.setAttribute('x2', mToPx(g.ex)); mid.setAttribute('y2', mToPx(g.ey));
      mid.setAttribute('stroke', COLOR_WIN);
      mid.setAttribute('stroke-width', 1);
      s.appendChild(mid);
    });

    // Doors: architectural rendering branches by door_type.
    data.doors.forEach(item => {
      const g = wallGeom(item);
      if (!g) return;
      if (item.door_type === 'sliding') {
        // Sliding glass door — two overlapping glass panels on parallel tracks.
        const t = 0.12;  // half-thickness
        // Tinted glass band
        const corners = [
          [g.sx - g.nx*t, g.sy - g.ny*t],
          [g.ex - g.nx*t, g.ey - g.ny*t],
          [g.ex + g.nx*t, g.ey + g.ny*t],
          [g.sx + g.nx*t, g.sy + g.ny*t],
        ];
        const glass = document.createElementNS(NS, 'polygon');
        glass.setAttribute('points', corners.map(p => `${mToPx(p[0])},${mToPx(p[1])}`).join(' '));
        glass.setAttribute('fill', '#d4ebe6');
        glass.setAttribute('stroke', COLOR_SLIDING);
        glass.setAttribute('stroke-width', item.id === selectedId ? 2 : 1);
        s.appendChild(glass);
        // Two parallel tracks (top/bottom of frame)
        const halfW = item.width_m / 2;
        function panel(offsetPerp, startAlong, endAlong) {
          const line = document.createElementNS(NS, 'line');
          const x1 = g.sx + g.ux*startAlong + g.nx*offsetPerp;
          const y1 = g.sy + g.uy*startAlong + g.ny*offsetPerp;
          const x2 = g.sx + g.ux*endAlong   + g.nx*offsetPerp;
          const y2 = g.sy + g.uy*endAlong   + g.ny*offsetPerp;
          line.setAttribute('x1', mToPx(x1)); line.setAttribute('y1', mToPx(y1));
          line.setAttribute('x2', mToPx(x2)); line.setAttribute('y2', mToPx(y2));
          line.setAttribute('stroke', COLOR_SLIDING);
          line.setAttribute('stroke-width', 2);
          s.appendChild(line);
        }
        // Left glass panel (outer track)
        panel(-t*0.4, 0, halfW + 0.1);
        // Right glass panel (inner track, overlapping)
        panel( t*0.4, halfW - 0.1, item.width_m);
        // Small arrow hint of sliding direction (centered)
        const arrow = document.createElementNS(NS, 'text');
        arrow.setAttribute('x', mToPx(g.sx + g.ux*halfW));
        arrow.setAttribute('y', mToPx(g.sy + g.uy*halfW) + 4);
        arrow.setAttribute('font-size', '10');
        arrow.setAttribute('fill', COLOR_SLIDING);
        arrow.setAttribute('text-anchor', 'middle');
        arrow.textContent = '↔';
        s.appendChild(arrow);
        return;
      }
      // Hinged door (default / legacy)
      const t = 0.08;
      const corners = [
        [g.sx - g.nx*t, g.sy - g.ny*t],
        [g.ex - g.nx*t, g.ey - g.ny*t],
        [g.ex + g.nx*t, g.ey + g.ny*t],
        [g.sx + g.nx*t, g.sy + g.ny*t],
      ];
      const erase = document.createElementNS(NS, 'polygon');
      erase.setAttribute('points', corners.map(p => `${mToPx(p[0])},${mToPx(p[1])}`).join(' '));
      erase.setAttribute('fill', '#fafaf7');
      erase.setAttribute('stroke', 'none');
      s.appendChild(erase);
      const lx = g.nx, ly = g.ny;
      const leafEndX = g.sx + lx * item.width_m;
      const leafEndY = g.sy + ly * item.width_m;
      const leaf = document.createElementNS(NS, 'line');
      leaf.setAttribute('x1', mToPx(g.sx)); leaf.setAttribute('y1', mToPx(g.sy));
      leaf.setAttribute('x2', mToPx(leafEndX)); leaf.setAttribute('y2', mToPx(leafEndY));
      leaf.setAttribute('stroke', COLOR_DOOR);
      leaf.setAttribute('stroke-width', item.id === selectedId ? 3 : 2);
      s.appendChild(leaf);
      const arc = document.createElementNS(NS, 'path');
      const r = item.width_m;
      const rPx = mToPx(r);
      arc.setAttribute('d', `M ${mToPx(leafEndX)} ${mToPx(leafEndY)} A ${rPx} ${rPx} 0 0 0 ${mToPx(g.ex)} ${mToPx(g.ey)}`);
      arc.setAttribute('fill', 'none');
      arc.setAttribute('stroke', COLOR_DOOR);
      arc.setAttribute('stroke-width', 1);
      arc.setAttribute('stroke-dasharray', '3,3');
      s.appendChild(arc);
      const hinge = document.createElementNS(NS, 'circle');
      hinge.setAttribute('cx', mToPx(g.sx));
      hinge.setAttribute('cy', mToPx(g.sy));
      hinge.setAttribute('r', 3);
      hinge.setAttribute('fill', COLOR_DOOR);
      s.appendChild(hinge);
    });

    // leads_to labels — same style as divider labels, so the destination
    // of every door / sliding / passage-divider is visible on the canvas.
    for (const item of data.doors || []) {
      if (!item.leads_to) continue;
      const g = wallGeom(item);
      if (!g) continue;
      const midX = (g.sx + g.ex) / 2, midY = (g.sy + g.ey) / 2;
      const isSliding = item.door_type === 'sliding';
      const color = isSliding ? COLOR_SLIDING : COLOR_DOOR;
      // Offset the label perpendicular to the wall so it doesn't overlap the opening.
      const off = 0.25;
      const lbl = document.createElementNS(NS, 'text');
      lbl.setAttribute('x', mToPx(midX + g.nx * off));
      lbl.setAttribute('y', mToPx(midY + g.ny * off));
      lbl.setAttribute('font-size', '10');
      lbl.setAttribute('font-weight', 'bold');
      lbl.setAttribute('fill', color);
      lbl.setAttribute('text-anchor', 'middle');
      lbl.textContent = '→ ' + item.leads_to;
      s.appendChild(lbl);
    }

    // Pending wall in-flight (ghost from first click to cursor)
    if (pending) {
      const marker = document.createElementNS(NS, 'circle');
      marker.setAttribute('cx', mToPx(pending.x1));
      marker.setAttribute('cy', mToPx(pending.y1));
      marker.setAttribute('r', 4);
      marker.setAttribute('fill', '#27ae60');
      s.appendChild(marker);
    }
  }

  // Init + event wiring
  // Live cursor feedback — status bar text PLUS a visible marker on the
  // canvas so the user sees where the click will land BEFORE committing.
  function onSvgMove(ev) {
    const rect = svg().getBoundingClientRect();
    const xM = pxToM(ev.clientX - rect.left);
    const yM = pxToM(ev.clientY - rect.top);
    let msg = `cursor: ${xM.toFixed(2)}m, ${yM.toFixed(2)}m`;
    let markerX = mToPx(xM), markerY = mToPx(yM), markerOffset = null;
    if (tool === 'window' || tool === 'door' || tool === 'sliding') {
      const hit = findWallAt(xM, yM);
      if (hit) {
        const w = hit.wall;
        const wallLen = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
        // Apply the same 0.05m soft-snap here so the hover marker lands on
        // the exact position a click will commit to.
        const OPENING_SNAP = 0.05;
        const rawOff  = hit.t * wallLen;
        const snapped = ev.shiftKey ? rawOff : Math.round(rawOff / OPENING_SNAP) * OPENING_SNAP;
        const snapT   = Math.max(0, Math.min(1, snapped / wallLen));
        markerOffset  = snapped;
        const fromEnd = wallLen - snapped;
        markerX = mToPx(w.x1 + snapT * (w.x2 - w.x1));
        markerY = mToPx(w.y1 + snapT * (w.y2 - w.y1));
        const nearer = markerOffset <= fromEnd
          ? { d: markerOffset, from: 'S' }
          : { d: fromEnd,      from: 'E' };
        window._markerNear = nearer;
        msg += `  ·  ${nearer.d.toFixed(2)}m from ${nearer.from}  (S=${markerOffset.toFixed(2)}m, E=${fromEnd.toFixed(2)}m)`;
      } else {
        msg += '  ·  (no wall under cursor)';
      }
    }
    setStatus(msg);
    let marker = document.getElementById('layout-cursor-marker');
    const s = svg();
    if (!marker) {
      marker = document.createElementNS(NS, 'g');
      marker.setAttribute('id', 'layout-cursor-marker');
      marker.setAttribute('pointer-events', 'none');
      s.appendChild(marker);
    }
    marker.innerHTML = '';
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', markerX);
    dot.setAttribute('cy', markerY);
    dot.setAttribute('r', 4);
    dot.setAttribute('fill', markerOffset !== null ? '#27ae60' : '#aaa');
    dot.setAttribute('stroke', '#fff');
    dot.setAttribute('stroke-width', 1);
    marker.appendChild(dot);
    if (markerOffset !== null) {
      const near = window._markerNear || { d: markerOffset, from: 'S' };
      const lbl = document.createElementNS(NS, 'text');
      lbl.setAttribute('x', markerX + 8);
      lbl.setAttribute('y', markerY - 6);
      lbl.setAttribute('font-size', '11');
      lbl.setAttribute('fill', '#27ae60');
      lbl.setAttribute('font-weight', 'bold');
      lbl.textContent = `${near.d.toFixed(2)}m from ${near.from}`;
      marker.appendChild(lbl);
    }
  }

  window.layoutInit = function () {
    if (window._layoutInitDone) { draw(); return; }
    window._layoutInitDone = true;
    svg().addEventListener('click', onSvgClick);
    svg().addEventListener('mousemove', onSvgMove);
    // Populate the "Leads to" dropdown from the rooms table (slugs).
    fetch('/api/room-slugs').then(r => r.ok ? r.json() : []).then(rooms => {
      const sel = document.getElementById('layout-edit-leads');
      if (!sel || !Array.isArray(rooms)) return;
      for (const r of rooms) {
        const opt = document.createElement('option');
        opt.value = r.slug;
        opt.textContent = `${r.name} (${r.slug})`;
        sel.appendChild(opt);
      }
    }).catch(() => {});
    // Re-fit canvas when the window is resized (debounced).
    let _resizeT;
    window.addEventListener('resize', () => {
      clearTimeout(_resizeT);
      _resizeT = setTimeout(draw, 100);
    });
    layoutLoadRoom();
    // Default to wall tool selected
    layoutSetTool('wall');
  };
})();
