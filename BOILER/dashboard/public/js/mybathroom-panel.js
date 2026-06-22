// My BathRoom — second OpenHASP plate (mybathroom-panel @ 192.168.1.206)
// Self-contained controller, namespaced np*/nb* so it coexists with
// my-bathroom.js (the .220 plate) on the same page. Reuses the generic
// /api/hasp/<panel>/* endpoints + the dashboard_browser MQTT WebSocket.
// Derived from my-bathroom.js's panel logic via scripted rename.
(function () {
  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // ─── HASP My BathRoom status card ──────────────────────────────────────────
  // Browser subscribes to mosquitto over WebSocket (port 9001) as `dashboard_browser`.
  // Required ACL on LXC 107: read hasp/mybathroom-panel/state/# + read hasp/mybathroom-panel/LWT
  const NP_BROKER_HOST = '192.168.1.189';
  const NP_BROKER_PORT = 9001;
  const NP_USER        = 'dashboard_browser';
  const NP_PLATE       = 'mybathroom-panel';

  let _npInited = false;
  let _npMqtt   = null;

  function npSetOnline(connected, label) {
    const dot  = document.getElementById('np-online-dot');
    const text = document.getElementById('np-online-text');
    if (dot)  dot.style.color = connected ? '#3a7d44' : '#c0392b';
    if (text) text.textContent = label || (connected ? 'connected' : 'offline');
  }

  function npFmtUptime(sec) {
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
  // Persists across page navigations via localStorage so the chip shows
  // last-known state immediately on reload instead of waiting for MQTT.
  const NP_POWER_KEY = 'mybathroom-panel.hp.power';
  function npRenderPower(on) {
    const chip = document.getElementById('np-power-chip');
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
    const bOn  = document.getElementById('np-btn-on');
    const bOff = document.getElementById('np-btn-off');
    if (bOn)  { bOn.style.background  = on === true  ? '#3a7d44' : ''; bOn.style.color  = on === true  ? '#fff' : '#3a7d44'; }
    if (bOff) { bOff.style.background = on === false ? '#c0392b' : ''; bOff.style.color = on === false ? '#fff' : '#c0392b'; }
    try {
      if (on === true || on === false) localStorage.setItem(NP_POWER_KEY, on ? '1' : '0');
    } catch (_) {}
  }
  function npRestoreCachedPower() {
    try {
      const v = localStorage.getItem(NP_POWER_KEY);
      if (v === '1') npRenderPower(true);
      else if (v === '0') npRenderPower(false);
    } catch (_) {}
  }

  function npUpdateStatus(s) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('np-uptime', npFmtUptime(s.uptime));
    set('np-rssi',   s.rssi ?? '—');
    const page = s.page ?? null;
    const num  = s.numPages ?? null;
    set('np-page', page != null ? (num != null ? `${page} / ${num}` : `${page}`) : '—');
    // Note: OpenHASP firmware 0.7.0-rc12 statusupdate does NOT include the
    // backlight state — see the dedicated state/backlight subscription in
    // npInit() for power tracking.
    // Populate page selector once (numPages reported by the panel)
    const sel = document.getElementById('np-page-select');
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
  // open MQTT WebSocket (npInit). dashboard_browser ACL: write hasp/+/command/#
  window.npPower = function (on) {
    if (!_npMqtt || !_npMqtt.connected) return;
    // 'dim 0' sets brightness to 0% but doesn't turn off the backlight
    // controller — many panels still show a faint glow. 'backlight off'
    // hard-cuts the LED rail. Use both: backlight on/off + a sensible dim.
    _npMqtt.publish(`hasp/${NP_PLATE}/command/backlight`, on ? 'on' : 'off');
    if (on) _npMqtt.publish(`hasp/${NP_PLATE}/command/dim`, '100');
    npRenderPower(!!on);
    setTimeout(() => _npMqtt.publish(`hasp/${NP_PLATE}/command/statusupdate`, ''), 500);
  };
  window.npGotoPage = function (n) {
    if (!_npMqtt || !_npMqtt.connected || n === '') return;
    _npMqtt.publish(`hasp/${NP_PLATE}/command/page`, String(n));
    // Reset the dropdown to its placeholder so the same page can be re-clicked
    const sel = document.getElementById('np-page-select');
    if (sel) sel.value = '';
  };

  async function npInit() {
    if (_npInited) return;
    _npInited = true;
    if (typeof mqtt === 'undefined') { npSetOnline(false, 'mqtt.js missing'); return; }
    let pass;
    try {
      const r = await fetch('/api/dashboard-settings/_mqtt_browser_pass').then(r => r.json());
      pass = r.value;
    } catch (e) { npSetOnline(false, 'broker pass fetch failed'); return; }
    if (!pass) { npSetOnline(false, 'MQTT_BROWSER_PASS not set'); return; }
    _npMqtt = mqtt.connect(`ws://${NP_BROKER_HOST}:${NP_BROKER_PORT}`, {
      username: NP_USER, password: pass,
      clientId: 'hasp-mybathroom-panel-tab-' + Math.random().toString(36).slice(2, 10),
      reconnectPeriod: 5000, connectTimeout: 8000,
    });
    _npMqtt.on('connect', () => {
      npSetOnline(false, 'broker connected, awaiting panel…');
      _npMqtt.subscribe(`hasp/${NP_PLATE}/state/statusupdate`, { qos: 0 });
      // state/backlight publishes whenever the backlight changes — the
      // statusupdate JSON does NOT carry the backlight field on firmware
      // 0.7.0-rc12. Subscribe directly to this topic to track power state.
      _npMqtt.subscribe(`hasp/${NP_PLATE}/state/backlight`, { qos: 0 });
      _npMqtt.subscribe(`hasp/${NP_PLATE}/LWT`, { qos: 0 });
      NP_RELAYS.forEach(r => _npMqtt.subscribe(`hasp/${NP_PLATE}/state/${r.out}`, { qos: 0 }));
      // OpenHASP firmware doesn't auto-push statusupdate periodically — it
      // only responds when asked. Request once now + every 30 s after.
      const askForStatus = () => _npMqtt.publish(`hasp/${NP_PLATE}/command/statusupdate`, '');
      askForStatus();
      if (window._npStatusTimer) clearInterval(window._npStatusTimer);
      window._npStatusTimer = setInterval(askForStatus, 30000);
    });
    _npMqtt.on('reconnect', () => npSetOnline(false, 'reconnecting…'));
    _npMqtt.on('close',     () => npSetOnline(false));
    _npMqtt.on('error',     (e) => { console.error('HASP MQTT error:', e); npSetOnline(false, 'broker error'); });
    _npMqtt.on('message', (topic, payload) => {
      if (topic === `hasp/${NP_PLATE}/LWT`) {
        npSetOnline(payload.toString() === 'online');
      } else if (topic === `hasp/${NP_PLATE}/state/statusupdate`) {
        try { npUpdateStatus(JSON.parse(payload.toString())); } catch (_) {}
      } else if (/\/state\/output1$/.test(topic) || /\/state\/output2$/.test(topic)) {
        try { const o = JSON.parse(payload.toString());
          const out = topic.endsWith('output1') ? 'output1' : 'output2';
          const r = NP_RELAYS.find(x => x.out === out);
          const v = (o && typeof o.state === 'string') ? o.state.toLowerCase() === 'on'
                  : (o && o.val != null) ? Number(o.val) > 0 : null;
          if (r && v !== null) npRenderRelay(r.key, v);
        } catch (_) {}
      } else if (topic === `hasp/${NP_PLATE}/state/backlight`) {
        // Payload shape: {"state":"on"|"off","brightness":<0-255>}
        try {
          const o = JSON.parse(payload.toString());
          if (o && typeof o.state === 'string') {
            npRenderPower(o.state.toLowerCase() === 'on');
          }
        } catch (_) {}
      }
    });
  }

  // ─── Button Bindings — wallmote-style multi-device per slot ────────────────
  const NB_PANEL = 'mybathroom-panel';
  const ACTIONS = [
    { v: 'turn_on',  label: 'Turn On',  tag: 'on'     },
    { v: 'turn_off', label: 'Turn Off', tag: 'off'    },
    { v: 'toggle',   label: 'Toggle',   tag: 'toggle' },
  ];
  const CONTROLLABLE_TYPES = new Set(['switch', 'light', 'circuit_breaker', 'water_heater', 'curtain', 'valve', 'esp_board', 'panel', 'display', 'media_player', 'vacuum']);

  let _buttons = [];
  let _controllable = [];
  let _nbActivePicker = null;  // {row_id, snapshot}
  let _nbAlexaAnnouncements = [];
  let _nbAlexaStations      = [];

  function nbAlexaOptionValue(action, name) { return name ? `${action}:${name}` : action; }
  function nbParseAlexaOptionValue(v) {
    const i = v.indexOf(':');
    return i < 0 ? { action: v } : { action: v.slice(0, i), name: v.slice(i + 1) };
  }

  function nbActionLabel(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.label : v; }
  function nbActionTag(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.tag : 'toggle'; }
  // Render-helper for binding chips: page-select bindings show `P<n>`;
  // Alexa speak/play show the template/station name appended.
  function nbBindingTag(b) {
    if (b && b.page_num != null) return `P${b.page_num}`;
    if (b && b.action === 'speak' && b.template_name) return `say:${b.template_name}`;
    if (b && b.action === 'play'  && b.station_name)  return `play:${b.station_name}`;
    // Vacuum verbs (start/stop/dock/locate) and bare alexa stop both
    // render as the verb itself — context (device name) disambiguates.
    if (b && (b.action === 'stop' || b.action === 'start'
              || b.action === 'dock' || b.action === 'locate')) return b.action;
    return nbActionTag(b ? b.action : 'toggle');
  }
  function nbDefaultActionFor(_event) { return 'toggle'; }

  async function nbLoadControllableDevices() {
    if (_controllable.length) return _controllable;
    try {
      const [devs, anns, stations] = await Promise.all([
        fetch('/api/devices').then(r => r.json()),
        fetch('/api/dashboard-settings/media-agents.alexa_announcements').then(r => r.json()).catch(() => ({ value: [] })),
        fetch('/api/dashboard-settings/media-agents.alexa_quick_music').then(r => r.json()).catch(() => ({ value: [] })),
      ]);
      _nbAlexaAnnouncements = Array.isArray(anns && anns.value) ? anns.value : [];
      _nbAlexaStations      = Array.isArray(stations && stations.value) ? stations.value : [];
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

  function nbRenderPickerDisplay(rowId) {
    const row = _buttons.find(r => r.id === rowId);
    const el = document.querySelector(`[data-nb-picker="${rowId}"]`);
    if (!row || !el) return;
    const sel = row.bindings || [];
    if (!sel.length) {
      el.classList.add('empty');
      el.innerHTML = '— select devices —';
      el.title = '';
    } else {
      el.classList.remove('empty');
      el.innerHTML = sel.map(s =>
        `${escHtml(s.label ? s.name + ':' + s.label : (s.name || '?'))}<span class="action-tag ${nbBindingTag(s)}">${nbBindingTag(s)}</span>`
      ).join(' · ');
      el.title = sel.map(s => `${s.name || '?'}${s.label?':'+s.label:''} → ${nbActionLabel(s.action)}`).join('\n');
    }
  }

  function nbRenderButtonCard(headerRow, allRowsForButton) {
    return `
      <div class="button-row" data-nb-btn="${headerRow.page}-${headerRow.button_id}">
        <div class="button-label">
          ${escHtml(headerRow.label || '')}
          <div style="font-weight:normal;color:#aaa;font-size:0.72rem;">p${headerRow.page}b${headerRow.button_id}</div>
        </div>
        <div class="event-rows">
          ${allRowsForButton.map(r => `
            <div class="event-row">
              <span class="event-type ${r.event}">${r.event}</span>
              <div class="device-picker ${(r.bindings && r.bindings.length) ? '' : 'empty'}"
                   data-nb-picker="${r.id}"
                   onclick="nbOpenPicker(${r.id})">
                ${(r.bindings && r.bindings.length)
                    ? r.bindings.map(s => `${escHtml(s.label ? s.name + ':' + s.label : (s.name || '?'))}<span class="action-tag ${nbBindingTag(s)}">${nbBindingTag(s)}</span>`).join(' · ')
                    : '— select devices —'}
              </div>
              <button class="btn-test" onclick="nbTestRow(${r.id}, this)">Test</button>
            </div>`).join('')}
        </div>
      </div>`;
  }

  // ─── Picker popover ────────────────────────────────────────────────────────
  window.nbOpenPicker = function (rowId) {
    const row = _buttons.find(r => r.id === rowId);
    if (!row) return;
    if (!row.bindings) row.bindings = [];
    _nbActivePicker = { rowId, snapshot: JSON.parse(JSON.stringify(row.bindings)) };
    const lbl = row.label || `p${row.page}b${row.button_id}`;
    document.getElementById('nbk-title').textContent = `${lbl} · ${row.event}`;
    document.getElementById('nbk-search-input').value = '';
    nbRenderPickerList('');
    document.getElementById('nbk-overlay').classList.add('show');
  };

  window.nbClosePicker = function (save) {
    document.getElementById('nbk-overlay').classList.remove('show');
    if (!save && _nbActivePicker) {
      const row = _buttons.find(r => r.id === _nbActivePicker.rowId);
      if (row) row.bindings = _nbActivePicker.snapshot;
    }
    if (_nbActivePicker) nbRenderPickerDisplay(_nbActivePicker.rowId);
    _nbActivePicker = null;
  };

  window.nbFilterPicker = function () {
    nbRenderPickerList(document.getElementById('nbk-search-input').value);
  };

  function nbRenderPickerList(filter) {
    if (!_nbActivePicker) return;
    const row = _buttons.find(r => r.id === _nbActivePicker.rowId);
    if (!row) return;
    if (!row.bindings) row.bindings = [];
    const selByKey = new Map(row.bindings.map(s => [s.device_id + ':' + (s.channel || ''), s]));
    const f = (filter || '').toLowerCase();
    const list = document.getElementById('nbk-list');
    list.innerHTML = '';
    let currentRoom = null, visible = 0;
    const defAct = nbDefaultActionFor(row.event);

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
          ? nbAlexaOptionValue(existing.action,
              existing.template_name || existing.station_name || null)
          : 'speak:' + ((_nbAlexaAnnouncements[0] && _nbAlexaAnnouncements[0].name) || '');
        const speakOpts = (_nbAlexaAnnouncements || []).map(t => {
          const v = nbAlexaOptionValue('speak', t.name);
          return `<option value="${escHtml(v)}" ${v === curVal ? 'selected' : ''}>${escHtml(t.name)}</option>`;
        }).join('');
        const playOpts = (_nbAlexaStations || []).map(s => {
          const v = nbAlexaOptionValue('play', s.name);
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
        nbToggleSelection(d, cb.checked, sel.value, isPageSelect, isAlexa, isVacuum);
      });
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        if (!cb.checked) cb.checked = true;
        nbToggleSelection(d, cb.checked, sel.value, isPageSelect, isAlexa, isVacuum);
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
    nbUpdatePickerCount();
  }

  function nbToggleSelection(dev, checked, action, isPageSelect, isAlexa, isVacuum) {
    if (!_nbActivePicker) return;
    const row = _buttons.find(r => r.id === _nbActivePicker.rowId);
    if (!row) return;
    if (!row.bindings) row.bindings = [];
    const idx = row.bindings.findIndex(s =>
      s.device_id === dev.device_id && (s.channel || null) === (dev.channel || null));
    const pageNum = isPageSelect ? parseInt(action, 10) : null;
    let storedAction = isPageSelect ? 'turn_on' : action;
    let templateName = null, stationName = null;
    if (isAlexa) {
      const parsed = nbParseAlexaOptionValue(action);
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
    nbUpdatePickerCount();
  }

  function nbUpdatePickerCount() {
    if (!_nbActivePicker) return;
    const row = _buttons.find(r => r.id === _nbActivePicker.rowId);
    document.getElementById('nbk-count').textContent =
      `${(row && row.bindings ? row.bindings.length : 0)} selected`;
  }

  // ─── Test + Save ───────────────────────────────────────────────────────────
  window.nbTestRow = async function (rowId, btn) {
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await fetch(`/api/hasp/${NB_PANEL}/buttons/${rowId}/test`, { method: 'POST' });
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

  window.nbSaveAllBindings = async function () {
    const saveBtn = document.querySelector('#tab-panel2 .wallmote-card .btn-save');
    if (!saveBtn) return;
    const original = saveBtn.textContent;
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    let ok = 0, fail = 0;
    for (const row of _buttons) {
      try {
        const r = await fetch(`/api/hasp/${NB_PANEL}/buttons/${row.id}`, {
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

  async function nbLoadButtons() {
    await nbLoadControllableDevices();
    try {
      const r = await fetch(`/api/hasp/${NB_PANEL}/buttons`).then(r => r.json());
      _buttons = (r.buttons || []).map(b => ({ ...b, bindings: b.bindings || [] }));
    } catch (_) { _buttons = []; }
    const list = document.getElementById('nb-buttons-list');
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
      cards.push(nbRenderButtonCard(r, allRows));
    }
    list.innerHTML = cards.join('');
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _nbActivePicker) nbClosePicker(false);
  });
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'nbk-overlay' && _nbActivePicker) nbClosePicker(false);
  });

  // ─── Display Templates card ────────────────────────────────────────────────
  let _displays = [];
  let _stateKeys = [];
  let _deviceSources = []; // [{value:'device:<id>:<key>', label:'<DeviceName> · <key>', room}]

  // Numeric / displayable dps keys worth offering as a display source
  const _DEVICE_DPS_FIELDS = ['temperature', 'humidity', 'illuminance', 'uv',
                              'battery', 'power', 'energy', 'voltage', 'current',
                              'pressure', 'co2', 'voc', 'pm25'];

  async function nbLoadStateKeys() {
    try {
      const r = await fetch('/api/rule-engine/state').then(r => r.json());
      _stateKeys = Object.keys((r && r.state) || {}).sort();
    } catch (_) { _stateKeys = []; }
    return _stateKeys;
  }

  async function nbLoadDeviceSources() {
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
  let _nbPreviewDevsCache = { ts: 0, list: [] };
  async function _nbPreviewDevices() {
    const now = Date.now();
    if (now - _nbPreviewDevsCache.ts < 10000 && _nbPreviewDevsCache.list.length) {
      return _nbPreviewDevsCache.list;
    }
    try {
      const r = await fetch('/api/devices').then(r => r.json());
      _nbPreviewDevsCache = { ts: now, list: Array.isArray(r) ? r : (r.devices || []) };
    } catch (_) {}
    return _nbPreviewDevsCache.list;
  }

  function nbRenderTemplate(format, shared, sourceVal) {
    return String(format || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
      if (k === 'val') return sourceVal == null ? '' : String(sourceVal);
      const v = shared[k];
      return v == null ? '' : String(v);
    });
  }

  async function _nbResolveSource(srcVal) {
    if (!srcVal) return null;
    if (srcVal.startsWith('device:')) {
      const rest = srcVal.slice('device:'.length);
      const i = rest.indexOf(':');
      if (i > 0) {
        const [devId, key] = [rest.slice(0, i), rest.slice(i + 1)];
        const devs = await _nbPreviewDevices();
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

  async function nbRenderPreview(format, sourceVal) {
    if (!format) return '';
    const [r, resolved] = await Promise.all([
      fetch('/api/rule-engine/state').then(r => r.json()).catch(() => ({})),
      _nbResolveSource(sourceVal),
    ]);
    return nbRenderTemplate(format, (r && r.state) || {}, resolved);
  }

  function nbRenderDisplay(d) {
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
              oninput="nbUpdateDisplay(${d.id},'page',parseInt(this.value))" style="${inp}">
          </label>
          <label style="${lblStyle}">Label ID
            <input type="number" value="${d.label_id}" min="0"
              oninput="nbUpdateDisplay(${d.id},'label_id',parseInt(this.value))" style="${inp}">
          </label>
          <label style="${lblStyle}">Type
            <select onchange="nbUpdateDisplay(${d.id},'display_type',this.value)" style="${inp}">${dtypes}</select>
          </label>
          <label style="${lblStyle}">Target
            <select onchange="nbUpdateDisplay(${d.id},'target_property',this.value)" style="${inp}">${tprops}</select>
          </label>
          <label style="${lblStyle}">Refresh
            <input type="number" value="${d.refresh_sec || 30}" min="5" max="3600"
              oninput="nbUpdateDisplay(${d.id},'refresh_sec',parseInt(this.value))" style="${inp}">
          </label>
          <label style="${lblStyle}" title="state.shared key or Device sensor">Source
            <select onchange="nbUpdateDisplay(${d.id},'source_value',this.value); nbUpdateDisplay(${d.id},'source_type',this.value.startsWith('device:')?'device':'shared_state'); nbUpdatePreview(${d.id})" style="${inp}">${keysOptions}</select>
          </label>
          <label style="${lblStyle}">Description
            <input type="text" value="${escHtml(d.description || '')}"
              oninput="nbUpdateDisplay(${d.id},'description',this.value)" style="${inp}">
          </label>
          <label style="${lblStyle}">Format
            <input type="text" value="${escHtml(d.format_string || '')}" placeholder="{{val}}°C"
              oninput="nbUpdateDisplay(${d.id},'format_string',this.value); nbUpdatePreview(${d.id})"
              style="${inp}font-family:monospace;">
          </label>
          <div style="${lblStyle}">Preview
            <div style="background:#fff;padding:3px 8px;border-radius:3px;border-left:3px solid #7a9ab8;font-size:0.82rem;font-family:monospace;color:#000;height:22px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="last: ${escHtml(d.last_value || '')}">
              <span data-cell="preview">—</span>
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:end;height:100%;">
            <button class="btn-save" style="padding:4px 10px;" onclick="nbSaveDisplay(${d.id})" title="Save this row">Save</button>
            <button class="btn-test" style="border-color:#c0392b;color:#c0392b;font-size:1rem;line-height:1;padding:3px 9px;" onclick="nbDeleteDisplay(${d.id})" title="Delete this display row">×</button>
            <span data-cell="status" style="font-size:0.72rem;color:#888;align-self:center;"></span>
          </div>
        </div>
      </div>`;
  }

  window.nbUpdateDisplay = function (id, field, value) {
    const d = _displays.find(x => x.id === id);
    if (d) d[field] = value;
  };

  window.nbUpdatePreview = async function (id) {
    const d = _displays.find(x => x.id === id);
    if (!d) return;
    const el = document.querySelector(`[data-id="${id}"] [data-cell="preview"]`);
    if (!el) return;
    const rendered = await nbRenderPreview(d.format_string, d.source_value);
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

  window.nbSaveDisplay = async function (id) {
    const d = _displays.find(x => x.id === id);
    if (!d) return;
    const status = document.querySelector(`[data-id="${id}"] [data-cell="status"]`);
    if (status) { status.style.color = '#888'; status.textContent = '…'; }
    try {
      const srcType = (d.source_value || '').startsWith('device:') ? 'device' : 'shared_state';
      const r = await fetch(`/api/hasp/${NB_PANEL}/displays/${id}`, {
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
      if (r.ok) nbRenderDisplaysList();
    } catch (e) {
      if (status) { status.style.color = '#c0392b'; status.textContent = '✗ ' + e.message; }
    }
  };

  window.nbDeleteDisplay = async function (id) {
    if (!confirm('Delete this display?')) return;
    try {
      await fetch(`/api/hasp/${NB_PANEL}/displays/${id}`, { method: 'DELETE' });
      await nbLoadDisplays();
    } catch (_) {}
  };

  window.nbAddDisplay = async function () {
    try {
      const r = await fetch(`/api/hasp/${NB_PANEL}/displays`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: 1, label_id: 200,
          display_type: 'text', target_property: 'text',
          source_type: 'shared_state', format_string: '', refresh_sec: 30,
        })
      });
      if (r.ok) await nbLoadDisplays();
    } catch (e) { alert('Add failed: ' + e.message); }
  };

  function nbRenderDisplaysList() {
    const list = document.getElementById('nb-displays-list');
    const count = document.getElementById('nb-displays-count');
    if (!list) return;
    const filter = (document.getElementById('nb-displays-filter') || {}).value || 'active';
    const limitRaw = (document.getElementById('nb-displays-limit') || {}).value || '10';
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
    list.innerHTML = shown.map(nbRenderDisplay).join('');
    for (const d of shown) nbUpdatePreview(d.id);
  }
  window.nbRenderDisplaysList = nbRenderDisplaysList;

  window.nbToggleDisplaysCard = function () {
    const body = document.getElementById('nb-displays-body');
    const toggle = document.getElementById('nb-displays-toggle');
    if (!body) return;
    const collapsed = body.style.display === 'none';
    body.style.display = collapsed ? '' : 'none';
    if (toggle) toggle.textContent = collapsed ? '▾' : '▸';
  };

  async function nbLoadDisplays() {
    await Promise.all([nbLoadStateKeys(), nbLoadDeviceSources()]);
    try {
      const r = await fetch(`/api/hasp/${NB_PANEL}/displays`).then(r => r.json());
      _displays = r.displays || [];
    } catch (_) { _displays = []; }
    nbRenderDisplaysList();
  }

  // ─── Sync from panel ───────────────────────────────────────────────────────
  window.nbSyncFromPanel = async function () {
    const btn = document.getElementById('nb-sync-btn');
    const status = document.getElementById('nb-sync-status');
    btn.disabled = true;
    if (status) { status.style.color = '#888'; status.textContent = 'syncing…'; }
    try {
      const r = await fetch(`/api/hasp/${NB_PANEL}/sync`, { method: 'POST' });
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
      await Promise.all([nbLoadButtons(), nbLoadDisplays()]);
    } catch (e) {
      if (status) { status.style.color = '#c0392b'; status.textContent = '✗ ' + e.message; }
    } finally { btn.disabled = false; }
  };

  // ─── On-board relay lights — this plate replaces the failed My Bathroom Switch ──
  // Page-1 buttons drive two GPIO relays: p1b10 = Laundry Light (GPIO1, grp1),
  // p1b20 = My Bathroom Light (GPIO2, grp2). Control via the documented OpenHASP
  // `command/output<pin>` with a JSON {"state":"on"|"off"} payload — STATE-based
  // (idempotent) and group-syncs the button display. Real relay state is pushed
  // on hasp/<plate>/state/output<pin> (the button state/p1bNN topic does NOT push).
  const NP_RELAYS = [
    { key: 'p1b10', out: 'output1', label: 'Laundry Light' },
    { key: 'p1b20', out: 'output2', label: 'My Bathroom Light' },
  ];
  function npRenderRelay(key, on) {
    const chip = document.getElementById('np-relay-' + key);
    if (chip) {
      chip.textContent = (on == null) ? '—' : (on ? 'ON' : 'OFF');
      chip.style.background  = (on == null) ? '#eee' : (on ? '#3a7d44' : '#c0392b');
      chip.style.color       = (on == null) ? '#888' : '#fff';
      chip.style.borderColor = (on == null) ? '#d0cbc4' : (on ? '#3a7d44' : '#c0392b');
    }
    const bOn  = document.getElementById('np-relay-' + key + '-on');
    const bOff = document.getElementById('np-relay-' + key + '-off');
    if (bOn)  { bOn.style.background  = on === true  ? '#3a7d44' : ''; bOn.style.color  = on === true  ? '#fff' : '#3a7d44'; }
    if (bOff) { bOff.style.background = on === false ? '#c0392b' : ''; bOff.style.color = on === false ? '#fff' : '#c0392b'; }
  }
  window.npRelay = function (key, on) {
    if (!_npMqtt || !_npMqtt.connected) return;
    const r = NP_RELAYS.find(x => x.key === key);
    if (r) _npMqtt.publish(`hasp/${NP_PLATE}/command/${r.out}`, JSON.stringify({ state: on ? 'on' : 'off' }));
    npRenderRelay(key, !!on);   // optimistic; corrected by the state/output<pin> push
  };

  // ─── Lazy-init on first activation of the 'panel2' tab ──────────────────────
  const _npOrigShowTab = window.showTab;
  let _np2Inited = false;
  window.showTab = function (name, btn) {
    if (_npOrigShowTab) _npOrigShowTab(name, btn);
    if (name === 'panel2' && !_np2Inited) {
      _np2Inited = true;
      npRestoreCachedPower();
      npInit();
      nbLoadButtons();
      nbLoadDisplays();
    }
  };
})();
