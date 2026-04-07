'use strict';

let allDevices = [];
let allRoomsList = [];   // authoritative list from rooms table
let settingsRendered = false;
const REFRESH_MS = 5000;

// ─── Stale threshold (minutes) — persisted in localStorage ───────────────────
let staleThresholdMin = parseInt(localStorage.getItem('staleThresholdMin') || '30', 10);

function saveStaleThreshold(val) {
  staleThresholdMin = Math.max(1, parseInt(val, 10) || 30);
  localStorage.setItem('staleThresholdMin', staleThresholdMin);
  document.getElementById('stale-threshold-input').value = staleThresholdMin;
  document.getElementById('stale-threshold-lbl').textContent = staleThresholdMin;
  updateStats();
}

function filterStale() {
  const count = parseInt(document.getElementById('stat-stale').textContent, 10);
  if (!count) return;
  showTab('all', document.querySelector('.tab-btn:nth-child(2)'));
  document.getElementById('filter-online').checked = false;
  // Trigger re-render then scroll to table
  applyFilters();
  document.getElementById('tab-all').scrollIntoView({ behavior: 'smooth' });
}

// ─── Status decoding ──────────────────────────────────────────────────────────

function decodeStatus(dev) {
  const dps = dev.last_state;
  const type = dev.device_type;

  if (!dps) return { label: 'unknown', cls: 'dot-unknown', text: '—' };

  if (type === 'presence') {
    const v = dps['1'];
    if (v === 'none' || v === false || v === 0) return { label: 'clear',   cls: 'dot-clear',   text: 'Clear' };
    if (v !== undefined)                        return { label: 'present', cls: 'dot-present', text: 'Present' };
    return { label: 'unknown', cls: 'dot-unknown', text: '—' };
  }

  if (type === 'siren') {
    const alarm = dps['13'];
    const batt  = dps['15'];
    if (alarm === true)  return { label: 'on',  cls: 'dot-on',  text: 'ALARM!' };
    if (alarm === false) return { label: 'off', cls: 'dot-off', text: batt !== undefined ? `Idle ${batt}%` : 'Idle' };
    return { label: 'unknown', cls: 'dot-unknown', text: '—' };
  }

  if (type === 'wireless_switch') {
    const batt = dps['10'];
    return { label: 'on', cls: 'dot-on', text: batt !== undefined ? `Ready ${batt}%` : 'Ready' };
  }

  if (['switch','circuit_breaker','water_heater','light','valve'].includes(type)) {
    const chanKeys = getChannelKeys(dev);
    if (chanKeys.length > 1) {
      const onCount = chanKeys.filter(k => dps[k] === true || dps[k] === 1).length;
      const cls = onCount > 0 ? 'dot-on' : 'dot-off';
      const label = onCount > 0 ? 'on' : 'off';
      return { label, cls, text: `${onCount}/${chanKeys.length} ON` };
    }
    // Single channel
    const v = dps['1'] ?? dps['20'];
    if (v === true  || v === 1 || v === 'on')  return { label: 'on',  cls: 'dot-on',  text: 'ON' };
    if (v === false || v === 0 || v === 'off') return { label: 'off', cls: 'dot-off', text: 'OFF' };
    // Scene switches (DPS 1 = "scene") — trigger only, no on/off state
    if (typeof v === 'string') return { label: 'on', cls: 'dot-on', text: 'Ready' };
    return { label: 'unknown', cls: 'dot-unknown', text: '—' };
  }

  if (type === 'curtain') {
    const v = dps['1'];
    if (v === 'open')  return { label: 'on',  cls: 'dot-on',  text: 'Open' };
    if (v === 'close') return { label: 'off', cls: 'dot-off', text: 'Closed' };
    if (v === 'stop')  return { label: 'on',  cls: 'dot-on',  text: 'Stopped' };
    return { label: 'unknown', cls: 'dot-unknown', text: '—' };
  }

  if (type === 'temp_controller') {
    const v = dps['3'] ?? dps['2'] ?? dps['1'];
    if (v !== undefined) return { label: 'on', cls: 'dot-on', text: (v / 10).toFixed(1) + '°C' };
  }

  // BSH Home Connect appliances
  if (['oven','dishwasher','hood','hob','washer'].includes(type)) {
    const op = dps['BSH.Common.Status.OperationState'] || '';
    const short = op.split('.').pop();
    if (short === 'Run')       return { label: 'on',  cls: 'dot-on',  text: 'Running' };
    if (short === 'Finished')  return { label: 'on',  cls: 'dot-on',  text: 'Finished' };
    if (short === 'DelayedStart') return { label: 'on', cls: 'dot-on', text: 'Delayed' };
    if (short === 'Pause')     return { label: 'on',  cls: 'dot-on',  text: 'Paused' };
    if (short === 'Aborting')  return { label: 'on',  cls: 'dot-on',  text: 'Aborting' };
    if (short === 'Ready')     return { label: 'off', cls: 'dot-off', text: 'Ready' };
    if (short === 'Inactive')  return { label: 'off', cls: 'dot-off', text: 'Inactive' };
    const door = dps['BSH.Common.Status.DoorState'] || '';
    const doorShort = door.split('.').pop();
    if (doorShort === 'Open')  return { label: 'on',  cls: 'dot-on',  text: 'Door Open' };
    if (op) return { label: 'off', cls: 'dot-off', text: short };
    return { label: 'unknown', cls: 'dot-unknown', text: '—' };
  }

  if (type === 'gateway') {
    return { label: 'on', cls: 'dot-on', text: 'Online' };
  }

  return { label: 'unknown', cls: 'dot-unknown', text: '—' };
}

// ─── DPS details (labeled attributes) ────────────────────────────────────────

function decodeDetails(dev) {
  const labels = dev.dps_labels;
  const dps    = dev.last_state;
  if (!labels || !dps) return '';
  return Object.entries(labels)
    .filter(([k]) => dps[k] !== undefined)
    .map(([k, lbl]) => {
      let val = dps[k];
      if (typeof val === 'number' && lbl.includes('x0.1')) {
        val = (val / 10).toFixed(1) + '°C';
      }
      // Strip the scale hint from the label for display
      const cleanLbl = lbl.replace(/\s*\(x[\d.]+\s*[^)]*\)/i, '').trim();
      return `<span class="dps-detail"><span class="dps-detail-lbl">${escHtml(cleanLbl)}</span> ${escHtml(String(val))}</span>`;
    }).join('');
}

// ─── Last seen formatting ─────────────────────────────────────────────────────

