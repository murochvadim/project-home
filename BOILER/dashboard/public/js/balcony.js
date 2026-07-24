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

  // Reflect current backlight power state on the chip + active button.
  // Accepts true / false / null (= unknown). Persists across page navigations
  // via localStorage so the chip shows last-known state immediately on reload
  // instead of waiting for the first MQTT statusupdate roundtrip.
  const HP_POWER_KEY = 'balcony.hp.power';
  function hpRenderPower(on) {
    const chip = document.getElementById('hp-power-chip');
    if (chip) {
      if (on === true) {
        chip.textContent = 'power: ON';
        chip.style.background = '#3a7d44'; chip.style.color = '#fff'; chip.style.borderColor = '#3a7d44';
      } else if (on === false) {
        chip.textContent = 'power: OFF';
        chip.style.background = '#c0392b'; chip.style.color = '#fff'; chip.style.borderColor = '#c0392b';
      } else {
        chip.textContent = 'power: —';
        chip.style.background = '#eee'; chip.style.color = '#888'; chip.style.borderColor = '#d0cbc4';
      }
    }
    const bOn  = document.getElementById('hp-btn-on');
    const bOff = document.getElementById('hp-btn-off');
    if (bOn)  { bOn.style.background  = on === true  ? '#3a7d44' : ''; bOn.style.color  = on === true  ? '#fff' : '#3a7d44'; }
    if (bOff) { bOff.style.background = on === false ? '#c0392b' : ''; bOff.style.color = on === false ? '#fff' : '#c0392b'; }
    try {
      if (on === true || on === false) localStorage.setItem(HP_POWER_KEY, on ? '1' : '0');
    } catch (_) {}
  }
  function hpRestoreCachedPower() {
    try {
      const v = localStorage.getItem(HP_POWER_KEY);
      if (v === '1') hpRenderPower(true);
      else if (v === '0') hpRenderPower(false);
    } catch (_) {}
  }

  function hpUpdateStatus(s) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('hp-uptime', hpFmtUptime(s.uptime));
    set('hp-rssi',   s.rssi ?? '—');
    const page = s.page ?? null;
    const num  = s.numPages ?? null;
    set('hp-page', page != null ? (num != null ? `${page} / ${num}` : `${page}`) : '—');
    // Note: OpenHASP firmware 0.7.0-rc12 statusupdate does NOT include the
    // backlight state — see the dedicated state/backlight subscription in
    // hpInit() for power tracking.
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
    // Optimistic UI flip + force a quick statusupdate so the real state
    // (echoed back from the panel) confirms in ~1 s instead of waiting
    // for the 30 s status poll.
    hpRenderPower(!!on);
    setTimeout(() => _hpMqtt.publish(`hasp/${HP_PLATE}/command/statusupdate`, ''), 500);
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
      // state/backlight publishes whenever the backlight changes — the
      // statusupdate JSON does NOT carry the backlight field on firmware
      // 0.7.0-rc12. Subscribe directly to this topic to track power state.
      _hpMqtt.subscribe(`hasp/${HP_PLATE}/state/backlight`, { qos: 0 });
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
      } else if (topic === `hasp/${HP_PLATE}/state/backlight`) {
        // Payload shape: {"state":"on"|"off","brightness":<0-255>}
        try {
          const o = JSON.parse(payload.toString());
          if (o && typeof o.state === 'string') {
            hpRenderPower(o.state.toLowerCase() === 'on');
          }
        } catch (_) {}
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
  const CONTROLLABLE_TYPES = new Set(['switch', 'light', 'circuit_breaker', 'water_heater', 'curtain', 'valve', 'esp_board', 'panel', 'display', 'media_player', 'vacuum']);

  let _buttons = [];
  let _controllable = [];
  let _bcActivePicker = null;  // {row_id, snapshot}
  // Media Buttons card (page 4 control + page 5 selection → Balcony TV tv55)
  const MEDIA_API   = 'http://192.168.1.138:8766';  // player service (browser → media agent directly, same as media.js)
  let _mediaButtons = [];   // hasp_buttons rows with action_type='media'
  let _playlists    = [];   // [{id, name, ...}] from media agent
  let _videos       = [];   // [{rel, name}] under /Videos
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
    // Vacuum verbs (start/stop/dock/locate) and bare alexa stop both
    // render as the verb itself — context (device name) disambiguates.
    if (b && (b.action === 'stop' || b.action === 'start'
              || b.action === 'dock' || b.action === 'locate')) return b.action;
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
                                 chan_meta: meta,
                                 // Pulse-only channels (action_on without action_off,
                                 // e.g. RemoteXY door_open) get a filtered action
                                 // dropdown so the user can't pick Turn Off / Toggle.
                                 has_on:  !!cc.action_on,
                                 has_off: !!cc.action_off });
          }
        } else {
          _controllable.push({ device_id: d.id, channel: null, name: d.name, label: '',
                               room: d.room || '', protocol: d.protocol,
                               dps_config: d.dps_config || {} });   // for vacuum verb list
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
      const isAlexa  = d.protocol === 'alexa';
      const isVacuum = d.protocol === 'vacuum';
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
      } else if (isVacuum) {
        // Vacuum verbs: read from this device's dps_config (Roomba has
        // 4, Viomi has 3 — locate broken on Viomi's HA integration).
        const verbs = Object.values(d.dps_config || {})
          .filter(cfg => cfg && cfg.action_on)
          .map(cfg => cfg.action_on);
        const curVal = existing ? existing.action : (verbs[0] || 'start');
        const verbOpts = verbs.map(verb =>
          `<option value="${verb}" ${verb === curVal ? 'selected' : ''}>${verb}</option>`
        ).join('');
        dropdownHtml = `<select class="picker-action-select">
          <optgroup label="Vacuum">${verbOpts}</optgroup>
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
        // ESP channels with has_on / has_off flags get filtered to the
        // directions the channel actually supports. Other rows (Tuya gangs,
        // Zigbee) keep the full ACTIONS list.
        const allowedActions = (d.has_on !== undefined || d.has_off !== undefined)
          ? ACTIONS.filter(a =>
              (a.v === 'turn_on'  && d.has_on) ||
              (a.v === 'turn_off' && d.has_off) ||
              (a.v === 'toggle'   && d.has_on && d.has_off)
            )
          : ACTIONS;
        dropdownHtml = `<select class="picker-action-select">
          ${allowedActions.map(a => `<option value="${a.v}" ${a.v === act ? 'selected' : ''}>${a.label}</option>`).join('')}
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
        bcToggleSelection(d, cb.checked, sel.value, isPageSelect, isAlexa, isVacuum);
      });
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        if (!cb.checked) cb.checked = true;
        bcToggleSelection(d, cb.checked, sel.value, isPageSelect, isAlexa, isVacuum);
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

  function bcToggleSelection(dev, checked, action, isPageSelect, isAlexa, isVacuum) {
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
      const all = (r.buttons || []).map(b => ({ ...b, bindings: b.bindings || [] }));
      // Media buttons (page 4 control / page 5 selection) get their own card —
      // keep them out of the device-only Button Bindings picker.
      _mediaButtons = all.filter(b => b.action_type === 'media');
      _buttons      = all.filter(b => b.action_type !== 'media');
    } catch (_) { _buttons = []; _mediaButtons = []; }
    bcLoadMediaButtons();
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

  // ─── Media Buttons card ────────────────────────────────────────────────────
  // Page 4 = control (TV on/off, queue pause/stop/next — fixed bindings).
  // Page 5 = selection (assign one playlist OR one video per button). Saving a
  // selection PATCHes the row's bindings JSONB; the Balcony Buttons rule then
  // routes the press to rule_engine._dispatch_media → media agent on LXC 100.
  const _VID_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ts', '.flv', '.wmv']);

  async function bcLoadMediaButtons() {
    try {
      const [pr, wr] = await Promise.all([
        fetch(`${MEDIA_API}/api/playlists`).then(r => r.json()).catch(() => []),
        fetch(`${MEDIA_API}/api/media/walk?path=Videos`).then(r => r.json()).catch(() => ({ files: [] })),
      ]);
      _playlists = Array.isArray(pr) ? pr : (pr.playlists || []);
      _videos = ((wr && wr.files) || [])
        .filter(f => _VID_EXT.has((f.ext || '').toLowerCase()))
        .map(f => ({ rel: (f.path || '').replace('/mnt/media/', ''), name: f.name }));
    } catch (_) { /* keep whatever we had */ }
    bcRenderMediaList();
  }

  function bcMediaRow(r, selectable) {
    const b = (r.bindings || [])[0] || null;
    const head = `<div style="min-width:118px;font-weight:600;">${escHtml(r.label || ('p' + r.page + 'b' + r.button_id))}`
      + `<span style="font-weight:normal;color:#aaa;font-size:0.72rem;"> p${r.page}b${r.button_id}</span></div>`;
    let mid;
    if (!selectable) {
      mid = `<span style="font-size:0.8rem;color:#777;flex:1;">control · <code>${escHtml(b ? b.media_action : '—')}</code> → tv55</span>`;
    } else {
      let cur = '';
      if (b && b.media_action === 'play_playlist' && b.playlist_id != null) cur = 'pl:' + b.playlist_id;
      else if (b && b.media_action === 'play_video' && b.rel_path) cur = 'vid:' + b.rel_path;
      const plOpts = _playlists.map(p =>
        `<option value="pl:${p.id}"${cur === 'pl:' + p.id ? ' selected' : ''}>${escHtml(p.name)}</option>`).join('');
      const vidOpts = _videos.map(v =>
        `<option value="vid:${escHtml(v.rel)}"${cur === 'vid:' + v.rel ? ' selected' : ''}>${escHtml(v.name)}</option>`).join('');
      mid = `<select onchange="bcMediaSelectChange(${r.id}, this.value, this)" style="flex:1;max-width:360px;padding:4px 6px;font-size:0.82rem;border:1px solid #d0cbc4;border-radius:3px;">`
        + `<option value=""${cur === '' ? ' selected' : ''}>— none —</option>`
        + `<optgroup label="Playlists">${plOpts}</optgroup>`
        + `<optgroup label="Videos">${vidOpts}</optgroup>`
        + `</select>`;
    }
    return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid #eee;">`
      + head + mid
      + `<button class="btn-test" onclick="bcTestMediaRow(${r.id}, this)">▶ Test</button></div>`;
  }

  function bcRenderMediaList() {
    const list = document.getElementById('bc-media-list');
    if (!list) return;
    const ctrl = _mediaButtons.filter(b => b.page === 4).sort((a, b) => a.button_id - b.button_id);
    const sel  = _mediaButtons.filter(b => b.page === 5).sort((a, b) => a.button_id - b.button_id);
    const hdr = t => `<div style="font-size:0.8rem;color:#555;font-weight:600;margin:10px 0 4px;">${t}</div>`;
    const none = '<div style="color:#888;font-size:0.8rem;padding:4px;">none — run Sync from panel after editing widgets</div>';
    list.innerHTML =
      hdr('Page 4 — Control (fixed)') + (ctrl.length ? ctrl.map(r => bcMediaRow(r, false)).join('') : none)
      + hdr('Page 5 — Selection (pick a playlist or video)') + (sel.length ? sel.map(r => bcMediaRow(r, true)).join('') : none);
  }

  window.bcMediaSelectChange = async function (rowId, val, selEl) {
    const row = _mediaButtons.find(r => r.id === rowId);
    if (!row) return;
    if (!val) {
      row.bindings = [];
    } else if (val.startsWith('pl:')) {
      const pid = parseInt(val.slice(3), 10);
      const pl = _playlists.find(p => p.id === pid);
      row.bindings = [{ type: 'media', media_action: 'play_playlist', playlist_id: pid,
                        target: 'tv55', shuffle: false, repeat: false,
                        label: pl ? pl.name : ('Playlist ' + pid) }];
    } else if (val.startsWith('vid:')) {
      const rel = val.slice(4);
      row.bindings = [{ type: 'media', media_action: 'play_video', rel_path: rel,
                        target: 'tv55', label: rel.split('/').pop() }];
    }
    // Auto-save immediately — the panel button reads the SAVED binding, so a
    // pick must persist without a separate Save click (the old trap). Save All
    // stays as a bulk backup.
    try {
      const r = await fetch(`/api/hasp/${BC_PANEL}/buttons/${rowId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindings: row.bindings || [] })
      });
      if (selEl) {
        selEl.style.borderColor = r.ok ? '#3a7d44' : '#c0392b';
        setTimeout(() => { selEl.style.borderColor = '#d0cbc4'; }, 1200);
      }
    } catch (_) {
      if (selEl) { selEl.style.borderColor = '#c0392b'; setTimeout(() => { selEl.style.borderColor = '#d0cbc4'; }, 1200); }
    }
  };

  window.bcSaveMediaButtons = async function () {
    const btn = document.querySelector('#bc-media-card .btn-save');
    if (!btn) return;
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    let ok = 0, fail = 0;
    // Only page-5 selection rows are user-editable; page-4 control bindings are fixed.
    for (const row of _mediaButtons.filter(r => r.page === 5)) {
      try {
        const r = await fetch(`/api/hasp/${BC_PANEL}/buttons/${row.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bindings: row.bindings || [] })
        });
        if (r.ok) ok++; else fail++;
      } catch (_) { fail++; }
    }
    btn.textContent = fail === 0 ? '✓ Saved' : `✗ ${fail} failed`;
    btn.style.background = fail === 0 ? '#3a7d44' : '#c0392b';
    setTimeout(() => { btn.textContent = original; btn.style.background = ''; btn.disabled = false; }, 2000);
  };

  window.bcTestMediaRow = async function (rowId, btnEl) {
    const row = _mediaButtons.find(r => r.id === rowId);
    if (!row) return;
    const b = (row.bindings || [])[0];
    const flash = (txt, okColor) => {
      if (!btnEl) return;
      const o = btnEl.textContent; btnEl.textContent = txt;
      if (okColor) btnEl.style.color = okColor;
      setTimeout(() => { btnEl.textContent = o; btnEl.style.color = ''; }, 1500);
    };
    if (!b || !b.media_action) { flash('— empty', '#c0392b'); return; }
    const target = b.target || 'tv55';
    let url, body = {};
    switch (b.media_action) {
      case 'tv_on':  url = `${MEDIA_API}/api/media/command`; body = { entity: target, command: 'turn_on' }; break;
      case 'tv_off': url = `${MEDIA_API}/api/media/command`; body = { entity: target, command: 'turn_off' }; break;
      case 'vol_up':   url = `${MEDIA_API}/api/media/command`; body = { entity: target, command: 'volume_step', value: 10 };   break;
      case 'vol_down': url = `${MEDIA_API}/api/media/command`; body = { entity: target, command: 'volume_step', value: -10 }; break;
      case 'pause':  url = `${MEDIA_API}/api/queue/pause`; break;
      case 'stop':   url = `${MEDIA_API}/api/queue/stop`;  break;
      case 'next':   url = `${MEDIA_API}/api/queue/next`;  break;
      case 'prev':   url = `${MEDIA_API}/api/queue/prev`;  break;
      case 'play_playlist':
        url = `${MEDIA_API}/api/playlists/${b.playlist_id}/play`;
        body = { target, shuffle: !!b.shuffle, repeat: !!b.repeat }; break;
      case 'play_video':
        url = `${MEDIA_API}/api/media/play`;
        body = { relPath: b.rel_path, target }; break;
      default: flash('— ?', '#c0392b'); return;
    }
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      flash(r.ok ? '✓' : '✗ ' + r.status, r.ok ? '#3a7d44' : '#c0392b');
    } catch (_) { flash('✗ net', '#c0392b'); }
  };

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
      const isAlexa  = d.protocol === 'alexa';
      const isVacuum = d.protocol === 'vacuum';
      // Alexa rows get a Speak/Play optgroup dropdown (same as the
      // panel-button picker). Vacuum rows get a Vacuum optgroup with
      // start/stop/dock/locate. Non-alexa, non-vacuum rows keep the
      // plain turn_on/turn_off/toggle dropdown.
      let actionSelectHtml;
      if (isVacuum) {
        const verbs = Object.values(d.dps_config || {})
          .filter(cfg => cfg && cfg.action_on)
          .map(cfg => cfg.action_on);
        const curVal = sel ? sel.action : (verbs[0] || 'start');
        const verbOpts = verbs.map(verb =>
          `<option value="${verb}" ${verb === curVal ? 'selected' : ''}>${verb}</option>`
        ).join('');
        actionSelectHtml = `<select class="picker-action-select" data-sw-action="${escHtml(rowKey)}" ${sel ? '' : 'disabled'}>
          <optgroup label="Vacuum">${verbOpts}</optgroup>
        </select>`;
      } else if (isAlexa) {
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
        const allowedActions = (d.has_on !== undefined || d.has_off !== undefined)
          ? ACTIONS.filter(a =>
              (a.v === 'turn_on'  && d.has_on) ||
              (a.v === 'turn_off' && d.has_off) ||
              (a.v === 'toggle'   && d.has_on && d.has_off)
            )
          : ACTIONS;
        actionSelectHtml = `<select class="picker-action-select" data-sw-action="${escHtml(rowKey)}" ${sel ? '' : 'disabled'}>
          ${allowedActions.map(a => `<option value="${a.v}" ${(sel?.action || defAct) === a.v ? 'selected' : ''}>${a.label}</option>`).join('')}
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
    hpRestoreCachedPower();
    hpInit();
    bcLoadButtons();
    bcLoadDisplays();
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// Star Projector tab — direct Tuya local DPS via POST /api/devices/:id/dps
// Self-contained IIFE; does not touch the panel/smart-switch module above.
// ════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const SP_DEVICE_NAME = 'Star Projector';
  let SP_DEVICE_ID = null;        // resolved on first init
  let SP_STATE = {};              // last_state cached from /api/devices
  let SP_LAST_SEEN = null;        // ISO string from /api/devices
  let SP_IP = null;
  let SP_BRIGHT_TOUCH_TS = 0;     // debounce for live slider repaint
  let SP_POLL_TIMER = null;
  let SP_INITED = false;

  // Tuya Cloud "WIFI Star Projector 2" datapoints — labels mirror dps_labels:
  //   20 Power (bool), 21 Mode (enum: white|colour|scene|music),
  //   22 Brightness (int 10..1000), 24 Colour (hex string HHHHSSSSVVVV),
  //   25 Scene (string id), 26 Timer (int seconds), 101/102/103 (unknown).

  const SP_MODES   = ['white', 'colour', 'scene', 'music'];
  // Captured scenes — array of {name, scene_data} where scene_data is the
  // raw hex string DPS 25 emits. Stored in dashboard_settings under
  // 'balcony.star_projector.scenes'. Built via capture-replay (the Tuya
  // cloud does not list factory scene presets — only the JSON schema).
  const SP_SCENES_KEY = 'balcony.star_projector.scenes';
  let SP_SCENES = [];

  // ── helpers ────────────────────────────────────────────────────────────
  async function spFetchDevice() {
    const r = await fetch('/api/devices');
    if (!r.ok) throw new Error('GET /api/devices ' + r.status);
    const list = await r.json();
    const dev = list.find(d => d.name === SP_DEVICE_NAME);
    if (!dev) throw new Error(`Device "${SP_DEVICE_NAME}" not in /api/devices`);
    SP_DEVICE_ID = dev.id;
    SP_STATE     = dev.last_state || {};
    SP_LAST_SEEN = dev.last_seen || null;
    SP_IP        = dev.local_ip || null;
    return dev;
  }

  async function spSendDps(dpsObj) {
    if (!SP_DEVICE_ID) await spFetchDevice();
    const r = await fetch(`/api/devices/${SP_DEVICE_ID}/dps`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ dps: dpsObj }),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`POST /dps failed (${r.status}): ${txt}`);
    }
    // Optimistic repaint — actual state lands within ~2 s via poll.
    Object.assign(SP_STATE, dpsObj);
    spRender();
    return r.json();
  }

  // ── colour conversion (browser RGB hex ↔ Tuya HSV 12-hex) ──────────────
  // Tuya HSV string: 4 hex chars H (0–360) + 4 hex chars S (0–1000) + 4 hex chars V (0–1000)
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, v = max;
    const d = max - min;
    s = max === 0 ? 0 : d / max;
    if (max === min) h = 0;
    else {
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return { h: Math.round(h * 360), s: Math.round(s * 1000), v: Math.round(v * 1000) };
  }
  function hsvToRgb(h, s, v) {
    h /= 360; s /= 1000; v /= 1000;
    let r, g, b;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }
  function hex4(n) { return n.toString(16).padStart(4, '0'); }
  function tuyaHsvFromHex(hex) {
    // hex = "#rrggbb"
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const { h, s, v } = rgbToHsv(r, g, b);
    return hex4(h) + hex4(s) + hex4(v);
  }
  function hexFromTuyaHsv(s) {
    if (!s || s.length < 12) return null;
    const h = parseInt(s.slice(0, 4),  16);
    const sat = parseInt(s.slice(4, 8),  16);
    const v = parseInt(s.slice(8, 12), 16);
    const { r, g, b } = hsvToRgb(h, sat, v);
    return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
  }

  // ── render ─────────────────────────────────────────────────────────────
  const SP_POWER_KEY = 'balcony.sp.power';
  function spRenderPower(power) {
    const chip = document.getElementById('sp-power-chip');
    if (chip) {
      if (power === true) {
        chip.textContent = 'power: ON';
        chip.style.background = '#3a7d44'; chip.style.color = '#fff'; chip.style.borderColor = '#3a7d44';
      } else if (power === false) {
        chip.textContent = 'power: OFF';
        chip.style.background = '#c0392b'; chip.style.color = '#fff'; chip.style.borderColor = '#c0392b';
      } else {
        chip.textContent = 'power: —';
        chip.style.background = '#eee'; chip.style.color = '#888'; chip.style.borderColor = '#d0cbc4';
      }
    }
    const bOn  = document.getElementById('sp-btn-on');
    const bOff = document.getElementById('sp-btn-off');
    if (bOn)  { bOn.style.background  = power === true  ? '#3a7d44' : ''; bOn.style.color  = power === true  ? '#fff' : '#3a7d44'; }
    if (bOff) { bOff.style.background = power === false ? '#c0392b' : ''; bOff.style.color = power === false ? '#fff' : '#c0392b'; }
    try {
      if (power === true || power === false) localStorage.setItem(SP_POWER_KEY, power ? '1' : '0');
    } catch (_) {}
  }
  function spRestoreCachedPower() {
    try {
      const v = localStorage.getItem(SP_POWER_KEY);
      if (v === '1') spRenderPower(true);
      else if (v === '0') spRenderPower(false);
    } catch (_) {}
  }

  function fmtAge(iso) {
    if (!iso) return '—';
    const ageSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (ageSec < 60)   return ageSec + 's ago';
    if (ageSec < 3600) return Math.floor(ageSec / 60) + ' min ago';
    if (ageSec < 86400) return Math.floor(ageSec / 3600) + ' h ago';
    return Math.floor(ageSec / 86400) + ' d ago';
  }
  function spRender() {
    const dot     = document.getElementById('sp-online-dot');
    const txt     = document.getElementById('sp-online-text');
    const ipEl    = document.getElementById('sp-ip');
    const seenEl  = document.getElementById('sp-last-seen');
    if (ipEl)   ipEl.textContent   = SP_IP || '—';
    if (seenEl) seenEl.textContent = fmtAge(SP_LAST_SEEN);
    const fresh = SP_LAST_SEEN && (Date.now() - new Date(SP_LAST_SEEN).getTime()) < 10 * 60 * 1000;
    if (dot) dot.style.color = fresh ? '#3a7d44' : '#c0392b';
    if (txt) { txt.textContent = fresh ? 'online' : 'offline'; txt.style.color = fresh ? '#3a7d44' : '#c0392b'; }

    spRenderPower(SP_STATE['20']);

    // Mode buttons — highlight active
    const mode = String(SP_STATE['21'] || '').toLowerCase();
    document.querySelectorAll('#sp-mode-row .sp-mode').forEach(b => {
      if (b.dataset.mode === mode) { b.style.background = '#3a7d44'; b.style.color = '#fff'; b.style.borderColor = '#3a7d44'; }
      else { b.style.background = ''; b.style.color = ''; b.style.borderColor = ''; }
    });

    // Brightness — repaint slider only if user isn't actively dragging
    if (Date.now() - SP_BRIGHT_TOUCH_TS > 3000) {
      const v = parseInt(SP_STATE['22'], 10);
      if (Number.isFinite(v)) {
        const s = document.getElementById('sp-bright');
        const o = document.getElementById('sp-bright-val');
        if (s) s.value = v;
        if (o) o.textContent = v;
      }
    }

    // Colour preview
    const rawColour = SP_STATE['24'];
    const hex = rawColour ? hexFromTuyaHsv(rawColour) : null;
    const pv = document.getElementById('sp-colour-preview');
    const hx = document.getElementById('sp-colour-hex');
    if (pv && hex) pv.style.background = hex;
    if (hx) hx.textContent = rawColour || '—';
    const picker = document.getElementById('sp-colour-picker');
    if (picker && hex && document.activeElement !== picker) picker.value = hex;

    // Re-render scenes list so the "PLAYING" highlight tracks live state
    // (power off, mode change, scene switch from Tuya app, etc.)
    spRenderScenes();
  }

  // Decode Tuya scene_data_v2 binary hex to a tiny tag: just "#N" (scene_num).
  // Full hex still available on hover via the title attribute.
  function spSceneSummary(hex) {
    if (!hex || typeof hex !== 'string') return '—';
    const sceneNum = parseInt(hex.slice(0, 2), 16);
    return Number.isFinite(sceneNum) ? `#${sceneNum}` : '?';
  }

  function spRenderScenes() {
    const row = document.getElementById('sp-scene-row');
    if (!row) return;
    if (!SP_SCENES.length) {
      row.innerHTML = '<div style="font-size:0.85rem;color:#999;font-style:italic;padding:6px 0;">No scenes captured yet. Switch to a scene in the Tuya app, type a name above, click Capture.</div>';
      return;
    }
    // Highlight the row whose scene_data matches the device's current DPS 25
    // value AND the device is in scene mode. If mode is white/colour/music,
    // nothing is "playing" — no highlight.
    const liveData = SP_STATE['25'];
    const liveMode = String(SP_STATE['21'] || '').toLowerCase();
    const power    = SP_STATE['20'];
    const playingIdx = (power === true && liveMode === 'scene' && typeof liveData === 'string')
      ? SP_SCENES.findIndex(s => s.scene_data === liveData)
      : -1;
    row.innerHTML = SP_SCENES.map((s, i) => {
      const safeName = s.name.replace(/"/g, '&quot;');
      const playing = i === playingIdx;
      const bg     = playing ? '#3a7d44' : '#f8f5f1';
      const fg     = playing ? '#fff'    : '#3a7d44';
      const border = playing ? '#3a7d44' : '#3a7d44';
      const badge  = playing
        ? '<span style="font-size:0.7rem;font-weight:600;padding:2px 6px;border-radius:8px;background:#fff;color:#3a7d44;">● PLAYING</span>'
        : '';
      return `<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:${playing ? '#eafbef' : '#f8f5f1'};border-radius:4px;${playing ? 'outline:2px solid #3a7d44;' : ''}">
        <button class="btn-test" style="background:${bg};color:${fg};border-color:${border};flex:1;text-align:left;" onclick="spApplyScene(${i})" title="Apply scene">▶ ${safeName}</button>
        ${badge}
        <span style="font-size:0.72rem;color:#aaa;" title="DPS 25 raw: ${s.scene_data}">${spSceneSummary(s.scene_data)}</span>
        <button class="btn-test" style="border-color:#c0392b;color:#c0392b;padding:2px 8px;" onclick="spDeleteScene(${i})" title="Delete scene">×</button>
      </div>`;
    }).join('');
  }

  async function spLoadScenes() {
    try {
      const r = await fetch(`/api/dashboard-settings/${SP_SCENES_KEY}`).then(r => r.json());
      const v = r && r.value;
      SP_SCENES = Array.isArray(v) ? v.filter(x => x && x.name && x.scene_data) : [];
    } catch (_) { SP_SCENES = []; }
    spRenderScenes();
  }
  async function spSaveScenes() {
    await fetch(`/api/dashboard-settings/${SP_SCENES_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: SP_SCENES }),
    });
  }

  // ── public click handlers (window-scoped for inline onclick) ───────────
  window.spPower = async (on) => {
    try { await spSendDps({ '20': !!on }); }
    catch (e) { alert('Power failed: ' + e.message); }
  };
  window.spSetMode = async (mode) => {
    if (!SP_MODES.includes(mode)) return;
    try { await spSendDps({ '21': mode }); }
    catch (e) { alert('Mode failed: ' + e.message); }
  };
  window.spOnBrightInput = (val) => {
    SP_BRIGHT_TOUCH_TS = Date.now();
    const o = document.getElementById('sp-bright-val');
    if (o) o.textContent = val;
  };
  window.spSetBrightness = async (val) => {
    SP_BRIGHT_TOUCH_TS = Date.now();
    const v = Math.max(10, Math.min(1000, parseInt(val, 10) || 500));
    try { await spSendDps({ '22': v }); }
    catch (e) { alert('Brightness failed: ' + e.message); }
  };
  window.spSetColourFromPicker = async (hex) => {
    const tuyaHsv = tuyaHsvFromHex(hex);
    try { await spSendDps({ '21': 'colour', '24': tuyaHsv }); }
    catch (e) { alert('Colour failed: ' + e.message); }
  };
  window.spApplyScene = async (i) => {
    const s = SP_SCENES[i];
    if (!s) return;
    try { await spSendDps({ '21': 'scene', '25': s.scene_data }); }
    catch (e) { alert('Apply scene failed: ' + e.message); }
  };
  window.spCaptureScene = async () => {
    const nameEl = document.getElementById('sp-scene-name');
    const name = (nameEl && nameEl.value || '').trim();
    if (!name) return alert('Type a scene name first.');
    // Pull fresh state in case the user just switched scene in the Tuya app.
    try { await spFetchDevice(); spRender(); } catch (_) {}
    const sd = SP_STATE['25'];
    if (!sd || typeof sd !== 'string' || sd.length < 4) {
      return alert('No scene_data on device yet — switch to a scene in the Tuya app first, wait ~3 s, then capture.');
    }
    if (SP_SCENES.some(x => x.name === name)) {
      if (!confirm(`Overwrite existing "${name}"?`)) return;
      SP_SCENES = SP_SCENES.filter(x => x.name !== name);
    }
    SP_SCENES.push({ name, scene_data: sd });
    try {
      await spSaveScenes();
      if (nameEl) nameEl.value = '';
      spRenderScenes();
    } catch (e) { alert('Save failed: ' + e.message); }
  };
  window.spDeleteScene = async (i) => {
    const s = SP_SCENES[i];
    if (!s) return;
    if (!confirm(`Delete scene "${s.name}"?`)) return;
    SP_SCENES.splice(i, 1);
    try {
      await spSaveScenes();
      spRenderScenes();
    } catch (e) { alert('Delete failed: ' + e.message); }
  };
  // ── init + poll ────────────────────────────────────────────────────────
  async function spInit() {
    if (SP_INITED) return;
    SP_INITED = true;
    spRestoreCachedPower();
    spRenderScenes();
    spLoadScenes();
    try {
      await spFetchDevice();
      spRender();
    } catch (e) {
      console.error('[star-projector] init failed:', e);
      const txt = document.getElementById('sp-online-text');
      if (txt) { txt.textContent = 'init failed: ' + e.message; txt.style.color = '#c0392b'; }
    }
    SP_POLL_TIMER = setInterval(async () => {
      try { await spFetchDevice(); spRender(); }
      catch (_) { /* swallow transient failures */ }
    }, 5000);
  }

  // Hook into showTab: lazy-init when user first opens the tab.
  const _prevShowTab = window.showTab;
  window.showTab = function (name, btn) {
    if (typeof _prevShowTab === 'function') _prevShowTab(name, btn);
    if (name === 'star-projector') spInit();
  };
})();

// ─── Somfy tab (self-contained; balcony_bridge CC1101 RTS blaster) ───────────
// Frontend-only: commands via POST /api/esp/boards/balcony_bridge/command
// (schema-validated somfy_up/down/my/prog:<idx>); names/invert in
// dashboard_settings.balcony.somfy_motors; live cc1101_ok + counters from
// GET /api/esp/boards (response is {boards:[...]}). Verified live 2026-07-22.
(function () {
  const BOARD = 'balcony_bridge';
  const DEFAULTS = [
    { idx: 0, name: 'Left Roof',     invert: false, enabled: true, run_sec: 20, position_pct: 0, astop_dir: 'open',  astop_sec: 15 },
    { idx: 1, name: 'Right Roof',    invert: false, enabled: true, run_sec: 20, position_pct: 0, astop_dir: 'open',  astop_sec: 15 },
    { idx: 2, name: 'Left Curtain',  invert: false, enabled: true, run_sec: 20, position_pct: 0, astop_dir: 'close', astop_sec: 15 },
    { idx: 3, name: 'Right Curtain', invert: false, enabled: true, run_sec: 20, position_pct: 0, astop_dir: 'close', astop_sec: 15 },
  ];
  let sfMotors = null, sfInited = false, sfTimer = null, sfPairIdx = null;
  const sfAnim = {};   // idx -> active timed-estimate animation {timer,...}
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  async function sfSaveConfig(v) {
    try {
      await fetch('/api/dashboard-settings/balcony.somfy_motors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: v || sfMotors }),
      });
    } catch (e) { /* non-fatal */ }
  }

  async function sfLoadConfig() {
    try {
      const r = await fetch('/api/dashboard-settings/balcony.somfy_motors').then(x => x.json());
      let v = r && r.value;
      if (!Array.isArray(v) || v.length !== 4) { v = DEFAULTS.slice(); sfMotors = v; await sfSaveConfig(v); return; }
      sfMotors = v.map((m, i) => ({
        idx: i,
        name: (m && m.name) || DEFAULTS[i].name,
        invert: !!(m && m.invert),
        enabled: !(m && m.enabled === false),
        run_sec: (m && +m.run_sec > 0) ? +m.run_sec : 20,
        position_pct: (m && typeof m.position_pct === 'number') ? Math.max(0, Math.min(100, m.position_pct)) : 0,
        astop_dir: (m && ['off', 'open', 'close'].includes(m.astop_dir)) ? m.astop_dir : DEFAULTS[i].astop_dir,
        astop_sec: (m && +m.astop_sec > 0) ? +m.astop_sec : 15,
      }));
    } catch (e) { sfMotors = DEFAULTS.slice(); }
  }

  function sfRender() {
    const wrap = document.getElementById('sf-cards');
    if (!wrap || !sfMotors) return;
    wrap.innerHTML = sfMotors.map(m => {
      const dis = m.enabled ? '' : 'disabled';
      return `
      <div class="sf-row" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 0;border-bottom:1px dashed #e8e2da;${m.enabled ? '' : 'opacity:0.55;'}">
        <div class="curtain-vis" id="sf-vis-${m.idx}" title="${esc(m.name)} — estimated position">
          <div class="curtain-pane curtain-left"  id="sf-paneL-${m.idx}" style="transform:translateX(0%);"></div>
          <div class="curtain-pane curtain-right" id="sf-paneR-${m.idx}" style="transform:translateX(0%);"></div>
        </div>
        <div style="min-width:104px;font-weight:600;font-size:0.9rem;">${esc(m.name)}</div>
        <button class="btn-test" style="border-color:#3a7d44;color:#3a7d44;" onclick="sfCmd(${m.idx},'open')" ${dis}>▲ Open</button>
        <button class="btn-test" onclick="sfCmd(${m.idx},'stop')" ${dis}>■ Stop</button>
        <button class="btn-test" style="border-color:#c0392b;color:#c0392b;" onclick="sfCmd(${m.idx},'close')" ${dis}>▼ Close</button>
        <label style="font-size:0.74rem;color:#777;">run <input type="number" min="1" max="300" value="${m.run_sec}" onchange="sfSetRun(${m.idx}, this.value)" style="width:46px;padding:2px 4px;"> s</label>
        <label style="font-size:0.74rem;color:#777;">set <input type="number" min="0" max="100" placeholder="%" onchange="sfSetPct(${m.idx}, this.value)" style="width:46px;padding:2px 4px;"> %</label>
        <label style="font-size:0.74rem;color:#777;">auto-stop
          <select onchange="sfSetAstopDir(${m.idx}, this.value)" style="font-size:0.72rem;padding:1px;">
            <option value="off"${m.astop_dir === 'off' ? ' selected' : ''}>off</option>
            <option value="open"${m.astop_dir === 'open' ? ' selected' : ''}>open</option>
            <option value="close"${m.astop_dir === 'close' ? ' selected' : ''}>close</option>
          </select>
          <input type="number" min="1" max="600" value="${m.astop_sec}" onchange="sfSetAstopSec(${m.idx}, this.value)" style="width:42px;padding:2px 4px;"> s</label>
        <button class="btn-test" onclick="sfOpenPair(${m.idx})" ${dis}>🔗 Pair</button>
        <label style="font-size:0.74rem;color:#777;cursor:pointer;"><input type="checkbox" ${m.enabled ? 'checked' : ''} onchange="sfToggleEnabled(${m.idx}, this.checked)"> enabled</label>
        <label style="font-size:0.74rem;color:#777;cursor:pointer;"><input type="checkbox" ${m.invert ? 'checked' : ''} onchange="sfToggleInvert(${m.idx}, this.checked)"> invert</label>
        <span style="margin-left:auto;font-size:0.72rem;color:#999;white-space:nowrap;"><span id="sf-lbl-${m.idx}">—</span> · cnt <b id="sf-cnt-${m.idx}">—</b></span>
      </div>`;
    }).join('');
    sfPaintAll();
  }

  async function sfPublish(actionStr) {
    try {
      const r = await fetch(`/api/esp/boards/${BOARD}/command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: actionStr }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) console.warn('[somfy] command failed', actionStr, j);
      return r.ok && !j.error;
    } catch (e) { console.warn('[somfy] command error', e); return false; }
  }

  // ── Timed position ESTIMATE (Somfy RTS gives no feedback — this is a guess) ──
  function sfShift(pct) { return Math.max(0, Math.min(92, (pct / 100) * 92)); }  // pane translateX %
  function sfPaint(idx, pct, moving) {
    const L = document.getElementById('sf-paneL-' + idx);
    const R = document.getElementById('sf-paneR-' + idx);
    const s = sfShift(pct);
    if (L) L.style.transform = `translateX(-${s}%)`;
    if (R) R.style.transform = `translateX(${s}%)`;
    const lbl = document.getElementById('sf-lbl-' + idx);
    if (lbl) {
      lbl.textContent = `${Math.round(pct)}%${moving ? ' · moving' : ''}`;
      lbl.style.color = moving ? '#c0392b' : '#999';
      lbl.style.fontWeight = moving ? '700' : '400';
    }
  }
  function sfPaintAll() { if (sfMotors) sfMotors.forEach(m => sfPaint(m.idx, m.position_pct || 0, !!sfAnim[m.idx])); }

  function sfStopAnim(idx) { const a = sfAnim[idx]; if (a && a.timer) clearInterval(a.timer); delete sfAnim[idx]; }

  function sfAnimateOver(idx, targetPct, durMs) {
    sfStopAnim(idx);
    const m = sfMotors[idx];
    const startPct = Math.max(0, Math.min(100, m.position_pct || 0));
    targetPct = Math.max(0, Math.min(100, targetPct));
    if (durMs < 60 || Math.abs(targetPct - startPct) < 0.5) { m.position_pct = targetPct; sfPaint(idx, targetPct, false); sfSaveConfig(); return; }
    const startTs = Date.now();
    const a = { timer: null };
    a.timer = setInterval(() => {
      const frac = Math.min(1, (Date.now() - startTs) / durMs);
      const pct = startPct + (targetPct - startPct) * frac;
      m.position_pct = pct;
      sfPaint(idx, pct, frac < 1);
      if (frac >= 1) { sfStopAnim(idx); m.position_pct = targetPct; sfPaint(idx, targetPct, false); sfSaveConfig(); }
    }, 100);
    sfAnim[idx] = a;
  }
  function sfAnimateTo(idx, targetPct) {   // full travel: duration derived from run_sec
    const m = sfMotors[idx];
    const startPct = Math.max(0, Math.min(100, m.position_pct || 0));
    const run = Math.max(1, m.run_sec || 20);
    sfAnimateOver(idx, targetPct, Math.abs(targetPct - startPct) / 100 * run * 1000);
  }

  async function sfMove(idx, dir) {   // dir 'open' (→100) | 'close' (→0)
    const m = sfMotors[idx]; if (!m || !m.enabled) return;
    const a = dir === 'open' ? (m.invert ? 'somfy_down' : 'somfy_up')
                             : (m.invert ? 'somfy_up'   : 'somfy_down');
    await sfPublish(`${a}:${idx}`);
    // Auto-stop on this direction → mirror the board: animate to a PARTIAL position
    // over astop_sec then freeze. Otherwise full travel over the run-based time.
    if (m.astop_dir === dir && m.astop_sec > 0) {
      const cur = Math.max(0, Math.min(100, m.position_pct || 0));
      const delta = Math.min(100, (m.astop_sec / Math.max(1, m.run_sec || 20)) * 100);
      const target = dir === 'open' ? Math.min(100, cur + delta) : Math.max(0, cur - delta);
      sfAnimateOver(idx, target, m.astop_sec * 1000);
    } else {
      sfAnimateTo(idx, dir === 'open' ? 100 : 0);
    }
  }
  async function sfStop(idx) {
    const m = sfMotors[idx]; if (!m || !m.enabled) return;
    sfStopAnim(idx);                        // freeze the estimate where it is
    sfPaint(idx, m.position_pct || 0, false);
    await sfPublish(`somfy_my:${idx}`);
    await sfSaveConfig();
  }
  function sfCmd(idx, action) {
    if (action === 'open') sfMove(idx, 'open');
    else if (action === 'close') sfMove(idx, 'close');
    else sfStop(idx);
  }
  window.sfCmd = sfCmd;

  async function sfSetRun(idx, val) {
    const m = sfMotors[idx]; if (!m) return;
    let r = parseInt(val, 10); if (isNaN(r) || r < 1) r = 1; if (r > 300) r = 300;
    m.run_sec = r; await sfSaveConfig();
  }
  window.sfSetRun = sfSetRun;

  async function sfSetPct(idx, val) {   // manual anchor to correct drift
    const m = sfMotors[idx]; if (!m) return;
    let p = parseInt(val, 10); if (isNaN(p)) return;
    p = Math.max(0, Math.min(100, p));
    sfStopAnim(idx);
    m.position_pct = p;
    sfPaint(idx, p, false);
    await sfSaveConfig();
  }
  window.sfSetPct = sfSetPct;

  async function sfToggleEnabled(idx, checked) {
    const m = sfMotors[idx]; if (!m) return;
    m.enabled = !!checked;
    if (!m.enabled) sfStopAnim(idx);
    await sfSaveConfig();
    sfRender();   // re-render to grey/enable the row's controls (sfPaintAll runs inside)
  }
  window.sfToggleEnabled = sfToggleEnabled;

  // ── Balcony fan (RF via balcony_bridge) — fan_tx:<value> (needs v18 firmware) ──
  async function fanCmd(value) { await sfPublish(`fan_tx:${value}`); }
  window.fanCmd = fanCmd;

  // ── auto-stop: dashboard holds open/close + sec; the board holds up/down + sec ──
  function sfAstopCsv() {   // map each motor's open/close→up(1)/down(2) via invert
    return sfMotors.map(m => {
      let dir = 0;
      if (m.astop_dir === 'open')  dir = m.invert ? 2 : 1;
      else if (m.astop_dir === 'close') dir = m.invert ? 1 : 2;
      const sec = (dir && m.astop_sec > 0) ? m.astop_sec : 0;
      return dir ? `${dir}:${sec}` : '0:0';
    }).join(',');
  }
  async function sfPushAstop() {   // push the CSV to the board (needs v17 schema)
    try {
      await fetch(`/api/esp/boards/${BOARD}/parameters`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ somfy_astop: sfAstopCsv() }),
      });
    } catch (e) { console.warn('[somfy] astop push failed', e); }
  }
  async function sfSetAstopDir(idx, val) {
    const m = sfMotors[idx]; if (!m) return;
    m.astop_dir = ['off', 'open', 'close'].includes(val) ? val : 'off';
    await sfSaveConfig(); await sfPushAstop();
  }
  window.sfSetAstopDir = sfSetAstopDir;
  async function sfSetAstopSec(idx, val) {
    const m = sfMotors[idx]; if (!m) return;
    let s = parseInt(val, 10); if (isNaN(s) || s < 1) s = 1; if (s > 600) s = 600;
    m.astop_sec = s;
    await sfSaveConfig(); await sfPushAstop();
  }
  window.sfSetAstopSec = sfSetAstopSec;

  function sfOpenPair(idx) {
    const m = sfMotors[idx]; if (!m || !m.enabled) return;
    sfPairIdx = idx;
    document.getElementById('sf-pair-name').textContent = (sfMotors[idx] || {}).name || ('Motor ' + idx);
    const st = document.getElementById('sf-pair-status'); st.textContent = ''; st.style.color = '#3a7d44';
    document.getElementById('sf-pair-modal').style.display = 'flex';
  }
  window.sfOpenPair = sfOpenPair;

  function sfClosePair() { document.getElementById('sf-pair-modal').style.display = 'none'; sfPairIdx = null; }
  window.sfClosePair = sfClosePair;

  async function sfSendProg() {
    if (sfPairIdx == null) return;
    const st = document.getElementById('sf-pair-status');
    st.textContent = 'Sending PROG…'; st.style.color = '#666';
    const ok = await sfPublish(`somfy_prog:${sfPairIdx}`);
    st.textContent = ok ? 'PROG sent — the motor should jog. If it did, it is paired; test Open/Close.'
                        : 'Failed to send (board offline?).';
    st.style.color = ok ? '#3a7d44' : '#c0392b';
  }
  window.sfSendProg = sfSendProg;

  async function sfToggleInvert(idx, checked) {
    if (sfMotors[idx]) sfMotors[idx].invert = !!checked;
    await sfSaveConfig();
    await sfPushAstop();   // invert flips the open/close → up/down mapping
  }
  window.sfToggleInvert = sfToggleInvert;

  async function sfPoll() {
    try {
      const d = await fetch('/api/esp/boards').then(r => r.json());
      const b = (d.boards || []).find(x => x.id === BOARD);
      const dot = document.getElementById('sf-online-dot');
      const txt = document.getElementById('sf-online-text');
      const chip = document.getElementById('sf-cc-chip');
      const cards = document.getElementById('sf-cards');
      if (!b) { if (txt) txt.textContent = 'board not found'; if (dot) dot.style.color = '#c0392b'; return; }
      const ls = b.last_status || {};
      const ageSec = b.last_seen ? (Date.now() - new Date(b.last_seen).getTime()) / 1000 : 9e9;
      const online = ageSec < 180;
      if (dot) dot.style.color = online ? '#27ae60' : '#c0392b';
      if (txt) txt.textContent = online ? 'online' : 'offline';
      if (chip) {
        const ok = ls.cc1101_ok === true;
        chip.textContent = 'CC1101: ' + (ok ? '✓ detected' : (ls.cc1101_ok === false ? '✗ not detected' : '—'));
        chip.style.background   = ok ? '#e7f6ec' : '#f6e7e7';
        chip.style.color        = ok ? '#1e7d34' : '#c0392b';
        chip.style.borderColor  = ok ? '#b7e0c2' : '#e0b7b7';
      }
      const counters = ls.somfy_counters || [];
      for (let i = 0; i < 4; i++) {
        const el = document.getElementById('sf-cnt-' + i);
        if (el) el.textContent = (counters[i] != null ? counters[i] : '—');
      }
      // fan state (estimate synced from remote + dashboard)
      const fp = document.getElementById('fan-power-chip');
      const fl = document.getElementById('fan-light-chip');
      const fsl = document.getElementById('fan-speed-lbl');
      if (fp) {
        const on = ls.fan_power === true;
        fp.textContent = 'fan: ' + (ls.fan_power === undefined ? '—' : (on ? 'ON' : 'OFF'));
        fp.style.background = on ? '#e7f6ec' : '#eee'; fp.style.color = on ? '#1e7d34' : '#888';
        fp.style.borderColor = on ? '#b7e0c2' : '#d0cbc4';
      }
      if (fl) {
        const lon = ls.fan_light === true;
        fl.textContent = 'light: ' + (ls.fan_light === undefined ? '—' : (lon ? 'ON' : 'OFF'));
        fl.style.background = lon ? '#fdf6d8' : '#eee'; fl.style.color = lon ? '#8a6d00' : '#888';
        fl.style.borderColor = lon ? '#e8dca0' : '#d0cbc4';
      }
      if (fsl) fsl.innerHTML = 'speed: <b>' + (ls.fan_speed != null ? ls.fan_speed : '—') + '</b>';
      if (cards) { cards.style.opacity = online ? '1' : '0.45'; cards.style.pointerEvents = online ? '' : 'none'; }
    } catch (e) { /* keep last-known */ }
  }

  async function sfInit() {
    if (sfInited) { sfPoll(); return; }
    sfInited = true;
    await sfLoadConfig();
    sfRender();
    sfPoll();
    sfPushAstop();   // sync the board with the saved config on open
    if (!sfTimer) sfTimer = setInterval(sfPoll, 5000);
  }

  const _prevShowTabSomfy = window.showTab;
  window.showTab = function (name, btn) {
    if (typeof _prevShowTabSomfy === 'function') _prevShowTabSomfy(name, btn);
    if (name === 'somfy') sfInit();
  };
})();

