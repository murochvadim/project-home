// Living Room Agent — page logic
(function () {
  const WM1_ID = 'e410cc7b-a734-4177-b941-2394dd7a5f7f';
  const WM2_ID = '62f40d30-5c63-4d97-bf55-c602d1e2ee93';

  const CONTROLLABLE_TYPES = new Set(['switch', 'light', 'circuit_breaker', 'water_heater', 'curtain', 'valve', 'esp_board', 'panel', 'display', 'media_player', 'vacuum']);
  const ACTIONS = [
    { v: 'turn_on',  label: 'Turn On',  tag: 'on'     },
    { v: 'turn_off', label: 'Turn Off', tag: 'off'    },
    { v: 'toggle',   label: 'Toggle',   tag: 'toggle' },
  ];
  const STORAGE_KEY = 'living-room.wallmote_bindings';

  // In-memory bindings state
  // Shape: { 'wm1:button1:pushed': [{device_id, channel, name, label, action,
  //          template_name?, station_name?}, ...] }
  let bindings = {};

  // Cached device list (built once on load)
  let controllableDevices = [];

  // Saved Alexa announcements + stations — loaded once with the device list
  // so the bindings picker can offer Speak / Play options for media_players.
  let _alexaAnnouncements = [];   // [{name, message, default_volume?}]
  let _alexaStations      = [];   // [{name, content_id, content_type}]

  // Encode/decode the Alexa-action option value used in the picker
  // dropdown. Format: '<verb>' or '<verb>:<name>'. Trusts that user-
  // facing names don't contain a colon (validated at save in the form).
  function alexaOptionValue(action, name) {
    return name ? `${action}:${name}` : action;
  }
  function parseAlexaOptionValue(v) {
    const i = v.indexOf(':');
    return i < 0 ? { action: v } : { action: v.slice(0, i), name: v.slice(i + 1) };
  }

  // Active picker context
  let activePicker = null;

  function key(wm, btn, ev) { return `${wm}:${btn}:${ev}`; }
  function defaultActionFor(event) { return event === 'held' ? 'toggle' : 'turn_on'; }
  function actionLabel(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.label : v; }
  function actionTag(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.tag : 'on'; }
  // Chip-tag for a binding: page-select bindings show `P<n>`; Alexa speak/play
  // show the template/station name appended so the user sees the target.
  function bindingTag(b) {
    if (b && b.page_num != null) return `P${b.page_num}`;
    if (b && b.action === 'speak' && b.template_name) return `say:${b.template_name}`;
    if (b && b.action === 'play'  && b.station_name)  return `play:${b.station_name}`;
    // Vacuum verbs (start/stop/dock/locate) and bare alexa stop both
    // render as the verb itself — context (device name in the chip)
    // disambiguates which.
    if (b && (b.action === 'stop' || b.action === 'start'
              || b.action === 'dock' || b.action === 'locate')) return b.action;
    return actionTag(b ? b.action : 'on');
  }

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
      const [devs, saved, anns, stations] = await Promise.all([
        fetch('/api/devices').then(r => r.json()),
        fetch(`/api/dashboard-settings/${encodeURIComponent(STORAGE_KEY)}`).then(r => r.json()).catch(() => ({ value: null })),
        fetch('/api/dashboard-settings/media-agents.alexa_announcements').then(r => r.json()).catch(() => ({ value: [] })),
        fetch('/api/dashboard-settings/media-agents.alexa_quick_music').then(r => r.json()).catch(() => ({ value: [] })),
      ]);
      _alexaAnnouncements = Array.isArray(anns && anns.value) ? anns.value : [];
      _alexaStations      = Array.isArray(stations && stations.value) ? stations.value : [];

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
        const dpsCfg = d.dps_config || {};

        // Channel-expansion priority:
        // 1) channel_config with numeric keys (Tuya local/gateway multi-gang)
        // 2) dps_labels with state_l<N> keys (Zigbee multi-gang)
        // 3) dps_config keys with action_on (ESP boards, HASP panel,
        //    Awtrix display — controllable channels declared per-device
        //    via dps_config.<channel>.action_on/action_off). Gated to
        //    those protocols so Alexa devices' dps_config.power (used
        //    only for the Devices-page on/off chip) doesn't get
        //    surfaced as a "Ch.power" row in the bindings picker.
        const tuyaChans = Object.keys(chanCfg).filter(k => k && !isNaN(parseInt(k))).sort();
        const zigbeeChans = Object.keys(dpsLabels).filter(k => /^state_l\d+$/i.test(k))
          .sort((a, b) => parseInt(a.replace(/\D/g,'')) - parseInt(b.replace(/\D/g,'')));
        const actionChans = (d.protocol === 'esp' || d.protocol === 'hasp' || d.protocol === 'awtrix')
          ? Object.keys(dpsCfg).filter(k => (dpsCfg[k] || {}).action_on)
          : [];

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
        } else if (actionChans.length) {
          for (const ch of actionChans) {
            const cc = dpsCfg[ch] || {};
            // chan_meta drives the picker render — page-select channels
            // (e.g. HASP balcony's `page` 1-12) get a page-number
            // dropdown instead of the action dropdown.
            const meta = (cc.type ? { type: cc.type, min: cc.min, max: cc.max } : null);
            controllableDevices.push({
              device_id: d.id, channel: ch,
              name: d.name, label: cc.name || ch,
              room: cc.room || d.room || '', protocol: d.protocol,
              chan_meta: meta,
            });
          }
        } else {
          controllableDevices.push({
            device_id: d.id, channel: null,
            name: d.name, label: '',
            room: d.room || '', protocol: d.protocol,
            dps_config: d.dps_config || {},   // needed for vacuum verb list (which actions this device actually supports)
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
      // Page-select channels get a page-number dropdown (1..max) in
      // place of the toggle/turn_on/turn_off action dropdown. Selecting
      // a number stores `{action: 'turn_on', page_num: N}` on the
      // binding — rule engine HASP branch translates that to a
      // `command/page` publish.
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
        // Vacuum verbs: read from this device's dps_config so each
        // device exposes only what it actually supports (e.g. Roomba
        // has start/stop/dock/locate, Viomi has start/stop/dock —
        // locate is broken on Viomi's HA integration). action_on alias
        // = the verb the rule engine emits.
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
        // Alexa dropdown: Speak / Play music / Stop only. Other transport
        // (pause/resume/next/prev) + power were dropped per user request
        // 2026-05-07. Stop is the counterpart to play — without it a
        // binding can start music but not stop it from a button press.
        const curVal = existing
          ? alexaOptionValue(existing.action,
              existing.template_name || existing.station_name || null)
          : 'speak:' + ((_alexaAnnouncements[0] && _alexaAnnouncements[0].name) || '');
        const speakOpts = (_alexaAnnouncements || []).map(t => {
          const v = alexaOptionValue('speak', t.name);
          return `<option value="${escHtml(v)}" ${v === curVal ? 'selected' : ''}>${escHtml(t.name)}</option>`;
        }).join('');
        const playOpts = (_alexaStations || []).map(s => {
          const v = alexaOptionValue('play', s.name);
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
        <div class="picker-item-meta">${escHtml(d.protocol)}${d.channel ? ' · Ch.'+d.channel : ''}</div>
      `;
      const cb = item.querySelector('input');
      const sel = item.querySelector('select');

      item.addEventListener('click', (e) => {
        if (e.target === sel || sel.contains(e.target)) return;  // let the select handle its own clicks
        if (e.target !== cb) cb.checked = !cb.checked;
        toggleSelection(d, cb.checked, sel.value, isPageSelect, isAlexa, isVacuum);
      });
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        // Changing action implicitly selects the device (if not already)
        if (!cb.checked) cb.checked = true;
        toggleSelection(d, cb.checked, sel.value, isPageSelect, isAlexa, isVacuum);
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

  function toggleSelection(dev, checked, action, isPageSelect, isAlexa, isVacuum) {
    if (!activePicker) return;
    const slotKey = key(activePicker.wallmote, activePicker.button, activePicker.event);
    if (!bindings[slotKey]) bindings[slotKey] = [];
    const existingIdx = bindings[slotKey].findIndex(s =>
      s.device_id === dev.device_id && (s.channel || null) === (dev.channel || null));
    // Decode the dropdown value depending on row type:
    //   Alexa  → 'speak:<name>' / 'play:<name>' / 'stop' / 'turn_on' / etc.
    //   page   → just the page number (action stays 'turn_on')
    //   other  → plain action verb
    const pageNum = isPageSelect ? parseInt(action, 10) : null;
    let storedAction = isPageSelect ? 'turn_on' : action;
    let templateName = null, stationName = null;
    if (isAlexa) {
      const parsed = parseAlexaOptionValue(action);
      storedAction = parsed.action;
      if (parsed.action === 'speak') templateName = parsed.name || '';
      if (parsed.action === 'play')  stationName  = parsed.name || '';
    }
    if (checked) {
      const writeFields = (b) => {
        b.action = storedAction;
        if (isPageSelect) b.page_num = pageNum; else delete b.page_num;
        if (isAlexa) {
          if (templateName) b.template_name = templateName; else delete b.template_name;
          if (stationName)  b.station_name  = stationName;  else delete b.station_name;
        }
      };
      if (existingIdx >= 0) {
        writeFields(bindings[slotKey][existingIdx]);
      } else {
        const b = {
          device_id: dev.device_id, channel: dev.channel,
          name: dev.name, label: dev.label,
          action: storedAction,
        };
        if (isPageSelect) b.page_num = pageNum;
        if (isAlexa && templateName) b.template_name = templateName;
        if (isAlexa && stationName)  b.station_name  = stationName;
        bindings[slotKey].push(b);
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
        `${escHtml(s.label ? s.name + ':' + s.label : s.name)}<span class="action-tag ${bindingTag(s)}">${bindingTag(s)}</span>`;
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

  // ─── Awtrix tab ────────────────────────────────────────────────────────────
  // Browser publishes MQTT directly via WebSocket on the broker (port 9001).
  // No new server.js endpoints — message templates are stored under
  // dashboard_settings.awtrix.messages, the broker password is fetched once
  // via the existing /api/dashboard-settings/_mqtt_browser_pass endpoint
  // (special-cased in-handler to read from process.env.MQTT_BROWSER_PASS).
  const AW_DEVICE       = 'awtrix_05ec2c';
  const AW_BROKER_HOST  = '192.168.1.189';
  const AW_BROKER_PORT  = 9001;
  const AW_USER         = 'dashboard_browser';
  const AW_STORAGE_KEY  = 'awtrix.messages';

  let _awInited     = false;
  let _awMqtt       = null;
  let _awState      = {};   // cached state.shared dict
  let _awMessages   = [];   // array of {name, template, color, scroll_speed, text_case, duration_s}
  let _awPrevTimer  = null;
  let _awLastStats  = {};   // most recent stats payload (used by Clear display to know current app)

  function awSetOnline(connected) {
    const dot  = document.getElementById('aw-online-dot');
    const text = document.getElementById('aw-online-text');
    if (dot)  dot.style.color = connected ? '#3a7d44' : '#c0392b';
    if (text) text.textContent = connected ? 'connected' : 'disconnected';
  }

  function awSetMsg(text, isError) {
    const el = document.getElementById('aw-msg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = isError ? '#c0392b' : '#3a7d44';
    if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
  }

  function awUpdateStatus(stats) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('aw-bat',  stats.bat ?? '—');
    set('aw-bri',  stats.bri ?? '—');
    set('aw-rssi', stats.wifi_signal ?? '—');
    set('aw-app',  stats.app ?? '—');
    set('aw-temp', stats.temp ?? '—');
    set('aw-hum',  stats.hum ?? '—');
  }

  async function awLoadState() {
    try {
      const r = await fetch('/api/rule-engine/state').then(r => r.json());
      _awState = r && typeof r.state === 'object' ? r.state : {};
    } catch (e) {
      console.error('awLoadState failed:', e);
      _awState = {};
    }
  }

  function awResolve(tpl) {
    if (!tpl) return '';
    return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
      const v = _awState[key];
      if (v === undefined || v === null) return '?';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    });
  }

  function awPreview() {
    if (_awPrevTimer) clearTimeout(_awPrevTimer);
    _awPrevTimer = setTimeout(() => {
      const text = document.getElementById('aw-text').value;
      const out  = document.getElementById('aw-preview');
      if (out) out.textContent = awResolve(text) || '—';
    }, 300);
  }
  window.awPreview = awPreview;

  // Clear what's currently on the display.
  //   • Active notification popup → dismissed
  //   • ANY custom app currently displaying → REMOVED permanently (empty retained
  //     pub to remove from device NVS + remove from dashboard storage if present).
  //   • Built-in app (Time/Date/Temperature/Humidity/Battery) → rotation advanced.
  const AW_BUILTINS = new Set(['Time', 'Date', 'Temperature', 'Humidity', 'Battery']);
  async function awClearDisplay() {
    console.log('[awtrix] Clear display clicked. _awLastStats.app =', _awLastStats && _awLastStats.app);
    if (!_awMqtt || !_awMqtt.connected) { awSetMsg('MQTT not connected', true); return; }
    const cur = _awLastStats && _awLastStats.app;
    // Always dismiss notifications
    _awMqtt.publish(`${AW_DEVICE}/notify/dismiss`, '', { qos: 0 });
    if (cur && !AW_BUILTINS.has(cur)) {
      // Custom app — remove from device (empty retained) regardless of dashboard storage
      _awMqtt.publish(`${AW_DEVICE}/custom/${cur}`, '', { qos: 0, retain: true }, (err) => {
        if (err) console.error('[awtrix] custom remove pub err', err);
        else     console.log('[awtrix] custom remove pub OK for', cur);
      });
      // Sync dashboard storage if we had it
      const had = _awMessages.find(m => m.name === cur);
      if (had) {
        _awMessages = _awMessages.filter(m => m.name !== cur);
        try { await awSaveMessages(); } catch (_) {}
        awRenderSaved();
      }
      awSetMsg(`Removed "${cur}" — display cleared`);
    } else if (cur) {
      // Built-in — just advance
      _awMqtt.publish(`${AW_DEVICE}/nextapp`, '', { qos: 0 });
      awSetMsg(`"${cur}" is built-in — advanced rotation`);
    } else {
      // No stats yet (just opened tab) — best effort dismiss + advance
      _awMqtt.publish(`${AW_DEVICE}/nextapp`, '', { qos: 0 });
      awSetMsg('No current app info yet — try again in a few seconds');
    }
  }
  window.awClearDisplay = awClearDisplay;

  function awGetForm() {
    const blinkChk = document.getElementById('aw-blink').checked;
    const blinkMs  = parseInt(document.getElementById('aw-blink-ms').value, 10) || 500;
    const soundChk = document.getElementById('aw-sound').checked;
    const soundVal = document.getElementById('aw-sound-val').value.trim();
    return {
      text:        document.getElementById('aw-text').value,
      color:       document.getElementById('aw-color').value,
      scrollSpeed: parseInt(document.getElementById('aw-speed').value, 10),
      textCase:    parseInt(document.getElementById('aw-case').value, 10),
      duration:    parseInt(document.getElementById('aw-duration').value, 10),
      blinkMs:     blinkChk ? blinkMs : 0,
      sound:       soundChk ? soundVal : '',
      priority:    document.getElementById('aw-priority').value,
      clearAfter:  document.getElementById('aw-clear').checked,
    };
  }

  function awBuildPayload(form, persistent) {
    const payload = {
      text:        awResolve(form.text),
      color:       form.color,
      scrollSpeed: form.scrollSpeed,
      textCase:    form.textCase,
    };
    if (persistent) {
      payload.repeat = -1;
      // "Clear after run" → set lifetime so the custom app auto-removes after duration
      if (form.clearAfter) {
        payload.lifetime     = form.duration;
        payload.lifetimeMode = 0;          // 0 = remove on expiry, 1 = mark stale
      }
    } else {
      payload.duration = form.duration;
    }
    if (form.blinkMs && form.blinkMs > 0) payload.blinkText = form.blinkMs;
    if (form.sound) {
      // RTTTL strings have ":d=" / ":o=" / ":b=" markers — anything else is treated as a filename
      if (/:[dob]=/.test(form.sound)) payload.rtttl = form.sound;
      else                            payload.sound = form.sound;
    }
    // Priority maps to AWTRIX flags: high = wake + don't queue (override now);
    // low = no push-icon animation; normal = defaults.
    if (form.priority === 'high') {
      payload.wakeup = true;
      payload.stack  = false;
    } else if (form.priority === 'low') {
      payload.pushIcon = 0;
    }
    return payload;
  }

  function awPower(on) {
    if (!_awMqtt || !_awMqtt.connected) { awSetMsg('MQTT not connected', true); return; }
    _awMqtt.publish(`${AW_DEVICE}/power`, JSON.stringify({ power: !!on }), { qos: 0 }, (err) => {
      if (err) awSetMsg('Power failed: ' + err.message, true);
      else     awSetMsg(`Display ${on ? 'on' : 'off'}`);
    });
  }
  window.awPower = awPower;

  // Toggle uses the in-handler HTTP proxy on server.js (POST /api/dashboard-settings/_awtrix_settings).
  // We don't use MQTT for built-ins because firmware 0.98 silently ignores DAT via the MQTT settings
  // topic — HTTP path works for all 5 keys reliably.
  async function awBuiltin(key, on) {
    try {
      const body = {}; body[key] = !!on;
      const r = await fetch('/api/dashboard-settings/_awtrix_settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: body }),
      }).then(r => r.json());
      if (r.ok || r.status === 200) {
        awSetMsg(`${key} ${on ? 'on' : 'off'} — click Reboot & Apply to refresh rotation`);
      } else {
        awSetMsg(`Toggle ${key} failed: ${r.error || 'unknown'}`, true);
      }
    } catch (e) { awSetMsg('Toggle failed: ' + e.message, true); }
  }
  window.awBuiltin = awBuiltin;

  async function awLoadBuiltins() {
    try {
      const r = await fetch('/api/dashboard-settings/_awtrix_settings').then(r => r.json());
      const s = r && r.value ? r.value : {};
      ['TIM','TEMP','HUM','BAT'].forEach(k => {
        const el = document.getElementById('aw-bi-' + k);
        if (el) el.checked = !!s[k];
      });
    } catch (e) {
      console.error('awLoadBuiltins failed:', e);
    }
  }

  function awReboot() {
    if (!_awMqtt || !_awMqtt.connected) { awSetMsg('MQTT not connected', true); return; }
    if (!confirm('Reboot the AWTRIX display? Takes ~10 s.')) return;
    _awMqtt.publish(`${AW_DEVICE}/reboot`, '', { qos: 0 }, (err) => {
      if (err) awSetMsg('Reboot failed: ' + err.message, true);
      else     awSetMsg('Rebooting… display will return in ~10 s with rotation rebuilt');
    });
  }
  window.awReboot = awReboot;

  function awPushNotify() {
    if (!_awMqtt || !_awMqtt.connected) { awSetMsg('MQTT not connected', true); return; }
    const form = awGetForm();
    if (!form.text) { awSetMsg('Type a sentence first', true); return; }
    const payload = awBuildPayload(form, false);
    _awMqtt.publish(`${AW_DEVICE}/notify`, JSON.stringify(payload), { qos: 0 }, (err) => {
      if (err) awSetMsg('Publish failed: ' + err.message, true);
      else     awSetMsg('Pushed: ' + payload.text);
    });
  }
  window.awPushNotify = awPushNotify;

  async function awSaveAsApp() {
    if (!_awMqtt || !_awMqtt.connected) { awSetMsg('MQTT not connected', true); return; }
    const form = awGetForm();
    if (!form.text) { awSetMsg('Type a sentence first', true); return; }
    const name = (prompt('Name for this app (lowercase, no spaces):', '') || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!name) return;
    if (['time', 'temperature', 'humidity', 'battery', 'date'].includes(name)) {
      awSetMsg(`"${name}" collides with a built-in — pick another`, true); return;
    }
    const row = {
      name, template: form.text, color: form.color,
      scroll_speed: form.scrollSpeed, text_case: form.textCase, duration_s: form.duration,
      blink_ms: form.blinkMs, sound: form.sound, priority: form.priority,
      clear_after: form.clearAfter,
    };
    const idx = _awMessages.findIndex(m => m.name === name);
    if (idx >= 0) _awMessages[idx] = row; else _awMessages.push(row);
    await awSaveMessages();
    // Push retained custom app (persistent in rotation)
    const payload = awBuildPayload(form, true);
    _awMqtt.publish(`${AW_DEVICE}/custom/${name}`, JSON.stringify(payload), { qos: 0, retain: true }, (err) => {
      if (err) awSetMsg('Saved DB but MQTT failed: ' + err.message, true);
      else     awSetMsg(`Saved "${name}" + pushed to device`);
    });
    awRenderSaved();
  }
  window.awSaveAsApp = awSaveAsApp;

  async function awSaveMessages() {
    await fetch(`/api/dashboard-settings/${encodeURIComponent(AW_STORAGE_KEY)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: _awMessages }),
    });
  }

  async function awLoadMessages() {
    try {
      const r = await fetch(`/api/dashboard-settings/${encodeURIComponent(AW_STORAGE_KEY)}`).then(r => r.json());
      _awMessages = Array.isArray(r.value) ? r.value : [];
    } catch (e) {
      _awMessages = [];
    }
    awRenderSaved();
  }

  function awRenderSaved() {
    const tbody = document.getElementById('aw-saved-body');
    if (!tbody) return;
    if (!_awMessages.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="padding:14px;color:#888;text-align:center;">No saved apps yet</td></tr>';
      return;
    }
    const caseLabel = c => ({0:'Auto', 1:'UPPER', 2:'lower'}[c] || 'Auto');
    const prio = p => p === 'high' ? '<b style="color:#c0392b;">High</b>'
                    : p === 'low'  ? '<span style="color:#888;">Low</span>'
                    : 'Normal';
    tbody.innerHTML = _awMessages.map(m => `
      <tr style="border-bottom:1px solid #e8e2da;">
        <td style="padding:6px 4px;font-family:monospace;">${escapeHtml(m.name)}</td>
        <td style="padding:6px 4px;">${escapeHtml(m.template)}</td>
        <td style="padding:6px 4px;text-align:center;"><span title="${escapeHtml(m.color)}" style="display:inline-block;width:18px;height:14px;background:${escapeHtml(m.color)};border:1px solid #ccc;vertical-align:middle;"></span></td>
        <td style="padding:6px 4px;text-align:center;">${m.scroll_speed ?? ''}</td>
        <td style="padding:6px 4px;text-align:center;">${caseLabel(m.text_case)}</td>
        <td style="padding:6px 4px;text-align:center;">${m.duration_s ?? ''}s</td>
        <td style="padding:6px 4px;text-align:center;">${m.blink_ms && m.blink_ms > 0 ? m.blink_ms + 'ms' : '—'}</td>
        <td style="padding:6px 4px;font-family:monospace;font-size:0.78rem;color:${m.sound ? '#444' : '#aaa'};">${m.sound ? escapeHtml(m.sound) : '—'}</td>
        <td style="padding:6px 4px;text-align:center;">${prio(m.priority || 'normal')}</td>
        <td style="padding:6px 4px;text-align:center;">${m.clear_after ? '✓' : '—'}</td>
        <td style="padding:6px 4px;text-align:right;white-space:nowrap;">
          <button class="btn-test" onclick="awPushSaved('${m.name}')">Push</button>
          <button class="btn-test" onclick="awEdit('${m.name}')">Edit</button>
          <button class="btn-test" style="border-color:#c0392b;color:#c0392b;" onclick="awDelete('${m.name}')">Delete</button>
        </td>
      </tr>`).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function awEdit(name) {
    const m = _awMessages.find(x => x.name === name);
    if (!m) return;
    document.getElementById('aw-text').value     = m.template;
    document.getElementById('aw-color').value    = m.color;
    document.getElementById('aw-speed').value    = m.scroll_speed;
    document.getElementById('aw-case').value     = m.text_case;
    document.getElementById('aw-duration').value = m.duration_s;
    document.getElementById('aw-blink').checked  = !!(m.blink_ms && m.blink_ms > 0);
    document.getElementById('aw-blink-ms').value = m.blink_ms && m.blink_ms > 0 ? m.blink_ms : 500;
    document.getElementById('aw-sound').checked  = !!m.sound;
    document.getElementById('aw-sound-val').value = m.sound || '';
    document.getElementById('aw-priority').value = m.priority || 'normal';
    document.getElementById('aw-clear').checked  = !!m.clear_after;
    awPreview();
    awSetMsg(`Loaded "${name}" — edit, then Save as app to overwrite`);
  }
  window.awEdit = awEdit;

  function awMessageToForm(m) {
    return {
      text: m.template, color: m.color,
      scrollSpeed: m.scroll_speed, textCase: m.text_case, duration: m.duration_s,
      blinkMs: m.blink_ms || 0, sound: m.sound || '', priority: m.priority || 'normal',
      clearAfter: !!m.clear_after,
    };
  }

  function awPushSaved(name) {
    if (!_awMqtt || !_awMqtt.connected) { awSetMsg('MQTT not connected', true); return; }
    const m = _awMessages.find(x => x.name === name);
    if (!m) return;
    const payload = awBuildPayload(awMessageToForm(m), true);
    _awMqtt.publish(`${AW_DEVICE}/custom/${name}`, JSON.stringify(payload), { qos: 0, retain: true }, (err) => {
      if (err) awSetMsg('Push failed: ' + err.message, true);
      else     awSetMsg(`Pushed "${name}"`);
    });
  }
  window.awPushSaved = awPushSaved;

  async function awDelete(name) {
    if (!confirm(`Delete app "${name}"?`)) return;
    _awMessages = _awMessages.filter(m => m.name !== name);
    await awSaveMessages();
    if (_awMqtt && _awMqtt.connected) {
      // Empty retained payload removes the custom app from the device rotation
      _awMqtt.publish(`${AW_DEVICE}/custom/${name}`, '', { qos: 0, retain: true });
    }
    awRenderSaved();
    awSetMsg(`Deleted "${name}"`);
  }
  window.awDelete = awDelete;

  async function awInit() {
    if (_awInited) return;
    _awInited = true;
    if (typeof mqtt === 'undefined') { awSetMsg('mqtt.js library missing', true); return; }

    let pass;
    try {
      const r = await fetch('/api/dashboard-settings/_mqtt_browser_pass').then(r => r.json());
      pass = r.value;
    } catch (e) { awSetMsg('Could not fetch broker password', true); return; }
    if (!pass) { awSetMsg('MQTT_BROWSER_PASS not set in dashboard .env', true); return; }

    await awLoadState();
    await awLoadMessages();
    await awLoadBuiltins();

    _awMqtt = mqtt.connect(`ws://${AW_BROKER_HOST}:${AW_BROKER_PORT}`, {
      username: AW_USER, password: pass,
      clientId: 'awtrix-tab-' + Math.random().toString(36).slice(2, 10),
      reconnectPeriod: 5000, connectTimeout: 8000,
    });
    _awMqtt.on('connect', () => {
      awSetOnline(true);
      _awMqtt.subscribe(`${AW_DEVICE}/stats`, { qos: 0 });
    });
    _awMqtt.on('reconnect', () => awSetOnline(false));
    _awMqtt.on('close',     () => awSetOnline(false));
    _awMqtt.on('error',     (e) => { console.error('MQTT error:', e); awSetOnline(false); });
    _awMqtt.on('message', (topic, payload) => {
      if (topic === `${AW_DEVICE}/stats`) {
        try {
          const stats = JSON.parse(payload.toString());
          _awLastStats = stats;
          awUpdateStatus(stats);
        } catch (_) {}
      }
    });
  }

  // Hook into showTab so awInit runs first time the tab is opened
  const _origShowTab = window.showTab;
  window.showTab = function (name, btn) {
    _origShowTab(name, btn);
    if (name === 'awtrix') awInit();
  };
})();