function lastSeenText(ts, stale) {
  if (!ts) return { text: 'never', cls: 'last-seen-none' };
  const sec = (Date.now() - new Date(ts)) / 1000;
  if (sec < 0) return { text: 'just now', cls: 'last-seen-ok' }; // clock drift
  let text;
  if (sec < 60)   text = Math.round(sec) + 's ago';
  else if (sec < 3600) text = Math.round(sec/60) + 'm ago';
  else if (sec < 86400) text = Math.round(sec/3600) + 'h ago';
  else text = Math.round(sec/86400) + 'd ago';
  if (stale) return { text: '⚠ ' + text, cls: 'last-seen-stale' };
  if (sec < 60)   return { text, cls: 'last-seen-ok' };
  if (sec < 3600) return { text, cls: 'last-seen-warn' };
  return { text, cls: 'last-seen-old' };
}

function isOnline(dev) {
  if (!dev.last_seen) return false;
  const ageSec = (Date.now() - new Date(dev.last_seen)) / 1000;
  if (ageSec < 0) return true; // clock drift
  // Local devices only push on state change — an idle switch may not push for hours.
  // If it has valid last_state, consider it online (TCP push would detect disconnect).
  if (dev.protocol === 'local') return dev.last_state ? true : ageSec < 300;
  return ageSec < 180;  // gateway/cloud poll every 60s
}

// ─── Source badge ─────────────────────────────────────────────────────────────

function updateBadge(src) {
  const map = {
    tcp_push:     { label: 'TCP Push',      color: '#27ae60' },
    local_poll:   { label: 'Local Poll',    color: '#b7770d' },
    cloud_poll:   { label: 'Cloud Poll',    color: '#d35400' },
    cloud_push:   { label: 'Pulsar',        color: '#27ae60' },
    gateway_push: { label: 'Gateway Push',  color: '#8e44ad' },
    gateway_init: { label: 'Initial',       color: '#999' },
    initial:      { label: 'Initial',       color: '#999' },
    ha_api:       { label: 'HA API',        color: '#2980b9' },
    home_connect: { label: 'Home Connect',  color: '#1a5276' },
    mqtt:         { label: 'MQTT',          color: '#16a085' },
  };
  const m = map[src] || { label: src || '—', color: '#999' };
  return `<span style="font-size:0.72rem;color:${m.color};font-weight:500">${m.label}</span>`;
}

// ─── Protocol badge ───────────────────────────────────────────────────────────

function protoBadge(proto) {
  return `<span class="proto-badge proto-${proto}">${proto}</span>`;
}

// ─── Load & render ────────────────────────────────────────────────────────────


async function loadAll() {
  try {
    const [devRes, roomRes] = await Promise.all([
      fetch('/api/devices'),
      fetch('/api/rooms'),
    ]);
    if (!devRes.ok) throw new Error(devRes.status);
    allDevices  = await devRes.json();
    allRoomsList = roomRes.ok ? (await roomRes.json()).map(r => r.room) : [];
    document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString();
    updateStats();
    populateRoomFilter();
    applyFilters();
    renderPresence();
    // Settings tab: only render on first load, not on auto-refresh
    if (!settingsRendered) { applySettingsFilters(); settingsRendered = true; }
  } catch (e) {
    console.error('loadAll error:', e);
  }
}

function isStale(dev) {
  if (!dev.last_seen) return true;
  return (Date.now() - new Date(dev.last_seen)) / 1000 > staleThresholdMin * 60;
}

function updateStats() {
  const counted   = allDevices.filter(d => d.device_type !== 'scene' && d.enabled !== false);
  const total     = counted.length;
  const online    = counted.filter(isOnline).length;
  const present   = counted.filter(d => d.device_type === 'presence' && decodeStatus(d).label === 'present').length;
  const switchOn  = counted.filter(d => d.device_type === 'switch' && decodeStatus(d).label === 'on').length;
  const local     = counted.filter(d => d.protocol === 'local').length;
  const gateway   = counted.filter(d => d.protocol === 'gateway').length;
  const cloud     = counted.filter(d => d.protocol === 'cloud').length;
  const stale     = counted.filter(isStale).length;

  document.getElementById('stat-total').textContent       = total;
  document.getElementById('stat-online').textContent      = online;
  document.getElementById('stat-present').textContent     = present;
  document.getElementById('stat-switches-on').textContent = switchOn;
  document.getElementById('stat-local-val').textContent   = local;
  document.getElementById('stat-gateway-val').textContent = gateway;
  document.getElementById('stat-cloud-val').textContent   = cloud;
  document.getElementById('stat-stale').textContent       = stale;
}

function populateRoomFilter() {
  const rooms = allRooms();
  const sel = document.getElementById('filter-room');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All rooms</option>' +
    rooms.map(r => `<option value="${r}">${r}</option>`).join('');
  sel.value = cur;

  // Update room datalist for settings editing
  const dl = document.getElementById('rooms-datalist');
  if (dl) dl.innerHTML = rooms.map(r => `<option value="${escHtml(r)}">`).join('');
}

// ─── All Devices tab ──────────────────────────────────────────────────────────