// ─── Roborock tab (self-contained; HA-mediated vacuum via /api/vacuum) ───────
// Frontend-only: status from GET /api/devices/states, control via
// POST /api/vacuum/:entity/:verb. Mirrors the Star Projector tab pattern.
(function () {
  'use strict';

  const RV_ID = 'vacuum.roborock_s6_f881_robot_cleaner';
  let RV_STATE = {};        // last_state {state, battery}
  let RV_LAST_SEEN = null;
  let RV_TIMER = null;
  let RV_INITED = false;

  // HA vacuum state → chip style
  const RV_STATE_STYLE = {
    cleaning:  { label: 'cleaning',  bg: '#3a7d44', fg: '#fff' },
    returning: { label: 'returning', bg: '#2b4c7e', fg: '#fff' },
    paused:    { label: 'paused',    bg: '#e6a23c', fg: '#fff' },
    docked:    { label: 'docked',    bg: '#6b7a8f', fg: '#fff' },
    idle:      { label: 'idle',      bg: '#6b7a8f', fg: '#fff' },
    error:     { label: 'error',     bg: '#c0392b', fg: '#fff' },
  };

  async function rvFetch() {
    const r = await fetch('/api/devices/states?ids=' + encodeURIComponent(RV_ID));
    if (!r.ok) throw new Error('GET /api/devices/states ' + r.status);
    const list = await r.json();
    const dev = Array.isArray(list) ? list.find(d => d.id === RV_ID) : null;
    RV_STATE     = (dev && dev.last_state) || {};
    RV_LAST_SEEN = (dev && dev.last_seen) || null;
    return dev;
  }

  // Send a vacuum verb (start/stop/pause/dock/locate) via the existing endpoint.
  window.rvCmd = async function (verb) {
    const st = document.getElementById('rv-cmd-status');
    if (st) { st.textContent = '· ' + verb + '…'; st.style.color = '#888'; }
    try {
      const r = await fetch('/api/vacuum/' + encodeURIComponent(RV_ID) + '/' + encodeURIComponent(verb), { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      if (st) { st.textContent = '✓ ' + verb + ' sent'; st.style.color = '#3a7d44'; }
      setTimeout(() => { rvFetch().then(rvRender).catch(() => {}); }, 1200);  // let HA settle, then refresh
    } catch (e) {
      if (st) { st.textContent = '✗ ' + verb + ' failed: ' + e.message; st.style.color = '#c0392b'; }
    }
  };

  // Set suction/fan speed via the dedicated endpoint (routes-vacuum.js).
  window.rvSetFan = async function (speed) {
    const st = document.getElementById('rv-cmd-status');
    if (st) { st.textContent = '· suction → ' + speed + '…'; st.style.color = '#888'; }
    try {
      const r = await fetch('/api/vacuum/' + encodeURIComponent(RV_ID) + '/fan-speed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speed: speed }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      RV_STATE.fan_speed = speed;  // optimistic
      if (st) { st.textContent = '✓ suction: ' + speed; st.style.color = '#3a7d44'; }
      setTimeout(() => { rvFetch().then(rvRender).catch(() => {}); }, 1200);
    } catch (e) {
      if (st) { st.textContent = '✗ suction failed: ' + e.message; st.style.color = '#c0392b'; }
    }
  };

  function rvFmtAge(iso) {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  function rvRender() {
    const dot  = document.getElementById('rv-online-dot');
    const txt  = document.getElementById('rv-online-text');
    const seen = document.getElementById('rv-last-seen');
    const chip = document.getElementById('rv-state-chip');
    const batt = document.getElementById('rv-batt-chip');
    // Vacuums push sparsely (docked sits idle for hours) — 30 min freshness window.
    const fresh = RV_LAST_SEEN && (Date.now() - new Date(RV_LAST_SEEN).getTime()) < 30 * 60 * 1000;
    if (seen) seen.textContent = rvFmtAge(RV_LAST_SEEN);
    if (dot) dot.style.color = fresh ? '#3a7d44' : '#c0392b';
    if (txt) { txt.textContent = fresh ? 'online' : 'offline'; txt.style.color = fresh ? '#3a7d44' : '#c0392b'; }

    const state = String(RV_STATE.state || '').toLowerCase();
    if (chip) {
      const s = RV_STATE_STYLE[state];
      if (s) { chip.textContent = 'state: ' + s.label; chip.style.background = s.bg; chip.style.color = s.fg; chip.style.borderColor = s.bg; }
      else   { chip.textContent = 'state: ' + (state || '—'); chip.style.background = '#eee'; chip.style.color = '#888'; chip.style.borderColor = '#d0cbc4'; }
    }
    if (batt) {
      const b = RV_STATE.battery;
      batt.textContent = '🔋 ' + (b != null ? b + '%' : '—');
    }
    const ca = document.getElementById('rv-clean-area');
    const ct = document.getElementById('rv-clean-time');
    if (ca) ca.textContent = (RV_STATE.clean_area != null ? RV_STATE.clean_area : '—');
    if (ct) ct.textContent = (RV_STATE.clean_time != null ? RV_STATE.clean_time : '—');
    const fan = document.getElementById('rv-fan');
    if (fan && RV_STATE.fan_speed && document.activeElement !== fan) fan.value = RV_STATE.fan_speed;
  }

  async function rvInit() {
    if (RV_INITED) { rvFetch().then(rvRender).catch(() => {}); return; }
    RV_INITED = true;
    try { await rvFetch(); rvRender(); }
    catch (e) {
      console.error('[roborock] init failed:', e);
      const txt = document.getElementById('rv-online-text');
      if (txt) { txt.textContent = 'init failed: ' + e.message; txt.style.color = '#c0392b'; }
    }
    if (!RV_TIMER) RV_TIMER = setInterval(() => { rvFetch().then(rvRender).catch(() => {}); }, 5000);
  }

  const _prevShowTabRv = window.showTab;
  window.showTab = function (name, btn) {
    if (typeof _prevShowTabRv === 'function') _prevShowTabRv(name, btn);
    if (name === 'roborock') rvInit();
  };
})();

