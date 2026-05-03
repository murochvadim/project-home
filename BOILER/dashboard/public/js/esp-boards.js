// esp-boards.js — Project Boards page
//
// Owns: load boards, render tab bar, per-board sub-tabs (Status / Params /
// Test / OTA). Reads from /api/esp/boards, writes via PATCH + POST endpoints.
// MQTT ack subscription is intentionally NOT implemented in v1 — acks are
// silent, the Test button just shows "Sent" (Phase 4 scope).

let BOARDS = [];
let SELECTED_ID = null;
let SELECTED_SUB_TAB = 'status';   // persists across auto-refresh re-renders
let PARAMS_DIRTY = false;          // user has typed but not saved → auto-refresh is suppressed
const ONLINE_AGE_SEC = 180;   // 3 missed heartbeats — matches isOnline() in devices.js for esp branch

// ─── Helpers ───────────────────────────────────────────────────────────
function ageSec(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 1000;
}

function isOnline(b) {
  return ageSec(b.last_seen) < ONLINE_AGE_SEC;
}

function fmtUptime(s) {
  if (s == null) return '—';
  s = parseInt(s, 10);
  if (!isFinite(s)) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function fmtAge(iso) {
  const s = ageSec(iso);
  if (!isFinite(s)) return 'never';
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtBytes(b) {
  if (b == null || !isFinite(b)) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const DESTRUCTIVE_ACTIONS = new Set(['reset_wifi', 'clear_eeprom', 'restart', 'factory_reset']);

// Action grouping — drives which sub-tab + card a given schema action key
// renders in. Groups with `tab='status'` go into the Status sub-tab as a
// system card; everything else lands in the Simulation sub-tab. Actions in
// the schema but NOT listed here fall through to a generic "Other" card so
// new sketches stay visible without dashboard edits.
const ACTION_GROUPS = [
  { id: 'system',   label: 'System',        tab: 'status',     keys: ['restart', 'clear_eeprom', 'reset_wifi'] },
  { id: 'doorlock', label: 'Doorlock',      tab: 'simulation', keys: ['open_doorlock'],                           statusFlag: 'door_relay',   statusLabel: 'Door Relay' },
  { id: 'robot',    label: 'Robot',         tab: 'simulation', keys: ['robot_alive', 'robot_lost_power'],         statusFlag: 'charge_relay', statusLabel: 'Charge Relay' },
  { id: 'hivemq',   label: 'HiveMQ Bridge', tab: 'simulation', keys: ['reconnect_hivemq', 'sim_came_parking', 'sim_in_parking', 'sim_no_data'] },
];

// ─── Load + render ─────────────────────────────────────────────────────
// `auto=true` is passed by the 30 s timer; user-initiated refreshes call
// loadBoards() with no arg.
async function loadBoards(auto = false) {
  // Suppress auto-refresh when user is mid-edit (would discard their typed
  // values + jump them back to Status). Manual refresh button still works.
  if (auto && PARAMS_DIRTY) {
    document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString() + ' (skipped — unsaved edits)';
    return;
  }
  document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString();
  try {
    const r = await fetch('/api/esp/boards');
    const data = await r.json();
    BOARDS = data.boards || [];
  } catch (e) {
    BOARDS = [];
    document.getElementById('summary-text').innerHTML = `<span style="color:#c0392b;">Failed to load: ${escHtml(e.message)}</span>`;
    return;
  }
  renderSummary();
  renderTabs();
  if (BOARDS.length === 0) {
    // Empty state already rendered in HTML
    return;
  }
  if (!SELECTED_ID || !BOARDS.find(b => b.id === SELECTED_ID)) {
    SELECTED_ID = BOARDS[0].id;
  }
  renderBoardPane();
}

function renderSummary() {
  const online = BOARDS.filter(isOnline).length;
  const offline = BOARDS.length - online;
  let html = '';
  if (BOARDS.length === 0) {
    html = '<span style="color:#888;">No boards registered</span>';
  } else {
    html = `<span class="pill online">${online} online</span>`;
    if (offline > 0) html += `<span class="pill offline">${offline} offline</span>`;
    html += `<span style="color:#888;">${BOARDS.length} total</span>`;
  }
  document.getElementById('summary-text').innerHTML = html;
}

function renderTabs() {
  const host = document.getElementById('board-tabs');
  if (BOARDS.length === 0) { host.innerHTML = ''; return; }
  host.innerHTML = BOARDS.map(b => {
    const dotClass = !b.last_seen ? 'unknown' : (isOnline(b) ? 'online' : 'offline');
    const active = b.id === SELECTED_ID ? 'active' : '';
    return `<div class="board-tab ${active}" data-id="${escHtml(b.id)}">
      <span class="dot ${dotClass}">●</span>${escHtml(b.name || b.id)}
    </div>`;
  }).join('');
  host.querySelectorAll('.board-tab').forEach(el => {
    el.addEventListener('click', () => {
      SELECTED_ID = el.dataset.id;
      renderTabs();
      renderBoardPane();
    });
  });
}

function renderBoardPane() {
  const board = BOARDS.find(b => b.id === SELECTED_ID);
  const host = document.getElementById('board-pane');
  if (!board) { host.innerHTML = ''; return; }
  // Render with all sub-tab buttons + panels inactive; we activate the
  // remembered SELECTED_SUB_TAB explicitly below so the user's choice
  // survives the 30 s auto-refresh re-render.
  host.innerHTML = `
    <div class="card" style="padding:14px;">
      <div class="sub-tabs">
        <button class="sub-tab" data-pane="status">Status</button>
        <button class="sub-tab" data-pane="params">Params</button>
        <button class="sub-tab" data-pane="simulation">Simulation</button>
        <button class="sub-tab" data-pane="ota">OTA</button>
      </div>
      <div class="sub-panel" id="sub-status">${renderStatus(board)}</div>
      <div class="sub-panel" id="sub-params">${renderParams(board)}</div>
      <div class="sub-panel" id="sub-simulation">${renderSimulation(board)}</div>
      <div class="sub-panel" id="sub-ota">${renderOta(board)}</div>
    </div>
  `;
  // Apply the remembered tab; fall back to status if the remembered one is
  // somehow absent (defensive — shouldn't happen).
  const activate = (pane) => {
    host.querySelectorAll('.sub-tab').forEach(t => t.classList.toggle('active', t.dataset.pane === pane));
    host.querySelectorAll('.sub-panel').forEach(p => p.classList.toggle('active', p.id === 'sub-' + pane));
  };
  activate(host.querySelector(`.sub-tab[data-pane="${SELECTED_SUB_TAB}"]`) ? SELECTED_SUB_TAB : 'status');
  host.querySelectorAll('.sub-tab').forEach(el => {
    el.addEventListener('click', () => {
      SELECTED_SUB_TAB = el.dataset.pane;
      activate(SELECTED_SUB_TAB);
    });
  });
  wireParamsForm(board);
  wireActionButtons(board);   // covers System (in Status) + Simulation buttons
  wireOtaForm(board);
  // Live MQTT stream is page-level now — wired once from init(), not per
  // board. No call here.
}

// ─── Sub-panel: Status ─────────────────────────────────────────────────
// Renders a small dot+label cell for board-side connection / relay state.
// `value` is a tri-state: true → green ●, false → red ●, null/undefined → grey ●.
function dotCell(value, trueText, falseText) {
  if (value == null) return `<span style="color:#aaa;">●</span> <span style="color:#aaa;font-style:italic;">unknown</span>`;
  return value
    ? `<span style="color:#3a7d44;">●</span> ${trueText}`
    : `<span style="color:#c0392b;">●</span> ${falseText}`;
}

function renderStatus(b) {
  const status = b.last_status || {};
  const online = isOnline(b);
  const dotColor = online ? '#3a7d44' : (b.last_seen ? '#c0392b' : '#aaa');
  const onlineText = !b.last_seen ? 'never seen' : (online ? 'online' : 'offline');
  return `
    <div class="esp-card">
      <h3 class="esp-card-title">Connection</h3>
      <div class="status-grid">
        <div class="item"><label>Status</label><div class="value">
          <span style="color:${dotColor};">●</span> ${onlineText}
        </div></div>
        <div class="item"><label>IP</label><div class="value ${b.ip ? '' : 'dim'}">${escHtml(b.ip || '—')}</div></div>
        <div class="item"><label>Last seen</label><div class="value ${b.last_seen ? '' : 'dim'}">${fmtAge(b.last_seen)}</div></div>
        <div class="item"><label>MAC</label><div class="value ${b.mac ? '' : 'dim'}">${escHtml(b.mac || '—')}</div></div>

        <div class="item"><label>Sketch</label><div class="value ${b.sketch_name ? '' : 'dim'}">${escHtml(b.sketch_name || '—')}</div></div>
        <div class="item"><label>Version</label><div class="value ${b.sketch_version ? '' : 'dim'}">${escHtml(b.sketch_version || '—')}</div></div>
        <div class="item"><label>Uptime</label><div class="value ${status.uptime_s != null ? '' : 'dim'}">${fmtUptime(status.uptime_s)}</div></div>
        <div class="item"><label>RSSI</label><div class="value ${status.rssi != null ? '' : 'dim'}">${status.rssi != null ? status.rssi + ' dBm' : '—'}</div></div>

        <div class="item"><label>Free heap</label><div class="value ${status.free_heap != null ? '' : 'dim'}">${fmtBytes(status.free_heap)}</div></div>
        <div class="item"><label>Build</label><div class="value ${status.build_ts ? '' : 'dim'}" style="font-size:0.82rem;">${escHtml(status.build_ts || '—')}</div></div>
        <div class="item"><label>OTA password</label><div class="value ${b.has_ota_password ? '' : 'dim'}">${b.has_ota_password ? 'set' : 'not set'}</div></div>
        <div class="item"><label>Enabled</label><div class="value">${b.enabled ? 'yes' : 'no'}</div></div>
      </div>
    </div>

    <div class="esp-card">
      <h3 class="esp-card-title">Brokers</h3>
      <div class="status-grid">
        <div class="item"><label>HiveMQ Cloud</label><div class="value">${dotCell(online ? status.hivemq_connected : null, 'connected', 'disconnected')}</div></div>
        <div class="item"><label>Mosquitto (LXC 107)</label><div class="value">${dotCell(online ? status.mosq_connected : null, 'connected', 'disconnected')}</div></div>
      </div>
      ${online ? '' : '<p style="margin:8px 0 0 0;font-size:0.75rem;color:#aaa;font-style:italic;">Board is offline — broker state shown as unknown until heartbeat resumes.</p>'}
    </div>

    ${renderActionGroup(b, ACTION_GROUPS.find(g => g.id === 'system'), { destructive: true })}
  `;
}

// Generic group renderer used by Status (system card) AND Simulation tab.
// `opts.destructive`: true → all buttons get the destructive (red) class
//                            and a confirm dialog before sending. Otherwise
//                            destructive flagging falls back to per-action
//                            DESTRUCTIVE_ACTIONS set.
function renderActionGroup(b, group, opts = {}) {
  if (!group) return '';
  const schemaActions = (b.schema?.actions || []);
  const present = group.keys
    .map(k => schemaActions.find(a => a.key === k))
    .filter(Boolean);
  // If schema hasn't arrived yet, render an explanatory empty-state for
  // the simulation tab; for the status tab (System card), skip silently
  // to avoid clutter when the board is offline or pre-schema.
  if (!present.length) {
    if (group.tab !== 'simulation') return '';
    return `<div class="esp-card"><h3 class="esp-card-title">${escHtml(group.label)}</h3>
      <div class="empty-state" style="padding:14px;font-size:0.85rem;">No matching actions in board schema yet.</div></div>`;
  }
  const status = b.last_status || {};
  const online = isOnline(b);
  const statusRow = group.statusFlag
    ? `<div style="margin-bottom:10px;font-size:0.85rem;">
         <strong>${escHtml(group.statusLabel)}:</strong>
         ${dotCell(online ? status[group.statusFlag] : null, '<span style="color:#c0392b;">ON</span>', '<span style="color:#888;">off</span>')}
       </div>`
    : '';
  const buttons = present.map(a => {
    const cls = (opts.destructive || DESTRUCTIVE_ACTIONS.has(a.key)) ? 'destructive' : '';
    return `<button class="action-btn ${cls}" data-action-key="${escHtml(a.key)}" title="${escHtml(a.description || '')}">
      ▶ ${escHtml(a.label || a.key)}<span class="badge" data-badge-for="${escHtml(a.key)}" style="display:none;"></span>
    </button>`;
  }).join('');
  return `
    <div class="esp-card">
      <h3 class="esp-card-title">${escHtml(group.label)}</h3>
      ${statusRow}
      <div class="actions-grid">${buttons}</div>
    </div>
  `;
}

// ─── Sub-panel: Params ─────────────────────────────────────────────────
function renderParams(b) {
  const schemaParams = (b.schema && Array.isArray(b.schema.parameters)) ? b.schema.parameters : [];
  if (!schemaParams.length) {
    return `<div class="empty-state" style="padding:14px;">
      <p>This board has not published a parameter schema yet.</p>
      <p style="font-size:0.8rem;color:#aaa;">Schema arrives on the board's next Mosquitto connect (topic <code>mur/home/esp/${escHtml(b.id)}/schema</code>).</p>
    </div>`;
  }
  const current = b.parameters || {};
  let rowsHtml = '';
  for (const p of schemaParams) {
    const val = current[p.key] != null ? current[p.key] : (p.default != null ? p.default : '');
    const range = (p.min != null && p.max != null)
      ? `${p.min}–${p.max}`
      : (p.min_length != null && p.max_length != null) ? `${p.min_length}–${p.max_length} chars` : '';
    let inputType;
    if (p.secret)                                       inputType = 'password';
    else if (p.type === 'int' || p.type === 'float')    inputType = 'number';
    else                                                inputType = 'text';
    const unitTxt = p.unit || (p.type === 'int' ? 'int' : (p.type === 'string' ? 'string' : ''));
    rowsHtml += `
      <div class="label">
        <span class="key">${escHtml(p.key)}</span>
        <span class="desc">${escHtml(p.description || '')}</span>
      </div>
      <input type="${inputType}" data-param-key="${escHtml(p.key)}" value="${escHtml(val)}"
             ${p.min != null ? `min="${p.min}"` : ''} ${p.max != null ? `max="${p.max}"` : ''}
             ${p.min_length != null ? `minlength="${p.min_length}"` : ''} ${p.max_length != null ? `maxlength="${p.max_length}"` : ''}
             ${p.secret ? 'autocomplete="off" spellcheck="false"' : ''}>
      <span class="unit">${escHtml(unitTxt)}</span>
      <span class="range">${range ? `range ${range}` : ''}</span>
    `;
  }
  return `
    <div class="params-form">${rowsHtml}</div>
    <button class="btn-save-params" id="btn-save-params">Save Parameters</button>
    <span class="save-status" id="params-save-status"></span>
    <p style="margin-top:14px;font-size:0.78rem;color:#888;">
      Save publishes JSON to <code>mur/home/esp/${escHtml(b.id)}/config</code> — board reads it, updates its <code>EspParams</code> struct, and persists to EEPROM.
    </p>
  `;
}

function wireParamsForm(board) {
  const btn = document.getElementById('btn-save-params');
  if (!btn) return;
  // Mark form dirty on first input — auto-refresh will skip while dirty so
  // the user's typed values + active sub-tab aren't clobbered mid-edit.
  document.querySelectorAll('[data-param-key]').forEach(el => {
    el.addEventListener('input', () => { PARAMS_DIRTY = true; });
  });
  btn.addEventListener('click', async () => {
    const payload = {};
    document.querySelectorAll('[data-param-key]').forEach(el => {
      const k = el.dataset.paramKey;
      const v = el.value;
      if (v === '') return;
      const schemaP = (board.schema?.parameters || []).find(p => p.key === k);
      const t = schemaP?.type;
      if (t === 'int') payload[k] = parseInt(v, 10);
      else if (t === 'float') payload[k] = parseFloat(v);
      else if (t === 'bool') payload[k] = (v === 'true' || v === '1' || v === 'on');
      else payload[k] = v;
    });
    btn.disabled = true;
    const status = document.getElementById('params-save-status');
    status.className = 'save-status';
    status.textContent = 'Saving…';
    try {
      const r = await fetch(`/api/esp/boards/${encodeURIComponent(board.id)}/parameters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      status.className = 'save-status ok';
      status.textContent = '✓ Saved + published';
      PARAMS_DIRTY = false;  // clear dirty so auto-refresh resumes
      // Refresh after 2s so the board's new params show in DB next time we render
      setTimeout(() => loadBoards(true), 2000);
    } catch (e) {
      status.className = 'save-status fail';
      status.textContent = '✗ ' + e.message;
    } finally {
      btn.disabled = false;
    }
  });
}

// ─── Sub-panel: Simulation (was Test) ──────────────────────────────────
function renderSimulation(b) {
  const schemaActions = b.schema?.actions || [];
  if (!schemaActions.length) {
    return `<div class="empty-state" style="padding:14px;">
      <p>This board has not published an action schema yet.</p>
      <p style="font-size:0.8rem;color:#aaa;">Schema arrives on the board's next Mosquitto connect (topic <code>mur/home/esp/${escHtml(b.id)}/schema</code>).</p>
    </div>`;
  }
  // Render every Simulation-tab group, then a fallback "Other" card for any
  // schema actions not assigned to a group above.
  const groupedKeys = new Set();
  ACTION_GROUPS.forEach(g => g.keys.forEach(k => groupedKeys.add(k)));
  let html = ACTION_GROUPS.filter(g => g.tab === 'simulation').map(g => renderActionGroup(b, g)).join('');
  const ungrouped = schemaActions.filter(a => !groupedKeys.has(a.key));
  if (ungrouped.length) {
    const buttons = ungrouped.map(a => {
      const cls = DESTRUCTIVE_ACTIONS.has(a.key) ? 'destructive' : '';
      return `<button class="action-btn ${cls}" data-action-key="${escHtml(a.key)}" title="${escHtml(a.description || '')}">
        ▶ ${escHtml(a.label || a.key)}<span class="badge" data-badge-for="${escHtml(a.key)}" style="display:none;"></span>
      </button>`;
    }).join('');
    html += `<div class="esp-card"><h3 class="esp-card-title">Other</h3><div class="actions-grid">${buttons}</div></div>`;
  }
  html += `<p style="font-size:0.78rem;color:#888;margin:6px 0 14px 0;">
    Each click sends the action key to <code>mur/home/esp/${escHtml(b.id)}/command</code>. Destructive actions confirm before sending. Watch the page-level <strong>Live MQTT Events</strong> card (top of page) for board-side ack + bridged events from any board.
  </p>`;
  return html;
}

// Wires button click handlers across BOTH Status (system card) and
// Simulation sub-tabs — selectors below are document-wide.
function wireActionButtons(board) {
  document.querySelectorAll('[data-action-key]').forEach(btn => {
    // Skip already-wired buttons (renderBoardPane is called multiple times)
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', async () => {
      const action = btn.dataset.actionKey;
      if (DESTRUCTIVE_ACTIONS.has(action)) {
        // Use single-quoted dialog text so a board name containing double-quotes
        // doesn't visually break the message. (confirm() is plain text — no XSS,
        // just readability.)
        const target = (board.name || board.id || '').replace(/'/g, "\\'");
        if (!confirm(`Run '${action}' on '${target}'?\n\nThis is a destructive action.`)) return;
      }
      // Use sibling traversal to find the badge — avoids constructing a CSS
      // attribute selector with a value that may contain quotes/brackets if a
      // future board's schema action key has unusual characters.
      const badge = btn.querySelector('.badge');
      if (badge) {
        badge.style.display = '';
        badge.className = 'badge pending';
        badge.textContent = 'sending';
      }
      try {
        const r = await fetch(`/api/esp/boards/${encodeURIComponent(board.id)}/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        if (badge) {
          badge.className = 'badge ok';
          badge.textContent = 'sent';
          setTimeout(() => { badge.style.display = 'none'; }, 4000);
        }
      } catch (e) {
        if (badge) {
          badge.className = 'badge fail';
          badge.textContent = e.message;
        }
      }
    });
  });
}

// ─── Page-level Live MQTT Events ─────────────────────────────────────────
// Subscribes to mur/home/esp/+/event (wildcard) so events from EVERY board
// appear here, not just the currently-selected board. Persists for the
// whole page session — no tear-down on board switch. Each row carries a
// board-ID badge parsed from the topic so you can tell who emitted what.
const LIVE_BROKER_HOST = '192.168.1.189';   // LXC 107 — broker WebSocket listener (port 9001)
const LIVE_BROKER_PORT = 9001;
const LIVE_USER        = 'dashboard_browser';
const LIVE_TOPIC       = 'mur/home/esp/+/event';
const LIVE_MAX_ROWS    = 50;

let _liveMqtt = null;
let _liveRows = [];

function liveSetStatus(text, color = '#aaa') {
  const el = document.getElementById('live-status');
  if (el) { el.textContent = text; el.style.color = color; }
}

function liveAppendRow(payloadStr, topic) {
  let parsed;
  try { parsed = JSON.parse(payloadStr); } catch (_) { parsed = { raw: payloadStr }; }
  // Topic format: mur/home/esp/<id>/event — extract the id for the badge.
  const parts = String(topic || '').split('/');
  const boardId = parts.length >= 4 ? parts[3] : '?';
  const time = new Date().toLocaleTimeString();
  _liveRows.unshift({ time, topic, boardId, ...parsed });
  if (_liveRows.length > LIVE_MAX_ROWS) _liveRows.length = LIVE_MAX_ROWS;
  liveRedraw();
}

function liveRedraw() {
  const host = document.getElementById('live-rows');
  if (!host) return;
  if (!_liveRows.length) { host.innerHTML = '<div style="color:#888;font-style:italic;">awaiting first event…</div>'; return; }
  host.innerHTML = _liveRows.map(r => {
    const kindColor = r.kind === 'rx' ? '#7fc97f'
                    : r.kind === 'ack' ? '#a6cee3'
                    : r.kind === 'sim' ? '#fdc086'
                    : '#bbb';
    // Board id badge — distinct neutral color so it doesn't compete with kind/src
    const idChip = `<span style="background:#3a4452;color:#dde;padding:1px 6px;border-radius:3px;font-size:0.7rem;font-weight:600;">${escHtml(r.boardId)}</span>`;
    const srcChip = r.src ? `<span style="background:${kindColor};color:#000;padding:1px 6px;border-radius:3px;font-size:0.7rem;font-weight:600;">${escHtml(r.src)}</span>` : '';
    const kindChip = r.kind ? `<span style="color:${kindColor};">${escHtml(r.kind)}</span>` : '';
    const tpc = r.topic ? `<span style="color:#888;">${escHtml(r.topic)}</span>` : '';
    const payload = r.payload != null ? `<span style="color:#fff;">${escHtml(r.payload)}</span>` : '';
    const action = r.action ? `<span style="color:#ffaa00;">${escHtml(r.action)}</span>` : '';
    const extras = [tpc, payload, action].filter(Boolean).join(' ');
    return `<div><span style="color:#666;">${escHtml(r.time)}</span> ${idChip} ${srcChip} ${kindChip} ${extras}</div>`;
  }).join('');
}

async function wireLiveStream() {
  // Wire the Clear button (idempotent — single page-level element).
  const clearBtn = document.getElementById('live-clear');
  if (clearBtn && !clearBtn._wired) {
    clearBtn._wired = true;
    clearBtn.addEventListener('click', () => { _liveRows = []; liveRedraw(); });
  }

  // Already subscribed? Just refresh the rendered list (in case the host
  // got recreated by some other UI event) and bail.
  if (_liveMqtt) {
    if (_liveRows.length) liveRedraw();
    liveSetStatus(_liveMqtt.connected ? 'connected' : 'reconnecting…',
                  _liveMqtt.connected ? '#3a7d44' : '#aaa');
    return;
  }

  if (typeof mqtt === 'undefined') { liveSetStatus('mqtt.js missing', '#c0392b'); return; }

  let pass;
  try {
    const r = await fetch('/api/dashboard-settings/_mqtt_browser_pass').then(r => r.json());
    pass = r.value;
  } catch (e) { liveSetStatus('broker pass fetch failed', '#c0392b'); return; }
  if (!pass) { liveSetStatus('MQTT_BROWSER_PASS not set', '#c0392b'); return; }

  liveSetStatus('connecting…');
  _liveMqtt = mqtt.connect(`ws://${LIVE_BROKER_HOST}:${LIVE_BROKER_PORT}`, {
    username: LIVE_USER, password: pass,
    clientId: 'esp-live-' + Math.random().toString(36).slice(2, 10),
    reconnectPeriod: 5000, connectTimeout: 8000,
  });
  _liveMqtt.on('connect', () => {
    liveSetStatus('connected', '#3a7d44');
    _liveMqtt.subscribe(LIVE_TOPIC, { qos: 0 }, (err) => {
      if (err) liveSetStatus('subscribe failed: ' + err.message, '#c0392b');
    });
  });
  _liveMqtt.on('reconnect', () => liveSetStatus('reconnecting…'));
  _liveMqtt.on('close',     () => liveSetStatus('disconnected', '#c0392b'));
  _liveMqtt.on('error',     (e) => { console.error('Live MQTT error:', e); liveSetStatus('error: ' + e.message, '#c0392b'); });
  _liveMqtt.on('message',   (t, payload) => liveAppendRow(payload.toString(), t));
}

// ─── Sub-panel: OTA ─────────────────────────────────────────────────────
function renderOta(b) {
  if (!b.ip) {
    return `<div class="ota-disabled">No known IP for this board yet — wait for the next ARP scan or the board's first /status publish.</div>`;
  }
  if (!b.has_ota_password) {
    return `<div class="ota-disabled">Board has no <code>ota_password</code> set. Set one via the DB (<code>UPDATE esp_boards SET ota_password='…' WHERE id='${escHtml(b.id)}'</code>) before flashing.</div>`;
  }
  const isEsp32 = (b.last_status?.sketch_name || '').toLowerCase().includes('esp32');
  return `
    <div class="ota-drop" id="ota-drop">
      <div style="font-size:1.1rem;margin-bottom:6px;">Drop <code>.bin</code> file here, or click to browse</div>
      <div style="font-size:0.78rem;">Target: <code>${escHtml(b.ip)}</code> · espota.py (${isEsp32 ? 'ESP32' : 'ESP8266'}) · OTA password baked in</div>
      <input type="file" id="ota-file" accept=".bin" style="display:none;">
    </div>
    <div class="ota-status" id="ota-status"></div>
    <p style="margin-top:14px;font-size:0.78rem;color:#888;">
      Upload spawns <code>espota.py -i ${escHtml(b.ip)} -p 8266 -a &lt;password&gt; -f &lt;your.bin&gt; -r</code>.
      The board reboots into the new firmware on success.
    </p>
  `;
}

function wireOtaForm(board) {
  const drop = document.getElementById('ota-drop');
  const fileEl = document.getElementById('ota-file');
  const status = document.getElementById('ota-status');
  if (!drop || !fileEl) return;

  drop.addEventListener('click', () => fileEl.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) doUpload(e.dataTransfer.files[0]);
  });
  fileEl.addEventListener('change', () => {
    if (fileEl.files.length > 0) doUpload(fileEl.files[0]);
  });

  async function doUpload(file) {
    if (!/\.bin$/i.test(file.name)) {
      status.style.color = '#c0392b';
      status.textContent = '✗ Must be a .bin file';
      return;
    }
    status.style.color = '#555';
    status.textContent = `Uploading ${file.name} (${(file.size / 1024).toFixed(1)} KB)…`;
    const fd = new FormData();
    fd.append('firmware', file);
    try {
      const r = await fetch(`/api/esp/boards/${encodeURIComponent(board.id)}/ota`, { method: 'POST', body: fd });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        status.style.color = '#c0392b';
        status.textContent = `✗ exit=${data.exit_code ?? 'n/a'} ${data.error || ''}\n${data.stderr || ''}\n${data.stdout || ''}`;
      } else {
        status.style.color = '#3a7d44';
        status.textContent = `✓ OTA push succeeded (exit 0). Board rebooting.\n${data.stdout || ''}`;
        setTimeout(loadBoards, 5000);
      }
    } catch (e) {
      status.style.color = '#c0392b';
      status.textContent = '✗ ' + e.message;
    }
  }
}

// ─── Init + auto-refresh ───────────────────────────────────────────────
loadBoards();
wireLiveStream();   // page-level subscription; persists across board switches
setInterval(() => loadBoards(true), 30000);  // 30 s — half the board's status heartbeat cadence