function applyFilters() {
  const search      = (document.getElementById('search-input').value || '').toLowerCase();
  const typeFilter  = document.getElementById('filter-type').value;
  const protoFilt   = document.getElementById('filter-proto').value;
  const updateFilt  = document.getElementById('filter-update').value;
  const roomFilt    = document.getElementById('filter-room').value;
  const onlineOnly  = document.getElementById('filter-online').checked;

  const filtered = allDevices.filter(d => {
    if (d.enabled === false) return false;
    if (d.show_dashboard === false) return false;
    if (search     && !d.name.toLowerCase().includes(search)) return false;
    if (typeFilter && d.device_type !== typeFilter)           return false;
    if (protoFilt  && d.protocol    !== protoFilt)            return false;
    if (updateFilt && d.last_source !== updateFilt)           return false;
    if (roomFilt) {
      const inDevRoom  = d.room === roomFilt;
      const inChanRoom = d.channel_config && Object.values(d.channel_config).some(ch => ch.room === roomFilt);
      const inDpsRoom  = d.dps_config && Object.values(d.dps_config).some(a => a.room === roomFilt);
      if (!inDevRoom && !inChanRoom && !inDpsRoom) return false;
    }
    if (onlineOnly && !isOnline(d)) return false;
    return true;
  });

  const tbody = document.getElementById('devices-tbody');
  const rows = [];
  let totalRows = 0;

  for (const d of filtered) {
    const chanKeys  = getChannelKeys(d);
    const cfg       = d.channel_config || {};
    const dpsCfg    = d.dps_config || {};
    const dpsLabels = d.dps_labels || {};
    const ls        = lastSeenText(d.last_seen, isStale(d));
    const hasDpsAttrs = d.last_state && Object.keys(dpsLabels).length > 0;

    if (chanKeys.length > 1) {
      // Multi-channel switch → one row per channel
      const visibleChans = chanKeys.filter(k => {
        if (cfg[k]?.enabled === false) return false;
        if (cfg[k]?.show_dashboard === false) return false;
        if (!roomFilt) return true;
        return (cfg[k]?.room || d.room || '') === roomFilt;
      });
      for (const k of visibleChans) {
        const isOn  = d.last_state[k] === true || d.last_state[k] === 1;
        const dot   = isOn ? 'dot-on' : 'dot-off';
        const txt   = isOn ? 'ON' : 'OFF';
        const name  = cfg[k]?.name ? `${escHtml(d.name)} — ${escHtml(cfg[k].name)}` : `${escHtml(d.name)} Ch.${k}`;
        const room  = cfg[k]?.room || d.room || '—';
        rows.push(`<tr>
          <td><span class="status-dot ${dot}"></span>${txt}</td>
          <td>${name}</td>
          <td>${escHtml(room)}</td>
          <td><span class="type-badge">${d.device_type} ch.${k}</span></td>
          <td>${protoBadge(d.protocol)}</td>
          <td>${updateBadge(d.last_source)}</td>
          <td class="${ls.cls}">${ls.text}</td>
          <td style="font-size:0.75rem;color:var(--muted)">${d.mac ? (d.local_ip || '—') : '—'}</td>
        </tr>`);
        totalRows++;
      }

    } else if (hasDpsAttrs) {
      // Device with labeled DPS attributes → one row per labeled attribute
      const labelKeys = Object.keys(dpsLabels).sort((a, b) => Number(a) - Number(b));
      const visibleAttrs = labelKeys.filter(k => {
        const ac = dpsCfg[k] || {};
        if (ac.enabled === false) return false;
        if (ac.show_dashboard === false) return false;
        if (roomFilt && (ac.room || d.room || '') !== roomFilt) return false;
        return true;
      });
      for (const k of visibleAttrs) {
        if (d.last_state[k] === undefined) continue;
        const raw   = d.last_state[k];
        const lbl   = dpsLabels[k];
        const attrName = dpsCfg[k]?.name || lbl.replace(/\s*\(x[\d.]+[^)]*\)/i, '').trim();
        const attrRoom = dpsCfg[k]?.room || d.room || '—';
        // Decode value
        let dot = '', statusTxt = '';
        if (typeof raw === 'boolean' || raw === 0 || raw === 1) {
          const on = raw === true || raw === 1;
          dot = on ? 'dot-on' : 'dot-off'; statusTxt = on ? 'ON' : 'OFF';
        } else if (typeof raw === 'number' && lbl.includes('x0.1')) {
          dot = 'dot-on'; statusTxt = (raw / 10).toFixed(1) + '°C';
        } else {
          dot = 'dot-on';
          statusTxt = String(raw);
          // Shorten BSH enum values
          if (typeof raw === 'string' && raw.includes('.')) statusTxt = raw.split('.').pop();
        }
        rows.push(`<tr>
          <td><span class="status-dot ${dot}"></span>${escHtml(statusTxt)}</td>
          <td>${escHtml(d.name)} — ${escHtml(attrName)}</td>
          <td>${escHtml(attrRoom)}</td>
          <td><span class="type-badge">${d.device_type}</span></td>
          <td>${protoBadge(d.protocol)}</td>
          <td>${updateBadge(d.last_source)}</td>
          <td class="${ls.cls}">${ls.text}</td>
          <td style="font-size:0.75rem;color:var(--muted)">${d.mac ? (d.local_ip || '—') : '—'}</td>
        </tr>`);
        totalRows++;
      }

    } else {
      // Normal single row
      const st = decodeStatus(d);
      rows.push(`<tr>
        <td><span class="status-dot ${st.cls}"></span>${st.text}</td>
        <td>${escHtml(d.name)}</td>
        <td>${escHtml(d.room || '—')}</td>
        <td><span class="type-badge">${d.device_type || '?'}</span></td>
        <td>${protoBadge(d.protocol)}</td>
        <td>${updateBadge(d.last_source)}</td>
        <td class="${ls.cls}">${ls.text}</td>
        <td style="font-size:0.75rem;color:var(--muted)">${d.mac ? (d.local_ip || '—') : '—'}</td>
      </tr>`);
      totalRows++;
    }
  }

  tbody.innerHTML = rows.join('') || '<tr><td colspan="8" style="color:var(--muted)">No devices match filter</td></tr>';

  document.getElementById('devices-count').textContent =
    `Showing ${filtered.length} devices (${totalRows} rows)`;
}

// ─── Presence tab ─────────────────────────────────────────────────────────────

