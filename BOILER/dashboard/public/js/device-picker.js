// Shared device picker — used by Living Room Rule Settings and Main Agent
// Base Rule Settings tabs. Pops up a modal listing all devices (search + type
// filter + optional channel picker for multi-channel switches, or preset
// picker for Pixoo displays). On pick, invokes callback with a pre-formatted
// token: "@Device Name" or "@Device Name Label" (label = dps_label for
// switches, preset name for Pixoo).
(function () {
  let _devices = [];
  let _pixooPresets = [];
  let _awtrixApps = [];      // saved apps from dashboard_settings.awtrix.messages
  let _alexaAnns = [];       // saved announcement templates from dashboard_settings.media-agents.alexa_announcements
  let _modal = null;
  let _onPick = null;
  let _multi = false;               // multi-select mode (scenes batch-add)
  let _selectedTokens = new Set();  // tokens checked in multi mode
  let _multiRowTokens = [];         // index→token map for the current multi render

  const MULTI_CHANNEL_TYPES = new Set(['switch', 'circuit_breaker']);

  // True if the device should expose display-style action sub-buttons
  // (on / off / push <preset>) — Awtrix + Pixoo today, future ambient
  // displays automatically by setting device_type='display'.
  function _isDisplayDevice(d) {
    return d.device_type === 'display' || d.protocol === 'pixoo' || d.protocol === 'awtrix';
  }
  function _isAlexaDevice(d) {
    return d.protocol === 'alexa';
  }

  function _displayPresetsFor(d) {
    if (d.protocol === 'pixoo')  return _pixooPresets.map(p => p.name).filter(Boolean);
    if (d.protocol === 'awtrix') return _awtrixApps.map(a => a.name).filter(Boolean);
    return [];
  }

  // Returns [[key, label], ...] pairs for SUB-channel pickers (multi-gang
  // switches). Display devices use a different sub-row (rendered inline)
  // because they need 'on/off' actions on top of 'push <preset>'.
  function _virtualChannelsFor(d) {
    // Multi-gang only: a single-label device should NOT render a channel
    // picker (`1: State`) because there's no ambiguity to resolve. Such
    // devices fall through to either the actionable on/off branch (if
    // dps_config.<key>.action_on is declared) or the bare-name chip.
    if (MULTI_CHANNEL_TYPES.has(d.device_type) && d.dps_labels && Object.keys(d.dps_labels).length > 1) {
      return Object.entries(d.dps_labels);
    }
    return null;
  }

  // Returns [[channel, label], ...] for channels in dps_config that declare
  // action_on / action_off mappings (any protocol). Used to render on/off
  // sub-buttons for devices like the smell board where the rule engine knows
  // how to translate generic turn_on/turn_off into a board-specific MQTT
  // action (e.g. smell_auto_start). Single channel → plain "on"/"off" tokens
  // ("@Name on"); multiple channels → channel-suffixed tokens
  // ("@Name auto_enabled on") so the dispatcher routes to the right one.
  function _actionableChannelsFor(d) {
    const cfg = d.dps_config || {};
    const labels = d.dps_labels || {};
    const out = [];
    for (const [k, ch] of Object.entries(cfg)) {
      if (!ch || typeof ch !== 'object') continue;
      if (ch.action_on || ch.action_off) {
        out.push([k, labels[k] || ch.name || k]);
      }
    }
    return out;
  }

  function _ensureModal() {
    if (_modal) return _modal;
    _modal = document.createElement('div');
    _modal.id = 'dp-modal';
    _modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1000;align-items:center;justify-content:center;';
    _modal.innerHTML = `
      <div style="background:#fff;border-radius:6px;max-width:560px;width:92%;max-height:80vh;display:flex;flex-direction:column;padding:14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <h3 style="margin:0;font-size:1rem;">Insert device reference</h3>
          <button onclick="window._dpClose()" style="padding:3px 10px;border:1px solid #aaa;background:#fff;border-radius:4px;cursor:pointer;">Close</button>
        </div>
        <input type="text" id="dp-search" placeholder="Search by name or room…"
               style="padding:5px 8px;border:1px solid #d0cbc4;border-radius:3px;font-size:0.85rem;margin-bottom:8px;" />
        <div id="dp-type-filter" style="display:flex;gap:4px;font-size:0.72rem;margin-bottom:8px;flex-wrap:wrap;"></div>
        <div id="dp-list" style="flex:1;overflow-y:auto;border:1px solid #e8e3d8;border-radius:3px;"></div>
        <div style="margin-top:6px;display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span id="dp-hint" style="font-size:0.72rem;color:#888;">Click a device (or a channel) to insert its reference.</span>
          <button id="dp-add-selected" onclick="window._dpAddSelected()" style="display:none;padding:5px 14px;border:none;border-radius:4px;background:#6c4f9f;color:#fff;font-size:0.82rem;cursor:pointer;">Add selected (0)</button>
        </div>
      </div>
    `;
    document.body.appendChild(_modal);
    _modal.addEventListener('click', (e) => { if (e.target === _modal) window._dpClose(); });
    document.getElementById('dp-search').addEventListener('input', _renderList);
    return _modal;
  }

  let _selectedType = '__all__';

  function _renderTypeFilter() {
    const el = document.getElementById('dp-type-filter');
    if (!el) return;
    const types = ['__all__', ...Array.from(new Set(_devices.map(d => d.device_type || 'unknown'))).sort()];
    el.innerHTML = types.map(t => {
      const label = t === '__all__' ? 'all' : t;
      const count = t === '__all__' ? _devices.length : _devices.filter(d => (d.device_type || 'unknown') === t).length;
      const active = t === _selectedType;
      return `<button data-dp-type="${t}" style="padding:3px 8px;border:1px solid ${active ? '#6c4f9f' : '#d0cbc4'};background:${active ? '#6c4f9f' : '#fff'};color:${active ? '#fff' : '#333'};border-radius:3px;cursor:pointer;font-size:0.72rem;">${label} (${count})</button>`;
    }).join('');
    el.querySelectorAll('[data-dp-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        _selectedType = btn.dataset.dpType;
        _renderTypeFilter();
        _renderList();
      });
    });
  }

  function _renderList() {
    const listEl = document.getElementById('dp-list');
    const searchEl = document.getElementById('dp-search');
    if (!listEl || !searchEl) return;
    const q = (searchEl.value || '').trim().toLowerCase();
    let filtered = _devices;
    if (_selectedType !== '__all__') filtered = filtered.filter(d => (d.device_type || 'unknown') === _selectedType);
    if (q) {
      filtered = filtered.filter(d => (
        (d.name || '').toLowerCase().includes(q) ||
        (d.room || '').toLowerCase().includes(q) ||
        (d.device_type || '').toLowerCase().includes(q)
      ));
    }
    filtered.sort((a, b) => (a.room || 'zzz').localeCompare(b.room || 'zzz') || (a.name || '').localeCompare(b.name || ''));
    if (!filtered.length) {
      listEl.innerHTML = '<div style="padding:14px;text-align:center;color:#999;">No match.</div>';
      if (_multi) _updateAddSelectedBtn();
      return;
    }
    if (_multi) {
      // Multi-select: a checkbox per selectable reference, no action buttons.
      _multiRowTokens = [];
      listEl.innerHTML = filtered.map(d => {
        const roomStr = d.room ? `<span style="color:#888;font-size:0.72rem;margin-left:6px;">(${d.room})</span>` : '';
        const typeStr = `<span style="color:#6c4f9f;font-size:0.7rem;margin-left:6px;">[${d.device_type || 'device'}]</span>`;
        return _multiTokensFor(d).map(o => {
          const idx = _multiRowTokens.length;
          _multiRowTokens.push(o.token);
          const checked = _selectedTokens.has(o.token) ? 'checked' : '';
          const sub = o.label ? `<span style="color:#666;font-size:0.74rem;"> — ${o.label}</span>` : '';
          return `<label style="display:flex;align-items:center;gap:7px;padding:5px 10px;cursor:pointer;border-bottom:1px solid #f0ece3;">
            <input type="checkbox" data-dp-idx="${idx}" ${checked} style="cursor:pointer;">
            <span><strong>${d.name || '(unnamed)'}</strong>${sub}${typeStr}${roomStr}</span>
          </label>`;
        }).join('');
      }).join('');
      listEl.querySelectorAll('[data-dp-idx]').forEach(cb => {
        cb.addEventListener('change', () => {
          const tok = _multiRowTokens[parseInt(cb.getAttribute('data-dp-idx'), 10)];
          if (!tok) return;
          if (cb.checked) _selectedTokens.add(tok); else _selectedTokens.delete(tok);
          _updateAddSelectedBtn();
        });
      });
      _updateAddSelectedBtn();
      return;
    }
    listEl.innerHTML = filtered.map(d => {
      const isDisplay = _isDisplayDevice(d);
      const isAlexa   = _isAlexaDevice(d);
      const channelPairs = _virtualChannelsFor(d);
      const hasChannels = !!(channelPairs && channelPairs.length);
      const actionable = !isDisplay && !isAlexa ? _actionableChannelsFor(d) : [];
      const hasActionable = actionable.length > 0;
      const roomStr = d.room ? `<span style="color:#888;font-size:0.72rem;margin-left:6px;">(${d.room})</span>` : '';
      const typeStr = `<span style="color:#6c4f9f;font-size:0.7rem;margin-left:6px;">[${d.device_type || 'device'}]</span>`;

      let extrasHtml = '';
      if (isDisplay) {
        // on/off + push <preset> sub-buttons. Tokens: '@Name on'/'@Name off' or '@Name push <preset>'.
        const presets = _displayPresetsFor(d);
        const onBtn  = `<button data-dp-action="on"  data-dp-name="${(d.name||'').replace(/"/g,'&quot;')}"
                          style="padding:2px 8px;margin:2px;border:1px solid #3a7d44;color:#3a7d44;background:#fff;border-radius:3px;cursor:pointer;font-size:0.72rem;font-weight:600;">on</button>`;
        const offBtn = `<button data-dp-action="off" data-dp-name="${(d.name||'').replace(/"/g,'&quot;')}"
                          style="padding:2px 8px;margin:2px;border:1px solid #c0392b;color:#c0392b;background:#fff;border-radius:3px;cursor:pointer;font-size:0.72rem;font-weight:600;">off</button>`;
        const pushBtns = presets.map(p =>
          `<button data-dp-action="push" data-dp-preset="${(p||'').replace(/"/g,'&quot;')}" data-dp-name="${(d.name||'').replace(/"/g,'&quot;')}"
                   style="padding:2px 8px;margin:2px;border:1px solid #d0cbc4;background:#fafaf7;border-radius:3px;cursor:pointer;font-size:0.72rem;">push ${p}</button>`
        ).join('');
        const emptyHint = !presets.length
          ? `<span style="color:#999;font-size:0.7rem;margin-left:4px;">no saved ${d.protocol === 'awtrix' ? 'apps' : 'presets'} yet</span>`
          : '';
        extrasHtml = `<div style="padding:2px 8px 6px 24px;">${onBtn}${offBtn}${pushBtns}${emptyHint}</div>`;
      } else if (isAlexa) {
        // Alexa: on/off + say + transport (stop / pause / resume / next / prev / vol)
        // + announce <SavedTemplate>. Tokens follow _display_chips.py grammar.
        const safeName = (d.name || '').replace(/"/g, '&quot;');
        const onBtn  = `<button data-dp-action="alexa-on"  data-dp-name="${safeName}"
                          style="padding:2px 8px;margin:2px;border:1px solid #3a7d44;color:#3a7d44;background:#fff;border-radius:3px;cursor:pointer;font-size:0.72rem;font-weight:600;">on</button>`;
        const offBtn = `<button data-dp-action="alexa-off" data-dp-name="${safeName}"
                          style="padding:2px 8px;margin:2px;border:1px solid #c0392b;color:#c0392b;background:#fff;border-radius:3px;cursor:pointer;font-size:0.72rem;font-weight:600;">off</button>`;
        // Transport bare-word buttons.
        const xpStyle = "padding:2px 8px;margin:2px;border:1px solid #d0cbc4;background:#fafaf7;border-radius:3px;cursor:pointer;font-size:0.72rem;";
        const xpBtns = ['stop','pause','resume','next','prev'].map(verb =>
          `<button data-dp-action="alexa-${verb}" data-dp-name="${safeName}" style="${xpStyle}">${verb}</button>`
        ).join('');
        const volBtn = `<button data-dp-action="alexa-vol" data-dp-name="${safeName}" style="${xpStyle}">vol…</button>`;
        // Speak — one button per saved announcement template. Click =
        // direct insert, no extra step. Replaces the older free-form
        // `say` input + per-template `announce X` button row 2026-05-07
        // per user request: "change say to speak saved and can choose
        // which saved". Free-form say chip is still recognized by the
        // parser for back-compat with existing rules.
        const speakBtns = (_alexaAnns || []).map(t =>
          `<button data-dp-action="alexa-speak" data-dp-name="${safeName}"
                   data-dp-template="${(t.name||'').replace(/"/g,'&quot;')}"
                   style="padding:2px 8px;margin:2px;border:1px solid #6c4f9f;color:#6c4f9f;background:#fff;border-radius:3px;cursor:pointer;font-size:0.72rem;">speak ${(t.name||'')}</button>`
        ).join('');
        const speakRow = !(_alexaAnns || []).length
          ? `<span style="color:#999;font-size:0.7rem;">No saved announcements yet — add one on the Media Agents page.</span>`
          : speakBtns;
        extrasHtml = `<div style="padding:2px 8px 6px 24px;">
          ${onBtn}${offBtn}<br>
          ${xpBtns}${volBtn}<br>
          ${speakRow}
        </div>`;
      } else if (hasChannels) {
        const channels = channelPairs.map(([key, label]) =>
          `<button data-dp-pick="device:${encodeURIComponent(d.id)}" data-dp-name="${(d.name||'').replace(/"/g,'&quot;')}" data-dp-channel="${key}" data-dp-label="${(label||'').replace(/"/g,'&quot;')}"
                   style="padding:2px 8px;margin:2px;border:1px solid #d0cbc4;background:#fafaf7;border-radius:3px;cursor:pointer;font-size:0.72rem;">${key}: ${label || '(unnamed)'}</button>`
        ).join('');
        extrasHtml = `<div style="padding:2px 8px 6px 24px;">${channels}</div>`;
      } else if (hasActionable) {
        // One on/off button pair per actionable channel. Button label always
        // carries the channel's friendly name so e.g. "AUTO Cycle: on" makes
        // it obvious which mode is being toggled (vs. a bare "on" that the
        // user might confuse with manual). Token suffix is only added when
        // the device exposes multiple actionable channels — single-channel
        // devices keep the short "@Name on" form and let the engine resolve
        // via the dps_config fallback.
        //
        // Page-select channels (type='page_select' in dps_config) are
        // special — the action isn't on/off but "go to page N". Render
        // a number dropdown (min..max) per such channel; selecting a
        // number inserts a token like "@Balcony Panel Display Page 5".
        const cfg = d.dps_config || {};
        const single = actionable.length === 1;
        const buttons = actionable.flatMap(([key, label]) => {
          const ch = cfg[key] || {};
          if (ch.type === 'page_select') {
            const lo = Number(ch.min || 1);
            const hi = Number(ch.max || 12);
            const opts = [];
            for (let n = lo; n <= hi; n++) {
              opts.push(`<option value="${n}">Page ${n}</option>`);
            }
            const lblPrefix = `${label || key}: `;
            return [
              `<span style="display:inline-flex;align-items:center;gap:4px;margin:2px;">
                 <span style="font-size:0.72rem;color:#555;">${lblPrefix}</span>
                 <select data-dp-action="page-select" data-dp-name="${(d.name||'').replace(/"/g,'&quot;')}" data-dp-channel-label="${(label||key).replace(/"/g,'&quot;')}"
                         style="padding:2px 6px;border:1px solid #6c4f9f;border-radius:3px;font-size:0.72rem;cursor:pointer;background:#fff;color:#6c4f9f;">
                   <option value="">— pick page —</option>${opts.join('')}
                 </select>
               </span>`
            ];
          }
          const suffix = single ? '' : ` ${key}`;
          const lblPrefix = `${label || key}: `;
          // Render [on] only when action_on is declared, [off] only when
          // action_off is declared. Channels that lack one direction (e.g.
          // RemoteXY door_open — open is a real pulse, "close" has no
          // hardware counterpart) get a single button instead of both.
          return [
            ch.action_on ? `<button data-dp-action="esp-on"  data-dp-name="${(d.name||'').replace(/"/g,'&quot;')}" data-dp-channel="${key}" data-dp-suffix="${suffix.replace(/"/g,'&quot;')}"
                     style="padding:2px 8px;margin:2px;border:1px solid #3a7d44;color:#3a7d44;background:#fff;border-radius:3px;cursor:pointer;font-size:0.72rem;font-weight:600;">${lblPrefix}on</button>` : '',
            ch.action_off ? `<button data-dp-action="esp-off" data-dp-name="${(d.name||'').replace(/"/g,'&quot;')}" data-dp-channel="${key}" data-dp-suffix="${suffix.replace(/"/g,'&quot;')}"
                     style="padding:2px 8px;margin:2px;border:1px solid #c0392b;color:#c0392b;background:#fff;border-radius:3px;cursor:pointer;font-size:0.72rem;font-weight:600;">${lblPrefix}off</button>` : '',
          ];
        }).join('');
        extrasHtml = `<div style="padding:2px 8px 6px 24px;">${buttons}</div>`;
      }

      const baseRow = isDisplay
        // For display devices, the bare-name click is removed — actions are mandatory.
        ? `<div style="padding:6px 10px;color:#666;"><strong>${d.name || '(unnamed)'}</strong>${typeStr}${roomStr}</div>`
        : `<div data-dp-pick="device:${encodeURIComponent(d.id)}" data-dp-name="${(d.name||'').replace(/"/g,'&quot;')}"
                 style="padding:6px 10px;cursor:pointer;" title="Click to insert reference without specific channel">
             <strong>${d.name || '(unnamed)'}</strong>${typeStr}${roomStr}
           </div>`;

      return `<div style="border-bottom:1px solid #e8e3d8;">${baseRow}${extrasHtml}</div>`;
    }).join('');

    // Channel/bare-name picks (legacy + multi-gang switches)
    listEl.querySelectorAll('[data-dp-pick]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = el.dataset.dpName || '';
        const channel = el.dataset.dpChannel;
        const label = (el.dataset.dpLabel || '').trim();
        let token;
        if (!channel) {
          token = `@${name}`;
        } else {
          token = `@${name} ${(label && label !== '(unnamed)') ? label : `Ch${channel}`}`;
        }
        if (_onPick) _onPick(token);
        window._dpClose();
      });
    });

    // Display action picks (on / off / push <preset>) AND ESP-style on/off
    // (with optional channel suffix when the device has multiple actionable
    // channels — e.g. "@My Bathroom Smell auto_enabled on").
    listEl.querySelectorAll('[data-dp-action]').forEach(el => {
      // page-select uses a <select> + change event — everything else is
      // a <button> + click. Wire both to a single action router.
      const evt = el.tagName === 'SELECT' ? 'change' : 'click';
      el.addEventListener(evt, (e) => {
        e.stopPropagation();
        const name = el.dataset.dpName || '';
        const action = el.dataset.dpAction;
        let token;
        if (action === 'on' || action === 'off')        token = `@${name} ${action}`;
        else if (action === 'push')                     token = `@${name} push ${el.dataset.dpPreset || ''}`.trim();
        else if (action === 'alexa-on')                 token = `@${name} on`;
        else if (action === 'alexa-off')                token = `@${name} off`;
        else if (action === 'alexa-stop')               token = `@${name} stop`;
        else if (action === 'alexa-pause')              token = `@${name} pause`;
        else if (action === 'alexa-resume')             token = `@${name} resume`;
        else if (action === 'alexa-next')               token = `@${name} next`;
        else if (action === 'alexa-prev')               token = `@${name} prev`;
        else if (action === 'alexa-vol') {
          const raw = prompt('Volume 0-100:', '50');
          if (raw == null) return;
          const n = parseInt(String(raw).trim(), 10);
          if (isNaN(n) || n < 0 || n > 100) { alert('Volume must be 0-100'); return; }
          token = `@${name} vol ${n}`;
        }
        else if (action === 'alexa-speak') {
          const tname = el.dataset.dpTemplate || '';
          if (!tname) return;
          token = `@${name} speak ${tname}`;
        }
        else if (action === 'esp-on' || action === 'esp-off') {
          const suffix = el.dataset.dpSuffix || '';   // ' <channel>' or ''
          const verb   = action === 'esp-on' ? 'on' : 'off';
          token = `@${name}${suffix} ${verb}`;
        }
        else if (action === 'page-select') {
          const n = parseInt(el.value, 10);
          if (isNaN(n) || n < 1) return;              // placeholder option, ignore
          // Token format: "@<Name> Page <N>". The receiving rule (or
          // shared parser when one is added) recognizes 'Page <int>'
          // as a goto-page command and dispatches via the rule engine
          // HASP branch's existing goto_page alias path.
          token = `@${name} Page ${n}`;
        }
        if (token && _onPick) _onPick(token);
        window._dpClose();
      });
    });
  }

  window._dpClose = function () {
    if (_modal) _modal.style.display = 'none';
    _onPick = null;
    _multi = false;
    _selectedTokens = new Set();
    const addBtn = document.getElementById('dp-add-selected');
    if (addBtn) addBtn.style.display = 'none';
  };

  // Multi-select helpers (scenes batch-add).
  // Selectable references for a device in multi mode: per-channel for multi-gang
  // switches / multi-actionable boards, else the bare device. No action is set
  // here — the scene chip's on/off toggle sets it afterwards.
  function _multiTokensFor(d) {
    const channelPairs = _virtualChannelsFor(d);
    if (channelPairs && channelPairs.length) {
      return channelPairs.map(([key, label]) => ({
        token: `@${d.name} ${(label && label !== '(unnamed)') ? label : `Ch${key}`}`,
        label: `${key}: ${label || '(unnamed)'}`,
      }));
    }
    const act = (!_isDisplayDevice(d) && !_isAlexaDevice(d)) ? _actionableChannelsFor(d) : [];
    if (act.length > 1) {
      return act.map(([key, label]) => ({ token: `@${d.name} ${label || key}`, label: `${label || key}` }));
    }
    return [{ token: `@${d.name}`, label: '' }];
  }
  function _updateAddSelectedBtn() {
    const btn = document.getElementById('dp-add-selected');
    if (btn) btn.textContent = `Add selected (${_selectedTokens.size})`;
  }
  window._dpAddSelected = function () {
    const tokens = Array.from(_selectedTokens);
    const cb = _onPick;
    window._dpClose();          // clears _onPick + multi state
    if (cb) cb(tokens);
  };

  // Shared helpers for migrating legacy "@Name:dpsKey" tokens to "@Name Label"
  window._dpFetchDevices = async function () {
    if (window._dpDevicesMap && (Date.now() - (window._dpDevicesLoadedAt || 0) < 30000)) {
      return window._dpDevicesMap;
    }
    try {
      const r = await fetch('/api/devices');
      const arr = await r.json();
      const map = new Map();
      for (const d of arr) {
        if (d && d.name) {
          map.set(d.name, d);
          map.set(d.name.toLowerCase(), d);
        }
      }
      window._dpDevicesMap = map;
      window._dpDevicesLoadedAt = Date.now();
      return map;
    } catch (e) {
      return new Map();
    }
  };

  window._dpMigrateToken = function (token, devMap) {
    if (typeof token !== 'string' || !token.startsWith('@')) return token;
    const colon = token.lastIndexOf(':');
    if (colon < 0) return token;
    const name = token.slice(1, colon).trim();
    const key  = token.slice(colon + 1).trim();
    if (!name || !key) return token;
    const dev = devMap.get(name) || devMap.get(name.toLowerCase());
    if (!dev || !dev.dps_labels) return token;
    const label = (dev.dps_labels[key] || '').trim();
    if (!label || label === '(unnamed)') return token;
    return `@${name} ${label}`;
  };

  // Public API — call from sentence rows.
  //   openDevicePicker(callback)
  // callback receives a string token like "@Main Switch Ch1" or "@Pixoo Daily_Welcome".
  window.openDevicePicker = async function (callback, opts) {
    _ensureModal();
    _onPick = callback;
    _multi = !!(opts && opts.multi);
    _selectedTokens = new Set();
    _selectedType = '__all__';
    document.getElementById('dp-search').value = '';
    const hintEl = document.getElementById('dp-hint');
    if (hintEl) hintEl.textContent = _multi
      ? 'Check devices, then "Add selected". Set on/off on each chip afterwards.'
      : 'Click a device (or a channel) to insert its reference.';
    const addBtn = document.getElementById('dp-add-selected');
    if (addBtn) { addBtn.style.display = _multi ? 'inline-block' : 'none'; addBtn.textContent = 'Add selected (0)'; }
    _modal.style.display = 'flex';
    // Load devices + pixoo presets in parallel (cache for 30s)
    const fresh = !_devices.length || (Date.now() - (_devices._loadedAt || 0)) > 30000;
    if (fresh) {
      try {
        const [devRes, presRes, awRes, alexaAnnRes] = await Promise.all([
          fetch('/api/devices').then(r => r.json()),
          fetch('/api/pixoo/presets').then(r => r.json()).catch(() => []),
          fetch('/api/dashboard-settings/awtrix.messages').then(r => r.json()).catch(() => ({ value: [] })),
          fetch('/api/dashboard-settings/media-agents.alexa_announcements').then(r => r.json()).catch(() => ({ value: [] })),
        ]);
        _devices = Array.isArray(devRes) ? devRes : [];
        _devices._loadedAt = Date.now();
        _pixooPresets = Array.isArray(presRes) ? presRes : [];
        const awVal = awRes && awRes.value;
        _awtrixApps = Array.isArray(awVal) ? awVal : [];
        const annVal = alexaAnnRes && alexaAnnRes.value;
        _alexaAnns = Array.isArray(annVal) ? annVal : [];
      } catch (e) {
        _devices = [];
        _pixooPresets = [];
        _awtrixApps = [];
        _alexaAnns = [];
      }
    }
    _renderTypeFilter();
    _renderList();
    setTimeout(() => document.getElementById('dp-search')?.focus(), 50);
  };
})();
