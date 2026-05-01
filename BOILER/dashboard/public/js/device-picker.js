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
  let _modal = null;
  let _onPick = null;

  const MULTI_CHANNEL_TYPES = new Set(['switch', 'circuit_breaker']);

  // True if the device should expose display-style action sub-buttons
  // (on / off / push <preset>) — Awtrix + Pixoo today, future ambient
  // displays automatically by setting device_type='display'.
  function _isDisplayDevice(d) {
    return d.device_type === 'display' || d.protocol === 'pixoo' || d.protocol === 'awtrix';
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
    if (MULTI_CHANNEL_TYPES.has(d.device_type) && d.dps_labels && Object.keys(d.dps_labels).length > 0) {
      return Object.entries(d.dps_labels);
    }
    return null;
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
        <div style="margin-top:6px;font-size:0.72rem;color:#888;">Click a device (or a channel) to insert its reference.</div>
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
      return;
    }
    listEl.innerHTML = filtered.map(d => {
      const isDisplay = _isDisplayDevice(d);
      const channelPairs = _virtualChannelsFor(d);
      const hasChannels = !!(channelPairs && channelPairs.length);
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
      } else if (hasChannels) {
        const channels = channelPairs.map(([key, label]) =>
          `<button data-dp-pick="device:${encodeURIComponent(d.id)}" data-dp-name="${(d.name||'').replace(/"/g,'&quot;')}" data-dp-channel="${key}" data-dp-label="${(label||'').replace(/"/g,'&quot;')}"
                   style="padding:2px 8px;margin:2px;border:1px solid #d0cbc4;background:#fafaf7;border-radius:3px;cursor:pointer;font-size:0.72rem;">${key}: ${label || '(unnamed)'}</button>`
        ).join('');
        extrasHtml = `<div style="padding:2px 8px 6px 24px;">${channels}</div>`;
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

    // Display action picks (on / off / push <preset>)
    listEl.querySelectorAll('[data-dp-action]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = el.dataset.dpName || '';
        const action = el.dataset.dpAction;
        let token;
        if (action === 'on' || action === 'off') token = `@${name} ${action}`;
        else if (action === 'push')               token = `@${name} push ${el.dataset.dpPreset || ''}`.trim();
        if (token && _onPick) _onPick(token);
        window._dpClose();
      });
    });
  }

  window._dpClose = function () {
    if (_modal) _modal.style.display = 'none';
    _onPick = null;
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
  window.openDevicePicker = async function (callback) {
    _ensureModal();
    _onPick = callback;
    _selectedType = '__all__';
    document.getElementById('dp-search').value = '';
    _modal.style.display = 'flex';
    // Load devices + pixoo presets in parallel (cache for 30s)
    const fresh = !_devices.length || (Date.now() - (_devices._loadedAt || 0)) > 30000;
    if (fresh) {
      try {
        const [devRes, presRes, awRes] = await Promise.all([
          fetch('/api/devices').then(r => r.json()),
          fetch('/api/pixoo/presets').then(r => r.json()).catch(() => []),
          fetch('/api/dashboard-settings/awtrix.messages').then(r => r.json()).catch(() => ({ value: [] })),
        ]);
        _devices = Array.isArray(devRes) ? devRes : [];
        _devices._loadedAt = Date.now();
        _pixooPresets = Array.isArray(presRes) ? presRes : [];
        const awVal = awRes && awRes.value;
        _awtrixApps = Array.isArray(awVal) ? awVal : [];
      } catch (e) {
        _devices = [];
        _pixooPresets = [];
        _awtrixApps = [];
      }
    }
    _renderTypeFilter();
    _renderList();
    setTimeout(() => document.getElementById('dp-search')?.focus(), 50);
  };
})();