function renderPresence() {
  const sensors = allDevices.filter(d => d.device_type === 'presence');
  const grid = document.getElementById('presence-grid');

  if (!sensors.length) {
    grid.innerHTML = '<div style="color:var(--muted)">No presence sensors found.</div>';
    return;
  }

  grid.innerHTML = sensors.map(d => {
    const st  = decodeStatus(d);
    const ls  = lastSeenText(d.last_seen);
    const online = isOnline(d);
    return `<div class="presence-card ${st.label === 'present' ? 'present' : (online ? '' : 'unknown')}">
      <div class="presence-room">${escHtml(d.room || 'No room')}</div>
      <div class="presence-name">${escHtml(d.name)}</div>
      <div class="presence-state ${st.label}">
        <span class="status-dot ${st.cls}"></span>${st.text}
      </div>
      <div class="presence-age">${protoBadge(d.protocol)} · ${ls.text}</div>
    </div>`;
  }).join('');
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

function getChannelKeys(dev) {
  if (!dev.last_state) return [];
  const bools = [], nums = [];
  for (let i = 1; i <= 8; i++) {
    const k = String(i);
    const v = dev.last_state[k];
    if (typeof v === 'boolean')  bools.push(k);
    else if (v === 0 || v === 1) nums.push(k);
  }
  // Include numeric 0/1 only if there are already 2+ booleans —
  // confirming this is a genuine multi-gang device, not a counter/setting.
  const keys = bools.length >= 2 ? [...bools, ...nums].sort((a,b) => +a - +b) : bools;
  return keys.length > 1 ? keys : [];
}

function allRooms() {
  // Start from authoritative rooms table
  const set = new Set(allRoomsList);
  // Also include any rooms on devices that aren't in the table yet
  for (const d of allDevices) {
    if (d.room) set.add(d.room);
    if (d.channel_config) {
      for (const ch of Object.values(d.channel_config)) {
        if (ch.room) set.add(ch.room);
      }
    }
  }
  return [...set].sort();
}

function applySettingsFilters() {
  const search = (document.getElementById('settings-search').value || '').toLowerCase();
  const type   = document.getElementById('settings-type').value;

  const filtered = allDevices.filter(d => {
    if (search && !d.name.toLowerCase().includes(search)) return false;
    if (type   && d.device_type !== type)                 return false;
    return true;
  });

  const tbody = document.getElementById('settings-tbody');
  const rows = [];

  for (const d of filtered) {
    const chanKeys = getChannelKeys(d);
    const cfg = d.channel_config || {};

    rows.push(`
    <tr data-id="${escHtml(d.id)}">
      <td class="editable-cell" data-field="name">${escHtml(d.name)}</td>
      <td class="editable-cell" data-field="room">${escHtml(d.room || '')}</td>
      <td><span class="type-badge">${d.device_type || '?'}</span></td>
      <td>${protoBadge(d.protocol)}</td>
      <td style="text-align:center">
        <label class="toggle"><input type="checkbox" data-id="${escHtml(d.id)}" data-field="enabled" ${d.enabled ? 'checked' : ''}>
          <span class="slider"></span></label>
      </td>
      <td style="text-align:center">
        <label class="toggle"><input type="checkbox" data-id="${escHtml(d.id)}" data-field="show_dashboard" ${d.show_dashboard ? 'checked' : ''}>
          <span class="slider"></span></label>
      </td>
      <td style="text-align:center">
        <label class="toggle"><input type="checkbox" data-id="${escHtml(d.id)}" data-field="poll_enabled" ${d.poll_enabled ? 'checked' : ''}>
          <span class="slider"></span></label>
      </td>
      <td class="editable-cell" data-field="notes">${escHtml(d.notes || '')}</td>
      <td style="text-align:center">
        <button class="btn-dps" onclick="toggleDpsPanel('${escAttr(d.id)}', this)">DPS</button>
      </td>
      <td style="text-align:center">
        <button onclick="deactivateDevice('${escAttr(d.id)}','${escAttr(d.name)}')" title="Remove from project"
          style="font-size:0.7rem;padding:2px 6px;border:1px solid #c0392b;color:#c0392b;background:transparent;border-radius:4px;cursor:pointer;">✕</button>
      </td>
    </tr>`);

    // Channel sub-rows for multi-gang switches
    for (const k of chanKeys) {
      const chCfg    = cfg[k] || {};
      const chName   = chCfg.name || '';
      const chRoom   = chCfg.room || '';
      const chEn     = chCfg.enabled !== false;
      const chDash   = chCfg.show_dashboard !== false;
      const isOn     = d.last_state && d.last_state[k] === true;
      rows.push(`
    <tr class="channel-sub-row" data-parent-id="${escHtml(d.id)}" data-channel="${k}">
      <td class="editable-cell chan-name" data-field="name" style="padding-left:28px;color:var(--muted)">
        <span class="chan-indicator ${isOn ? 'dot-on' : 'dot-off'}"></span>Ch.${k} ${escHtml(chName)}
      </td>
      <td class="editable-cell chan-room" data-field="room">${escHtml(chRoom)}</td>
      <td><span style="font-size:0.72rem;color:var(--muted)">ch.${k}</span></td>
      <td></td>
      <td style="text-align:center">
        <label class="toggle"><input type="checkbox" class="chan-toggle" data-parent-id="${escHtml(d.id)}" data-channel="${k}" data-field="enabled" ${chEn ? 'checked' : ''}>
          <span class="slider"></span></label>
      </td>
      <td style="text-align:center">
        <label class="toggle"><input type="checkbox" class="chan-toggle" data-parent-id="${escHtml(d.id)}" data-channel="${k}" data-field="show_dashboard" ${chDash ? 'checked' : ''}>
          <span class="slider"></span></label>
      </td>
      <td></td>
      <td></td>
      <td></td>
    </tr>`);
    }

    // DPS attribute sub-rows for devices with labeled DPS
    const dpsLabels = d.dps_labels || {};
    const dpsCfg    = d.dps_config || {};
    const dpsKeys   = Object.keys(dpsLabels).sort((a, b) => Number(a) - Number(b));
    for (const k of dpsKeys) {
      if (!d.last_state || d.last_state[k] === undefined) continue;
      const raw      = d.last_state[k];
      const lbl      = dpsLabels[k];
      const attrName = dpsCfg[k]?.name || lbl.replace(/\s*\(x[\d.]+[^)]*\)/i, '').trim();
      const attrRoom = dpsCfg[k]?.room || '';
      const enabled  = dpsCfg[k]?.enabled !== false;
      const showDash = dpsCfg[k]?.show_dashboard !== false;
      let valTxt = String(raw);
      if (typeof raw === 'number' && lbl.includes('x0.1')) valTxt = (raw / 10).toFixed(1) + '°C';
      // Shorten BSH enum values: BSH.Common.EnumType.DoorState.Closed → Closed
      if (typeof raw === 'string' && raw.includes('.')) valTxt = raw.split('.').pop();
      const dot = (raw === true || raw === 1) ? 'dot-on' : (raw === false || raw === 0) ? 'dot-off' : 'dot-on';
      rows.push(`
    <tr class="dps-attr-row" data-parent-id="${escHtml(d.id)}" data-dps="${k}">
      <td style="padding-left:28px;color:var(--muted);font-size:0.8rem;" title="${escHtml(k)}">
        <span class="chan-indicator ${dot}"></span>${escHtml(valTxt)}
      </td>
      <td class="editable-cell dps-attr-name" data-field="name">${escHtml(attrName)}</td>
      <td class="editable-cell dps-attr-room" data-field="room">${escHtml(attrRoom)}</td>
      <td><span style="font-size:0.72rem;color:var(--muted)" title="${escHtml(k)}">dps ${k.includes('.') ? escHtml(k.split('.').pop()) : k}</span></td>
      <td style="text-align:center">
        <label class="toggle"><input type="checkbox" class="dps-attr-toggle" data-parent-id="${escHtml(d.id)}" data-dps="${k}" data-field="enabled" ${enabled ? 'checked' : ''}>
          <span class="slider"></span></label>
      </td>
      <td style="text-align:center">
        <label class="toggle"><input type="checkbox" class="dps-attr-toggle" data-parent-id="${escHtml(d.id)}" data-dps="${k}" data-field="show_dashboard" ${showDash ? 'checked' : ''}>
          <span class="slider"></span></label>
      </td>
      <td></td>
      <td></td>
      <td colspan="1"></td>
    </tr>`);
    }
  }

  tbody.innerHTML = rows.join('') ||
    '<tr><td colspan="10" style="color:var(--muted)">No devices match</td></tr>';
}

