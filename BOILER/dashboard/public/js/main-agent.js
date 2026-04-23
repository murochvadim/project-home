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
      const allKeys = [];
      const keySet = new Set();
      sorted.forEach(e => {
        if (e.event_type === 'state_changed') {
          _extractKeys(e.result).forEach(k => {
            if (!keySet.has(k) && !redundantKeys.has(k)) { keySet.add(k); allKeys.push(k); }
          });
        } else {
          const k = e.event_type;
          if (!keySet.has(k) && k !== 'skipped') { keySet.add(k); allKeys.push(k); }
        }
      });

      // Build time buckets with counts per key
      const bucketMap = {};
      sorted.forEach(e => {
        const ts = new Date(e.ts).getTime();
        const bucket = Math.floor(ts / resMs) * resMs;
        if (!bucketMap[bucket]) bucketMap[bucket] = {};
        const keys = e.event_type === 'state_changed' ? _extractKeys(e.result) : [e.event_type];
        keys.forEach(k => { bucketMap[bucket][k] = (bucketMap[bucket][k] || 0) + 1; });
      });

      // Sort buckets chronologically
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
        const counts = bucketMap[ts];
        html += '<tr style="border-bottom:1px solid #f0ebe3;">';
        html += `<td style="padding:3px 8px;color:#888;font-size:0.72rem;white-space:nowrap;">${time}</td>`;
        allKeys.forEach(k => {
          const count = counts[k] || 0;
          const val = count === 0 ? '—' : count;
          html += `<td style="text-align:center;padding:3px 6px;font-size:0.75rem;border-radius:3px;${cellStyle(count)}">${val}</td>`;
        });
        html += '</tr>';
      });

      html += '</tbody></table>';
      html += `<div style="font-size:0.68rem;color:#aaa;margin-top:6px;padding:0 8px;">Number = how many times this state key changed in the time bucket. Bold = 3+ changes. — = no change.</div>`;
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

      const people = parseInt(s.people_home) || 0;
      const peopleEl = document.getElementById('stat-people');
      peopleEl.textContent = people;
      peopleEl.className = 'stat-val ' + (people === 0 ? 'p0' : people === 1 ? 'p1' : 'pm');

      const activeCount = parseInt(s.active_room_count) || 0;
      document.getElementById('stat-active-rooms').textContent = activeCount;
      document.getElementById('stat-last-room').textContent = s.last_motion_room || '—';

      const lastMotionTs = parseFloat(s['_timer:last_motion']) || 0;
      // Format time without "ago" suffix — label already says context
      const motionAgo = lastMotionTs ? formatTimeAgo(lastMotionTs).replace(' ago', '') : '—';
      document.getElementById('stat-motion-ago').textContent = motionAgo;

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
      const maxSegs = (rule.sentences || []).reduce((m, s) => Math.max(m, (s.segments || []).length), 0) || 1;
      const segHeaderRow = Array.from({length: maxSegs}, (_, i) => {
        const lbl = (i % 2 === 0) ? 'text' : 'device';
        return `<th style="padding:3px 6px;text-align:left;font-weight:normal;color:#aaa;">${lbl}</th>`;
      }).join('');
      const sentencesHtml = (rule.sentences || []).map((s, sIdx) => {
        const segCells = Array.from({length: maxSegs}, (_, segIdx) => {
          const seg = s.segments[segIdx];
          return _brsRenderSegmentCell(rule.id, s, segIdx, seg);
        }).join('');
        return `
        <tr style="border-top:1px solid #e8e3d8;">
          <td style="padding:4px 6px;text-align:center;width:36px;color:#888;font-size:0.78rem;vertical-align:middle;">${sIdx + 1}.</td>
          <td style="padding:4px 6px;text-align:center;width:40px;vertical-align:middle;">
            <input type="checkbox" ${s.active ? 'checked' : ''} data-brs-rule="${rule.id}" data-brs-sent="${s.id}" data-brs-field="active" style="margin:0;" />
          </td>
          ${segCells}
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

  const _BRS_CELL_W = 150;
  const _BRS_CELL_H = 26;
  function _brsRenderSegmentCell(ruleId, s, segIdx, seg) {
    const tdBase = 'padding:4px 4px;vertical-align:middle;';
    if (!seg) return `<td style="${tdBase}"></td>`;
    if (seg.t === 'text') {
      const v = seg.v || '';
      const isFirstEmpty = (segIdx === 0 && s.segments.length === 1 && !v);
      const placeholder = isFirstEmpty ? 'e.g. between 17:00 and 22:30' : '';
      const size = Math.max(v.length + 2, 15);
      return `<td style="${tdBase}">
        <input type="text" value="${brsEsc(v)}" size="${size}"
               data-brs-rule="${ruleId}" data-brs-sent="${s.id}" data-brs-seg="${segIdx}"
               oninput="brsUpdateSegText(this)"
               placeholder="${placeholder}"
               style="min-width:${_BRS_CELL_W}px;height:${_BRS_CELL_H}px;box-sizing:border-box;border:1px solid #e8e3d8;border-radius:3px;padding:0 6px;font-size:0.82rem;background:#fff;line-height:${_BRS_CELL_H - 2}px;" />
      </td>`;
    }
    return `<td style="${tdBase}">
      <span title="${brsEsc(seg.v)}" style="width:${_BRS_CELL_W}px;height:${_BRS_CELL_H}px;box-sizing:border-box;background:#6c4f9f14;color:#6c4f9f;border:1px solid #6c4f9f55;border-radius:4px;padding:0 4px 0 8px;font-size:0.82rem;display:flex;align-items:center;justify-content:space-between;white-space:nowrap;line-height:1;gap:4px;overflow:hidden;">
        <span onclick="brsReplaceDevice('${ruleId}','${s.id}',${segIdx})" style="cursor:pointer;overflow:hidden;text-overflow:ellipsis;flex:1;">${brsEsc(seg.v)}</span>
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
