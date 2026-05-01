// Balcony Agent — page logic
(function () {
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
  }
  window.refreshPage = refreshPage;

  // ─── HASP Balcony status card ──────────────────────────────────────────────
  // Browser subscribes to mosquitto over WebSocket (port 9001) as `dashboard_browser`.
  // Mirrors the Awtrix tab pattern (see living-room.js Awtrix section).
  // Required ACL on LXC 107 (one-time):
  //   read hasp/balcony/state/#
  //   read hasp/balcony/LWT
  const HP_BROKER_HOST = '192.168.1.189';
  const HP_BROKER_PORT = 9001;
  const HP_USER        = 'dashboard_browser';
  const HP_PLATE       = 'balcony';

  let _hpInited = false;
  let _hpMqtt   = null;

  function hpSetOnline(connected, label) {
    const dot  = document.getElementById('hp-online-dot');
    const text = document.getElementById('hp-online-text');
    if (dot)  dot.style.color = connected ? '#3a7d44' : '#c0392b';
    if (text) text.textContent = label || (connected ? 'connected' : 'offline');
  }

  function hpFmtUptime(sec) {
    if (sec == null || isNaN(sec)) return '—';
    sec = Math.floor(Number(sec));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d} d ${h} h`;
    if (h > 0) return `${h} h ${m} m`;
    return `${m} m`;
  }

  function hpUpdateStatus(s) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('hp-uptime', hpFmtUptime(s.uptime));
    set('hp-rssi',   s.rssi ?? '—');
    const page = s.page ?? null;
    const num  = s.numPages ?? null;
    set('hp-page', page != null ? (num != null ? `${page} / ${num}` : `${page}`) : '—');
  }

  async function hpInit() {
    if (_hpInited) return;
    _hpInited = true;
    if (typeof mqtt === 'undefined') { hpSetOnline(false, 'mqtt.js missing'); return; }

    let pass;
    try {
      const r = await fetch('/api/dashboard-settings/_mqtt_browser_pass').then(r => r.json());
      pass = r.value;
    } catch (e) { hpSetOnline(false, 'broker pass fetch failed'); return; }
    if (!pass) { hpSetOnline(false, 'MQTT_BROWSER_PASS not set'); return; }

    _hpMqtt = mqtt.connect(`ws://${HP_BROKER_HOST}:${HP_BROKER_PORT}`, {
      username: HP_USER, password: pass,
      clientId: 'hasp-balcony-tab-' + Math.random().toString(36).slice(2, 10),
      reconnectPeriod: 5000, connectTimeout: 8000,
    });
    _hpMqtt.on('connect', () => {
      hpSetOnline(false, 'broker connected, awaiting panel…');
      _hpMqtt.subscribe(`hasp/${HP_PLATE}/state/statusupdate`, { qos: 0 });
      _hpMqtt.subscribe(`hasp/${HP_PLATE}/LWT`, { qos: 0 });
    });
    _hpMqtt.on('reconnect', () => hpSetOnline(false, 'reconnecting…'));
    _hpMqtt.on('close',     () => hpSetOnline(false));
    _hpMqtt.on('error',     (e) => { console.error('HASP MQTT error:', e); hpSetOnline(false, 'broker error'); });
    _hpMqtt.on('message', (topic, payload) => {
      if (topic === `hasp/${HP_PLATE}/LWT`) {
        hpSetOnline(payload.toString() === 'online');
      } else if (topic === `hasp/${HP_PLATE}/state/statusupdate`) {
        try { hpUpdateStatus(JSON.parse(payload.toString())); } catch (_) {}
      }
    });
  }

  // ─── Button Bindings card ──────────────────────────────────────────────────
  let _devices = [];      // cached /api/devices result
  let _presets = [];      // cached /api/pixoo/presets result
  let _buttons = [];      // current rows from /api/hasp/balcony/buttons
  let _btnDirty = false;  // any unsaved changes

  const BC_PANEL = 'balcony';
  // OpenHASP firmware emits 'down' + 'up' on every press by default; 'short' /
  // 'long' / 'double' only fire if the button is configured to synthesize them
  // in pages.jsonl — so 'up' is the safe default that always works.
  const EVENT_OPTIONS = ['up', 'down', 'short', 'long', 'double'];
  const ACTION_TYPES = ['', 'device', 'hasp_command', 'pixoo_preset'];

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function bcMarkDirty() {
    _btnDirty = true;
    const b = document.getElementById('btn-bindings-save');
    if (b) b.disabled = false;
  }

  async function bcLoadDevices() {
    if (_devices.length) return _devices;
    try {
      const r = await fetch('/api/devices').then(r => r.json());
      _devices = (r.devices || r || []).filter(d => d.id && d.name);
      _devices.sort((a, b) => (a.room || '').localeCompare(b.room || '') || a.name.localeCompare(b.name));
    } catch (_) { _devices = []; }
    return _devices;
  }

  async function bcLoadPresets() {
    if (_presets.length) return _presets;
    try {
      const r = await fetch('/api/pixoo/presets').then(r => r.json());
      _presets = (r.presets || r || []).filter(p => p && p.name);
    } catch (_) { _presets = []; }
    return _presets;
  }

  function bcRenderTargetCell(row) {
    const at = row.action_type || '';
    const ap = row.action_payload || {};
    const target = row.action_target || '';

    if (at === 'device') {
      const opts = ['<option value="">— pick device —</option>'].concat(_devices.map(d =>
        `<option value="${escHtml(d.id)}"${d.id === target ? ' selected' : ''}>${escHtml(d.room || '·')} / ${escHtml(d.name)}</option>`
      )).join('');
      return `<select onchange="bcUpdateRow(${row.id},'action_target',this.value)" style="width:100%;font-size:0.78rem;">${opts}</select>`;
    }
    if (at === 'pixoo_preset') {
      const opts = ['<option value="">— pick preset —</option>'].concat(_presets.map(p =>
        `<option value="${escHtml(p.name)}"${p.name === target ? ' selected' : ''}>${escHtml(p.name)}</option>`
      )).join('');
      return `<select onchange="bcUpdateRow(${row.id},'action_target',this.value)" style="width:100%;font-size:0.78rem;">${opts}</select>`;
    }
    if (at === 'hasp_command') {
      return `<input type="text" value="${escHtml(target)}" placeholder="page 2 / clearpage 1 / p1b110.val 1"
        oninput="bcUpdateRow(${row.id},'action_target',this.value)" style="width:100%;font-size:0.78rem;padding:3px 5px;">`;
    }
    return `<span style="color:#aaa;font-size:0.78rem;">— pick action type first —</span>`;
  }

  // For a target device, list the valid channel keys derived from its protocol.
  // Zigbee multi-gang: state_l1, state_l2, … (from dps_labels).
  // Tuya local/gateway: numeric DPS keys from channel_config or dps_labels.
  // Single-channel devices return [] — no channel needed.
  function bcChannelOptions(dev) {
    if (!dev) return null;
    const labels = dev.dps_labels || {};
    if (dev.protocol === 'zigbee') {
      const keys = Object.keys(labels).filter(k => /^state(_l\d+)?$/.test(k));
      return keys.length ? keys : Object.keys(labels);
    }
    if (dev.protocol === 'local' || dev.protocol === 'gateway') {
      const cc = dev.channel_config || {};
      const ccKeys = Object.keys(cc);
      if (ccKeys.length) return ccKeys;
      return Object.keys(labels).filter(k => /^\d+$/.test(k));
    }
    return [];
  }

  function bcRenderPayloadCell(row) {
    const at = row.action_type || '';
    const ap = row.action_payload || {};
    if (at !== 'device') return `<span style="color:#bbb;font-size:0.78rem;">—</span>`;

    const action = ap.action || 'toggle';
    const channel = ap.channel || '';
    const actionSel = `
      <select onchange="bcUpdatePayload(${row.id},'action',this.value)" style="width:72px;font-size:0.78rem;">
        <option value="toggle"${action === 'toggle' ? ' selected' : ''}>toggle</option>
        <option value="turn_on"${action === 'turn_on' ? ' selected' : ''}>on</option>
        <option value="turn_off"${action === 'turn_off' ? ' selected' : ''}>off</option>
      </select>`;

    const dev = row.action_target ? _devices.find(d => d.id === row.action_target) : null;
    const channels = bcChannelOptions(dev);

    if (!dev) {
      return actionSel + `<span style="color:#bbb;font-size:0.72rem;margin-left:4px;">pick target</span>`;
    }
    if (channels === null || channels.length === 0) {
      return actionSel + `<span style="color:#888;font-size:0.72rem;margin-left:4px;">no channel</span>`;
    }
    // Build dropdown — preserve any value not in the list (legacy / typo'd) as a stub option
    const inList = channels.includes(channel);
    const opts = [`<option value="">— ch —</option>`].concat(channels.map(c => {
      const lbl = (dev.dps_labels && dev.dps_labels[c]) || c;
      return `<option value="${escHtml(c)}"${c === channel ? ' selected' : ''}>${escHtml(c)}${lbl !== c ? ` — ${escHtml(lbl)}` : ''}</option>`;
    }));
    if (channel && !inList) {
      opts.push(`<option value="${escHtml(channel)}" selected style="color:#c0392b;">${escHtml(channel)} (legacy)</option>`);
    }
    return actionSel + `
      <select onchange="bcUpdatePayload(${row.id},'channel',this.value)" style="width:170px;font-size:0.78rem;margin-left:4px;">
        ${opts.join('')}
      </select>`;
  }

  function bcRenderRow(row) {
    const eventSel = EVENT_OPTIONS.map(e =>
      `<option value="${e}"${e === row.event ? ' selected' : ''}>${e}</option>`
    ).join('');
    const typeSel = ACTION_TYPES.map(t =>
      `<option value="${t}"${t === (row.action_type || '') ? ' selected' : ''}>${t || '— none —'}</option>`
    ).join('');
    return `
      <tr data-id="${row.id}" style="border-bottom:1px dashed #e8e2da;">
        <td style="padding:6px 4px;font-weight:600;">${escHtml(row.label)} <span style="color:#aaa;font-weight:normal;font-size:0.72rem;">(p${row.page}b${row.button_id})</span></td>
        <td style="padding:6px 4px;"><select onchange="bcUpdateRow(${row.id},'event',this.value)" style="width:100%;font-size:0.78rem;">${eventSel}</select></td>
        <td style="padding:6px 4px;"><select onchange="bcUpdateRow(${row.id},'action_type',this.value)" style="width:100%;font-size:0.78rem;">${typeSel}</select></td>
        <td style="padding:6px 4px;" data-cell="target">${bcRenderTargetCell(row)}</td>
        <td style="padding:6px 4px;" data-cell="payload">${bcRenderPayloadCell(row)}</td>
        <td style="padding:6px 4px;">
          <button class="btn-test" onclick="bcTestRow(${row.id})">▶ Test</button>
          <span data-cell="status" style="font-size:0.72rem;color:#888;margin-left:4px;"></span>
        </td>
      </tr>`;
  }

  function bcRedrawRow(row) {
    const tr = document.querySelector(`#bc-buttons-tbody tr[data-id="${row.id}"]`);
    if (!tr) return;
    tr.querySelector('[data-cell="target"]').innerHTML = bcRenderTargetCell(row);
    tr.querySelector('[data-cell="payload"]').innerHTML = bcRenderPayloadCell(row);
  }

  window.bcUpdateRow = function (id, field, value) {
    const row = _buttons.find(r => r.id === id);
    if (!row) return;
    row[field] = value;
    if (field === 'action_type') {
      row.action_target = '';
      row.action_payload = {};
      bcRedrawRow(row);
    } else if (field === 'action_target') {
      // Target changed — re-render payload cell so the channel dropdown adapts
      // to the new device's protocol (zigbee state_lN vs Tuya numeric).
      bcRedrawRow(row);
    }
    bcMarkDirty();
  };

  window.bcUpdatePayload = function (id, key, value) {
    const row = _buttons.find(r => r.id === id);
    if (!row) return;
    row.action_payload = row.action_payload || {};
    if (value) row.action_payload[key] = value;
    else delete row.action_payload[key];
    bcMarkDirty();
  };

  window.bcSaveAllBindings = async function () {
    const b = document.getElementById('btn-bindings-save');
    b.disabled = true; b.textContent = 'Saving…';
    let okCount = 0, failCount = 0;
    for (const row of _buttons) {
      try {
        const r = await fetch(`/api/hasp/${BC_PANEL}/buttons/${row.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: row.event,
            action_type: row.action_type || null,
            action_target: row.action_target || null,
            action_payload: row.action_payload || {},
          })
        });
        if (r.ok) okCount++; else failCount++;
      } catch (_) { failCount++; }
    }
    b.textContent = failCount ? `Save All (${failCount} failed)` : 'Save All';
    b.disabled = !!failCount;
    _btnDirty = !!failCount;
  };

  window.bcTestRow = async function (id) {
    const row = _buttons.find(r => r.id === id);
    if (!row) return;
    const tr = document.querySelector(`#bc-buttons-tbody tr[data-id="${id}"]`);
    const status = tr && tr.querySelector('[data-cell="status"]');
    if (status) { status.style.color = '#888'; status.textContent = '…'; }
    try {
      const r = await fetch(`/api/hasp/${BC_PANEL}/buttons/${id}/test`, { method: 'POST' });
      const out = await r.json();
      if (status) {
        status.style.color = r.ok ? '#3a7d44' : '#c0392b';
        status.textContent = r.ok ? `✓ ${out.dispatched}` : `✗ ${out.error || 'fail'}`;
        setTimeout(() => { if (status.textContent.startsWith('✓') || status.textContent.startsWith('✗')) status.textContent = ''; }, 4000);
      }
    } catch (e) {
      if (status) { status.style.color = '#c0392b'; status.textContent = '✗ ' + e.message; }
    }
  };

  async function bcLoadButtons() {
    await Promise.all([bcLoadDevices(), bcLoadPresets()]);
    try {
      const r = await fetch(`/api/hasp/${BC_PANEL}/buttons`).then(r => r.json());
      _buttons = (r.buttons || []).map(b => ({ ...b, action_payload: b.action_payload || {} }));
    } catch (_) { _buttons = []; }
    const tbody = document.getElementById('bc-buttons-tbody');
    if (!tbody) return;
    if (!_buttons.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:12px;color:#888;">No button rows. Seeded by ensureSchema on first dashboard start.</td></tr>';
      return;
    }
    tbody.innerHTML = _buttons.map(bcRenderRow).join('');
  }

  // ─── Display Templates card ────────────────────────────────────────────────
  let _displays = [];
  let _stateKeys = [];

  async function bcLoadStateKeys() {
    try {
      const r = await fetch('/api/rule-engine/state').then(r => r.json());
      _stateKeys = Object.keys((r && r.state) || {}).sort();
    } catch (_) { _stateKeys = []; }
    return _stateKeys;
  }

  function bcRenderTemplate(format, shared) {
    return String(format || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
      const v = shared[k];
      return v == null ? '' : String(v);
    });
  }

  async function bcRenderPreview(format) {
    if (!format) return '';
    try {
      const r = await fetch('/api/rule-engine/state').then(r => r.json());
      return bcRenderTemplate(format, (r && r.state) || {});
    } catch (_) { return ''; }
  }

  function bcRenderDisplay(d) {
    const keysOptions = ['<option value="">— state.shared key —</option>'].concat(_stateKeys.map(k =>
      `<option value="${escHtml(k)}"${k === (d.source_value || '') ? ' selected' : ''}>${escHtml(k)}</option>`
    )).join('');
    const dtypes = ['text', 'gauge', 'series', 'bar'].map(t =>
      `<option value="${t}"${t === d.display_type ? ' selected' : ''}>${t}</option>`
    ).join('');
    const tprops = ['text', 'val', 'bg_color', 'text_color'].map(t =>
      `<option value="${t}"${t === d.target_property ? ' selected' : ''}>${t}</option>`
    ).join('');
    const last = d.last_value ? `last: ${escHtml(d.last_value)}` : '';
    return `
      <div class="card" style="padding:10px;margin-bottom:10px;background:#faf8f5;" data-id="${d.id}">
        <div style="display:grid;grid-template-columns:90px 90px 130px 110px 1fr;gap:8px;align-items:end;font-size:0.78rem;color:#444;">
          <label>Page<input type="number" value="${d.page}" min="0" max="12" oninput="bcUpdateDisplay(${d.id},'page',parseInt(this.value))" style="width:100%;padding:3px;border:1px solid #d0cbc4;border-radius:3px;font-size:0.78rem;"></label>
          <label>Label ID<input type="number" value="${d.label_id}" min="0" oninput="bcUpdateDisplay(${d.id},'label_id',parseInt(this.value))" style="width:100%;padding:3px;border:1px solid #d0cbc4;border-radius:3px;font-size:0.78rem;"></label>
          <label>Display type<select onchange="bcUpdateDisplay(${d.id},'display_type',this.value)" style="width:100%;font-size:0.78rem;">${dtypes}</select></label>
          <label>Target prop<select onchange="bcUpdateDisplay(${d.id},'target_property',this.value)" style="width:100%;font-size:0.78rem;">${tprops}</select></label>
          <label>Refresh (s)<input type="number" value="${d.refresh_sec || 30}" min="5" max="3600" oninput="bcUpdateDisplay(${d.id},'refresh_sec',parseInt(this.value))" style="width:100%;padding:3px;border:1px solid #d0cbc4;border-radius:3px;font-size:0.78rem;"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px;font-size:0.78rem;color:#444;">
          <label>Key (state.shared)<select onchange="bcUpdateDisplay(${d.id},'source_value',this.value)" style="width:100%;font-size:0.78rem;">${keysOptions}</select></label>
          <label>Description<input type="text" value="${escHtml(d.description || '')}" oninput="bcUpdateDisplay(${d.id},'description',this.value)" style="width:100%;padding:3px;border:1px solid #d0cbc4;border-radius:3px;font-size:0.78rem;"></label>
        </div>
        <div style="margin-top:6px;font-size:0.78rem;color:#444;">
          <label>Format<input type="text" value="${escHtml(d.format_string || '')}" placeholder="Boiler {{boiler_temp}}°C"
            oninput="bcUpdateDisplay(${d.id},'format_string',this.value); bcUpdatePreview(${d.id})"
            style="width:100%;padding:4px 6px;border:1px solid #d0cbc4;border-radius:3px;font-size:0.85rem;font-family:monospace;"></label>
        </div>
        <div style="background:#fff;padding:6px 10px;border-radius:3px;border-left:3px solid #7a9ab8;margin-top:6px;font-size:0.82rem;">
          Preview: <span data-cell="preview" style="font-family:monospace;color:#000;">—</span>
          <span style="margin-left:14px;color:#888;font-size:0.72rem;">${last}</span>
        </div>
        <div style="margin-top:8px;display:flex;gap:8px;">
          <button class="btn-save" style="padding:4px 12px;" onclick="bcSaveDisplay(${d.id})">Save</button>
          <button class="btn-test" style="border-color:#c0392b;color:#c0392b;" onclick="bcDeleteDisplay(${d.id})">Delete</button>
          <span data-cell="status" style="font-size:0.78rem;color:#888;align-self:center;"></span>
        </div>
      </div>`;
  }

  window.bcUpdateDisplay = function (id, field, value) {
    const d = _displays.find(x => x.id === id);
    if (d) d[field] = value;
  };

  window.bcUpdatePreview = async function (id) {
    const d = _displays.find(x => x.id === id);
    if (!d) return;
    const el = document.querySelector(`[data-id="${id}"] [data-cell="preview"]`);
    if (el) el.textContent = await bcRenderPreview(d.format_string) || '—';
  };

  window.bcSaveDisplay = async function (id) {
    const d = _displays.find(x => x.id === id);
    if (!d) return;
    const status = document.querySelector(`[data-id="${id}"] [data-cell="status"]`);
    if (status) { status.style.color = '#888'; status.textContent = '…'; }
    try {
      const r = await fetch(`/api/hasp/${BC_PANEL}/displays/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: d.page, label_id: d.label_id,
          description: d.description || null,
          display_type: d.display_type || 'text',
          target_property: d.target_property || 'text',
          source_type: 'shared_state',
          source_value: d.source_value || null,
          format_string: d.format_string || '',
          refresh_sec: d.refresh_sec || 30,
        })
      });
      if (status) {
        status.style.color = r.ok ? '#3a7d44' : '#c0392b';
        status.textContent = r.ok ? '✓ saved' : '✗ save failed';
        setTimeout(() => { status.textContent = ''; }, 3000);
      }
    } catch (e) {
      if (status) { status.style.color = '#c0392b'; status.textContent = '✗ ' + e.message; }
    }
  };

  window.bcDeleteDisplay = async function (id) {
    if (!confirm('Delete this display?')) return;
    try {
      await fetch(`/api/hasp/${BC_PANEL}/displays/${id}`, { method: 'DELETE' });
      await bcLoadDisplays();
    } catch (_) {}
  };

  window.bcAddDisplay = async function () {
    try {
      const r = await fetch(`/api/hasp/${BC_PANEL}/displays`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: 1, label_id: 200,
          display_type: 'text', target_property: 'text',
          source_type: 'shared_state', format_string: '', refresh_sec: 30,
        })
      });
      if (r.ok) await bcLoadDisplays();
    } catch (e) { alert('Add failed: ' + e.message); }
  };

  async function bcLoadDisplays() {
    await bcLoadStateKeys();
    try {
      const r = await fetch(`/api/hasp/${BC_PANEL}/displays`).then(r => r.json());
      _displays = r.displays || [];
    } catch (_) { _displays = []; }
    const list = document.getElementById('bc-displays-list');
    if (!list) return;
    if (!_displays.length) {
      list.innerHTML = '<div style="padding:8px;color:#888;font-size:0.85rem;">No displays yet. Click <b>+ Add</b> to bind a panel widget to live state.</div>';
      return;
    }
    list.innerHTML = _displays.map(bcRenderDisplay).join('');
    // Render previews
    for (const d of _displays) bcUpdatePreview(d.id);
  }

  window.addEventListener('DOMContentLoaded', () => {
    refreshPage();
    hpInit();
    bcLoadButtons();
    bcLoadDisplays();
  });
})();