// ─── Inline edit ──────────────────────────────────────────────────────────────

function makeEditInput(field, currentVal) {
  if (field === 'room') {
    const sel = document.createElement('select');
    sel.className = 'edit-select';
    sel.style.cssText = 'width:100%;background:#fff;border:1px solid #d0cbc4;border-radius:4px;color:#2e2e2e;padding:2px 4px;font-size:0.84rem;';
    const rooms = allRooms();
    sel.innerHTML = '<option value="">— no room —</option>' +
      rooms.map(r => `<option value="${escHtml(r)}" ${r === currentVal ? 'selected' : ''}>${escHtml(r)}</option>`).join('');
    if (currentVal && !rooms.includes(currentVal)) {
      sel.innerHTML += `<option value="${escHtml(currentVal)}" selected>${escHtml(currentVal)}</option>`;
    }
    return sel;
  }
  const input = document.createElement('input');
  input.type = 'text';
  input.style.cssText = 'width:100%;background:#fff;border:1px solid #d0cbc4;border-radius:4px;color:#2e2e2e;padding:2px 6px;font-size:0.84rem;';
  return input;
}

function editCell(td, field, id) {
  if (td.querySelector('input,select')) return;
  const original = td.textContent.trim();
  const el = makeEditInput(field, original);
  if (field !== 'room') el.value = original;
  td.textContent = '';
  td.appendChild(el);
  el.focus();
  if (field === 'room') {
    el.addEventListener('change', () => { saveCell(el, field, id, original, td); });
    el.addEventListener('blur',   () => { saveCell(el, field, id, original, td); });
  } else {
    el.addEventListener('blur', () => saveCell(el, field, id, original, td));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.blur();
      if (e.key === 'Escape') { el.value = original; el.blur(); }
    });
  }
}

async function saveCell(input, field, id, original, td) {
  const val = input.value.trim();
  td.textContent = val || original;
  if (val === original) return;
  await patchDevice(id, { [field]: val });
  const dev = allDevices.find(d => d.id === id);
  if (dev) dev[field] = val;
}

async function saveChanCell(input, field, id, channel, original, td) {
  const val = input.value.trim();
  if (field === 'name') {
    td.innerHTML = `<span class="chan-indicator ${td.querySelector('.chan-indicator')?.className.split(' ')[1] || 'dot-off'}"></span>Ch.${channel} ${escHtml(val || original)}`;
  } else {
    td.textContent = val || original;
  }
  if (val === original) return;
  const dev = allDevices.find(d => d.id === id);
  if (!dev) return;
  const cfg = JSON.parse(JSON.stringify(dev.channel_config || {}));
  cfg[channel] = cfg[channel] || {};
  cfg[channel][field] = val;
  await patchDevice(id, { channel_config: cfg });
  dev.channel_config = cfg;
}

function editChanCell(td, field, id, channel) {
  if (td.querySelector('input,select')) return;
  const dev = allDevices.find(d => d.id === id);
  let original;
  if (field === 'name') {
    original = (dev?.channel_config?.[channel]?.name) || '';
  } else {
    original = (dev?.channel_config?.[channel]?.room) || '';
  }
  const el = makeEditInput(field, original);
  if (field !== 'room') el.value = original;
  td.textContent = '';
  td.appendChild(el);
  el.focus();
  if (field === 'room') {
    el.addEventListener('change', () => saveChanCell(el, field, id, channel, original, td));
    el.addEventListener('blur',   () => saveChanCell(el, field, id, channel, original, td));
  } else {
    el.addEventListener('blur', () => saveChanCell(el, field, id, channel, original, td));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.blur();
      if (e.key === 'Escape') { el.value = original; el.blur(); }
    });
  }
}

async function saveDpsAttrCell(el, field, id, dpsKey, original, td) {
  const val = el.value.trim();
  td.textContent = val || original;
  if (val === original) return;
  const dev = allDevices.find(d => d.id === id);
  if (!dev) return;
  const cfg = JSON.parse(JSON.stringify(dev.dps_config || {}));
  cfg[dpsKey] = cfg[dpsKey] || {};
  cfg[dpsKey][field] = val;
  await patchDevice(id, { dps_config: cfg });
  dev.dps_config = cfg;
}

function editDpsAttrCell(td, field, id, dpsKey) {
  if (td.querySelector('input,select')) return;
  const dev = allDevices.find(d => d.id === id);
  const original = (dev?.dps_config?.[dpsKey]?.[field]) || '';
  const el = makeEditInput(field, original);
  if (field !== 'room') el.value = original;
  td.textContent = '';
  td.appendChild(el);
  el.focus();
  if (field === 'room') {
    el.addEventListener('change', () => saveDpsAttrCell(el, field, id, dpsKey, original, td));
    el.addEventListener('blur',   () => saveDpsAttrCell(el, field, id, dpsKey, original, td));
  } else {
    el.addEventListener('blur', () => saveDpsAttrCell(el, field, id, dpsKey, original, td));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') el.blur();
      if (e.key === 'Escape') { el.value = original; el.blur(); }
    });
  }
}

// ─── API patch ────────────────────────────────────────────────────────────────

async function patchDevice(id, body) {
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(r.status);
    // Update local data
    const dev = allDevices.find(d => d.id === id);
    if (dev) Object.assign(dev, body);
  } catch (e) {
    console.error('patchDevice error:', e);
  }
}

// ─── DPS Labels panel ─────────────────────────────────────────────────────────

