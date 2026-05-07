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
    // Populate page selector once (numPages reported by the panel)
    const sel = document.getElementById('hp-page-select');
    if (sel && num && sel.options.length <= 1) {
      for (let i = 0; i <= num; i++) {  // include page 0 (global / nav layer)
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = i === 0 ? '0 (global)' : String(i);
        sel.appendChild(o);
      }
    }
  }

  // Panel control — backlight on/off + page navigation. Publishes via the
  // open MQTT WebSocket (hpInit). dashboard_browser ACL: write hasp/+/command/#
  window.hpPower = function (on) {
    if (!_hpMqtt || !_hpMqtt.connected) return;
    // 'dim 0' sets brightness to 0% but doesn't turn off the backlight
    // controller — many panels still show a faint glow. 'backlight off'
    // hard-cuts the LED rail. Use both: backlight on/off + a sensible dim.
    _hpMqtt.publish(`hasp/${HP_PLATE}/command/backlight`, on ? 'on' : 'off');
    if (on) _hpMqtt.publish(`hasp/${HP_PLATE}/command/dim`, '100');
  };
  window.hpGotoPage = function (n) {
    if (!_hpMqtt || !_hpMqtt.connected || n === '') return;
    _hpMqtt.publish(`hasp/${HP_PLATE}/command/page`, String(n));
    // Reset the dropdown to its placeholder so the same page can be re-clicked
    const sel = document.getElementById('hp-page-select');
    if (sel) sel.value = '';
  };

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
  const CONTROLLABLE_TYPES = new Set(['switch', 'light', 'circuit_breaker', 'water_heater', 'curtain', 'valve', 'esp_board', 'panel', 'display', 'media_player']);

  let _buttons = [];
  let _controllable = [];
  let _bcActivePicker = null;  // {row_id, snapshot}
  let _bcAlexaAnnouncements = [];   // [{name, message, ...}] — for Speak optgroup
  let _bcAlexaStations      = [];   // [{name, content_id, content_type}] — for Play optgroup

  function bcAlexaOptionValue(action, name) { return name ? `${action}:${name}` : action; }
  function bcParseAlexaOptionValue(v) {
    const i = v.indexOf(':');
    return i < 0 ? { action: v } : { action: v.slice(0, i), name: v.slice(i + 1) };
  }

  function bcActionLabel(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.label : v; }
  function bcActionTag(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.tag : 'toggle'; }
  // Render-helper for binding chips: page-select bindings show `P<n>`
  // instead of the generic action tag; Alexa speak/play show the
  // template/station name appended.
  function bcBindingTag(b) {
    if (b && b.page_num != null) return `P${b.page_num}`;
    if (b && b.action === 'speak' && b.template_name) return `say:${b.template_name}`;
    if (b && b.action === 'play'  && b.station_name)  return `play:${b.station_name}`;
    if (b && b.action === 'stop')                     return 'stop';
    return bcActionTag(b ? b.action : 'toggle');
  }
  function bcDefaultActionFor(_event) { return 'toggle'; }

  async function bcLoadControllableDevices() {
    if (_controllable.length) return _controllable;
    try {
      const [devs, anns, stations] = await Promise.all([
        fetch('/api/devices').then(r => r.json()),
        fetch('/api/dashboard-settings/media-agents.alexa_announcements').then(r => r.json()).catch(() => ({ value: [] })),
        fetch('/api/dashboard-settings/media-agents.alexa_quick_music').then(r => r.json()).catch(() => ({ value: [] })),
      ]);
      _bcAlexaAnnouncements = Array.isArray(anns && anns.value) ? anns.value : [];
      _bcAlexaStations      = Array.isArray(stations && stations.value) ? stations.value : [];
      const list = Array.isArray(devs) ? devs : (devs.devices || []);
      _controllable = [];
      for (const d of list) {
        if (d.enabled === false) continue;
        if (!CONTROLLABLE_TYPES.has(d.device_type)) continue;
        const chanCfg = d.channel_config || {};
        const dpsLabels = d.dps_labels || {};
        const dpsCfg = d.dps_config || {};
        const tuyaChans = Object.keys(chanCfg).filter(k => k && !isNaN(parseInt(k))).sort();
        const zigbeeChans = Object.keys(dpsLabels).filter(k => /^state_l\d+$/i.test(k))
          .sort((a, b) => parseInt(a.replace(/\D/g,'')) - parseInt(b.replace(/\D/g,'')));
        // ESP boards expose controllable channels via dps_config.<channel>.action_on
        // (and optional action_off). Each such channel is a target the rule
        // engine can dispatch turn_on / turn_off against — surface them in the
        // picker exactly the same way as Tuya gangs.
        const espChans = (d.protocol === 'esp')
          ? Object.keys(dpsCfg).filter(k => (dpsCfg[k] || {}).action_on)
          : [];
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
        } else if (espChans.length) {
          for (const ch of espChans) {
            const cc = dpsCfg[ch] || {};
            // Attach `chan_meta` so the picker can render the right
            // control. type='page_select' makes the picker show a
            // page-number dropdown (1..max) instead of the usual
            // toggle/turn_on/turn_off action dropdown.
            const meta = (cc.type ? { type: cc.type, min: cc.min, max: cc.max } : null);
            _controllable.push({ device_id: d.id, channel: ch, name: d.name, label: cc.name || ch,
                                 room: cc.room || d.room || '', protocol: d.protocol,
                                 chan_meta: meta });
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
        `${escHtml(s.label ? s.name + ':' + s.label : (s.name || '?'))}<span class="action-tag ${bcBindingTag(s)}">${bcBindingTag(s)}</span>`
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
                    ? r.bindings.map(s => `${escHtml(s.label ? s.name + ':' + s.label : (s.name || '?'))}<span class="action-tag ${bcBindingTag(s)}">${bcBindingTag(s)}</span>`).join(' · ')
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
      // Page-select channels (e.g. HASP balcony's `page` channel)
      // replace the action dropdown with a page-number dropdown
      // (min..max). Selecting a number stores `{action: 'turn_on',
      // page_num: N}` on the binding — the rule engine HASP branch
      // translates that into a `command/page` publish.
      const isPageSelect = d.chan_meta && d.chan_meta.type === 'page_select';
      const isAlexa = d.protocol === 'alexa';
      let dropdownHtml;
      if (isPageSelect) {
        const lo = Number(d.chan_meta.min || 1);
        const hi = Number(d.chan_meta.max || 12);
        const cur = (existing && existing.page_num) || lo;
        const opts = [];
        for (let n = lo; n <= hi; n++) opts.push(n);
        dropdownHtml = `<select class="picker-page-select">
          ${opts.map(n => `<option value="${n}" ${n === cur ? 'selected' : ''}>Page ${n}</option>`).join('')}
        </select>`;
      } else if (isAlexa) {
        const curVal = existing
          ? bcAlexaOptionValue(existing.action,
              existing.template_name || existing.station_name || null)
          : 'speak:' + ((_bcAlexaAnnouncements[0] && _bcAlexaAnnouncements[0].name) || '');
        const speakOpts = (_bcAlexaAnnouncements || []).map(t => {
          const v = bcAlexaOptionValue('speak', t.name);
          return `<option value="${escHtml(v)}" ${v === curVal ? 'selected' : ''}>${escHtml(t.name)}</option>`;
        }).join('');
        const playOpts = (_bcAlexaStations || []).map(s => {
          const v = bcAlexaOptionValue('play', s.name);
          return `<option value="${escHtml(v)}" ${v === curVal ? 'selected' : ''}>${escHtml(s.name)}</option>`;
        }).join('');
        dropdownHtml = `<select class="picker-action-select">
          ${speakOpts ? `<optgroup label="Speak">${speakOpts}</optgroup>` : ''}
          ${playOpts  ? `<optgroup label="Play music">${playOpts}</optgroup>` : ''}
          <optgroup label="Stop"><option value="stop" ${'stop' === curVal ? 'selected' : ''}>stop</option></optgroup>
        </select>`;
      } else {
        dropdownHtml = `<select class="picker-action-select">
          ${ACTIONS.map(a => `<option value="${a.v}" ${a.v === act ? 'selected' : ''}>${a.label}</option>`).join('')}
        </select>`;
      }

      const item = document.createElement('div');
      item.className = 'picker-item';
      item.innerHTML = `
        <input type="checkbox" ${checked ? 'checked' : ''}>
        <div class="picker-item-name">${escHtml(displayName)}</div>
        ${dropdownHtml}
        <div class="picker-item-meta">${escHtml(d.protocol)}${d.channel ? ' · '+d.channel : ''}</div>`;
      const cb = item.querySelector('input');
      const sel = item.querySelector('select');
      item.addEventListener('click', (e) => {
        if (e.target === sel || sel.contains(e.target)) return;
        if (e.target !== cb) cb.checked = !cb.checked;
        bcToggleSelection(d, cb.checked, sel.value, isPageSelect, isAlexa);
      });
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        if (!cb.checked) cb.checked = true;
        bcToggleSelection(d, cb.checked, sel.value, isPageSelect, isAlexa);
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

  function bcToggleSelection(dev, checked, action, isPageSelect, isAlexa) {
    if (!_bcActivePicker) return;
    const row = _buttons.find(r => r.id === _bcActivePicker.rowId);
    if (!row) return;
    if (!row.bindings) row.bindings = [];
    const idx = row.bindings.findIndex(s =>
      s.device_id === dev.device_id && (s.channel || null) === (dev.channel || null));
    // Decode dropdown value: alexa speak/play carry a name suffix, page-
    // select rows carry a page number, others are plain action verbs.
    const pageNum = isPageSelect ? parseInt(action, 10) : null;
    let storedAction = isPageSelect ? 'turn_on' : action;
    let templateName = null, stationName = null;
    if (isAlexa) {
      const parsed = bcParseAlexaOptionValue(action);
      storedAction = parsed.action;
      if (parsed.action === 'speak') templateName = parsed.name || '';
      if (parsed.action === 'play')  stationName  = parsed.name || '';
    }
    if (checked) {
      if (idx >= 0) {
        row.bindings[idx].action = storedAction;
        if (isPageSelect) row.bindings[idx].page_num = pageNum;
        else delete row.bindings[idx].page_num;
        if (isAlexa) {
          if (templateName) row.bindings[idx].template_name = templateName;
          else delete row.bindings[idx].template_name;
          if (stationName)  row.bindings[idx].station_name  = stationName;
          else delete row.bindings[idx].station_name;
        }
      } else {
        const b = {
          device_id: dev.device_id, channel: dev.channel,
          name: dev.name, label: dev.label, action: storedAction,
        };
        if (isPageSelect) b.page_num = pageNum;
        if (isAlexa && templateName) b.template_name = templateName;
        if (isAlexa && stationName)  b.station_name  = stationName;
        row.bindings.push(b);
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
    const inp = 'padding:3px 5px;border:1px solid #d0cbc4;border-radius:3px;font-size:0.78rem;width:100%;box-sizing:border-box;';
    const lblStyle = 'display:flex;flex-direction:column;font-size:0.72rem;color:#888;text-transform:uppercase;letter-spacing:0.4px;gap:2px;min-width:0;';
    return `
      <div class="card" style="padding:8px 10px;margin-bottom:8px;background:#faf8f5;overflow-x:auto;" data-id="${d.id}">
        <div style="display:grid;grid-template-columns:60px 70px 92px 88px 70px 1.4fr 1.1fr 1.5fr 110px auto;gap:8px;align-items:end;min-width:1180px;">
          <label style="${lblStyle}">Page
            <input type="number" value="${d.page}" min="0" max="12"
              oninput="bcUpdateDisplay(${d.id},'page',parseInt(this.value))" style="${inp}">
          </label>
          <label style="${lblStyle}">Label ID
            <input type="number" value="${d.label_id}" min="0"
              oninput="bcUpdateDisplay(${d.id},'label_id',parseInt(this.value))" style="${inp}">
          </label>
          <label style="${lblStyle}">Type
            <select onchange="bcUpdateDisplay(${d.id},'display_type',this.value)" style="${inp}">${dtypes}</select>
          </label>
          <label style="${lblStyle}">Target
            <select onchange="bcUpdateDisplay(${d.id},'target_property',this.value)" style="${inp}">${tprops}</select>
          </label>
          <label style="${lblStyle}">Refresh
            <input type="number" value="${d.refresh_sec || 30}" min="5" max="3600"
              oninput="bcUpdateDisplay(${d.id},'refresh_sec',parseInt(this.value))" style="${inp}">
          </label>
          <label style="${lblStyle}" title="state.shared key or Device sensor">Source
            <select onchange="bcUpdateDisplay(${d.id},'source_value',this.value); bcUpdateDisplay(${d.id},'source_type',this.value.startsWith('device:')?'device':'shared_state'); bcUpdatePreview(${d.id})" style="${inp}">${keysOptions}</select>
          </label>
          <label style="${lblStyle}">Description
            <input type="text" value="${escHtml(d.description || '')}"
              oninput="bcUpdateDisplay(${d.id},'description',this.value)" style="${inp}">
          </label>
          <label style="${lblStyle}">Format
            <input type="text" value="${escHtml(d.format_string || '')}" placeholder="{{val}}°C"
              oninput="bcUpdateDisplay(${d.id},'format_string',this.value); bcUpdatePreview(${d.id})"
              style="${inp}font-family:monospace;">
          </label>
          <div style="${lblStyle}">Preview
            <div style="background:#fff;padding:3px 8px;border-radius:3px;border-left:3px solid #7a9ab8;font-size:0.82rem;font-family:monospace;color:#000;height:22px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="last: ${escHtml(d.last_value || '')}">
              <span data-cell="preview">—</span>
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:end;height:100%;">
            <button class="btn-save" style="padding:4px 10px;" onclick="bcSaveDisplay(${d.id})" title="Save this row">Save</button>
            <button class="btn-test" style="border-color:#c0392b;color:#c0392b;font-size:1rem;line-height:1;padding:3px 9px;" onclick="bcDeleteDisplay(${d.id})" title="Delete this display row">×</button>
            <span data-cell="status" style="font-size:0.72rem;color:#888;align-self:center;"></span>
          </div>
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
    if (!el) return;
    const rendered = await bcRenderPreview(d.format_string, d.source_value);
    el.textContent = rendered || '—';
    // Put the full rendered value in the parent's tooltip so truncated text
    // is recoverable on hover. Keep last_value too if it differs.
    const wrap = el.parentElement;
    if (wrap) {
      const parts = [];
      if (rendered) parts.push(rendered);
      if (d.last_value && d.last_value !== rendered) parts.push(`last: ${d.last_value}`);
      wrap.title = parts.join(' · ');
    }
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
      // Refresh list so the 'only configured' filter sees the saved values
      if (r.ok) bcRenderDisplaysList();
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

  // ════════════════════════════════════════════════════════════════════════
  // ─── Balcony Smart Switch (Tuya TS0044) — bindings UI ────────────────────
  // 4 buttons × 2 events (single, hold) = 8 binding slots, multi-device per
  // slot. Storage: dashboard_settings.balcony.smart_switch_bindings. Mirrors
  // the HASP-button bindings pattern above with sw* prefix instead of bc*.
  // ════════════════════════════════════════════════════════════════════════
  const SW_STORAGE_KEY = 'balcony.smart_switch_bindings';
  // Single-press only (decided 2026-05-03). Hold doesn't work on the user's
  // MOES TS0044 firmware variant (0 hold events captured across many tests).
  // Double-click was tried but causes a visible on→off flicker that no
  // immediate-dispatch design can avoid; deferring single by 500ms to
  // suppress it introduced sluggish latency. Cleanest UX: bind one row per
  // button — user picks per-binding whether the action is `toggle`,
  // `turn_on`, or `turn_off`. Multi-device per slot still supported.
  const SW_EVENTS = ['single'];

  let _swButtons = [];          // [{id:'btn1:single', button:1, event:'single', label:'Button 1', bindings:[]}]
  let _swActivePicker = null;   // {rowId, snapshot}

  // Build the 8 fixed slots (button × event), seeding from saved bindings.
  function swBuildButtons(saved) {
    const out = [];
    for (let n = 1; n <= 4; n++) {
      for (const ev of SW_EVENTS) {
        const id = `btn${n}:${ev}`;
        out.push({
          id, button: n, event: ev,
          label: `Button ${n}`,
          bindings: Array.isArray(saved[id]) ? saved[id] : [],
        });
      }
    }
    return out;
  }

  async function swLoadBindings() {
    try {
      const r = await fetch('/api/dashboard-settings/' + encodeURIComponent(SW_STORAGE_KEY)).then(r => r.json());
      const saved = (r && typeof r.value === 'object' && r.value) ? r.value : {};
      _swButtons = swBuildButtons(saved);
    } catch (_) {
      _swButtons = swBuildButtons({});
    }
    await bcLoadControllableDevices();   // re-use the bc devices cache
    swRender();
  }

  function swRender() {
    const host = document.getElementById('sw-buttons-list');
    if (!host) return;
    // Group rows by button.
    const html = [1, 2, 3, 4].map(n => {
      const rowsForButton = _swButtons.filter(r => r.button === n);
      return swRenderButtonCard(rowsForButton[0], rowsForButton);
    }).join('');
    host.innerHTML = html || '<div style="padding:8px;color:#888;font-size:0.85rem;">no buttons</div>';
  }

  function swRenderButtonCard(headerRow, allRowsForButton) {
    return `
      <div class="button-row" data-sw-btn="${headerRow.button}">
        <div class="button-label">
          ${escHtml(headerRow.label)}
          <div style="font-weight:normal;color:#aaa;font-size:0.72rem;">btn${headerRow.button}</div>
        </div>
        <div class="event-rows">
          ${allRowsForButton.map(r => `
            <div class="event-row">
              <span class="event-type ${r.event}">${r.event}</span>
              <div class="device-picker ${(r.bindings && r.bindings.length) ? '' : 'empty'}"
                   data-sw-picker="${escHtml(r.id)}"
                   onclick="swOpenPicker('${escHtml(r.id)}')">
                ${(r.bindings && r.bindings.length)
                    ? r.bindings.map(s => `${escHtml(s.label ? s.name + ':' + s.label : (s.name || '?'))}<span class="action-tag ${bcBindingTag(s)}">${bcBindingTag(s)}</span>`).join(' · ')
                    : '— select devices —'}
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }

  function swRenderPickerDisplay(rowId) {
    const row = _swButtons.find(r => r.id === rowId);
    const el = document.querySelector(`[data-sw-picker="${rowId}"]`);
    if (!row || !el) return;
    el.classList.toggle('empty', !(row.bindings && row.bindings.length));
    el.innerHTML = (row.bindings && row.bindings.length)
      ? row.bindings.map(s => `${escHtml(s.label ? s.name + ':' + s.label : (s.name || '?'))}<span class="action-tag ${bcBindingTag(s)}">${bcBindingTag(s)}</span>`).join(' · ')
      : '— select devices —';
  }

  // Picker — separate state from HASP-button picker (_bcActivePicker) so the
  // two UIs don't collide when both tabs have open dialogs (rare but safe).
  window.swOpenPicker = function (rowId) {
    const row = _swButtons.find(r => r.id === rowId);
    if (!row) return;
    if (!row.bindings) row.bindings = [];
    _swActivePicker = { rowId, snapshot: JSON.parse(JSON.stringify(row.bindings)) };
    document.getElementById('picker-title').textContent = `${row.label} · ${row.event}`;
    document.getElementById('picker-search-input').value = '';
    swRenderPickerList('');
    document.getElementById('picker-overlay').classList.add('show');
    // Repoint the picker overlay's footer/close handlers to the smart-switch
    // helpers — the existing bcClosePicker / bcFilterPicker / bcTogglePickerItem
    // are wired via inline onclick to the bc* functions; we override via
    // window for the duration of this picker session and restore on close.
    window._swPickerActive = true;
  };

  function swRenderPickerList(filter) {
    if (!_swActivePicker) return;
    const row = _swButtons.find(r => r.id === _swActivePicker.rowId);
    if (!row) return;
    if (!row.bindings) row.bindings = [];
    const selByKey = new Map(row.bindings.map(s => [s.device_id + ':' + (s.channel || ''), s]));
    const f = (filter || '').toLowerCase();
    const list = document.getElementById('picker-list');
    list.innerHTML = '';
    let currentRoom = null;
    const defAct = 'toggle';

    for (const d of _controllable) {
      const rowKey = d.device_id + ':' + (d.channel || '');
      const displayName = d.label ? `${d.name} — ${d.label}` : d.name;
      const blob = `${d.name} ${d.label || ''} ${d.room || ''}`.toLowerCase();
      if (f && !blob.includes(f)) continue;

      if (d.room !== currentRoom) {
        currentRoom = d.room;
        const rl = document.createElement('div');
        rl.className = 'picker-room-label';
        rl.textContent = d.room || '(no room)';
        list.appendChild(rl);
      }

      const sel = selByKey.get(rowKey);
      const isAlexa = d.protocol === 'alexa';
      // Alexa rows get a Speak/Play optgroup dropdown (same as the
      // panel-button picker). Non-alexa rows keep the plain
      // turn_on/turn_off/toggle dropdown.
      let actionSelectHtml;
      if (isAlexa) {
        const curVal = sel
          ? bcAlexaOptionValue(sel.action, sel.template_name || sel.station_name || null)
          : 'speak:' + ((_bcAlexaAnnouncements[0] && _bcAlexaAnnouncements[0].name) || '');
        const speakOpts = (_bcAlexaAnnouncements || []).map(t => {
          const v = bcAlexaOptionValue('speak', t.name);
          return `<option value="${escHtml(v)}" ${v === curVal ? 'selected' : ''}>${escHtml(t.name)}</option>`;
        }).join('');
        const playOpts = (_bcAlexaStations || []).map(s2 => {
          const v = bcAlexaOptionValue('play', s2.name);
          return `<option value="${escHtml(v)}" ${v === curVal ? 'selected' : ''}>${escHtml(s2.name)}</option>`;
        }).join('');
        actionSelectHtml = `<select class="picker-action-select" data-sw-action="${escHtml(rowKey)}" ${sel ? '' : 'disabled'}>
          ${speakOpts ? `<optgroup label="Speak">${speakOpts}</optgroup>` : ''}
          ${playOpts  ? `<optgroup label="Play music">${playOpts}</optgroup>` : ''}
          <optgroup label="Stop"><option value="stop" ${'stop' === curVal ? 'selected' : ''}>stop</option></optgroup>
        </select>`;
      } else {
        actionSelectHtml = `<select class="picker-action-select" data-sw-action="${escHtml(rowKey)}" ${sel ? '' : 'disabled'}>
          ${ACTIONS.map(a => `<option value="${a.v}" ${(sel?.action || defAct) === a.v ? 'selected' : ''}>${a.label}</option>`).join('')}
        </select>`;
      }
      const item = document.createElement('div');
      item.className = 'picker-item';
      const checked = sel ? 'checked' : '';
      item.innerHTML = `
        <input type="checkbox" ${checked} data-sw-item="${escHtml(rowKey)}">
        <span class="picker-item-name">${escHtml(displayName)}</span>
        <span class="picker-item-meta">${escHtml(d.protocol || '')}</span>
        ${actionSelectHtml}
      `;
      const cb = item.querySelector('input[type=checkbox]');
      const selEl = item.querySelector('select.picker-action-select');
      // Helper: compute binding fields from the dropdown's current value.
      function bindingFromSelect() {
        if (isAlexa) {
          const parsed = bcParseAlexaOptionValue(selEl.value);
          const out = { action: parsed.action };
          if (parsed.action === 'speak') out.template_name = parsed.name || '';
          if (parsed.action === 'play')  out.station_name  = parsed.name || '';
          return out;
        }
        return { action: selEl.value || defAct };
      }
      cb.addEventListener('change', () => {
        if (cb.checked) {
          const bindFields = bindingFromSelect();
          row.bindings.push({
            device_id: d.device_id, channel: d.channel, name: d.name,
            label: d.label || '', ...bindFields,
          });
          selEl.disabled = false;
        } else {
          row.bindings = row.bindings.filter(s => !(s.device_id === d.device_id && (s.channel || '') === (d.channel || '')));
          selEl.disabled = true;
        }
      });
      selEl.addEventListener('change', () => {
        const b = row.bindings.find(s => s.device_id === d.device_id && (s.channel || '') === (d.channel || ''));
        if (!b) return;
        const fields = bindingFromSelect();
        b.action = fields.action;
        if (isAlexa) {
          if (fields.template_name) b.template_name = fields.template_name; else delete b.template_name;
          if (fields.station_name)  b.station_name  = fields.station_name;  else delete b.station_name;
        }
      });
      list.appendChild(item);
    }
  }

  // Override picker close + filter when a smart-switch picker is active so
  // the same overlay (declared in HTML, wired via inline onclick to bc*)
  // routes to the right state. The wrapper checks _swPickerActive; if not
  // set, falls through to the original bc* behavior.
  const _origBcClosePicker = window.bcClosePicker;
  window.bcClosePicker = function (save) {
    if (window._swPickerActive) {
      document.getElementById('picker-overlay').classList.remove('show');
      if (!save && _swActivePicker) {
        const row = _swButtons.find(r => r.id === _swActivePicker.rowId);
        if (row) row.bindings = _swActivePicker.snapshot;
      }
      if (_swActivePicker) swRenderPickerDisplay(_swActivePicker.rowId);
      _swActivePicker = null;
      window._swPickerActive = false;
      return;
    }
    return _origBcClosePicker.apply(this, arguments);
  };
  const _origBcFilterPicker = window.bcFilterPicker;
  window.bcFilterPicker = function () {
    if (window._swPickerActive) {
      swRenderPickerList(document.getElementById('picker-search-input').value);
      return;
    }
    return _origBcFilterPicker.apply(this, arguments);
  };

  window.swSaveAllBindings = async function () {
    // Serialize _swButtons → {slot_key: bindings[]} object expected by the rule.
    const payload = {};
    for (const r of _swButtons) {
      payload[r.id] = (r.bindings || []).map(b => {
        const out = {
          device_id: b.device_id,
          channel:   b.channel,
          action:    b.action,
          name:      b.name,
          label:     b.label || '',
        };
        // Preserve Alexa speak/play extras so the rule handler can do the
        // template / station lookup at fire-time.
        if (b.template_name) out.template_name = b.template_name;
        if (b.station_name)  out.station_name  = b.station_name;
        return out;
      });
    }
    try {
      const resp = await fetch('/api/dashboard-settings/' + encodeURIComponent(SW_STORAGE_KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: payload }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      alert('Saved.');
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
  };

  // Lazy-load on first tab activation. The original showTab fires once when
  // the user first clicks the smart-switch tab — wrap it to load bindings then.
  const _origShowTab = window.showTab;
  let _swInitialized = false;
  window.showTab = function (name, btn) {
    _origShowTab(name, btn);
    if (name === 'smart-switch' && !_swInitialized) {
      _swInitialized = true;
      swLoadBindings();
    }
  };

  window.addEventListener('DOMContentLoaded', () => {
    refreshPage();
    hpInit();
    bcLoadButtons();
    bcLoadDisplays();
  });
})();
