// ── Main Agent — Rule Engine State Dashboard ──────────────────
(function () {
  let refreshTimer = null;
  const ALL_ROOMS = [];

  function formatTimeAgo(unixTs) {
    if (!unixTs) return '—';
    const now = Date.now() / 1000;
    const diff = now - unixTs;
    if (diff < 0) return 'just now';
    if (diff < 60) return Math.floor(diff) + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function formatTimestamp(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    return d.toLocaleString('en-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  function parseJsonSafe(val) {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch (e) { return []; }
    }
    return [];
  }

  function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // Tab switching (same as Device Agent)
  window.showTab = function (id, btn) {
    document.querySelectorAll('.tab-panel').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + id).classList.add('active');
    btn.classList.add('active');
    // Start the Corridor Simulator polling loop when its tab is first activated.
    // Cheap to call repeatedly — the loop guards against double-starting.
    if (id === 'corridor-sim' && typeof window.corridorSim_start === 'function') {
      window.corridorSim_start();
    }
  };

  // Toggle rule enable/disable
  window.toggleRule = function (name, enabled) {
    fetch('/api/rule-engine/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, enabled }),
    }).catch(() => {});
  };

  window.saveRuleOverride = async function (name, overrides) {
    try {
      const r = await fetch('/api/rule-engine/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ...overrides }),
      });
      const data = await r.json();
      if (!data.ok) console.error('Override save failed:', data);
    } catch (e) { console.error('Override save error:', e); }
  };

  window._ruleTimeTarget = null;
  window.editRuleTime = function (name, curAfter, curBefore) {
    window._ruleTimeTarget = name;
    document.getElementById('rule-time-title').textContent = name + ' — Working Hours';
    document.getElementById('rule-time-after').value = curAfter || '';
    document.getElementById('rule-time-before').value = curBefore || '';
    document.getElementById('rule-time-overlay').style.display = 'flex';
  };
  window.closeRuleTimePopup = function () {
    document.getElementById('rule-time-overlay').style.display = 'none';
    window._ruleTimeTarget = null;
  };
  window.saveRuleTime = async function () {
    const name = window._ruleTimeTarget;
    if (!name) return;
    const after = document.getElementById('rule-time-after').value.trim();
    const before = document.getElementById('rule-time-before').value.trim();
    if (!after && !before) {
      await saveRuleOverride(name, { conditions: { time: null } });
      closeRuleTimePopup();
      return;
    }
    // Validate HH:MM format
    const timeRe = /^\d{1,2}:\d{2}$/;
    if ((after && !timeRe.test(after)) || (before && !timeRe.test(before))) {
      alert('Use HH:MM format (e.g., 08:00)');
      return;
    }
    const time = { after: after || '00:00', before: before || '23:59' };
    const conditions = { time };
    await saveRuleOverride(name, { conditions });
    closeRuleTimePopup();
    // Temporarily show the saved time in the table until rule engine picks it up
    const cells = document.querySelectorAll('#rules-body tr');
    cells.forEach(row => {
      const nameCell = row.querySelector('.rule-name');
      if (nameCell && nameCell.textContent === name) {
        const timeCell = row.querySelectorAll('td')[5];
        if (timeCell) timeCell.innerHTML = `<span style="font-size:0.72rem;color:#27ae60;">${after || '00:00'} - ${before || '23:59'}</span>`;
      }
    });
  };
  window.clearRuleTime = async function () {
    const name = window._ruleTimeTarget;
    if (!name) return;
    await saveRuleOverride(name, { conditions: { time: null } });
    closeRuleTimePopup();
    const cells = document.querySelectorAll('#rules-body tr');
    cells.forEach(row => {
      const nameCell = row.querySelector('.rule-name');
      if (nameCell && nameCell.textContent === name) {
        const timeCell = row.querySelectorAll('td')[5];
        if (timeCell) timeCell.innerHTML = `<span style="font-size:0.72rem;color:#27ae60;">—</span>`;
      }
    });
  };
  // Close popup on overlay click
  document.getElementById('rule-time-overlay')?.addEventListener('click', function(e) {
    if (e.target === this) closeRuleTimePopup();
  });

  let _traceRuleName = '';
  let _traceRange = '6h';

  function _extractKeys(result) {
    if (!result) return [];
    return result.split(';').map(s => s.trim().split('=')[0]).filter(Boolean);
  }

  window.showRuleTrace = function (name) {
    _traceRuleName = name;
    _traceRange = '6h';
    document.getElementById('rule-trace-title').textContent = name + ' — Event Trace';
    document.getElementById('rule-trace-overlay').style.display = 'flex';
    document.getElementById('trace-resolution').value = '5m';
    ['1h', '6h', '24h'].forEach(r => {
      const btn = document.getElementById('trace-btn-' + r);
      if (btn) { btn.style.background = r === '6h' ? '#7a9ab8' : ''; btn.style.color = r === '6h' ? '#fff' : ''; }
    });
    loadRuleTrace();
  };

  window.setTraceRange = function (range) {
    _traceRange = range;
    ['1h', '6h', '24h'].forEach(r => {
      const btn = document.getElementById('trace-btn-' + r);
      if (btn) { btn.style.background = r === range ? '#7a9ab8' : ''; btn.style.color = r === range ? '#fff' : ''; }
    });
    loadRuleTrace();
  };

  window.loadRuleTrace = async function () {
    const container = document.getElementById('rule-trace-table');
    const resolution = document.getElementById('trace-resolution')?.value || '5m';
    if (container) container.innerHTML = '<span style="color:#888;">Loading...</span>';
    try {
      const r = await fetch(`/api/rule-engine/events?rule=${encodeURIComponent(_traceRuleName)}&range=${_traceRange}`);
      const events = await r.json();
      if (!Array.isArray(events) || events.length === 0) {
        if (container) container.innerHTML = '<span style="color:#aaa;">No events in this time range</span>';
        return;
      }
      // Filter out skip events (noise from old data)
      const sorted = [...events].filter(e => e.event_type !== 'skipped').reverse();
      if (sorted.length === 0) {
        if (container) container.innerHTML = '<span style="color:#aaa;">No events in this time range</span>';
        return;
      }

      // Resolution in ms
      const resMs = { '1m': 60000, '2m': 120000, '5m': 300000, '10m': 600000, '30m': 1800000, '1h': 3600000 }[resolution] || 300000;

      // Collect all unique keys, filter redundant ones
      const redundantKeys = new Set(['active_room_count']); // always same as active_rooms
      // Per-rule whitelist — when set, only these keys are shown in the trace.
      // Other rules show every key they emit (default behaviour).
      const ruleKeyWhitelist = {
        'People Home': ['people_home'],
      };
      const whitelist = ruleKeyWhitelist[_traceRuleName] || null;
      const allKeys = [];
      const keySet = new Set();
      sorted.forEach(e => {
        if (e.event_type === 'state_changed') {
          _extractKeys(e.result).forEach(k => {
            if (keySet.has(k) || redundantKeys.has(k)) return;
            if (whitelist && !whitelist.includes(k)) return;
            keySet.add(k); allKeys.push(k);
          });
        } else {
          const k = e.event_type;
          if (keySet.has(k) || k === 'skipped') return;
          if (whitelist && !whitelist.includes(k)) return;
          keySet.add(k); allKeys.push(k);
        }
      });

      // Whitelisted rules render real VALUES (e.g. people_home=2 → cell shows "2"),
      // and we only keep buckets that contain at least one whitelisted change.
      // Non-whitelisted rules keep the legacy count-of-changes behaviour.
      const valueMode = whitelist !== null;

      // Parse "key=value; key=value" → [{k, v}, ...]
      const _extractPairs = (result) => {
        if (!result) return [];
        return result.split(';').map(s => s.trim()).filter(Boolean).map(p => {
          const i = p.indexOf('=');
          return i === -1 ? { k: p, v: '' } : { k: p.slice(0, i).trim(), v: p.slice(i + 1).trim() };
        });
      };

      // Build time buckets — values in valueMode, counts otherwise
      const bucketMap = {};
      sorted.forEach(e => {
        const ts = new Date(e.ts).getTime();
        const bucket = Math.floor(ts / resMs) * resMs;
        if (e.event_type === 'state_changed') {
          if (valueMode) {
            _extractPairs(e.result).forEach(({k, v}) => {
              if (!whitelist.includes(k)) return;
              if (!bucketMap[bucket]) bucketMap[bucket] = {};
              bucketMap[bucket][k] = v; // overwrite — last wins within bucket
            });
          } else {
            if (!bucketMap[bucket]) bucketMap[bucket] = {};
            _extractKeys(e.result).forEach(k => {
              bucketMap[bucket][k] = (bucketMap[bucket][k] || 0) + 1;
            });
          }
        } else {
          const k = e.event_type;
          if (valueMode && !whitelist.includes(k)) return;
          if (!bucketMap[bucket]) bucketMap[bucket] = {};
          bucketMap[bucket][k] = (bucketMap[bucket][k] || 0) + 1;
        }
      });

      // Sort buckets chronologically (in valueMode bucketMap only contains
      // buckets that had a whitelisted change, so empty buckets are already filtered).
      const bucketTimes = Object.keys(bucketMap).map(Number).sort((a, b) => a - b);

      const shortKey = (k) => k;
      const keyTooltips = {
        'activity_level': 'Home activity state: idle / low / active',
        'active_rooms': 'List of rooms with current presence or recent switch activity',
        'last_motion_room': 'Room with most recent motion detection',
        'people_home': 'Estimated number of people currently home',
        'occupied_rooms': 'Rooms with confirmed occupancy',
        'home_mode': 'Home mode: home / away',
        'command': 'Command dispatched to a device (pixoo push, etc.)',
        'force_fired': 'Rule force-tested from dashboard',
        'auto_disabled': 'Rule auto-disabled after repeated errors',
      };

      // Build HTML table
      const cellStyle = (count) => {
        if (!count) return 'color:#ccc;';
        if (count >= 3) return 'color:#2e2e2e;font-weight:600;';
        if (count >= 1) return 'color:#2e2e2e;';
        return 'color:#ccc;';
      };

      let html = '<table style="width:100%;border-collapse:collapse;font-size:0.75rem;">';
      html += '<thead><tr style="border-bottom:2px solid #d0cbc4;">';
      html += '<th style="text-align:left;padding:4px 8px;font-size:0.7rem;color:#888;">Time</th>';
      allKeys.forEach(k => {
        const tip = keyTooltips[k] || k;
        html += `<th style="text-align:center;padding:4px 6px;font-size:0.68rem;color:#888;white-space:nowrap;cursor:help;" title="${escHtml(tip)}">${escHtml(shortKey(k))}</th>`;
      });
      html += '</tr></thead><tbody>';

      bucketTimes.forEach(ts => {
        const d = new Date(ts);
        const time = d.toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
        const cells = bucketMap[ts];
        html += '<tr style="border-bottom:1px solid #f0ebe3;">';
        html += `<td style="padding:3px 8px;color:#888;font-size:0.72rem;white-space:nowrap;">${time}</td>`;
        allKeys.forEach(k => {
          const raw = cells[k];
          if (valueMode) {
            const display = (raw === undefined || raw === '') ? '—' : escHtml(String(raw));
            const style = (raw === undefined) ? 'color:#ccc;' : 'color:#2e2e2e;font-weight:600;';
            html += `<td style="text-align:center;padding:3px 6px;font-size:0.75rem;border-radius:3px;${style}">${display}</td>`;
          } else {
            const count = raw || 0;
            const val = count === 0 ? '—' : count;
            html += `<td style="text-align:center;padding:3px 6px;font-size:0.75rem;border-radius:3px;${cellStyle(count)}">${val}</td>`;
          }
        });
        html += '</tr>';
      });

      html += '</tbody></table>';
      const footer = valueMode
        ? 'Cell = value at the moment of change. Rows shown only when a tracked field changed in the bucket. — = no change in that field this bucket.'
        : 'Number = how many times this state key changed in the time bucket. Bold = 3+ changes. — = no change.';
      html += `<div style="font-size:0.68rem;color:#aaa;margin-top:6px;padding:0 8px;">${footer}</div>`;
      if (container) container.innerHTML = html;
    } catch (err) {
      if (container) container.innerHTML = '<span style="color:#e74c3c;">Failed to load events</span>';
    }
  };

  window.closeRuleTrace = function () {
    document.getElementById('rule-trace-overlay').style.display = 'none';
  };
  document.getElementById('rule-trace-overlay')?.addEventListener('click', function(e) {
    if (e.target === this) closeRuleTrace();
  });

  window.testRule = async function (name, force) {
    const el = document.getElementById('test-result');
    if (!el) return;
    el.style.display = 'block';
    el.style.background = '#f0ebe3';
    el.style.borderLeft = '4px solid #888';
    el.innerHTML = force ? `Force-running <b>${escHtml(name)}</b>...` : `Testing <b>${escHtml(name)}</b>...`;
    try {
      const r = await fetch('/api/rule-engine/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_name: name, force: !!force }),
      });
      const data = await r.json();
      if (data.status === 'force_fired') {
        el.style.background = 'rgba(230,126,34,0.1)';
        el.style.borderLeft = '4px solid #e67e22';
        el.innerHTML = `<b>${escHtml(name)}</b> — <span style="color:#e67e22;font-weight:600;">FORCE FIRED</span><br>` +
          (data.commands || []).map(c => `&nbsp;&nbsp;→ ${escHtml(c)}`).join('<br>') +
          `<br><span style="color:#888;font-size:0.75rem;">Commands dispatched to device</span>`;
      } else if (data.status === 'would_fire') {
        el.style.background = 'rgba(39,174,96,0.1)';
        el.style.borderLeft = '4px solid #27ae60';
        el.innerHTML = `<b>${escHtml(name)}</b> — <span style="color:#27ae60;font-weight:600;">WOULD FIRE</span><br>` +
          (data.commands || []).map(c => `&nbsp;&nbsp;→ ${escHtml(c)}`).join('<br>') +
          `<br><span style="color:#888;font-size:0.75rem;">Device: ${escHtml(data.device || '—')}</span>`;
      } else if (data.status === 'state_updated') {
        el.style.background = 'rgba(52,152,219,0.1)';
        el.style.borderLeft = '4px solid #3498db';
        const ch = data.state_changes || {};
        const chStr = Object.entries(ch).map(([k,v]) =>
          `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`
        ).join(', ');
        el.innerHTML = `<b>${escHtml(name)}</b> — <span style="color:#3498db;font-weight:600;">STATE UPDATED</span><br>` +
          `<span style="color:#888;font-size:0.75rem;">${escHtml(data.reason || '')}</span><br>` +
          (chStr ? `<span style="color:#555;font-size:0.75rem;">Changes: ${escHtml(chStr)}</span><br>` : '') +
          `<span style="color:#888;font-size:0.75rem;">Device: ${escHtml(data.device || '—')}</span>`;
      } else if (data.status === 'no_action') {
        el.style.background = 'rgba(149,165,166,0.1)';
        el.style.borderLeft = '4px solid #95a5a6';
        const state = data.state || {};
        const stateStr = Object.entries(state).map(([k,v]) => `${k}=${v}`).join(', ');
        const timerStr = (data.timers || []).join(', ');
        el.innerHTML = `<b>${escHtml(name)}</b> — <span style="color:#95a5a6;font-weight:600;">NO ACTION · RAN</span><br>` +
          `<span style="color:#888;font-size:0.75rem;">Rule executed successfully but would not change state or emit commands</span><br>` +
          (stateStr ? `<span style="color:#888;font-size:0.75rem;">State: ${escHtml(stateStr)}</span><br>` : '') +
          (timerStr ? `<span style="color:#888;font-size:0.75rem;">Timers: ${escHtml(timerStr)}</span>` : '');
      } else if (data.status === 'skip') {
        el.style.background = 'rgba(243,156,18,0.1)';
        el.style.borderLeft = '4px solid #f39c12';
        el.innerHTML = `<b>${escHtml(name)}</b> — <span style="color:#f39c12;font-weight:600;">SKIP</span><br>` +
          `<span style="color:#888;font-size:0.75rem;">${escHtml(data.reason || '')}</span>`;
      } else if (data.status === 'timeout') {
        el.style.background = 'rgba(231,76,60,0.1)';
        el.style.borderLeft = '4px solid #e74c3c';
        el.innerHTML = `<b>${escHtml(name)}</b> — <span style="color:#e74c3c;font-weight:600;">TIMEOUT</span><br>` +
          `<span style="color:#888;font-size:0.75rem;">Rule engine did not respond</span>`;
      } else {
        el.style.background = 'rgba(231,76,60,0.1)';
        el.style.borderLeft = '4px solid #e74c3c';
        el.innerHTML = `<b>${escHtml(name)}</b> — <span style="color:#e74c3c;">${escHtml(data.status || 'error')}</span><br>` +
          `<span style="color:#888;font-size:0.75rem;">${escHtml(data.reason || '')}</span>`;
      }
    } catch (e) {
      el.style.background = 'rgba(231,76,60,0.1)';
      el.style.borderLeft = '4px solid #e74c3c';
      el.innerHTML = `<b>${escHtml(name)}</b> — <span style="color:#e74c3c;">Connection error</span>`;
    }
    // Add close button
    el.innerHTML += `<button onclick="this.parentElement.style.display='none'" style="position:absolute;top:6px;right:8px;background:none;border:none;cursor:pointer;color:#888;font-size:1rem;" title="Close">&times;</button>`;
  };

  window.reloadRules = async function () {
    const btn = document.querySelector('[onclick="reloadRules()"]');
    try {
      if (btn) btn.textContent = 'Reloading...';
      const r = await fetch('/api/rule-engine/reload', { method: 'POST' });
      const data = await r.json();
      if (!data.ok) {
        if (btn) btn.textContent = 'Reload';
        return;
      }
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 500));
        try {
          const sResp = await fetch('/api/rule-engine/state');
          const sData = await sResp.json();
          const loaded = (sData.rules || []).length;
          const onDisk = (sData.state && sData.state._rules_on_disk) || 0;
          if (loaded === onDisk) break;
        } catch (_) {}
      }
      await loadState();
      if (btn) btn.textContent = 'Reload';
    } catch (e) {
      console.error('Reload error:', e);
      if (btn) btn.textContent = 'Reload';
    }
  };

  window.updateReloadBadge = function (rulesLoaded, rulesOnDisk) {
    const btn = document.querySelector('[onclick="reloadRules()"]');
    if (!btn) return;
    const newCount = (rulesOnDisk || 0) - (rulesLoaded || 0);
    if (newCount > 0) {
      btn.textContent = `Reload (${newCount} new)`;
      btn.style.background = '#e67e22';
      btn.style.color = '#fff';
    } else {
      btn.textContent = 'Reload';
      btn.style.background = '';
      btn.style.color = '';
    }
  };

  window.loadState = async function loadState() {
    try {
      const resp = await fetch('/api/rule-engine/state');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const s = data.state || {};
      const hb = data.heartbeat || {};

      // ── Stats chips ──
      const mode = s.home_mode || 'unknown';
      const modeEl = document.getElementById('stat-mode-val');
      modeEl.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
      modeEl.className = 'stat-val ' + mode;

      // Single People count = high-water-mark since last Main Door close.
      // Honors `transit` (= "--") while the Main Door is open.
      const pstate = s.people_count_state || 'stable';
      const people = parseInt(s.people_home) || 0;
      const peopleEl = document.getElementById('stat-people');
      const colorClass = n => (n === 0 ? 'p0' : n === 1 ? 'p1' : 'pm');
      if (pstate === 'transit') {
        peopleEl.textContent    = '--';
        peopleEl.className      = 'stat-val pending';
      } else {
        peopleEl.textContent    = people;
        peopleEl.className      = 'stat-val ' + colorClass(people);
      }

      const activeCount = parseInt(s.active_room_count) || 0;
      document.getElementById('stat-active-rooms').textContent = activeCount;
      document.getElementById('stat-last-room').textContent = s.last_motion_room || '—';

      const lastMotionTs = parseFloat(s['_timer:last_motion']) || 0;
      // Format time without "ago" suffix — label already says context
      const motionAgo = lastMotionTs ? formatTimeAgo(lastMotionTs).replace(' ago', '') : '—';
      document.getElementById('stat-motion-ago').textContent = motionAgo;

      // ── Tab-bar live display: time_mode + next sunrise/sunset ──
      const fmtSunHM = iso => {
        if (!iso) return '—';
        try {
          const d = new Date(iso);
          if (isNaN(d.getTime())) return '—';
          return d.toLocaleTimeString('en-IL', {
            timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false,
          });
        } catch (e) { return '—'; }
      };
      const hmEl = document.getElementById('tmb-home-mode');
      const tmEl = document.getElementById('tmb-time-mode');
      const srEl = document.getElementById('tmb-next-sunrise');
      const ssEl = document.getElementById('tmb-next-sunset');
      if (hmEl) hmEl.textContent = s.home_mode || '—';
      if (tmEl) tmEl.textContent = s.time_mode || '—';
      if (srEl) srEl.textContent = fmtSunHM(s.next_sunrise);
      if (ssEl) ssEl.textContent = fmtSunHM(s.next_sunset);

      // ── Engine status row ──
      const heartbeatAge = hb.ts ? (Date.now() - new Date(hb.ts).getTime()) / 1000 : Infinity;
      const isOnline = heartbeatAge < 120;
      document.getElementById('engine-dot').className = 'engine-dot ' + (isOnline ? 'online' : 'offline');
      document.getElementById('engine-label').textContent = isOnline ? 'Online' : 'Offline';

      const actLevel = s.activity_level || '—';
      document.getElementById('activity-level').textContent = actLevel.charAt(0).toUpperCase() + actLevel.slice(1);
      document.getElementById('last-heartbeat').textContent = hb.ts ? formatTimestamp(hb.ts) : '—';
      const rules = parseJsonSafe(s._rules);
      // Merge DB overrides into rules (dashboard changes take effect immediately)
      const overrides = (typeof s._rule_overrides === 'object' && s._rule_overrides) ? s._rule_overrides : {};
      rules.forEach(r => {
        const ovr = overrides[r.name];
        if (!ovr) return;
        if (ovr.priority !== undefined) r.priority = ovr.priority;
        if (ovr.conditions) {
          if (!r.conditions) r.conditions = {};
          for (const [k, v] of Object.entries(ovr.conditions)) {
            if (v === null) delete r.conditions[k];
            else r.conditions[k] = v;
          }
        }
      });
      const activeRules = rules.length;
      const disabledRules = new Set(parseJsonSafe(s._disabled_rules));
      document.getElementById('last-decision').textContent = `${activeRules - disabledRules.size} active / ${disabledRules.size} disabled`;

      // MQTT data health
      const mh = data.mqttHealth || {};
      document.getElementById('mqtt-health').textContent =
        `MQTT: ${mh.total || 0} devices | ${mh.clean || 0} clean | ${mh.empty || 0} empty | ${mh.noisy || 0} noisy`;

      const activeRooms = parseJsonSafe(s.active_rooms);
      const occupiedRooms = parseJsonSafe(s.occupied_rooms);

      // ── Rules tab ──
      const rulesBody = document.getElementById('rules-body');
      const groupColors = {};
      const palette = ['#3498db','#e67e22','#27ae60','#9b59b6','#e74c3c','#1abc9c','#f39c12','#2980b9'];
      let colorIdx = 0;
      // Count rules per group to determine if priority is editable
      const groupCounts = {};
      rules.forEach(r => { if (r.group) groupCounts[r.group] = (groupCounts[r.group] || 0) + 1; });

      if (rules.length === 0) {
        rulesBody.innerHTML = '<tr><td colspan="11" style="color:#aaa">No rules loaded</td></tr>';
      } else {
        rulesBody.innerHTML = rules.map(r => {
          const enabled = !disabledRules.has(r.name);
          const st = r.stats || {};
          const runs = st.count || 0;
          const avg = runs > 0 ? (st.total_ms / runs).toFixed(1) + 'ms' : '—';
          const max = st.max_ms ? st.max_ms.toFixed(1) + 'ms' : '—';
          const lastFired = st.last_fired ? formatTimestamp(st.last_fired) : '—';
          const group = r.group || '';
          const pri = r.priority != null ? r.priority : 10;
          const conds = r.conditions || {};
          const timeCond = conds.time || {};
          const timeAfter = timeCond.after || '';
          const timeBefore = timeCond.before || '';
          const timeStr = (timeAfter && timeBefore) ? `${timeAfter} - ${timeBefore}` : '';
          let dotColor = '#ccc';
          if (group) {
            if (!groupColors[group]) { groupColors[group] = palette[colorIdx++ % palette.length]; }
            dotColor = groupColors[group];
          }
          // Priority editable only if group has 2+ rules
          const groupSize = groupCounts[group] || 0;
          const priHtml = (group && groupSize >= 2)
            ? `<input type="number" min="1" max="99" value="${pri}" style="width:36px;padding:1px 3px;border:1px solid #d0cbc4;border-radius:3px;font-size:0.75rem;text-align:center;" onchange="saveRuleOverride('${escHtml(r.name)}',{priority:this.value})">`
            : `<span style="color:#ccc;">${pri}</span>`;
          const timeHtml = `<span style="cursor:pointer;text-decoration:underline;color:#3a5a8a;font-size:0.72rem;" onclick="editRuleTime('${escHtml(r.name)}','${timeAfter}','${timeBefore}')">${timeStr || '—'}</span>`;
          const hasError = (r.errors || 0) > 0;
          const isAutoDisabled = hasError && disabledRules.has(r.name);
          const rowStyle = isAutoDisabled ? 'background:rgba(231,76,60,0.08);' : hasError ? 'background:rgba(243,156,18,0.08);' : '';
          const errorBadge = isAutoDisabled ? ' <span style="font-size:0.65rem;color:#e74c3c;font-weight:600;">AUTO-DISABLED</span>'
            : hasError ? ` <span style="font-size:0.65rem;color:#e67e22;">${r.errors} err</span>` : '';
          return `<tr style="${rowStyle}">
            <td style="text-align:center;color:#888;font-size:0.75rem;">#${r.id || ''}</td>
            <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dotColor};" title="${escHtml(group)}"></span></td>
            <td class="rule-name"><span style="cursor:pointer;text-decoration:underline;" onclick="showRuleTrace('${escHtml(r.name)}')">${escHtml(r.name)}</span>${errorBadge}</td>
            <td style="font-size:0.78rem;color:#555;font-weight:500;">${escHtml(group)}</td>
            <td style="text-align:center">${priHtml}</td>
            <td style="text-align:center">${timeHtml}</td>
            <td style="text-align:center">${runs}</td>
            <td style="text-align:center">${avg}</td>
            <td style="text-align:center">${max}</td>
            <td style="font-size:0.75rem;color:#888;">${lastFired}</td>
            <td>
              <label class="toggle">
                <input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleRule('${escHtml(r.name)}', this.checked)">
                <span class="slider"></span>
              </label>
            </td>
            <td style="white-space:nowrap;">
              <button class="btn btn-secondary btn-sm" onclick="testRule('${escHtml(r.name)}',false)" style="font-size:0.68rem;padding:2px 6px;" title="Dry-run test">Test</button>
              <button class="btn btn-secondary btn-sm" onclick="testRule('${escHtml(r.name)}',true)" style="font-size:0.68rem;padding:2px 6px;background:#7a9ab8;color:#fff;" title="Reset cooldowns and dispatch for real">Force</button>
            </td>
          </tr>`;
        }).join('');
      }

      // ── Reload badge ──
      updateReloadBadge(rules.length, s._rules_on_disk);

      // ── Room grid ──
      const occupiedSet = new Set(occupiedRooms.map(r => r.toLowerCase()));
      const allRooms = new Set();
      occupiedRooms.forEach(r => allRooms.add(r));
      activeRooms.forEach(r => allRooms.add(r));
      ALL_ROOMS.forEach(r => allRooms.add(r));
      if (data.rooms && data.rooms.length) {
        data.rooms.forEach(r => allRooms.add(r));
      }
      ALL_ROOMS.length = 0;
      allRooms.forEach(r => ALL_ROOMS.push(r));
      ALL_ROOMS.sort();

      const gridEl = document.getElementById('room-grid');
      gridEl.innerHTML = '';
      if (ALL_ROOMS.length === 0) {
        gridEl.innerHTML = '<div style="color:#aaa">No rooms detected</div>';
      } else {
        ALL_ROOMS.forEach(room => {
          const chip = document.createElement('div');
          chip.className = 'room-chip';
          if (occupiedSet.has(room.toLowerCase())) chip.classList.add('occupied');
          chip.innerHTML = '<span class="room-dot"></span>' + escHtml(room);
          gridEl.appendChild(chip);
        });
      }

      // ── Refresh timestamp ──
      document.getElementById('last-refresh').textContent =
        'Updated ' + new Date().toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    } catch (err) {
      console.error('Failed to load rule engine state:', err);
      document.getElementById('last-refresh').textContent = 'Error: ' + err.message;
    }
  };

  loadState();
  refreshTimer = setInterval(loadState, 10000);

  // ── Base Rule Settings tab ─────────────────────────────────────────────────
  // Apartment-wide rule containers holding sentences for Layer 0 (home state
  // dimensions: time_mode, home_mode, voice_scene, sleep_mode) and Layer 1
  // (domain policies: light, HVAC, security). Same data shape as Living Room's
  // rule_sentences: array of {id, name, active, sentences:[...], added_at, updated_at}.
  // Rules numbered 1..N by array position so user says "generate base rule 2"
  // in chat. Stored under dashboard_settings.apartment.rule_sentences.
  // Reuses generic /api/dashboard-settings/:key endpoint.
  const BRS_STORAGE_KEY = 'apartment.rule_sentences';
  let brsRules = [];
  let brsDirty = false;

  function brsMarkDirty() {
    brsDirty = true;
    const b = document.getElementById('brs-dirty-badge');
    if (b) b.style.display = 'inline';
  }
  function brsClearDirty() {
    brsDirty = false;
    const b = document.getElementById('brs-dirty-badge');
    if (b) b.style.display = 'none';
  }
  window.addEventListener('beforeunload', (e) => {
    if (brsDirty) { e.preventDefault(); e.returnValue = ''; return ''; }
  });

  function brsNewId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  function brsFmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}-${mm} ${hh}:${mi}`;
  }

  function brsEsc(s) { return (s || '').replace(/"/g, '&quot;'); }

  function brsRender() {
    const container = document.getElementById('brs-rules-container');
    if (!container) return;
    if (!brsRules.length) {
      container.innerHTML = '<div style="padding:18px;text-align:center;color:#999;border:1px dashed #d0cbc4;border-radius:4px;">No base rules yet — click <b>+ Add rule</b> to start. Suggested first rule: <em>Time Mode</em> with 5 sentences for morning/day/evening/night/late_night windows.</div>';
      return;
    }
    container.innerHTML = '';
    brsRules.forEach((rule, idx) => {
      const ruleNum = idx + 1;
      const card = document.createElement('div');
      card.draggable = true;
      card.dataset.brsRuleCard = rule.id;
      card.style.cssText = 'border:1px solid #d0cbc4;border-radius:5px;padding:10px 12px;margin-bottom:10px;background:#fbfaf6;cursor:default;';
      for (const s of (rule.sentences || [])) { _brsEnsureSegments(s); s.segments = _brsNormalize(s.segments); }
      // maxSegs is computed only across sentences that ACTUALLY use chips
      // (segment count > 1). A pure-text sentence with one long segment must
      // not inflate column 0 — those sentences render with colspan and skip
      // the shared-column structure.
      const chipSentences = (rule.sentences || []).filter(s => (s.segments || []).length > 1);
      const maxSegs = chipSentences.reduce((m, s) => Math.max(m, (s.segments || []).length), 0) || 1;
      const segHeaderRow = Array.from({length: maxSegs}, (_, i) => {
        const lbl = (i % 2 === 0) ? 'text' : 'device';
        return `<th style="padding:3px 6px;text-align:left;font-weight:normal;color:#aaa;">${lbl}</th>`;
      }).join('');
      const sentencesHtml = (rule.sentences || []).map((s, sIdx) => {
        const isPureText = (s.segments || []).length <= 1;
        let segPart;
        if (isPureText) {
          // Single-segment text sentence — colspan across all segment columns
          // so its width doesn't push the chip-column widths around.
          const seg = s.segments[0] || { t: 'text', v: '' };
          const inner = _brsRenderSegmentInline(rule.id, s, 0, seg);
          segPart = `<td colspan="${maxSegs}" style="padding:4px 6px;vertical-align:middle;">${inner}</td>`;
        } else {
          const segCells = Array.from({length: maxSegs}, (_, segIdx) => {
            const seg = s.segments[segIdx];
            return _brsRenderSegmentCell(rule.id, s, segIdx, seg);
          }).join('');
          segPart = segCells;
        }
        return `
        <tr style="border-top:1px solid #e8e3d8;" data-brs-sent-row data-brs-sent-rule="${rule.id}" data-brs-sent-id="${s.id}">
          <td style="padding:4px 0;text-align:center;width:20px;vertical-align:middle;">
            <span draggable="true" data-brs-sent-handle title="Drag to reorder" style="cursor:grab;color:#aaa;font-size:0.95rem;user-select:none;display:inline-block;line-height:1;padding:2px 4px;">⋮⋮</span>
          </td>
          <td style="padding:4px 6px;text-align:center;width:36px;color:#888;font-size:0.78rem;vertical-align:middle;">${sIdx + 1}.</td>
          <td style="padding:4px 6px;text-align:center;width:40px;vertical-align:middle;">
            <input type="checkbox" ${s.active ? 'checked' : ''} data-brs-rule="${rule.id}" data-brs-sent="${s.id}" data-brs-field="active" style="margin:0;" />
          </td>
          ${segPart}
          <td style="padding:4px 6px;width:60px;vertical-align:middle;text-align:center;">
            <button onclick="brsAppendDevice('${rule.id}','${s.id}')" title="Insert a device" style="height:26px;box-sizing:border-box;background:#fff;color:#6c4f9f;border:1px dashed #6c4f9f;border-radius:3px;padding:0 10px;font-size:0.78rem;cursor:pointer;line-height:1;">+Dev</button>
          </td>
          <td style="padding:4px 6px;text-align:right;font-size:0.7rem;color:#999;width:100px;vertical-align:middle;">${brsFmtDate(s.updated_at || s.added_at)}</td>
          <td style="padding:4px 6px;text-align:center;width:40px;vertical-align:middle;">
            <button onclick="brsDeleteSentence('${rule.id}','${s.id}')" title="Delete sentence"
                    style="height:26px;box-sizing:border-box;background:#fff;color:#c0392b;border:1px solid #c0392b;border-radius:3px;padding:0 8px;font-size:0.78rem;cursor:pointer;line-height:1;">×</button>
          </td>
        </tr>`;
      }).join('');
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;height:28px;">
          <span title="Drag to reorder" style="cursor:grab;color:#aaa;font-size:1rem;user-select:none;line-height:28px;">⋮⋮</span>
          <strong style="color:#6c4f9f;min-width:70px;line-height:28px;">Base ${ruleNum}</strong>
          <input type="checkbox" ${rule.active ? 'checked' : ''} data-brs-rule="${rule.id}" data-brs-field="active" title="Enable rule" style="margin:0;" />
          <input type="text" value="${brsEsc(rule.name)}" data-brs-rule="${rule.id}" data-brs-field="name"
                 placeholder="Rule name (e.g. Time Mode, Home/Away, Voice Scene, Light Policy)"
                 style="flex:1;height:28px;box-sizing:border-box;padding:0 8px;border:1px solid #d0cbc4;border-radius:3px;font-size:0.88rem;font-weight:600;" />
          <button onclick="brsAddSentence('${rule.id}')" style="height:28px;box-sizing:border-box;background:#6c4f9f;color:#fff;border:none;border-radius:3px;padding:0 12px;font-size:0.78rem;cursor:pointer;line-height:1;">+ Sentence</button>
          <button onclick="brsDeleteRule('${rule.id}')" title="Delete rule"
                  style="height:28px;box-sizing:border-box;background:#fff;color:#c0392b;border:1px solid #c0392b;border-radius:3px;padding:0 10px;font-size:0.78rem;cursor:pointer;line-height:1;">× Rule</button>
        </div>
        ${rule.sentences && rule.sentences.length ? `
          <div style="overflow-x:auto;margin-left:4px;">
            <table style="border-collapse:collapse;table-layout:auto;">
              <thead>
                <tr style="background:#f0ece3;font-size:0.7rem;color:#666;">
                  <th style="padding:3px 0;width:20px;"></th>
                  <th style="padding:3px 6px;text-align:center;width:36px;">#</th>
                  <th style="padding:3px 6px;text-align:center;width:40px;">Active</th>
                  ${segHeaderRow}
                  <th style="padding:3px 6px;width:60px;"></th>
                  <th style="padding:3px 6px;text-align:right;width:100px;">Updated</th>
                  <th style="padding:3px 6px;width:40px;"></th>
                </tr>
              </thead>
              <tbody>${sentencesHtml}</tbody>
            </table>
          </div>` : '<div style="padding:8px 4px;color:#999;font-size:0.78rem;font-style:italic;">No sentences — click <b>+ Sentence</b> to add one.</div>'}
      `;
      container.appendChild(card);
    });
    container.querySelectorAll('[data-brs-rule]').forEach(el => {
      el.addEventListener('change', () => brsHandleEdit(el));
      if (el.type === 'text') el.addEventListener('blur', () => brsHandleEdit(el));
    });
    // Drag-and-drop reordering
    let _dragId = null;
    container.querySelectorAll('[data-brs-rule-card]').forEach(card => {
      card.addEventListener('dragstart', (e) => {
        _dragId = card.dataset.brsRuleCard;
        card.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => { card.style.opacity = ''; _dragId = null; });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        const over = card.dataset.brsRuleCard;
        if (!_dragId || over === _dragId) return;
        card.style.borderTop = '3px solid #6c4f9f';
      });
      card.addEventListener('dragleave', () => { card.style.borderTop = '1px solid #d0cbc4'; });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.style.borderTop = '1px solid #d0cbc4';
        const targetId = card.dataset.brsRuleCard;
        if (!_dragId || _dragId === targetId) return;
        const fromIdx = brsRules.findIndex(r => r.id === _dragId);
        const toIdx   = brsRules.findIndex(r => r.id === targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = brsRules.splice(fromIdx, 1);
        brsRules.splice(toIdx, 0, moved);
        brsMarkDirty();
        brsRender();
      });
    });
    // Sentence-row reordering (within a card only).
    // Drag source is the ⋮⋮ handle span (draggable=true); drop target is the
    // whole <tr>. Cross-card drops are blocked silently — handle stays grabbed,
    // cursor reflects no-drop, drop is a no-op.
    let _dragSentRuleId = null;
    let _dragSentSentId = null;
    let _dragSentSourceTr = null;
    container.querySelectorAll('[data-brs-sent-handle]').forEach(handle => {
      handle.addEventListener('dragstart', (e) => {
        const tr = handle.closest('[data-brs-sent-row]');
        if (!tr) return;
        _dragSentRuleId = tr.dataset.brsSentRule;
        _dragSentSentId = tr.dataset.brsSentId;
        _dragSentSourceTr = tr;
        tr.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
        // Required for Firefox — needs SOME data set on the transfer
        try { e.dataTransfer.setData('text/plain', _dragSentSentId); } catch (_) {}
      });
      handle.addEventListener('dragend', () => {
        if (_dragSentSourceTr) _dragSentSourceTr.style.opacity = '';
        _dragSentRuleId = null;
        _dragSentSentId = null;
        _dragSentSourceTr = null;
      });
    });
    container.querySelectorAll('[data-brs-sent-row]').forEach(tr => {
      tr.addEventListener('dragover', (e) => {
        if (!_dragSentRuleId) return;
        const overRuleId = tr.dataset.brsSentRule;
        const overSentId = tr.dataset.brsSentId;
        if (overRuleId !== _dragSentRuleId) return;  // cross-card blocked
        if (overSentId === _dragSentSentId) return;  // self
        e.preventDefault();  // only allow drop when in same rule
        tr.style.borderTop = '3px solid #6c4f9f';
      });
      tr.addEventListener('dragleave', () => {
        tr.style.borderTop = '1px solid #e8e3d8';
      });
      tr.addEventListener('drop', (e) => {
        tr.style.borderTop = '1px solid #e8e3d8';
        const overRuleId = tr.dataset.brsSentRule;
        const overSentId = tr.dataset.brsSentId;
        if (!_dragSentRuleId || overRuleId !== _dragSentRuleId || overSentId === _dragSentSentId) return;
        e.preventDefault();
        const rule = brsRules.find(r => r.id === _dragSentRuleId);
        if (!rule) return;
        const fromIdx = (rule.sentences || []).findIndex(s => s.id === _dragSentSentId);
        const toIdx   = (rule.sentences || []).findIndex(s => s.id === overSentId);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = rule.sentences.splice(fromIdx, 1);
        rule.sentences.splice(toIdx, 0, moved);
        brsMarkDirty();
        brsRender();
      });
    });
  }

  // Segment-based sentence model. Each sentence holds an array of segments:
  //   {t:'text', v:'free prose'} OR {t:'dev', v:'@Device Name:channel'}
  // Invariant: starts + ends with a text segment; alternates text-dev-text-...
  const _BRS_LEGACY_DEV_RE = /@[A-Za-z0-9_\-][A-Za-z0-9_\-]*(?:\s+[A-Z0-9][A-Za-z0-9_\-]*){0,4}(?::[A-Za-z0-9_]+)?/g;

  function _brsEnsureSegments(s) {
    if (Array.isArray(s.segments) && s.segments.length) return;
    const text = s.text || '';
    const re = new RegExp(_BRS_LEGACY_DEV_RE.source, 'g');
    const segs = [];
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      segs.push({t:'text', v: text.slice(last, m.index)});
      segs.push({t:'dev',  v: m[0]});
      last = m.index + m[0].length;
    }
    segs.push({t:'text', v: text.slice(last)});
    s.segments = segs;
  }

  function _brsNormalize(segs) {
    const out = [];
    for (const seg of segs || []) {
      if (!seg) continue;
      if (seg.t === 'text') {
        if (out.length && out[out.length-1].t === 'text') out[out.length-1].v += seg.v || '';
        else out.push({t:'text', v: seg.v || ''});
      } else if (seg.t === 'dev') {
        if (!out.length || out[out.length-1].t !== 'text') out.push({t:'text', v:''});
        out.push({t:'dev', v: seg.v});
      }
    }
    if (!out.length || out[0].t !== 'text') out.unshift({t:'text', v:''});
    if (out[out.length-1].t !== 'text') out.push({t:'text', v:''});
    return out;
  }

  const _BRS_CELL_W = 150;        // device chip width (long device names)
  const _BRS_TEXT_MIN_W = 12;     // text input minimum — collapses tight between chips
  const _BRS_CELL_H = 26;

  // Inline (flex-strip) renderer — used when sentences live in a single
  // shared cell so each sentence's segments size independently of others.
  function _brsRenderSegmentInline(ruleId, s, segIdx, seg) {
    if (!seg) return '';
    if (seg.t === 'text') {
      const v = seg.v || '';
      const isFirstEmpty = (segIdx === 0 && s.segments.length === 1 && !v);
      const placeholder = isFirstEmpty ? 'e.g. between 17:00 and 22:30' : '';
      const isSeparator = !!v && /^\s*$/.test(v) && !isFirstEmpty;
      const visibleLen = v.replace(/^\s+|\s+$/g, '').length;
      const size = isSeparator ? 1 : Math.max(visibleLen + 1, isFirstEmpty ? 15 : 1);
      const inputStyle = isSeparator
        ? `width:6px;min-width:6px;height:${_BRS_CELL_H}px;box-sizing:border-box;border:none;background:transparent;padding:0;font-size:0.82rem;line-height:${_BRS_CELL_H - 2}px;`
        : `min-width:${_BRS_TEXT_MIN_W}px;height:${_BRS_CELL_H}px;box-sizing:border-box;border:1px solid #e8e3d8;border-radius:3px;padding:0 2px;font-size:0.82rem;background:#fff;line-height:${_BRS_CELL_H - 2}px;`;
      return `<input type="text" value="${brsEsc(v)}" size="${size}"
               data-brs-rule="${ruleId}" data-brs-sent="${s.id}" data-brs-seg="${segIdx}"
               oninput="brsUpdateSegText(this)"
               placeholder="${placeholder}"
               style="${inputStyle}" />`;
    }
    return `<span title="${brsEsc(seg.v)}" style="max-width:${_BRS_CELL_W}px;height:${_BRS_CELL_H}px;box-sizing:border-box;background:#6c4f9f14;color:#6c4f9f;border:1px solid #6c4f9f55;border-radius:4px;padding:0 2px;font-size:0.82rem;display:inline-flex;align-items:center;white-space:nowrap;line-height:1;gap:2px;overflow:hidden;">
        <span onclick="brsReplaceDevice('${ruleId}','${s.id}',${segIdx})" style="cursor:pointer;overflow:hidden;text-overflow:ellipsis;">${brsEsc(seg.v)}</span>
        <button onclick="brsRemoveDevice('${ruleId}','${s.id}',${segIdx})" title="Remove device"
                style="background:none;border:none;color:#c0392b;cursor:pointer;padding:0 2px;font-weight:bold;font-size:0.95rem;line-height:1;flex-shrink:0;">×</button>
      </span>`;
  }

  function _brsRenderSegmentCell(ruleId, s, segIdx, seg) {
    const tdBase = 'padding:4px 0;vertical-align:middle;';
    if (!seg) return `<td style="${tdBase}"></td>`;
    if (seg.t === 'text') {
      const v = seg.v || '';
      const isFirstEmpty = (segIdx === 0 && s.segments.length === 1 && !v);
      const placeholder = isFirstEmpty ? 'e.g. between 17:00 and 22:30' : '';
      // Whitespace-only segments are auto-inserted separators between chips.
      // Render them as nearly-invisible thin clickable spacers — they keep
      // the text segment in place (so chip ↔ text ↔ chip structure is valid)
      // but take ~4 px of visual width instead of full input chrome.
      const isSeparator = !!v && /^\s*$/.test(v) && !isFirstEmpty;
      const visibleLen = v.replace(/^\s+|\s+$/g, '').length;
      const size = isSeparator ? 1 : Math.max(visibleLen + 1, isFirstEmpty ? 15 : 1);
      const inputStyle = isSeparator
        ? `width:6px;min-width:6px;height:${_BRS_CELL_H}px;box-sizing:border-box;border:none;background:transparent;padding:0;font-size:0.82rem;line-height:${_BRS_CELL_H - 2}px;`
        : `min-width:${_BRS_TEXT_MIN_W}px;height:${_BRS_CELL_H}px;box-sizing:border-box;border:1px solid #e8e3d8;border-radius:3px;padding:0 2px;font-size:0.82rem;background:#fff;line-height:${_BRS_CELL_H - 2}px;`;
      return `<td style="${tdBase}">
        <input type="text" value="${brsEsc(v)}" size="${size}"
               data-brs-rule="${ruleId}" data-brs-sent="${s.id}" data-brs-seg="${segIdx}"
               oninput="brsUpdateSegText(this)"
               placeholder="${placeholder}"
               style="${inputStyle}" />
      </td>`;
    }
    return `<td style="${tdBase}">
      <span title="${brsEsc(seg.v)}" style="max-width:${_BRS_CELL_W}px;height:${_BRS_CELL_H}px;box-sizing:border-box;background:#6c4f9f14;color:#6c4f9f;border:1px solid #6c4f9f55;border-radius:4px;padding:0 2px;font-size:0.82rem;display:inline-flex;align-items:center;white-space:nowrap;line-height:1;gap:2px;overflow:hidden;">
        <span onclick="brsReplaceDevice('${ruleId}','${s.id}',${segIdx})" style="cursor:pointer;overflow:hidden;text-overflow:ellipsis;">${brsEsc(seg.v)}</span>
        <button onclick="brsRemoveDevice('${ruleId}','${s.id}',${segIdx})" title="Remove device"
                style="background:none;border:none;color:#c0392b;cursor:pointer;padding:0 2px;font-weight:bold;font-size:0.95rem;line-height:1;flex-shrink:0;">×</button>
      </span>
    </td>`;
  }

  window.brsUpdateSegText = function (el) {
    const ruleId = el.dataset.brsRule;
    const sentId = el.dataset.brsSent;
    const segIdx = Number(el.dataset.brsSeg);
    const rule = brsRules.find(r => r.id === ruleId);
    if (!rule) return;
    const s = (rule.sentences || []).find(x => x.id === sentId);
    if (!s || !s.segments || !s.segments[segIdx]) return;
    s.segments[segIdx].v = el.value;
    s.updated_at = new Date().toISOString();
    rule.updated_at = s.updated_at;
    brsMarkDirty();
    el.size = Math.max(el.value.length + 2, 15);
  };

  window.brsAppendDevice = function (ruleId, sentId) {
    if (typeof window.openDevicePicker !== 'function') { alert('Device picker not loaded'); return; }
    const rule = brsRules.find(r => r.id === ruleId);
    if (!rule) return;
    const s = (rule.sentences || []).find(x => x.id === sentId);
    if (!s) return;
    _brsEnsureSegments(s);
    window.openDevicePicker((token) => {
      s.segments.push({t:'dev', v: token});
      s.segments.push({t:'text', v: ' '});
      s.segments = _brsNormalize(s.segments);
      s.updated_at = new Date().toISOString();
      rule.updated_at = s.updated_at;
      brsMarkDirty();
      brsRender();
    });
  };

  window.brsRemoveDevice = function (ruleId, sentId, segIdx) {
    const rule = brsRules.find(r => r.id === ruleId);
    if (!rule) return;
    const s = (rule.sentences || []).find(x => x.id === sentId);
    if (!s || !s.segments || !s.segments[segIdx] || s.segments[segIdx].t !== 'dev') return;
    s.segments.splice(segIdx, 1);
    s.segments = _brsNormalize(s.segments);
    s.updated_at = new Date().toISOString();
    rule.updated_at = s.updated_at;
    brsMarkDirty();
    brsRender();
  };

  window.brsReplaceDevice = function (ruleId, sentId, segIdx) {
    if (typeof window.openDevicePicker !== 'function') { alert('Device picker not loaded'); return; }
    const rule = brsRules.find(r => r.id === ruleId);
    if (!rule) return;
    const s = (rule.sentences || []).find(x => x.id === sentId);
    if (!s || !s.segments || !s.segments[segIdx] || s.segments[segIdx].t !== 'dev') return;
    window.openDevicePicker((newToken) => {
      s.segments[segIdx].v = newToken;
      s.updated_at = new Date().toISOString();
      rule.updated_at = s.updated_at;
      brsMarkDirty();
      brsRender();
    });
  };

  function brsHandleEdit(el) {
    const ruleId = el.dataset.brsRule;
    const sentId = el.dataset.brsSent;
    const field  = el.dataset.brsField;
    const rule = brsRules.find(r => r.id === ruleId);
    if (!rule) return;
    const newVal = el.type === 'checkbox' ? el.checked : el.value;
    const now = new Date().toISOString();
    if (sentId) {
      const s = (rule.sentences || []).find(x => x.id === sentId);
      if (!s || s[field] === newVal) return;
      s[field] = newVal;
      s.updated_at = now;
      rule.updated_at = now;
      brsMarkDirty();
    } else {
      if (rule[field] === newVal) return;
      rule[field] = newVal;
      rule.updated_at = now;
      brsMarkDirty();
    }
  }

  window.brsAddRule = function () {
    const now = new Date().toISOString();
    brsRules.push({
      id: brsNewId('r'),
      name: '',
      active: true,
      sentences: [],
      added_at: now,
      updated_at: now,
    });
    brsMarkDirty();
    brsRender();
    const inputs = document.querySelectorAll('#brs-rules-container input[data-brs-field="name"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  };

  window.brsDeleteRule = function (ruleId) {
    const rule = brsRules.find(r => r.id === ruleId);
    if (!rule) return;
    if (!confirm(`Delete rule "${rule.name || '(unnamed)'}" and its ${rule.sentences ? rule.sentences.length : 0} sentence(s)?`)) return;
    brsRules = brsRules.filter(r => r.id !== ruleId);
    brsMarkDirty();
    brsRender();
  };

  window.brsAddSentence = function (ruleId) {
    const rule = brsRules.find(r => r.id === ruleId);
    if (!rule) return;
    if (!rule.sentences) rule.sentences = [];
    const now = new Date().toISOString();
    rule.sentences.push({
      id: brsNewId('s'),
      segments: [{t:'text', v:''}],
      active: true,
      added_at: now,
      updated_at: now,
    });
    rule.updated_at = now;
    brsMarkDirty();
    brsRender();
    const inputs = document.querySelectorAll(`#brs-rules-container input[data-brs-rule="${ruleId}"][data-brs-seg="0"]`);
    if (inputs.length) inputs[inputs.length - 1].focus();
  };

  window.brsDeleteSentence = function (ruleId, sentId) {
    const rule = brsRules.find(r => r.id === ruleId);
    if (!rule || !rule.sentences) return;
    rule.sentences = rule.sentences.filter(s => s.id !== sentId);
    rule.updated_at = new Date().toISOString();
    brsMarkDirty();
    brsRender();
  };

  window.brsSave = async function () {
    try {
      const r = await fetch(`/api/dashboard-settings/${encodeURIComponent(BRS_STORAGE_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: brsRules }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const sentCount = brsRules.reduce((acc, r) => acc + (r.sentences ? r.sentences.length : 0), 0);
      brsClearDirty();
      alert(`Saved ${brsRules.length} base rule(s), ${sentCount} sentence(s).`);
    } catch (e) {
      alert('Save failed: ' + (e.message || e));
    }
  };

  window.brsDiscard = async function () {
    if (brsDirty && !confirm('Discard all unsaved changes and reload from server?')) return;
    await brsLoad();
  };

  async function _brsMigrateTokens() {
    if (typeof window._dpFetchDevices !== 'function' || typeof window._dpMigrateToken !== 'function') return false;
    const devMap = await window._dpFetchDevices();
    if (!devMap || !devMap.size) return false;
    let changed = false;
    for (const rule of brsRules) {
      for (const s of (rule.sentences || [])) {
        _brsEnsureSegments(s);
        for (const seg of (s.segments || [])) {
          if (seg.t !== 'dev') continue;
          const nv = window._dpMigrateToken(seg.v, devMap);
          if (nv !== seg.v) { seg.v = nv; changed = true; }
        }
      }
    }
    return changed;
  }

  async function brsLoad() {
    try {
      const r = await fetch(`/api/dashboard-settings/${encodeURIComponent(BRS_STORAGE_KEY)}`);
      if (!r.ok) { brsRules = []; brsClearDirty(); brsRender(); return; }
      const j = await r.json();
      brsRules = Array.isArray(j.value) ? j.value : [];
      for (const r of brsRules) if (!Array.isArray(r.sentences)) r.sentences = [];
      await _brsMigrateTokens();
      // Migration is cosmetic — don't flag dirty. The rewrite piggy-backs on the
      // next real save the user performs.
      brsClearDirty();
      brsRender();
    } catch (e) {
      brsRules = [];
      brsClearDirty();
      brsRender();
    }
  }

  window.addEventListener('DOMContentLoaded', brsLoad);
})();

// ─── Corridor Simulator tab ────────────────────────────────────────────
// Monitor + trigger surface for the planned Corridor → FR → RemoteXY door
// chain. Architecture: server.js owns the MQTT client (rule_engine creds,
// full read access), subscribes to /event /state /status /command for the
// 4 chain devices, keeps a 50-message ring buffer. Browser just polls
// /api/corridor-sim/state every 1 s — no MQTT lib, no WS lifecycle, no
// browser cache surprises. The ring buffer is captured live, so it
// includes EVERY message on the bus (commands, statuses, events) — not
// just what gets persisted to device_events.
(function () {
  let started    = false;
  let _pollTimer = null;
  // _paused persists across page navigations via sessionStorage — without
  // this, navigating away from Main Agent and back reset the flag to false
  // and the feed would resume updating even though the user had explicitly
  // stopped it. sessionStorage scopes to the browser tab, so closing the
  // tab still clears the pause (correct: fresh tab, fresh state).
  const PAUSE_KEY = 'corridorSim.paused';
  let _paused    = sessionStorage.getItem(PAUSE_KEY) === '1';
  let _events    = [];                          // last poll's events (server is source of truth)
  const POLL_MS = 1000;

  const PRESENCE_ID         = 'bfbdca138cb1c78c3dlbmc';
  const COR_SWITCH_ID       = 'bfe47a84d7cb783f59inot';
  const ENTRANCE_MONITOR_ID = 'bfb4de883ef1713bfdfdpw';   // Ch.2 — added 2026-05-15
  const FR_ID               = 'face_01';
  const REMOTEXY_ID         = 'remoteXY_01';

  function escH(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ageBadge(secs) {
    if (secs == null) return '<span style="color:#888;">—</span>';
    if (secs < 60)   return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    return `${Math.floor(secs / 3600)}h ago`;
  }
  function dot(on) {
    return on ? '<span style="color:#3a7d44;">●</span>' : '<span style="color:#888;">○</span>';
  }

  function topicMeta(topic) {
    const parts = String(topic || '').split('/');
    if (parts[0] === 'mur' && parts[1] === 'home' && parts[2] === 'device' && parts.length === 5) {
      const id = parts[3];
      const name = id === PRESENCE_ID         ? 'Corridor Presence'
                : id === COR_SWITCH_ID       ? 'Corridor Switch'
                : id === ENTRANCE_MONITOR_ID ? 'Entrance Monitor'
                : id;
      return { name, suffix: parts[4], color: '#3a7d44' };
    }
    if (parts[0] === 'mur' && parts[1] === 'home' && parts[2] === 'esp' && parts.length === 5) {
      const id = parts[3];
      const name = id === FR_ID ? 'Face Recognition'
                : id === REMOTEXY_ID ? 'RemoteXY' : id;
      const suffix = parts[4];
      let color;
      if      (suffix === 'command') color = '#e67e22';
      else if (suffix === 'event')   color = '#8e44ad';
      else if (suffix === 'status')  color = '#1565c0';
      else                           color = '#888';
      return { name, suffix, color };
    }
    // Pixoo command — flat topic, no per-device id.
    if (parts[0] === 'mur' && parts[1] === 'home' && parts[2] === 'pixoo' && parts.length === 4) {
      return { name: 'Pixoo', suffix: parts[3], color: '#e67e22' };
    }
    // Awtrix — flat topic, device id IS the prefix.
    if (parts[0] === 'awtrix_05ec2c' && parts.length === 2) {
      return { name: 'Awtrix', suffix: parts[1], color: '#e67e22' };
    }
    return { name: topic, suffix: '', color: '#888' };
  }

  // Update only the .cs-dev-state innerHTML in each device card per poll.
  // Buttons + result text + checkbox are stable — only the state line in
  // each card rerenders. This preserves typed/clicked widgets across polls
  // (e.g. the "actually pulse the relay" checkbox state, in-flight result
  // messages like "Sending…").
  function renderLiveState(s) {
    const presPresent = !!(s.presence && s.presence.last_state
      && (s.presence.last_state['1'] === true || s.presence.last_state['1'] === 'true' || s.presence.last_state['1'] === 'presence'));
    const switchOn    = !!(s.cor_switch && s.cor_switch.last_state
      && (s.cor_switch.last_state['1'] === true || s.cor_switch.last_state['1'] === 'true'));
    // Entrance Monitor is a 3-gang switch; only Ch.2 is exposed in the simulator.
    const emonOn      = !!(s.entrance_monitor && s.entrance_monitor.last_state
      && (s.entrance_monitor.last_state['2'] === true || s.entrance_monitor.last_state['2'] === 'true'));
    const frStatus    = (s.fr.board && s.fr.board.last_status) || {};
    const screenOn    = frStatus.screen_state === 'on';
    const lastRecog   = frStatus.last_recognition || '—';
    const rxStatus    = (s.remotexy.board && s.remotexy.board.last_status) || {};
    const doorRelay   = rxStatus.door_relay === true || rxStatus.door_relay === 'true';

    const stateLine = (label, content, age) => `
      <div class="cs-state-line">
        <span class="cs-state-label">${escH(label)}</span>
        <span class="cs-state-value">${content}</span>
        <span class="cs-state-age">${age != null ? ageBadge(age) : '—'}</span>
      </div>`;

    document.getElementById('cs-state-presence').innerHTML =
      stateLine('Presence', `${dot(presPresent)} ${presPresent ? 'present' : 'idle'}`, s.presence ? s.presence.age_sec : null);

    document.getElementById('cs-state-switch').innerHTML =
      stateLine('Light',    `${dot(switchOn)} ${switchOn ? 'ON' : 'off'}`,             s.cor_switch ? s.cor_switch.age_sec : null);

    document.getElementById('cs-state-emon').innerHTML =
      stateLine('Ch.2',     `${dot(emonOn)} ${emonOn ? 'ON' : 'off'}`,                 s.entrance_monitor ? s.entrance_monitor.age_sec : null);

    // FR card has TWO state lines: screen + last recognition
    document.getElementById('cs-state-fr').innerHTML =
      stateLine('Screen',   `${dot(screenOn)} ${screenOn ? 'on' : 'off'}`,             s.fr.board ? s.fr.board.age_sec : null)
      + stateLine('Last',   escH(lastRecog),                                            s.fr.board ? s.fr.board.age_sec : null);

    document.getElementById('cs-state-door').innerHTML =
      stateLine('Relay',    `${dot(doorRelay)} ${doorRelay ? 'PULSING' : 'idle'}`,     s.remotexy.board ? s.remotexy.board.age_sec : null);

    // Pixoo — two state lines:
    //   1. ONE of: Preset name (when Pixoo's drawing channel is showing
    //      a preset we pushed) OR the channel name (when user switched
    //      the Pixoo to Cloud / Faces / Sound / Custom Scene via the
    //      physical button, bypassing what we pushed). The drawing
    //      channel is 4 — anything else means the matrix isn't showing
    //      our preset right now.
    //   2. Bright — brightness % + power indicator (LightSwitch).
    const pix = s.pixoo;
    const onDrawingChannel = pix && pix.channel_idx === 4;
    let label = '—', value = '—', ageSec = null;
    if (pix) {
      if (onDrawingChannel && pix.screen) {
        // Our pushed content is actually live on the matrix
        if (pix.screen.startsWith('preset:')) {
          label = 'Preset';
          value = pix.screen.slice('preset:'.length);
        } else {
          label = 'Screen';
          value = pix.screen;
        }
        ageSec = pix.age_sec;
      } else if (pix.channel_name) {
        // User switched the Pixoo to a built-in channel (or device is off)
        label = 'Channel';
        value = pix.channel_name;
      }
    }
    const brightVal = pix && pix.brightness != null
      ? `${pix.power_on ? '<span style="color:#3a7d44;">●</span>' : '<span style="color:#888;">○</span>'} ${pix.brightness}%`
      : '—';
    document.getElementById('cs-state-pixoo').innerHTML =
      stateLine(label, escH(value), ageSec)
      + stateLine('Bright', brightVal, null);
  }

  function renderEvents(events) {
    const tbody = document.querySelector('#cs-events tbody');
    if (!events || !events.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="padding:6px;color:#888;">awaiting first message…</td></tr>`;
      return;
    }
    tbody.innerHTML = events.map(r => {
      const m = topicMeta(r.topic);
      const payloadStr = (typeof r.payload === 'object') ? JSON.stringify(r.payload) : String(r.payload || '');
      return `<tr>
        <td style="padding:4px 8px;font-variant-numeric:tabular-nums;">${new Date(r.ts).toLocaleTimeString()}</td>
        <td style="padding:4px 8px;">${escH(m.name)}</td>
        <td style="padding:4px 8px;color:${m.color};font-weight:600;">${escH(m.suffix)}</td>
        <td style="padding:4px 8px;font-family:monospace;font-size:0.78rem;color:#333;">${escH(payloadStr)}</td>
      </tr>`;
    }).join('');
  }

  // Render one button per enrolled user + a single Unknown button. Buttons
  // are dynamic from face_01.last_status.users; if no users are enrolled
  // yet, falls back to a single "user_0" placeholder. Dataset sig avoids
  // re-rendering the row on every poll (which would kill click events
  // mid-handler and reset focus styling).
  function renderFrUserPicker(frUsers) {
    const host = document.getElementById('cs-fr-buttons');
    if (!host) return;
    const list = Array.isArray(frUsers) && frUsers.length ? frUsers : [{ id: 0, name: 'user_0' }];
    const sig = list.map(u => `${u.id}|${u.name}`).join(',');
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    const userBtns = list.map(u =>
      `<button class="cs-sim-btn cs-sim-btn-blue" data-fr-user-id="${escH(u.id)}" data-fr-user-name="${escH(u.name)}">▶ ${escH(u.name)}</button>`
    ).join('');
    host.innerHTML = userBtns + `<button class="cs-sim-btn cs-sim-btn-red" id="cs-btn-fr-unknown">▶ Unknown</button>`;
    // Wire the freshly-rendered buttons. Per-user buttons share one handler
    // via the data-fr-user-* attributes.
    host.querySelectorAll('[data-fr-user-id]').forEach(btn => {
      btn.onclick = () => {
        const uid  = btn.dataset.frUserId;
        const name = btn.dataset.frUserName;
        trigger('/api/corridor-sim/trigger-fr-event',
          { kind: 'face_identified', user_id: Number.parseInt(uid, 10), user_name: name },
          'cs-fr-result',
          `published face_identified ${name}`);
      };
    });
    document.getElementById('cs-btn-fr-unknown').onclick = () =>
      trigger('/api/corridor-sim/trigger-fr-event', { kind: 'face_unknown', reason: 'no_match' }, 'cs-fr-result', 'published face_unknown');
  }

  function setStatus(text, color) {
    const el = document.getElementById('cs-events-status');
    if (el) { el.textContent = text; el.style.color = color; }
  }

  async function poll() {
    try {
      const r = await fetch('/api/corridor-sim/state');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const s = await r.json();
      renderLiveState(s);
      const frUsers = s.fr && s.fr.board && s.fr.board.last_status && s.fr.board.last_status.users;
      renderFrUserPicker(frUsers);
      if (!_paused && Array.isArray(s.events)) {
        const newKey = s.events.length ? `${s.events[0].ts}|${s.events[0].topic}` : '';
        const oldKey = _events.length  ? `${_events[0].ts}|${_events[0].topic}` : '';
        if (newKey !== oldKey) {
          _events = s.events;
          renderEvents(_events);
        }
      }
      setStatus(_paused ? '⏸ paused' : '● live', _paused ? '#888' : '#3a7d44');
    } catch (e) {
      setStatus('✗ ' + e.message, '#c0392b');
    }
  }

  async function trigger(url, body, resultId, successText) {
    const el = document.getElementById(resultId);
    el.style.color = '#666';
    el.textContent = 'Sending…';
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      el.style.color = '#3a7d44';
      el.textContent = '✓ ' + successText;
      setTimeout(poll, 200);
    } catch (e) {
      el.style.color = '#c0392b';
      el.textContent = '✗ ' + e.message;
    }
  }

  function wireButtons() {
    document.getElementById('cs-btn-presence-on').onclick = () =>
      trigger('/api/corridor-sim/trigger-presence', { value: true  }, 'cs-presence-result', 'published "present"');
    document.getElementById('cs-btn-presence-off').onclick = () =>
      trigger('/api/corridor-sim/trigger-presence', { value: false }, 'cs-presence-result', 'published "absent"');

    // FR result buttons are wired inside renderFrUserPicker (rendered
    // dynamically per enrolled user), not here.

    // FR Screen on/off — real commands to the FR board's /command topic.
    // The board responds with /event ack + /status update reflecting the
    // new screen_state, both visible in Recent Events.
    document.getElementById('cs-btn-screen-on').onclick = () =>
      trigger(`/api/esp/boards/${FR_ID}/command`, { action: 'screen_on' },  'cs-fr-result', 'screen_on sent');
    document.getElementById('cs-btn-screen-off').onclick = () =>
      trigger(`/api/esp/boards/${FR_ID}/command`, { action: 'screen_off' }, 'cs-fr-result', 'screen_off sent');

    // Corridor Switch on/off — real HA toggle (no separate "simulator"
    // shape needed since the switch is a normal device, not a sensor we
    // need to fake events for). Result is the same as clicking it on the
    // Devices page.
    document.getElementById('cs-btn-light-on').onclick = () =>
      trigger(`/api/devices/${COR_SWITCH_ID}/toggle`, { state: true,  channel: '1' }, 'cs-light-result', 'light ON');
    document.getElementById('cs-btn-light-off').onclick = () =>
      trigger(`/api/devices/${COR_SWITCH_ID}/toggle`, { state: false, channel: '1' }, 'cs-light-result', 'light OFF');

    // Entrance Monitor — same toggle path Corridor Light uses (Tuya local
    // device, HA-mediated turn_on/off via the device-toggle endpoint's
    // tuya-template fallback). Channel '2' is the only exposed gang.
    document.getElementById('cs-btn-emon-on').onclick = () =>
      trigger(`/api/devices/${ENTRANCE_MONITOR_ID}/toggle`, { state: true,  channel: '2' }, 'cs-emon-result', 'entrance monitor ON');
    document.getElementById('cs-btn-emon-off').onclick = () =>
      trigger(`/api/devices/${ENTRANCE_MONITOR_ID}/toggle`, { state: false, channel: '2' }, 'cs-emon-result', 'entrance monitor OFF');

    document.getElementById('cs-btn-door').onclick = () => {
      const reallyFire = document.getElementById('cs-door-real').checked;
      if (reallyFire) {
        trigger(`/api/esp/boards/${REMOTEXY_ID}/command`, { action: 'open_doorlock' }, 'cs-door-result', 'open_doorlock sent — relay pulsing');
      } else {
        // Dry-run — DON'T publish to MQTT (relay stays put). Just show in UI
        // that we would have fired. No ring-buffer entry either — the whole
        // point of dry-run is no broker activity.
        const el = document.getElementById('cs-door-result');
        el.style.color = '#e67e22';
        el.textContent = '⊘ dry-run: would have published open_doorlock — relay NOT pulsed';
      }
    };

    const stopBtn  = document.getElementById('cs-events-stop');
    const startBtn = document.getElementById('cs-events-start');
    const clearBtn = document.getElementById('cs-events-clear');
    stopBtn.onclick = () => {
      _paused = true;
      sessionStorage.setItem(PAUSE_KEY, '1');
      stopBtn.style.display  = 'none';
      startBtn.style.display = '';
      setStatus('⏸ paused', '#888');
    };
    startBtn.onclick = () => {
      _paused = false;
      sessionStorage.removeItem(PAUSE_KEY);
      startBtn.style.display = 'none';
      stopBtn.style.display  = '';
      setStatus('● live', '#3a7d44');
    };
    // Restore visual state from the persisted _paused flag — if user
    // navigated back into a tab where they had previously stopped updates,
    // the buttons + badge must reflect that immediately, not flicker through
    // 'live' first.
    if (_paused) {
      stopBtn.style.display  = 'none';
      startBtn.style.display = '';
      setStatus('⏸ paused', '#888');
    }
    clearBtn.onclick = async () => {
      try {
        await fetch('/api/corridor-sim/clear', { method: 'POST' });
        _events = [];
        renderEvents(_events);
      } catch (e) {}
    };
  }

  window.corridorSim_start = function () {
    if (started) return;
    started = true;
    console.log('[corridor-sim v49] server-side MQTT capture, 1 s HTTP polling, 6 chain devices');
    wireButtons();
    poll();
    _pollTimer = setInterval(poll, POLL_MS);
  };
})();