function toggleDpsPanel(id, btn) {
  const row = btn.closest('tr');
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains('dps-panel-row')) {
    existing.remove();
    btn.textContent = 'DPS';
    return;
  }
  btn.textContent = '▾';
  const dev = allDevices.find(d => d.id === id);
  if (!dev || !dev.last_state) return;

  const labels = dev.dps_labels || {};
  const dpsKeys = Object.keys(dev.last_state).sort((a, b) => Number(a) - Number(b));

  const panelRow = document.createElement('tr');
  panelRow.className = 'dps-panel-row';
  panelRow.innerHTML = `<td colspan="9">
    <div class="dps-panel">
      <span class="dps-hdr">DPS</span>
      <span class="dps-hdr">Current Value</span>
      <span class="dps-hdr">Label</span>
      <span class="dps-hdr"></span>
      ${dpsKeys.map(k => {
        const raw = dev.last_state[k];
        const lbl = labels[k] || '';
        let display = String(raw);
        if (typeof raw === 'number' && lbl.includes('x0.1')) {
          display = `${(raw / 10).toFixed(1)}°C`;
        }
        // Shorten BSH keys for display: BSH.Common.Status.DoorState → DoorState
        const shortKey = k.includes('.') ? k.split('.').pop() : k;
        return `
        <span class="dps-key" title="${escHtml(k)}">${escHtml(shortKey)}</span>
        <span class="dps-val">${escHtml(display)}</span>
        <input class="dps-lbl" data-dps="${k}" value="${escHtml(lbl)}" placeholder="label…">
        <span></span>`;
      }).join('')}
    </div>
    <div style="margin-top:8px;display:flex;gap:8px;">
      <button class="btn btn-secondary btn-sm" onclick="saveDpsLabels('${escAttr(id)}', this)">Save Labels</button>
      <span class="dps-save-status" style="font-size:0.8rem;color:var(--muted);line-height:2;"></span>
    </div>
  </td>`;

  row.insertAdjacentElement('afterend', panelRow);
}

async function saveDpsLabels(id, btn) {
  const panel = btn.closest('td');
  const inputs = panel.querySelectorAll('input.dps-lbl');
  const labels = {};
  inputs.forEach(inp => {
    const v = inp.value.trim();
    if (v) labels[inp.dataset.dps] = v;
  });
  btn.disabled = true;
  const status = panel.querySelector('.dps-save-status');
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dps_labels: labels }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    const dev = allDevices.find(d => d.id === id);
    if (dev) dev.dps_labels = labels;
    status.textContent = '✓ Saved';
    status.style.color = '#22c55e';
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    status.style.color = '#ef4444';
  }
  btn.disabled = false;
}

// ─── Rooms tab ────────────────────────────────────────────────────────────────

async function loadRooms() {
  const tbody = document.getElementById('rooms-tbody');
  try {
    const r = await fetch('/api/rooms');
    const rooms = await r.json();
    if (!rooms.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted)">No rooms defined yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rooms.map(row => `
      <tr data-room="${escHtml(row.room)}">
        <td class="room-name-cell" style="font-weight:500">${escHtml(row.room)}</td>
        <td style="color:var(--muted)">${row.device_count} device${row.device_count == 1 ? '' : 's'}</td>
        <td style="text-align:right;display:flex;gap:6px;justify-content:flex-end;">
          <button class="btn btn-secondary btn-sm" onclick="renameRoom('${escAttr(row.room)}', this)">Rename</button>
          <button class="btn btn-sm" style="background:#7f1d1d;color:#fca5a5;" onclick="deleteRoom('${escAttr(row.room)}', this)">Delete</button>
        </td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" style="color:#ef4444">Error: ${escHtml(e.message)}</td></tr>`;
  }
}

async function addRoom() {
  const input = document.getElementById('new-room-input');
  const name = input.value.trim();
  if (!name) return;
  try {
    const r = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    input.value = '';
    if (!allRoomsList.includes(name)) allRoomsList.push(name);
    allRoomsList.sort();
    await loadRooms();
    populateRoomFilter(); // refresh filter-room select + datalist
  } catch (e) {
    alert('Add room failed: ' + e.message);
  }
}

async function renameRoom(oldName, btn) {
  const newName = prompt(`Rename "${oldName}" to:`, oldName);
  if (!newName || newName.trim() === oldName) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const r = await fetch(`/api/rooms/${encodeURIComponent(oldName)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    await loadRooms();
    // Refresh device data so dropdowns update
    settingsRendered = false;
    await loadAll();
  } catch (e) {
    alert('Rename failed: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Rename';
  }
}

async function deleteRoom(name, btn) {
  if (!confirm(`Remove room "${name}" from all devices?`)) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const r = await fetch(`/api/rooms/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error);
    await loadRooms();
    settingsRendered = false;
    await loadAll();
  } catch (e) {
    alert('Delete failed: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
}

// ─── Tab switching ────────────────────────────────────────────────────────────

function showTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'settings') { settingsRendered = false; applySettingsFilters(); settingsRendered = true; loadBlocklist(); }
  if (name === 'rooms') loadRooms();
  if (name === 'history') populateHistorySelect();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return String(s || '').replace(/'/g,"\\'").replace(/"/g,'&quot;');
}

// ─── Event delegation ────────────────────────────────────────────────────────

document.getElementById('settings-tbody').addEventListener('click', function(e) {
  const td = e.target.closest('td.editable-cell');
  if (!td || td.querySelector('input[type=text]')) return;
  const row = td.closest('tr');

  // Channel sub-row
  if (row.classList.contains('channel-sub-row')) {
    const id      = row.dataset.parentId;
    const channel = row.dataset.channel;
    const field   = td.dataset.field;
    if (!id || !channel || !field) return;
    editChanCell(td, field, id, channel);
    return;
  }

  // DPS attribute sub-row
  if (row.classList.contains('dps-attr-row')) {
    const id     = row.dataset.parentId;
    const dpsKey = row.dataset.dps;
    const field  = td.dataset.field;
    if (!id || !dpsKey || !field) return;
    editDpsAttrCell(td, field, id, dpsKey);
    return;
  }

  // Normal device row
  const id    = row.dataset.id;
  const field = td.dataset.field;
  if (!id || !field) return;
  editCell(td, field, id);
});

document.getElementById('settings-tbody').addEventListener('change', function(e) {
  const inp = e.target;
  if (inp.type !== 'checkbox') return;

  // Channel toggle — saves into channel_config[k].enabled / .show_dashboard
  if (inp.classList.contains('chan-toggle')) {
    const id      = inp.dataset.parentId;
    const chanKey = inp.dataset.channel;
    const field   = inp.dataset.field;
    if (!id || !chanKey || !field) return;
    const dev = allDevices.find(d => d.id === id);
    if (!dev) return;
    const cfg = JSON.parse(JSON.stringify(dev.channel_config || {}));
    cfg[chanKey] = cfg[chanKey] || {};
    cfg[chanKey][field] = inp.checked;
    patchDevice(id, { channel_config: cfg });
    dev.channel_config = cfg;
    return;
  }

  // DPS attribute toggle
  if (inp.classList.contains('dps-attr-toggle')) {
    const id     = inp.dataset.parentId;
    const dpsKey = inp.dataset.dps;
    const field  = inp.dataset.field;
    if (!id || !dpsKey || !field) return;
    const dev = allDevices.find(d => d.id === id);
    if (!dev) return;
    const cfg = JSON.parse(JSON.stringify(dev.dps_config || {}));
    cfg[dpsKey] = cfg[dpsKey] || {};
    cfg[dpsKey][field] = inp.checked;
    patchDevice(id, { dps_config: cfg });
    dev.dps_config = cfg;
    return;
  }

  // Normal device toggle
  const id    = inp.dataset.id;
  const field = inp.dataset.field;
  if (!id || !field) return;
  patchDevice(id, { [field]: inp.checked });
  const dev = allDevices.find(d => d.id === id);
  if (dev) dev[field] = inp.checked;
});

