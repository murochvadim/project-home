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

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // ─── HASP Balcony status card ──────────────────────────────────────────────
  // Browser subscribes to mosquitto over WebSocket (port 9001) as `dashboard_browser`.
  // Required ACL on LXC 107: read hasp/balcony/state/# + read hasp/balcony/LWT
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
      // OpenHASP firmware doesn't auto-push statusupdate periodically — it
      // only responds when asked. Request once now + every 30 s after.
      const askForStatus = () => _hpMqtt.publish(`hasp/${HP_PLATE}/command/statusupdate`, '');
      askForStatus();
      if (window._hpStatusTimer) clearInterval(window._hpStatusTimer);
      window._hpStatusTimer = setInterval(askForStatus, 30000);
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

  // ─── Button Bindings — wallmote-style multi-device per slot ────────────────
  const BC_PANEL = 'balcony';
  const ACTIONS = [
    { v: 'turn_on',  label: 'Turn On',  tag: 'on'     },
    { v: 'turn_off', label: 'Turn Off', tag: 'off'    },
    { v: 'toggle',   label: 'Toggle',   tag: 'toggle' },
  ];
  const CONTROLLABLE_TYPES = new Set(['switch', 'light', 'circuit_breaker', 'water_heater', 'curtain', 'valve']);

  let _buttons = [];
  let _controllable = [];
  let _bcActivePicker = null;  // {row_id, snapshot}

  function bcActionLabel(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.label : v; }
  function bcActionTag(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.tag : 'toggle'; }
  function bcDefaultActionFor(_event) { return 'toggle'; }

  async function bcLoadControllableDevices() {
    if (_controllable.length) return _controllable;
    try {
      const devs = await fetch('/api/devices').then(r => r.json());
      const list = Array.isArray(devs) ? devs : (devs.devices || []);
      _controllable = [];
      for (const d of list) {
        if (d.enabled === false) continue;
        if (!CONTROLLABLE_TYPES.has(d.device_type)) continue;
        const chanCfg = d.channel_config || {};
        const dpsLabels = d.dps_labels || {};
        const tuyaChans = Object.keys(chanCfg).filter(k => k && !isNaN(parseInt(k))).sort();
        const zigbeeChans = Object.keys(dpsLabels).filter(k => /^state_l\d+$/i.test(k))
          .sort((a, b) => parseInt(a.replace(/\D/g,'')) - parseInt(b.replace(/\D/g,'')));
        if (tuyaChans.length > 1) {
          for (const ch of tuyaChans) {
            const ci = chanCfg[ch] || {};
            _controllable.push({ device_id: d.id, channel: ch, name: d.name, label: ci.name || `Ch.${ch}`,
                                 room: ci.room || d.room || '', protocol: d.protocol });
          }
        } else if (zigbeeChans.length > 1) {
          for (const ch of zigbeeChans) {
            _controllable.push({ device_id: d.id, channel: ch, name: d.name, label: dpsLabels[ch] || ch,
                                 room: d.room || '', protocol: d.protocol });
          }
        } else {
          _controllable.push({ device_id: d.id, channel: null, name: d.name, label: '',
                               room: d.room || '', protocol: d.protocol });
        }
      }
      _controllable.sort((a, b) => (a.room || 'zzz').localeCompare(b.room || 'zzz')
                                || a.name.localeCompare(b.name));
    } catch (_) { _controllable = []; }
    return _controllable;
  }

  function bcRenderPickerDisplay(rowId) {
    const row = _buttons.find(r => r.id === rowId);
    const el = document.querySelector(`[data-bc-picker="${rowId}"]`);
    if (!row || !el) return;
    const sel = row.bindings || [];
    if (!sel.length) {
      el.classList.add('empty');
      el.innerHTML = '— select devices —';
      el.title = '';
    } else {
      el.classList.remove('empty');
      el.innerHTML = sel.map(s =>
        `${escHtml(s.label ? s.name + ':' + s.label : (s.name || '?'))}<span class="action-tag ${bcActionTag(s.action)}">${bcActionTag(s.action)}</span>`
      ).join(' · ');
      el.title = sel.map(s => `${s.name || '?'}${s.label?':'+s.label:''} → ${bcActionLabel(s.action)}`).join('\n');
    }
  }

  function bcRenderButtonCard(headerRow, allRowsForButton) {
    return `
      <div class="button-row" data-bc-btn="${headerRow.page}-${headerRow.button_id}">
        <div class="button-label">
          ${escHtml(headerRow.label || '')}
          <div style="font-weight:normal;color:#aaa;font-size:0.72rem;">p${headerRow.page}b${headerRow.button_id}</div>
        </div>
        <div class="event-rows">
          ${allRowsForButton.map(r => `
            <div class="event-row">
              <span class="event-type ${r.event}">${r.event}</span>
              <div class="device-picker ${(r.bindings && r.bindings.length) ? '' : 'empty'}"
                   data-bc-picker="${r.id}"
                   onclick="bcOpenPicker(${r.id})">
                ${(r.bindings && r.bindings.length)
                    ? r.bindings.map(s => `${escHtml(s.label ? s.name + ':' + s.label : (s.name || '?'))}<span class="action-tag ${bcActionTag(s.action)}">${bcActionTag(s.action)}</span>`).join(' · ')
                    : '— select devices —'}
              </div>
              <button class="btn-test" onclick="bcTestRow(${r.id}, this)">Test</button>
            </div>`).join('')}
        </div>
      </div>`;
  }

  // ─── Picker popover ────────────────────────────────────────────────────────
  window.bcOpenPicker = function (rowId) {
    const row = _buttons.find(r => r.id === rowId);
    if (!row) return;
    if (!row.bindings) row.bindings = [];
    _bcActivePicker = { rowId, snapshot: JSON.parse(JSON.stringify(row.bindings)) };
    const lbl = row.label || `p${row.page}b${row.button_id}`;
    document.getElementById('picker-title').textContent = `${lbl} · ${row.event}`;
    document.getElementById('picker-search-input').value = '';
    bcRenderPickerList('');
    document.getElementById('picker-overlay').classList.add('show');
  };

  window.bcClosePicker = function (save) {
    document.getElementById('picker-overlay').classList.remove('show');
    if (!save && _bcActivePicker) {
      const row = _buttons.find(r => r.id === _bcActivePicker.rowId);
      if (row) row.bindings = _bcActivePicker.snapshot;
    }
    if (_bcActivePicker) bcRenderPickerDisplay(_bcActivePicker.rowId);
    _bcActivePicker = null;
  };

  window.bcFilterPicker = function () {
    bcRenderPickerList(document.getElementById('picker-search-input').value);
  };

  function bcRenderPickerList(filter) {
    if (!_bcActivePicker) return;
    const row = _buttons.find(r => r.id === _bcActivePicker.rowId);
    if (!row) return;
    if (!row.bindings) row.bindings = [];
    const selByKey = new Map(row.bindings.map(s => [s.device_id + ':' + (s.channel || ''), s]));
    const f = (filter || '').toLowerCase();
    const list = document.getElementById('picker-list');
    list.innerHTML = '';
    let currentRoom = null, visible = 0;
    const defAct = bcDefaultActionFor(row.event);

    for (const d of _controllable) {
      const rowKey = d.device_id + ':' + (d.channel || '');
      const displayName = d.label ? `${d.name} — ${d.label}` : d.name;
      const blob = `${d.name} ${d.label} ${d.room} ${d.protocol}`.toLowerCase();
      if (f && !blob.includes(f)) continue;

      if (d.room !== currentRoom) {
        currentRoom = d.room;
        const rl = document.createElement('div');
        rl.className = 'picker-room-label';
        rl.textContent = d.room || '(no room)';
        list.appendChild(rl);
      }

      const existing = selByKey.get(rowKey);
      const checked = !!existing;
      const act = existing ? existing.action : defAct;

      const item = document.createElement('div');
      item.className = 'picker-item';
      item.innerHTML = `
        <input type="checkbox" ${checked ? 'checked' : ''}>
        <div class="picker-item-name">${escHtml(displayName)}</div>
        <select class="picker-action-select">
          ${ACTIONS.map(a => `<option value="${a.v}" ${a.v === act ? 'selected' : ''}>${a.label}</option>`).join('')}
        </select>
        <div class="picker-item-meta">${escHtml(d.protocol)}${d.channel ? ' · '+d.channel : ''}</div>`;
      const cb = item.querySelector('input');
      const sel = item.querySelector('select');
      item.addEventListener('click', (e) => {
        if (e.target === sel || sel.contains(e.target)) return;
        if (e.target !== cb) cb.checked = !cb.checked;
        bcToggleSelection(d, cb.checked, sel.value);
      });
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        if (!cb.checked) cb.checked = true;
        bcToggleSelection(d, cb.checked, sel.value);
      });
      sel.addEventListener('click', (e) => e.stopPropagation());
      list.appendChild(item);
      visible++;
    }
    if (!visible) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:20px;color:#aaa;text-align:center;font-size:0.82rem;';
      empty.textContent = 'No devices match your filter';
      list.appendChild(empty);
    }
    bcUpdatePickerCount();
  }

  function bcToggleSelection(dev, checked, action) {
    if (!_bcActivePicker) return;
    const row = _buttons.find(r => r.id === _bcActivePicker.rowId);
    if (!row) return;
    if (!row.bindings) row.bindings = [];
    const idx = row.bindings.findIndex(s =>
      s.device_id === dev.device_id && (s.channel || null) === (dev.channel || null));
    if (checked) {
      if (idx >= 0) {
        row.bindings[idx].action = action;
      } else {
        row.bindings.push({
          device_id: dev.device_id, channel: dev.channel,
          name: dev.name, label: dev.label, action,
        });
      }
    } else if (idx >= 0) {
      row.bindings.splice(idx, 1);
    }
    bcUpdatePickerCount();
  }

  function bcUpdatePickerCount() {
    if (!_bcActivePicker) return;
    const row = _buttons.find(r => r.id === _bcActivePicker.rowId);
    document.getElementById('picker-count').textContent =
      `${(row && row.bindings ? row.bindings.length : 0)} selected`;
  }

  // ─── Test + Save ───────────────────────────────────────────────────────────
  window.bcTestRow = async function (rowId, btn) {
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await fetch(`/api/hasp/${BC_PANEL}/buttons/${rowId}/test`, { method: 'POST' });
      const out = await r.json();
      if (r.ok && out.fired) {
        btn.textContent = out.failed ? `✗ ${out.failed}/${out.fired+out.failed}` : `✓ ${out.fired}`;
        btn.style.cssText = `background:${out.failed?'#c0392b':'#3a7d44'};color:#fff;border-color:transparent;`;
      } else {
        btn.textContent = '✗ ' + (out.error || 'fail');
        btn.style.cssText = 'background:#c0392b;color:#fff;border-color:transparent;';
      }
    } catch (e) {
      btn.textContent = '✗ ' + e.message;
      btn.style.cssText = 'background:#c0392b;color:#fff;border-color:transparent;';
    }
    setTimeout(() => { btn.textContent = original; btn.disabled = false; btn.style.cssText = ''; }, 2500);
  };

  window.bcSaveAllBindings = async function () {
    const saveBtn = document.querySelector('.wallmote-card .btn-save');
    if (!saveBtn) return;
    const original = saveBtn.textContent;
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    let ok = 0, fail = 0;
    for (const row of _buttons) {
      try {
        const r = await fetch(`/api/hasp/${BC_PANEL}/buttons/${row.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bindings: row.bindings || [] })
        });
        if (r.ok) ok++; else fail++;
      } catch (_) { fail++; }
    }
    saveBtn.textContent = fail === 0 ? '✓ Saved' : `✗ ${fail} failed`;
    saveBtn.style.background = fail === 0 ? '#3a7d44' : '#c0392b';
    setTimeout(() => {
      saveBtn.textContent = original; saveBtn.style.background = ''; saveBtn.disabled = false;
    }, 2000);
  };

  async function bcLoadButtons() {
    await bcLoadControllableDevices();
    try {
      const r = await fetch(`/api/hasp/${BC_PANEL}/buttons`).then(r => r.json());
      _buttons = (r.buttons || []).map(b => ({ ...b, bindings: b.bindings || [] }));
    } catch (_) { _buttons = []; }
    const list = document.getElementById('bc-buttons-list');
    if (!list) return;
    if (!_buttons.length) {
      list.innerHTML = '<div style="padding:8px;color:#888;font-size:0.85rem;">No buttons. Run Sync from panel after adding widgets in the OpenHASP web UI.</div>';
      return;
    }
    // Group by (page, button_id) — render one card per button with all its event-rows inside
    const seen = new Set();
    const cards = [];
    for (const r of _buttons) {
      const key = `${r.page}-${r.button_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const allRows = _buttons.filter(b => b.page === r.page && b.button_id === r.button_id);
      cards.push(bcRenderButtonCard(r, allRows));
    }
    list.innerHTML = cards.join('');
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _bcActivePicker) bcClosePicker(false);
  });
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'picker-overlay' && _bcActivePicker) bcClosePicker(false);
  });

  // ─── Display Templates card ────────────────────────────────────────────────
  let _displays = [];
  let _stateKeys = [];
  let _deviceSources = []; // [{value:'device:<id>:<key>', label:'<DeviceName> · <key>', room}]

  // Numeric / displayable dps keys worth offering as a display source
  const _DEVICE_DPS_FIELDS = ['temperature', 'humidity', 'illuminance', 'uv',
                              'battery', 'power', 'energy', 'voltage', 'current',
                              'pressure', 'co2', 'voc', 'pm25'];

  async function bcLoadStateKeys() {
    try {
      const r = await fetch('/api/rule-engine/state').then(r => r.json());
      _stateKeys = Object.keys((r && r.state) || {}).sort();
    } catch (_) { _stateKeys = []; }
    return _stateKeys;
  }

  async function bcLoadDeviceSources() {
    if (_deviceSources.length) return _deviceSources;
    try {
      const devs = await fetch('/api/devices').then(r => r.json());
      const list = Array.isArray(devs) ? devs : (devs.devices || []);
      const out = [];
      for (const d of list) {
        if (!d.id || !d.name) continue;
        const ls = d.last_state || {};
        for (const k of _DEVICE_DPS_FIELDS) {
          if (ls[k] == null) continue;
          out.push({
            value: `device:${d.id}:${k}`,
            label: `${d.name} · ${k}`,
            room: d.room || '',
            sample: ls[k],
          });
        }
      }
      out.sort((a, b) => (a.room || 'zzz').localeCompare(b.room || 'zzz')
                     || a.label.localeCompare(b.label));
      _deviceSources = out;
    } catch (_) { _deviceSources = []; }
    return _deviceSources;
  }

  // Cache device list for preview rendering — refreshes every 10 s
  let _bcPreviewDevsCache = { ts: 0, list: [] };
  async function _bcPreviewDevices() {
    const now = Date.now();
    if (now - _bcPreviewDevsCache.ts < 10000 && _bcPreviewDevsCache.list.length) {
      return _bcPreviewDevsCache.list;
    }
    try {
      const r = await fetch('/api/devices').then(r => r.json());
      _bcPreviewDevsCache = { ts: now, list: Array.isArray(r) ? r : (r.devices || []) };
    } catch (_) {}
    return _bcPreviewDevsCache.list;
  }

  function bcRenderTemplate(format, shared, sourceVal) {
    return String(format || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
      if (k === 'val') return sourceVal == null ? '' : String(sourceVal);
      const v = shared[k];
      return v == null ? '' : String(v);
    });
  }

  async function _bcResolveSource(srcVal) {
    if (!srcVal) return null;
    if (srcVal.startsWith('device:')) {
      const rest = srcVal.slice('device:'.length);
      const i = rest.indexOf(':');
      if (i > 0) {
        const [devId, key] = [rest.slice(0, i), rest.slice(i + 1)];
        const devs = await _bcPreviewDevices();
        const d = devs.find(x => x.id === devId);
        return (d && d.last_state) ? d.last_state[key] : null;
      }
      return null;
    }
    try {
      const r = await fetch('/api/rule-engine/state').then(r => r.json());
      return ((r && r.state) || {})[srcVal];
    } catch (_) { return null; }
  }

  async function bcRenderPreview(format, sourceVal) {
    if (!format) return '';
    const [r, resolved] = await Promise.all([
      fetch('/api/rule-engine/state').then(r => r.json()).catch(() => ({})),
      _bcResolveSource(sourceVal),
    ]);
    return bcRenderTemplate(format, (r && r.state) || {}, resolved);
  }

  function bcRenderDisplay(d) {
    const cur = d.source_value || '';
    // Build a combined source picker: state.shared keys (optgroup) + device sensors (optgroup).
    // Optgroups can't be nested, so room is shown inline in the device label
    // ('<Room> · <DeviceName> · <field>') rather than a sub-group.
    const sharedOpts = _stateKeys.map(k =>
      `<option value="${escHtml(k)}"${k === cur ? ' selected' : ''}>${escHtml(k)}</option>`
    ).join('');
    const deviceOpts = _deviceSources.map(s => {
      const lab = s.room ? `${s.room} · ${s.label}` : s.label;
      return `<option value="${escHtml(s.value)}"${s.value === cur ? ' selected' : ''}>${escHtml(lab)}</option>`;
    }).join('');
    const keysOptions = `
      <option value="">— pick a source —</option>
      <optgroup label="state.shared keys">${sharedOpts}</optgroup>
      <optgroup label="Device sensors">${deviceOpts}</optgroup>
    `;
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
          <label>Source (state.shared key or Device sensor)<select onchange="bcUpdateDisplay(${d.id},'source_value',this.value); bcUpdateDisplay(${d.id},'source_type',this.value.startsWith('device:')?'device':'shared_state'); bcUpdatePreview(${d.id})" style="width:100%;font-size:0.78rem;">${keysOptions}</select></label>
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
    if (el) el.textContent = await bcRenderPreview(d.format_string, d.source_value) || '—';
  };

  window.bcSaveDisplay = async function (id) {
    const d = _displays.find(x => x.id === id);
    if (!d) return;
    const status = document.querySelector(`[data-id="${id}"] [data-cell="status"]`);
    if (status) { status.style.color = '#888'; status.textContent = '…'; }
    try {
      const srcType = (d.source_value || '').startsWith('device:') ? 'device' : 'shared_state';
      const r = await fetch(`/api/hasp/${BC_PANEL}/displays/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: d.page, label_id: d.label_id,
          description: d.description || null,
          display_type: d.display_type || 'text',
          target_property: d.target_property || 'text',
          source_type: srcType,
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

  function bcRenderDisplaysList() {
    const list = document.getElementById('bc-displays-list');
    const count = document.getElementById('bc-displays-count');
    if (!list) return;
    const filter = (document.getElementById('bc-displays-filter') || {}).value || 'active';
    const limitRaw = (document.getElementById('bc-displays-limit') || {}).value || '10';
    const limit = limitRaw === 'all' ? Infinity : parseInt(limitRaw, 10);

    let pool = _displays;
    if (filter === 'active') {
      pool = pool.filter(d => (d.format_string && d.format_string.trim()) || (d.source_value && d.source_value.trim()));
    }
    const total = _displays.length;
    const filtered = pool.length;
    const shown = pool.slice(0, limit);

    if (count) {
      const showingTxt = shown.length === filtered ? `${filtered}` : `${shown.length} of ${filtered}`;
      count.textContent = filter === 'active'
        ? `(${showingTxt} configured / ${total} total)`
        : `(${showingTxt} of ${total})`;
    }

    if (!shown.length) {
      list.innerHTML = filter === 'active'
        ? `<div style="padding:8px;color:#888;font-size:0.85rem;">No configured displays. Switch <b>Show</b> to "all" to see the ${total} placeholder rows synced from the panel, or click <b>+ Add</b> to create one.</div>`
        : '<div style="padding:8px;color:#888;font-size:0.85rem;">No displays yet. Click <b>+ Add</b> to bind a panel widget to live state.</div>';
      return;
    }
    list.innerHTML = shown.map(bcRenderDisplay).join('');
    for (const d of shown) bcUpdatePreview(d.id);
  }
  window.bcRenderDisplaysList = bcRenderDisplaysList;

  window.bcToggleDisplaysCard = function () {
    const body = document.getElementById('bc-displays-body');
    const toggle = document.getElementById('bc-displays-toggle');
    if (!body) return;
    const collapsed = body.style.display === 'none';
    body.style.display = collapsed ? '' : 'none';
    if (toggle) toggle.textContent = collapsed ? '▾' : '▸';
  };

  async function bcLoadDisplays() {
    await Promise.all([bcLoadStateKeys(), bcLoadDeviceSources()]);
    try {
      const r = await fetch(`/api/hasp/${BC_PANEL}/displays`).then(r => r.json());
      _displays = r.displays || [];
    } catch (_) { _displays = []; }
    bcRenderDisplaysList();
  }

  // ─── Sync from panel ───────────────────────────────────────────────────────
  window.bcSyncFromPanel = async function () {
    const btn = document.getElementById('bc-sync-btn');
    const status = document.getElementById('bc-sync-status');
    btn.disabled = true;
    if (status) { status.style.color = '#888'; status.textContent = 'syncing…'; }
    try {
      const r = await fetch(`/api/hasp/${BC_PANEL}/sync`, { method: 'POST' });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || 'sync failed');
      const parts = [];
      if (out.buttons.added) parts.push(`${out.buttons.added} new button${out.buttons.added > 1 ? 's' : ''}`);
      if (out.buttons.relabeled) parts.push(`${out.buttons.relabeled} relabeled`);
      if (out.buttons.deleted) parts.push(`${out.buttons.deleted} stale button${out.buttons.deleted > 1 ? 's' : ''} removed`);
      if (out.displays.added) parts.push(`${out.displays.added} new display${out.displays.added > 1 ? 's' : ''}`);
      if (out.displays.type_updated) parts.push(`${out.displays.type_updated} display type${out.displays.type_updated > 1 ? 's' : ''} updated`);
      if (out.displays.deleted) parts.push(`${out.displays.deleted} stale display${out.displays.deleted > 1 ? 's' : ''} removed`);
      if (status) {
        status.style.color = '#3a7d44';
        status.textContent = `✓ ${out.objects} widgets parsed${parts.length ? ' — ' + parts.join(', ') : ' — no changes'}${out.file_saved ? `, saved ${out.file_saved}` : ''}`;
      }
      await Promise.all([bcLoadButtons(), bcLoadDisplays()]);
    } catch (e) {
      if (status) { status.style.color = '#c0392b'; status.textContent = '✗ ' + e.message; }
    } finally { btn.disabled = false; }
  };

  window.addEventListener('DOMContentLoaded', () => {
    refreshPage();
    hpInit();
    bcLoadButtons();
    bcLoadDisplays();
  });
})();