// ─── Init ─────────────────────────────────────────────────────────────────────

// Init stale threshold input from localStorage
document.getElementById('stale-threshold-input').value = staleThresholdMin;
document.getElementById('stale-threshold-lbl').textContent = staleThresholdMin;

// ─── Device blocklist ─────────────────────────────────────────────────────────

async function deactivateDevice(id, name) {
  if (!confirm(`Remove "${name}" from project?\n\nThis will delete the device and all its event history. It can be reactivated later from the blocklist.`)) return;
  try {
    const r = await fetch(`/api/devices/blocklist/${encodeURIComponent(id)}/deactivate`, { method: 'POST' });
    const data = await r.json();
    if (data.ok) {
      allDevices = allDevices.filter(d => d.id !== id);
      applySettingsFilters();
      loadBlocklist();
    } else {
      alert('Error: ' + (data.error || 'unknown'));
    }
  } catch (e) { alert('Error: ' + e.message); }
}

async function loadBlocklist() {
  const tbody = document.getElementById('blocklist-tbody');
  try {
    const r = await fetch('/api/devices/blocklist');
    const rows = await r.json();
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:#aaa">No blocked devices</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(d => `<tr>
      <td>${escHtml(d.name)}</td>
      <td><span class="type-badge">${escHtml(d.device_type || '?')}</span></td>
      <td>${protoBadge(d.protocol || 'local')}</td>
      <td style="font-size:0.75rem;color:#888">${new Date(d.blocked_at).toLocaleDateString('he-IL')}</td>
      <td><button onclick="reactivateDevice('${escAttr(d.id)}','${escAttr(d.name)}')"
        style="font-size:0.75rem;padding:3px 10px;border:1px solid #27ae60;color:#27ae60;background:transparent;border-radius:4px;cursor:pointer;">Activate</button></td>
    </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#c0392b">Error: ${escHtml(e.message)}</td></tr>`;
  }
}

async function reactivateDevice(id, name) {
  if (!confirm(`Reactivate "${name}"? It will be added back as a fresh device with no history.`)) return;
  try {
    const r = await fetch(`/api/devices/blocklist/${encodeURIComponent(id)}/reactivate`, { method: 'POST' });
    const data = await r.json();
    if (data.ok) {
      await loadAll();
      applySettingsFilters();
      loadBlocklist();
    } else {
      alert('Error: ' + (data.error || 'unknown'));
    }
  } catch (e) { alert('Error: ' + e.message); }
}

// ─── Device History tab ───────────────────────────────────────────────────────

let historyChart = null;

function populateHistorySelect() {
  const sel = document.getElementById('history-device');
  const cur = sel.value;
  const devs = allDevices.filter(d => d.enabled !== false).sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = '<option value="">— select device —</option>' +
    devs.map(d => `<option value="${escAttr(d.id)}">${escHtml(d.name)} (${d.protocol})</option>`).join('');
  sel.value = cur;
}

async function loadHistory() {
  const devId = document.getElementById('history-device').value;
  const minutes = parseFloat(document.getElementById('history-range').value) || 1;
  const tbody = document.getElementById('history-tbody');
  const countEl = document.getElementById('history-count');

  if (!devId) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:#aaa">Select a device to view history</td></tr>';
    countEl.textContent = '';
    if (historyChart) { historyChart.destroy(); historyChart = null; }
    return;
  }

  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(devId)}/events?minutes=${minutes}`);
    if (!r.ok) throw new Error(r.status);
    const events = await r.json();
    countEl.textContent = `${events.length} events`;

    // Table
    tbody.innerHTML = events.length === 0
      ? '<tr><td colspan="3" style="color:#aaa">No events in this range</td></tr>'
      : events.slice().reverse().map(e => {
          const t = new Date(e.ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const srcColor = {tcp_push:'#27ae60', local_poll:'#b7770d', cloud_poll:'#d35400', cloud_push:'#27ae60', gateway_push:'#8e44ad'}[e.source] || '#999';
          const dpsStr = Object.entries(e.dps || {}).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(', ');
          return `<tr>
            <td style="white-space:nowrap">${escHtml(t)}</td>
            <td style="color:${srcColor};font-weight:500">${escHtml(e.source)}</td>
            <td style="color:#666">${escHtml(dpsStr)}</td>
          </tr>`;
        }).join('');

    // Chart — pass device for dps_config filtering
    const dev = allDevices.find(d => d.id === devId);
    renderHistoryChart(events, minutes, dev);

    // Build toggle buttons for switchable devices
    const togglesEl = document.getElementById('history-toggles');
    const switchTypes = ['switch','circuit_breaker','water_heater','light','valve'];
    document.getElementById('history-toggle-status').textContent = '';
    if (dev && switchTypes.includes(dev.device_type)) {
      const chanKeys = getChannelKeys(dev);
      const channels = chanKeys.length > 1 ? chanKeys : ['1'];
      const cfg = dev.channel_config || {};
      togglesEl.innerHTML = channels.map(ch => {
        const label = channels.length > 1 ? (cfg[ch]?.name || `Ch.${ch}`) : '';
        const isOn = dev.last_state && (dev.last_state[ch] === true || dev.last_state[ch] === 1);
        return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;">`
          + (label ? `<span style="font-size:0.78rem;color:#666;">${escHtml(label)}</span>` : '')
          + `<button onclick="historyToggle(true,'${ch}')" style="padding:3px 10px;border:1px solid #27ae60;background:${isOn ? '#27ae60' : '#fff'};color:${isOn ? '#fff' : '#27ae60'};border-radius:4px;cursor:pointer;font-size:0.78rem;font-weight:600;">ON</button>`
          + `<button onclick="historyToggle(false,'${ch}')" style="padding:3px 10px;border:1px solid #c0392b;background:${!isOn ? '#c0392b' : '#fff'};color:${!isOn ? '#fff' : '#c0392b'};border-radius:4px;cursor:pointer;font-size:0.78rem;font-weight:600;">OFF</button>`
          + `</span>`;
      }).join('');
    } else {
      togglesEl.innerHTML = '';
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" style="color:#c0392b">Error: ${escHtml(e.message)}</td></tr>`;
  }
}

function renderHistoryChart(events, minutes, dev) {
  const ctx = document.getElementById('history-chart');
  if (historyChart) { historyChart.destroy(); historyChart = null; }
  if (!events.length) return;

  const sourceColors = {
    tcp_push: '#27ae60', local_poll: '#b7770d', cloud_poll: '#d35400',
    cloud_push: '#2ecc71', gateway_push: '#8e44ad', initial: '#999',
    ha_api: '#2980b9', mqtt: '#16a085'
  };

  // Build set of allowed DPS keys — whitelist approach
  const dpsCfg = (dev && dev.dps_config) || {};
  const chanCfg = (dev && dev.channel_config) || {};
  const dpsLabelsChart = (dev && dev.dps_labels) || {};
  const hasAnyConfig = Object.keys(dpsCfg).length > 0 || Object.keys(chanCfg).length > 0 || Object.keys(dpsLabelsChart).length > 0;
  let allowedKeys = null; // null = allow all

  if (hasAnyConfig) {
    allowedKeys = new Set();
    allowedKeys.add('1');
    for (const [k, cfg] of Object.entries(chanCfg)) {
      if (cfg.enabled !== false) allowedKeys.add(k);
    }
    for (const [k, cfg] of Object.entries(dpsCfg)) {
      if (cfg.enabled !== false) allowedKeys.add(k);
    }
    for (const k of Object.keys(dpsLabelsChart)) {
      allowedKeys.add(k);
    }
  }

  // ── State lines: one line per allowed DPS key ──
  const dpsColors = ['#3a5a8a','#e74c3c','#27ae60','#8e44ad','#d35400','#16a085','#c0392b','#2980b9'];
  const byKey = {};

  function toVal(raw) {
    if (typeof raw === 'boolean') return raw ? 1 : 0;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const s = raw.toLowerCase();
      const short = raw.includes('.') ? raw.split('.').pop().toLowerCase() : s;
      if (['on','open','present','run','active','true','running'].includes(short)) return 1;
      if (['off','close','closed','none','inactive','false','ready'].includes(short)) return 0;
    }
    return null;
  }

  for (const e of events) {
    const dps = e.dps || {};
    for (const [k, raw] of Object.entries(dps)) {
      if (allowedKeys && !allowedKeys.has(k)) continue;
      const v = toVal(raw);
      if (v === null) continue;
      if (!byKey[k]) byKey[k] = [];
      byKey[k].push({ x: new Date(e.ts), y: v });
    }
  }

  const dpsKeys = Object.keys(byKey).sort((a, b) => Number(a) - Number(b));
  const allPoints = dpsKeys.flatMap(k => byKey[k]);
  const isBoolean = allPoints.length > 0 && allPoints.every(p => p.y === 0 || p.y === 1);

  // ── Source event dots ──
  const bySrc = {};
  for (const e of events) {
    const s = e.source || 'unknown';
    if (!bySrc[s]) bySrc[s] = [];
    bySrc[s].push({ x: new Date(e.ts), y: isBoolean ? 1.15 : null });
  }

  const datasets = [];

  // One line per DPS key
  dpsKeys.forEach((k, i) => {
    const color = dpsColors[i % dpsColors.length];
    const label = dpsKeys.length === 1 ? (isBoolean ? 'State (ON/OFF)' : 'Value')
      : (isBoolean ? `Ch.${k} (ON/OFF)` : `DPS ${k}`);
    datasets.push({
      label,
      data: byKey[k],
      type: 'line',
      borderColor: color,
      backgroundColor: color + '1a',
      fill: dpsKeys.length === 1,
      stepped: isBoolean,
      pointRadius: 0,
      borderWidth: 2,
      yAxisID: 'yState',
      order: 1,
    });
  });

  // Source dots
  for (const [src, pts] of Object.entries(bySrc)) {
    if (!isBoolean) {
      const maxVal = Math.max(...allPoints.map(p => p.y), 1);
      pts.forEach(p => p.y = maxVal * 1.05);
    }
    datasets.push({
      label: src,
      data: pts,
      backgroundColor: sourceColors[src] || '#999',
      borderColor: sourceColors[src] || '#999',
      pointRadius: 5,
      pointHoverRadius: 7,
      showLine: false,
      yAxisID: 'yState',
    });
  }

  historyChart = new Chart(ctx, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { font: { size: 11 }, usePointStyle: true } },
        tooltip: {
          callbacks: {
            label: item => {
              if (item.dataset.label === 'State (ON/OFF)') return item.parsed.y ? 'ON' : 'OFF';
              if (item.dataset.label === 'Value') return `Value: ${item.parsed.y}`;
              const t = new Date(item.parsed.x).toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
              return `${item.dataset.label} @ ${t}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: minutes < 1 ? 'second' : minutes <= 5 ? 'second' : 'minute',
            tooltipFormat: 'HH:mm:ss',
            displayFormats: { second: 'HH:mm:ss', minute: 'HH:mm' }
          },
          title: { display: true, text: 'Time', font: { size: 11 } },
          grid: { color: '#e8e4df' }
        },
        yState: {
          position: 'left',
          min: isBoolean ? -0.1 : undefined,
          max: isBoolean ? 1.3 : undefined,
          ticks: isBoolean
            ? { callback: v => v === 1 ? 'ON' : v === 0 ? 'OFF' : '', stepSize: 1 }
            : {},
          grid: { color: '#e8e4df' },
          title: { display: true, text: isBoolean ? 'State' : 'Value', font: { size: 11 } }
        }
      }
    }
  });
}

async function historyToggle(state, channel) {
  const devId = document.getElementById('history-device').value;
  const statusEl = document.getElementById('history-toggle-status');
  if (!devId) return;
  statusEl.textContent = 'Sending...';
  statusEl.style.color = '#888';
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(devId)}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, channel }),
    });
    const data = await r.json();
    if (data.ok) {
      statusEl.textContent = `${data.service} → ${escHtml(data.entity_id)}`;
      statusEl.style.color = '#27ae60';
    } else {
      statusEl.textContent = escHtml(data.error || 'Failed');
      statusEl.style.color = '#c0392b';
    }
    setTimeout(loadHistory, 1500);
  } catch (e) {
    statusEl.textContent = escHtml(e.message);
    statusEl.style.color = '#c0392b';
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadAll();
setInterval(loadAll, REFRESH_MS);
