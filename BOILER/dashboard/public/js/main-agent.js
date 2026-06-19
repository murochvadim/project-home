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

  // Reset just the Runs counter for one rule. Engine picks up within ≤60s.
  // The current row's runs cell is updated optimistically; subsequent polls
  // will reflect the engine-confirmed reset.
  window.resetRuleRuns = async function (name) {
    try {
      const r = await fetch('/api/rule-engine/reset-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule: name }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // Optimistic UI: zero the Runs cell for this rule's row.
      document.querySelectorAll('#rules-body tr').forEach(tr => {
        const nameCell = tr.querySelector('.rule-name');
        if (nameCell && nameCell.textContent.trim().startsWith(name)) {
          // Runs is the 6th td (group-dot, name, group, pri, time, runs, ...)
          // — but with section grouping we now have 11 columns, runs is 7th.
          // Cell indexing instead: find by the 'text-align:center' cells positioning.
          const cells = tr.querySelectorAll('td');
          // Order: dot, name, group, pri, time, runs, dispatch, last_fired, enabled, actions (10 cols)
          if (cells.length >= 10 && cells[5]) cells[5].textContent = '0';
        }
      });
    } catch (e) {
      console.warn('reset runs failed:', e.message);
    }
  };

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

  // Mode Buttons row test-fire — physically toggles the 8 Gang Switch relay
  // for the chosen mode via the same endpoint the Home State Simulator uses
  // (POST /api/corridor-sim/set-home-mode). The endpoint pre-cleans the other
  // two channels (turn_off in parallel) before turning the target on, so the
  // device never shows a transient multi-on state. The real device event then
  // flows through device-agent → MQTT → rule engine, identical to a wall
  // press. Mode Buttons rule reacts and updates home_mode.
  // Mode-button color palette — shared by the tab-bar `home mode:` chip,
  // the Home State Simulator card, and the Mode Buttons rule-row test buttons.
  // IIFE-level so every caller sees the same constants.
  const modeColor = m => (m === 'home'   ? '#27ae60'
                        : m === 'away'   ? '#e67e22'
                        : m === 'abroad' ? '#c0392b'
                        : '#888');

  // Rules whose Test/Force buttons are hidden from the rule table.
  // Two reasons rules end up here:
  //  1. Heartbeat-only rules — engine's synthesized presence-event test is
  //     rejected by the rule's `device_id == 'heartbeat'` guard; result is
  //     always 'no_action'. (Evening Lights, Morning Lights, Start Away Mode.)
  //  2. Rules whose test fire would have real-world side effects user wants
  //     to avoid accidentally triggering. (Move in Corridor — Force would
  //     dispatch the full corridor light + monitor + Awtrix + FR + Pixoo
  //     chain on real hardware.)
  // Keep ↺ Reset Runs visible.
  // Test/Force buttons were removed from ALL rules (2026-06-11) — the rule-row
  // default renders no per-rule action buttons. Only Mode Buttons
  // (HOME/AWAY/ABROAD), the RULES_RUN_BUTTON "Run", and ↺ Reset Runs remain.
  // Rules that get a single red "Run" button. Run uses the engine Force path
  // with the rule's own test_event (source='force_run'), so the rule fires
  // EXACTLY as declared — gates + latch honored, only the trigger moment
  // simulated.
  const RULES_RUN_BUTTON = new Set([
    'Evening Lights',
    'Morning Lights',
    'My Bathroom Lights',
    'Laundry Light',
    'Dressroom Lights',
  ]);
  window.testModeButton = async function (mode) {
    const el = document.getElementById('test-result');
    if (el) {
      el.style.display = 'block';
      el.style.background = '#f0ebe3';
      el.style.borderLeft = '4px solid ' + modeColor(mode);
      el.innerHTML = `Pressing <b>${escHtml(mode.toUpperCase())}</b> relay on 8 Gang Switch...`;
    }
    try {
      const r = await fetch('/api/corridor-sim/set-home-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        if (el) {
          el.style.background = 'rgba(231,76,60,0.1)';
          el.style.borderLeft = '4px solid #e74c3c';
          el.innerHTML = `Mode Buttons → <b>${escHtml(mode.toUpperCase())}</b> — <span style="color:#e74c3c;">${escHtml(data.error || 'failed')}</span>`;
        }
      } else {
        if (el) {
          el.style.background = 'rgba(39,174,96,0.06)';
          el.style.borderLeft = '4px solid ' + modeColor(mode);
          el.innerHTML =
            `Mode Buttons → <b style="color:${modeColor(mode)};">${escHtml(mode.toUpperCase())}</b> — relay press dispatched<br>` +
            `<span style="color:#888;font-size:0.75rem;">channel=${escHtml(data.channel)}, cleared off=[${(data.cleared_off || []).map(escHtml).join(',')}]</span><br>` +
            `<span style="color:#888;font-size:0.75rem;">Real device event will fire Mode Buttons; chip updates after the next state poll.</span>`;
        }
        setTimeout(() => { if (typeof loadState === 'function') loadState(); }, 1500);
      }
    } catch (e) {
      if (el) {
        el.style.background = 'rgba(231,76,60,0.1)';
        el.style.borderLeft = '4px solid #e74c3c';
        el.innerHTML = `Mode Buttons → <b>${escHtml(mode.toUpperCase())}</b> — <span style="color:#e74c3c;">Connection error</span>`;
      }
    }
    // Close button — added on EVERY path (success / error / catch) so the
    // panel can always be dismissed. Mirrors testRule's pattern.
    if (el) {
      el.innerHTML += `<button onclick="this.parentElement.style.display='none'" style="position:absolute;top:6px;right:8px;background:none;border:none;cursor:pointer;color:#888;font-size:1rem;" title="Close">&times;</button>`;
    }
  };

  window.setHomeMode = async function (mode) {
    const resultEl = document.getElementById('hsm-result');
    try {
      if (resultEl) { resultEl.textContent = '...'; resultEl.style.color = '#888'; }
      const r = await fetch('/api/corridor-sim/set-home-mode', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mode }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        if (resultEl) { resultEl.textContent = '✗ ' + (data.error || 'failed'); resultEl.style.color = '#c0392b'; }
        return;
      }
      if (resultEl) {
        resultEl.textContent = `✓ ${mode} simulated`;
        resultEl.style.color = '#27ae60';
        setTimeout(() => { if (resultEl.textContent.startsWith('✓')) resultEl.textContent = ''; }, 3000);
      }
      // Force-refresh state poll so hsm-current updates quickly.
      if (typeof loadState === 'function') loadState();
    } catch (e) {
      console.error('setHomeMode failed:', e);
      if (resultEl) { resultEl.textContent = '✗ connection error'; resultEl.style.color = '#c0392b'; }
    }
  };

  // ── FR Diagnostics ───────────────────────────────────────────────────────
  // Two toggles in a dedicated card on the Corridor Simulator tab:
  //   • FR Debug Mode — publishes action debug_enable / debug_disable to
  //     /api/esp/boards/face_01/command. Only works when face_01 is on
  //     sketch v16+ (older sketches reject the unknown action).
  //   • Door Unlock on FR Match — flips the s_frl1_unlock chip's action
  //     between "on" and "off". When "off", the rule engine drops the
  //     unlock command silently because RemoteXY Gate has no action_off.
  //   Both states polled every 5 s by loadFrDiagnostics().

  window.setFrDebug = async function (enabled) {
    const resultEl = document.getElementById('fr-debug-result');
    try {
      if (resultEl) { resultEl.textContent = '...'; resultEl.style.color = '#888'; }
      const action = enabled ? 'debug_enable' : 'debug_disable';
      const r = await fetch('/api/esp/boards/face_01/command', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        if (resultEl) {
          resultEl.textContent = '✗ ' + (data.error || 'failed') +
            (data.error && data.error.includes('unknown') ? ' (flash v16 first)' : '');
          resultEl.style.color = '#c0392b';
        }
        return;
      }
      if (resultEl) {
        resultEl.textContent = `✓ ${action} sent`;
        resultEl.style.color = '#27ae60';
        setTimeout(() => { if (resultEl.textContent.startsWith('✓')) resultEl.textContent = ''; }, 3000);
      }
      setTimeout(loadFrDiagnostics, 1000);
    } catch (e) {
      console.error('setFrDebug failed:', e);
      if (resultEl) { resultEl.textContent = '✗ connection error'; resultEl.style.color = '#c0392b'; }
    }
  };

  window.setUnlockChip = async function (enabled) {
    const resultEl = document.getElementById('fr-unlock-result');
    try {
      if (resultEl) { resultEl.textContent = '...'; resultEl.style.color = '#888'; }
      const r = await fetch('/api/fr-diagnostics/unlock-chip', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ enabled }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        if (resultEl) { resultEl.textContent = '✗ ' + (data.error || 'failed'); resultEl.style.color = '#c0392b'; }
        return;
      }
      if (resultEl) {
        resultEl.textContent = `✓ chip set to "${data.new_action}" (rule cache 30 s)`;
        resultEl.style.color = '#27ae60';
        setTimeout(() => { if (resultEl.textContent.startsWith('✓')) resultEl.textContent = ''; }, 5000);
      }
      setTimeout(loadFrDiagnostics, 300);
    } catch (e) {
      console.error('setUnlockChip failed:', e);
      if (resultEl) { resultEl.textContent = '✗ connection error'; resultEl.style.color = '#c0392b'; }
    }
  };

  async function loadFrDiagnostics() {
    // FR Debug Mode — read from /api/esp/boards (last_status.debug_enabled)
    try {
      const r = await fetch('/api/esp/boards');
      const d = await r.json();
      const boards = d.boards || d || [];
      const face = boards.find(b => b && b.id === 'face_01');
      const debugOn = face && face.last_status && face.last_status.debug_enabled === true;
      const dbgEl = document.getElementById('fr-debug-current');
      if (dbgEl) {
        if (face && face.last_status && 'debug_enabled' in face.last_status) {
          dbgEl.textContent = debugOn ? 'ON' : 'OFF';
          dbgEl.style.color = debugOn ? '#27ae60' : '#888';
        } else {
          dbgEl.textContent = 'N/A';
          dbgEl.style.color = '#c0392b';
          dbgEl.title = 'Flash v16 to enable this feature';
        }
      }
    } catch (_) {}
    // Unlock chip — read from /api/fr-diagnostics/unlock-chip
    try {
      const r = await fetch('/api/fr-diagnostics/unlock-chip');
      const d = await r.json();
      const ulEl = document.getElementById('fr-unlock-current');
      if (ulEl) {
        if (r.ok && typeof d.enabled === 'boolean') {
          ulEl.textContent = d.enabled ? 'ON' : 'OFF';
          ulEl.style.color = d.enabled ? '#27ae60' : '#888';
        } else {
          ulEl.textContent = '?';
          ulEl.style.color = '#c0392b';
          ulEl.title = d.error || 'failed';
        }
      }
    } catch (_) {}
  }
  // Poll every 5 s while the Corridor Simulator tab is visible.
  // Lazy-init on first tab activation (we don't poll the FR diagnostics
  // endpoints on every page load — only when the user opens the tab).
  let _frDiagPollTimer = null;
  function startFrDiagnosticsPoll() {
    if (_frDiagPollTimer) return;
    loadFrDiagnostics();
    _frDiagPollTimer = setInterval(loadFrDiagnostics, 5000);
  }
  // Hook: when the user clicks the Corridor Simulator tab, start polling.
  document.addEventListener('DOMContentLoaded', () => {
    // If page loads with corridor-sim already active, start immediately.
    if (document.getElementById('tab-corridor-sim')?.classList.contains('active')) {
      startFrDiagnosticsPoll();
    }
    // Wrap showTab so we start polling when the user opens the tab.
    const _prevShowTab = window.showTab;
    window.showTab = function (name, btn) {
      if (typeof _prevShowTab === 'function') _prevShowTab(name, btn);
      if (name === 'corridor-sim') startFrDiagnosticsPoll();
    };
  });

  window.saveManualPeople = async function () {
    const inp = document.getElementById('manual-people-input');
    const btn = document.getElementById('manual-people-save');
    if (!inp) return;
    const raw = inp.value.trim();
    const orig = btn ? btn.textContent : 'Save';
    try {
      if (btn) { btn.textContent = '...'; btn.disabled = true; }
      const body = raw === '' ? { value: null } : { value: parseInt(raw, 10) };
      const r = await fetch('/api/main-agent/manual-people', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        if (btn) { btn.textContent = '✗'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500); }
        console.warn('saveManualPeople error:', data.error);
        return;
      }
      if (btn) { btn.textContent = '✓'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1000); }
      // Trigger an immediate re-fetch so the chip + input update.
      inp.blur();
      if (typeof loadState === 'function') loadState();
    } catch (e) {
      console.error('saveManualPeople failed:', e);
      if (btn) { btn.textContent = '✗'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500); }
    }
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

  window.updateReloadBadge = function (rulesLoaded, rulesOnDisk, reloadPending) {
    const btn = document.querySelector('[onclick="reloadRules()"]');
    if (!btn) return;
    const newCount = (rulesOnDisk || 0) - (rulesLoaded || 0);
    if (newCount > 0) {
      // A brand-new rule file appeared (count went up).
      btn.textContent = `Reload (${newCount} new)`;
      btn.style.background = '#e67e22';
      btn.style.color = '#fff';
    } else if (reloadPending) {
      // An existing rule file was edited on disk since the last load.
      btn.textContent = '⟳ Reload needed';
      btn.style.background = '#c0392b';
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

      // Manual people count — latest row in manual_people_log. NULL row
      // = cleared (door transition or user clear) → display "—".
      // Skipped while the input is focused so we don't overwrite typing.
      const manualInput = document.getElementById('manual-people-input');
      if (!manualInput || document.activeElement !== manualInput) {
        fetch('/api/main-agent/manual-people').then(r => r.json()).then(mp => {
          const mEl = document.getElementById('stat-manual-people');
          const inp = document.getElementById('manual-people-input');
          if (mp && mp.value !== null && mp.value !== undefined) {
            mEl.textContent = mp.value;
            mEl.className   = 'stat-val ' + colorClass(parseInt(mp.value) || 0);
            if (inp) inp.value = mp.value;
          } else {
            mEl.textContent = '—';
            mEl.className   = 'stat-val pending';
            if (inp) inp.value = '';
          }
        }).catch(() => { /* best-effort */ });
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
      const ctEl = document.getElementById('tmb-corridor-transit');
      const tmEl = document.getElementById('tmb-time-mode');
      const srEl = document.getElementById('tmb-next-sunrise');
      const ssEl = document.getElementById('tmb-next-sunset');
      // Corridor transit colour palette:
      //   clear     = green  (idle / safe — default state)
      //   visit     = amber  (someone in corridor, unknown intent)
      //   to_home   = green  (coming in)
      //   from_home = blue   (leaving)
      const transitColor = (m) => (m === 'Corridor_To_Home'    ? '#27ae60'
                                 : m === 'Corridor_From_Home'  ? '#2e74b5'
                                 : m === 'Corridor_Visit_Home' ? '#e67e22'
                                 : '#27ae60');
      // Strip the "Corridor_" prefix for a tighter tab-bar chip.
      const transitShort = (m) => (m || '').replace(/^Corridor_/, '').replace(/_/g, ' ').toLowerCase() || '—';
      if (hmEl) {
        hmEl.textContent = s.home_mode || '—';
        hmEl.style.color = modeColor(s.home_mode);
        hmEl.style.fontWeight = '600';
      }
      if (ctEl) {
        const ctMode = s['corridor_transit.mode'] || 'Corridor_Clear_Home';
        ctEl.textContent = transitShort(ctMode);
        ctEl.style.color = transitColor(ctMode);
        ctEl.style.fontWeight = '600';
        ctEl.title = ctMode;
      }
      if (tmEl) tmEl.textContent = s.time_mode || '—';
      if (srEl) srEl.textContent = fmtSunHM(s.next_sunrise);
      if (ssEl) ssEl.textContent = fmtSunHM(s.next_sunset);

      // Home State Simulator current-mode display (Corridor Simulator tab).
      const hsmEl = document.getElementById('hsm-current');
      if (hsmEl) {
        hsmEl.textContent = s.home_mode || '—';
        hsmEl.style.color = modeColor(s.home_mode);
      }

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
        // Group rules into the same 5 sections used by Base Rule Settings.
        // Mapping is by rule NAME (since 'info' group covers both Layer 0 and
        // Activity rules — name-level granularity is needed). Unmapped rules
        // fall into a section named after their group capitalized.
        const RULE_NAME_TO_SECTION = {
          'Home Time Periods':       'Apartment (Layer 0)',
          'Mode Buttons':            'Apartment (Layer 0)',
          'Apartment Location':      'Apartment (Layer 0)',
          'Home Activity':           'Activity',
          'People Home':             'Activity',
          'Evening Lights':          'Lighting',
          'Morning Lights':          'Lighting',
          'Start Away Mode':         'Mode transitions',
          'Move in Corridor':           'Corridor',
          'Face Recognition Loop':      'Corridor',
          'Corridor Transit Classifier':'Corridor',
          'Daily_Welcome':           'Pixoo',
          'Wallmote Handler':        'Living Room',
          'My Bathroom Lights':      'My BathRoom',
          'Boiler Consumption Classify': 'Boiler',
        };
        const SECTION_ORDER = [
          'Apartment (Layer 0)', 'Activity', 'Lighting', 'Mode transitions',
          'Corridor', 'Living Room', 'Balcony', 'My BathRoom', 'Laundry', 'Dressroom', 'Boiler', 'Pixoo', 'Power', 'Other',
        ];
        // Capitalize each dash-separated word. Special-case my-bathroom so
        // the rendered label matches the project's canonical "My BathRoom"
        // camelCase used in SECTION_ORDER + everywhere in CLAUDE.md.
        const cap = s => {
          if (!s) return 'Other';
          if (s === 'my-bathroom') return 'My BathRoom';
          return s.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
        };
        const sectionOf = r => RULE_NAME_TO_SECTION[r.name] || cap(r.group);

        // Bucket rules by section
        const buckets = {};
        rules.forEach(r => {
          const sec = sectionOf(r);
          (buckets[sec] = buckets[sec] || []).push(r);
        });
        const orderedSections = [
          ...SECTION_ORDER.filter(s => buckets[s]),
          ...Object.keys(buckets).filter(s => !SECTION_ORDER.includes(s)).sort(),
        ];

        const renderRule = r => {
          const enabled = !disabledRules.has(r.name);
          const st = r.stats || {};
          const runs = st.count || 0;
          // Dispatch time = avg evaluate + dispatch per fire (engine records
          // total_ms/count). Scene rules read ~0 — their per-device work runs
          // async on the engine's run_scene thread (see its log line).
          const dispatch = runs > 0 ? (st.total_ms / runs).toFixed(1) + 'ms' : '—';
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
            <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dotColor};" title="${escHtml(group)}"></span></td>
            <td class="rule-name"><span style="cursor:pointer;text-decoration:underline;" onclick="showRuleTrace('${escHtml(r.name)}')">${escHtml(r.name)}</span>${errorBadge}</td>
            <td style="font-size:0.78rem;color:#555;font-weight:500;">${escHtml(group)}</td>
            <td style="text-align:center">${priHtml}</td>
            <td style="text-align:center">${timeHtml}</td>
            <td style="text-align:center">${runs}</td>
            <td style="text-align:center">${dispatch}</td>
            <td style="font-size:0.75rem;color:#888;">${lastFired}</td>
            <td>
              <label class="toggle">
                <input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleRule('${escHtml(r.name)}', this.checked)">
                <span class="slider"></span>
              </label>
            </td>
            <td style="white-space:nowrap;">
              ${r.name === 'Mode Buttons' ? `
                <button class="btn btn-secondary btn-sm" onclick="testModeButton('home')" style="font-size:0.68rem;padding:2px 6px;background:${modeColor('home')};color:#fff;" title="Press the HOME relay on 8 Gang Switch (real switch event → rule fires)">HOME</button>
                <button class="btn btn-secondary btn-sm" onclick="testModeButton('away')" style="font-size:0.68rem;padding:2px 6px;background:${modeColor('away')};color:#fff;" title="Press the AWAY relay on 8 Gang Switch (real switch event → rule fires)">AWAY</button>
                <button class="btn btn-secondary btn-sm" onclick="testModeButton('abroad')" style="font-size:0.68rem;padding:2px 6px;background:${modeColor('abroad')};color:#fff;" title="Press the ABROAD relay on 8 Gang Switch (real switch event → rule fires)">ABROAD</button>
              ` : RULES_RUN_BUTTON.has(r.name) ? `
                <button class="btn btn-secondary btn-sm" onclick="testRule('${escHtml(r.name)}',true)" style="font-size:0.68rem;padding:2px 6px;background:#c0392b;color:#fff;" title="Run the rule exactly as declared (gates + latch honored, only the trigger moment is simulated) and dispatch for real">Run</button>
              ` : ``}
              <button class="btn btn-secondary btn-sm" onclick="resetRuleRuns('${escHtml(r.name)}')" style="font-size:0.68rem;padding:2px 6px;" title="Zero the Runs counter only (avg/max/last-fired stay) — engine applies within 60 s">↺</button>
            </td>
          </tr>`;
        };

        // Render sections — each gets a header row + its rules.
        rulesBody.innerHTML = orderedSections.map(sec => {
          const sectionRules = buckets[sec];
          const header = `<tr style="background:#efe9dc;">
            <td colspan="11" style="padding:6px 10px;border-left:4px solid #6c4f9f;">
              <strong style="color:#3b2766;font-size:0.85rem;">${escHtml(sec)}</strong>
              <span style="color:#888;font-size:0.72rem;margin-left:6px;">(${sectionRules.length} ${sectionRules.length === 1 ? 'rule' : 'rules'})</span>
            </td>
          </tr>`;
          return header + sectionRules.map(renderRule).join('');
        }).join('');
      }

      // ── Reload badge ──
      updateReloadBadge(rules.length, s._rules_on_disk, s._rules_reload_pending);

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

  // Visual grouping of containers in Base Rule Settings (since 2026-05-16).
  // Maps container id → section label. Containers not listed fall into
  // "Other". Section render order is determined by BRS_SECTION_ORDER.
  // Collapsed/expanded state persists in localStorage per section.
  const BRS_RULE_GROUPS = {
    'r_timemode_init':              'Apartment (Layer 0)',
    'r_modebuttons_init':           'Apartment (Layer 0)',
    'r_apartment_location_init':    'Apartment (Layer 0)',
    'r_home_activity_knobs':        'Activity',
    'r_people_home_knobs':          'Activity',
    'r_evening_lights_init':        'Lighting',
    'r_morning_lights_init':        'Lighting',
    'r_start_away_init':            'Mode transitions',
    'r_move_in_corridor':           'Corridor',
    'r_face_recognition_loop_init': 'Corridor',
    'r_corridor_transit_init':      'Corridor',
    'r_power_discovery_init':       'Power',
    'r_power_known_state_init':     'Power',
  };
  const BRS_SECTION_ORDER = [
    'Apartment (Layer 0)',
    'Activity',
    'Lighting',
    'Mode transitions',
    'Corridor',
    'Balcony',
    'My BathRoom',
    'Living Room',
    'Power',
    'Other',
  ];
  function brsSectionFor(ruleId) { return BRS_RULE_GROUPS[ruleId] || 'Other'; }
  function brsSectionCollapsed(label) {
    return localStorage.getItem(`brs_section_${label}`) === 'collapsed';
  }
  function brsSectionToggle(label) {
    const key = `brs_section_${label}`;
    if (localStorage.getItem(key) === 'collapsed') localStorage.removeItem(key);
    else localStorage.setItem(key, 'collapsed');
    brsRender();
  }
  window.brsSectionToggle = brsSectionToggle;

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

    // Group rules by section. Each rule retains its global brsRules index
    // so card.dataset.brsRuleCard + drag-reorder still work unchanged.
    const sectionMap = {};
    brsRules.forEach((rule, idx) => {
      const label = brsSectionFor(rule.id);
      (sectionMap[label] = sectionMap[label] || []).push({ rule, idx });
    });
    // Section render order: known labels first, then any unknown sections
    // (just in case BRS_SECTION_ORDER is out of date) in alphabetical order.
    const orderedLabels = [
      ...BRS_SECTION_ORDER.filter(l => sectionMap[l]),
      ...Object.keys(sectionMap).filter(l => !BRS_SECTION_ORDER.includes(l)).sort(),
    ];

    orderedLabels.forEach(label => {
      const items = sectionMap[label];
      const collapsed = brsSectionCollapsed(label);
      // Section header — collapsible. Click anywhere on the header toggles.
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;gap:8px;margin:14px 0 6px;padding:6px 10px;background:#efe9dc;border-left:4px solid #6c4f9f;border-radius:3px;cursor:pointer;user-select:none;';
      header.onclick = () => brsSectionToggle(label);
      header.innerHTML = `
        <span style="color:#6c4f9f;font-size:0.95rem;width:14px;display:inline-block;text-align:center;">${collapsed ? '▶' : '▼'}</span>
        <strong style="color:#3b2766;font-size:0.92rem;">${label}</strong>
        <span style="color:#888;font-size:0.78rem;">(${items.length} ${items.length === 1 ? 'container' : 'containers'})</span>`;
      container.appendChild(header);
      if (collapsed) return;
      items.forEach(({ rule, idx }) => {
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
    s.text = s.segments.map(seg => seg.v || '').join('');
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
      s.text = s.segments.map(seg => seg.v || '').join('');
      s.updated_at = new Date().toISOString();
      rule.updated_at = s.updated_at;
      brsMarkDirty();
      brsRender();
    }, {includeScenes: true});
  };

  window.brsRemoveDevice = function (ruleId, sentId, segIdx) {
    const rule = brsRules.find(r => r.id === ruleId);
    if (!rule) return;
    const s = (rule.sentences || []).find(x => x.id === sentId);
    if (!s || !s.segments || !s.segments[segIdx] || s.segments[segIdx].t !== 'dev') return;
    s.segments.splice(segIdx, 1);
    s.segments = _brsNormalize(s.segments);
    s.text = s.segments.map(seg => seg.v || '').join('');
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
      s.text = s.segments.map(seg => seg.v || '').join('');
      s.updated_at = new Date().toISOString();
      rule.updated_at = s.updated_at;
      brsMarkDirty();
      brsRender();
    }, {includeScenes: true});
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
        let sentenceChanged = false;
        for (const seg of (s.segments || [])) {
          if (seg.t !== 'dev') continue;
          const nv = window._dpMigrateToken(seg.v, devMap);
          if (nv !== seg.v) { seg.v = nv; changed = true; sentenceChanged = true; }
        }
        if (sentenceChanged) s.text = s.segments.map(seg => seg.v || '').join('');
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

// ─── Scenes tab (STEP 1: create / name / note / save / delete) ──────────
// A scene is a named, reusable list of device actions stored in
// dashboard_settings.apartment.scenes. Step 1 captures name + notes only;
// the `devices` array is reserved for a later step (the +Dev chips). Mirrors
// the Base Rule Settings (brs*) CRUD + dirty/Save-All/Discard pattern.
(function () {
  const SCENES_STORAGE_KEY = 'apartment.scenes';
  let scenesList = [];
  let scenesDirty = false;

  function scenesNewId(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function scenesEsc(s) { return (s || '').replace(/"/g, '&quot;'); }
  function scenesEscText(s) { const d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; }
  // Split a device chip token into its device/channel BASE and its current
  // action. Recognizes the picker's grammar: trailing " on"/" off" (the scene
  // on/off state), or a special action (" push X" / " Page N" / " say …" /
  // " speak X" / " announce X" / " vol N" / transport words). `base` is the
  // token with the action stripped, so the on/off toggle can rewrite it as
  // "<base> on" / "<base> off".
  const _SCENES_ONOFF_RE   = /\s+(on|off)$/i;
  const _SCENES_SPECIAL_RE = /\s+(push|page|say|speak|announce|vol)\b.*$/i;
  const _SCENES_XPORT_RE   = /\s+(stop|pause|resume|next|prev)$/i;
  function scenesParseChip(token) {
    const t = String(token == null ? '' : token).trim();
    let m = t.match(_SCENES_ONOFF_RE);
    if (m) return { base: t.slice(0, m.index).trim(), action: m[1].toLowerCase(), special: null };
    m = t.match(_SCENES_SPECIAL_RE);
    if (m) return { base: t.slice(0, m.index).trim(), action: null, special: t.slice(m.index).trim() };
    m = t.match(_SCENES_XPORT_RE);
    if (m) return { base: t.slice(0, m.index).trim(), action: null, special: m[1].toLowerCase() };
    return { base: t, action: null, special: null };
  }
  function scenesFmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const dd = String(d.getDate()).padStart(2, '0'), mm = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0'), mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}-${mm} ${hh}:${mi}`;
  }
  function scenesMarkDirty() { scenesDirty = true; const b = document.getElementById('scenes-dirty-badge'); if (b) b.style.display = 'inline'; }
  function scenesClearDirty() { scenesDirty = false; const b = document.getElementById('scenes-dirty-badge'); if (b) b.style.display = 'none'; }
  window.addEventListener('beforeunload', (e) => { if (scenesDirty) { e.preventDefault(); e.returnValue = ''; return ''; } });

  // Per-scene collapse state (localStorage, like BRS section collapse).
  function scenesCollapsed(id) { return localStorage.getItem('scene_collapsed_' + id) === '1'; }
  window.scenesToggleCollapse = function (id) {
    const k = 'scene_collapsed_' + id;
    if (localStorage.getItem(k) === '1') localStorage.removeItem(k); else localStorage.setItem(k, '1');
    scenesRender();
  };

  function scenesRender() {
    const c = document.getElementById('scenes-container');
    if (!c) return;
    if (!scenesList.length) {
      c.innerHTML = '<div style="color:#888;font-size:0.85rem;padding:10px 2px;">No scenes yet. Click <b>+ New Scene</b> to create one.</div>';
      return;
    }
    c.innerHTML = scenesList.map((s, i) => {
      const collapsed = scenesCollapsed(s.id);
      const devs = Array.isArray(s.devices) ? s.devices : [];
      const chips = collapsed ? '' : devs.map((seg, di) => {
        const p = scenesParseChip(seg && seg.v);
        const baseTxt = (p.base || '').replace(/^@/, '') || '(device)';
        const onSel = p.action === 'on', offSel = p.action === 'off';
        const onBtn = `<button onclick="scenesSetDeviceAction(${i},${di},'on')" title="Turn on in this scene"
          style="border:1px solid #3a7d44;border-radius:3px;padding:1px 6px;font-size:0.7rem;cursor:pointer;${onSel ? 'background:#3a7d44;color:#fff;font-weight:600;' : 'background:#fff;color:#3a7d44;'}">on</button>`;
        const offBtn = `<button onclick="scenesSetDeviceAction(${i},${di},'off')" title="Turn off in this scene"
          style="border:1px solid #c0392b;border-radius:3px;padding:1px 6px;font-size:0.7rem;cursor:pointer;${offSel ? 'background:#c0392b;color:#fff;font-weight:600;' : 'background:#fff;color:#c0392b;'}">off</button>`;
        const specialNote = p.special ? `<span style="font-size:0.68rem;color:#999;">(${scenesEscText(p.special)})</span>` : '';
        return `<span style="display:inline-flex;align-items:center;gap:4px;background:#ece6f5;border:1px solid #cfc1e6;border-radius:12px;padding:2px 6px 2px 9px;margin:2px;font-size:0.78rem;">${scenesEscText(baseTxt)} ${onBtn}${offBtn}${specialNote}<button onclick="scenesRemoveDevice(${i},${di})" title="Remove device" style="background:none;border:none;color:#c0392b;cursor:pointer;font-size:0.95rem;line-height:1;padding:0 0 0 2px;">×</button></span>`;
      }).join('');
      const caret = `<button onclick="scenesToggleCollapse('${s.id}')" title="${collapsed ? 'Expand' : 'Collapse'} scene"
        style="background:none;border:none;cursor:pointer;font-size:1rem;color:#6c4f9f;padding:0 2px;line-height:1;">${collapsed ? '▸' : '▾'}</button>`;
      const collapsedHint = collapsed ? `<span style="font-size:0.72rem;color:#aaa;white-space:nowrap;margin-left:4px;">(${devs.length} device${devs.length === 1 ? '' : 's'})</span>` : '';
      const body = collapsed ? '' : `
        <input type="text" value="${scenesEsc(s.notes)}" placeholder="Notes (what this scene does)"
               oninput="scenesSetField(${i},'notes',this.value)"
               style="width:100%;font-size:0.82rem;padding:5px 8px;border:1px solid #ddd;border-radius:4px;color:#444;box-sizing:border-box;">
        <div style="margin-top:8px;display:flex;align-items:center;flex-wrap:wrap;gap:3px;">
          <span style="font-size:0.74rem;color:#888;margin-right:2px;">Devices:</span>
          ${chips || '<span style="font-size:0.74rem;color:#bbb;">none yet</span>'}
          <button onclick="scenesAddDevice(${i})" title="Add devices (multi-select — check several, then Add selected)"
                  style="background:#fff;color:#6c4f9f;border:1px solid #cfc1e6;border-radius:4px;padding:2px 9px;font-size:0.74rem;cursor:pointer;margin-left:4px;">+ Dev</button>
          ${devs.length ? `<button onclick="scenesSetAllActions(${i},'on')" title="Set ALL devices on"
                  style="background:#fff;color:#3a7d44;border:1px solid #bcdcc2;border-radius:4px;padding:2px 9px;font-size:0.74rem;cursor:pointer;margin-left:6px;">All on</button>
          <button onclick="scenesSetAllActions(${i},'off')" title="Set ALL devices off"
                  style="background:#fff;color:#c0392b;border:1px solid #e0b4b4;border-radius:4px;padding:2px 9px;font-size:0.74rem;cursor:pointer;">All off</button>
          <span style="font-size:0.72rem;color:#c0392b;font-weight:600;margin-left:8px;">Set required Device state after loading !!!</span>` : ''}
        </div>`;
      return `
      <div style="border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:10px;background:#fafafa;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:${collapsed ? '0' : '8px'};">
          ${caret}
          <label style="font-size:0.78rem;color:#666;display:flex;align-items:center;gap:5px;white-space:nowrap;">
            <input type="checkbox" ${s.active !== false ? 'checked' : ''} onchange="scenesSetActive(${i},this.checked)"> active
          </label>
          <input type="text" value="${scenesEsc(s.name)}" placeholder="Scene name (e.g. Away Off)"
                 oninput="scenesSetField(${i},'name',this.value)"
                 style="flex:1;font-weight:600;font-size:0.95rem;padding:5px 8px;border:1px solid #ccc;border-radius:4px;">
          ${collapsedHint}
          <span style="font-size:0.72rem;color:#aaa;white-space:nowrap;">${scenesFmtDate(s.updated_at || s.added_at)}</span>
          <button onclick="scenesRun(${i})" title="Run this scene now — fires its device on/off list"
                  style="background:#fff;color:#2e7d32;border:1px solid #bcdcc2;border-radius:4px;padding:3px 9px;font-size:0.8rem;cursor:pointer;white-space:nowrap;min-width:84px;text-align:center;">▶ Run</button>
          <button onclick="scenesDelete(${i})" title="Delete scene"
                  style="background:#fff;color:#c0392b;border:1px solid #e0b4b4;border-radius:4px;padding:3px 9px;font-size:0.8rem;cursor:pointer;white-space:nowrap;min-width:84px;text-align:center;">× Delete</button>
        </div>
        ${body}
      </div>`;
    }).join('');
  }

  window.scenesSetField = function (i, field, val) {
    if (!scenesList[i]) return;
    scenesList[i][field] = val;
    scenesList[i].updated_at = new Date().toISOString();
    scenesMarkDirty();
  };
  window.scenesSetActive = function (i, checked) {
    if (!scenesList[i]) return;
    scenesList[i].active = checked;
    scenesList[i].updated_at = new Date().toISOString();
    scenesMarkDirty();
  };
  window.scenesNew = function () {
    const now = new Date().toISOString();
    scenesList.push({ id: scenesNewId('scene'), name: '', notes: '', active: true, devices: [], added_at: now, updated_at: now });
    scenesMarkDirty();
    scenesRender();
  };
  window.scenesDelete = function (i) {
    if (!scenesList[i]) return;
    const nm = scenesList[i].name || '(unnamed)';
    if (!confirm('Delete scene "' + nm + '"?')) return;
    scenesList.splice(i, 1);
    scenesMarkDirty();
    scenesRender();
  };
  // Run a scene now — the dashboard only POSTs a trigger; the rule engine's
  // `Scene Runner` rule does the actual dispatch (same path as Start Away Mode).
  // Run fires the SAVED scene, so block while there are unsaved edits.
  window.scenesRun = async function (i) {
    const s = scenesList[i];
    if (!s) return;
    const name = (s.name || '').trim();
    if (!name) { alert('Give the scene a name (and Save) first.'); return; }
    if (scenesDirty) { alert('You have unsaved changes — Save All first. Run fires the saved scene.'); return; }
    if (s.active === false) { alert('This scene is inactive. Tick "active" + Save before running.'); return; }
    if (!confirm('Run scene "' + name + '" now? This will switch its devices.')) return;
    try {
      const r = await fetch('/api/scenes/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
      alert('▶ Scene "' + name + '" sent' + (j.devices != null ? ' (' + j.devices + ' devices)' : '') + '.');
    } catch (e) {
      alert('Run failed: ' + e.message);
    }
  };
  // Add a device to a scene via the shared picker (lists ALL devices). The
  // picker returns a token string ("@Name", "@Name Channel", "@Name on", …);
  // we store it as a {t:'dev', v:token} chip — the same shape the rule parser
  // (_parse_dev_chip / parse_display_chip) already understands, so a future
  // rule-engine scene expansion can consume scene.devices directly.
  window.scenesAddDevice = function (i) {
    if (!scenesList[i]) return;
    if (typeof window.openDevicePicker !== 'function') { alert('Device picker not loaded.'); return; }
    // Hide devices/channels already in THIS scene: the picker's bare token
    // equals each chip's base (its on/off stripped via scenesParseChip).
    const exclude = (scenesList[i].devices || [])
      .map(seg => scenesParseChip(seg && seg.v).base)
      .filter(Boolean);
    // Multi-select: the picker returns an ARRAY of tokens. (Falls back to a
    // single token defensively if some caller ever runs it single-pick.)
    window.openDevicePicker(function (tokens) {
      const arr = Array.isArray(tokens) ? tokens : (tokens ? [tokens] : []);
      if (!arr.length) return;
      if (!Array.isArray(scenesList[i].devices)) scenesList[i].devices = [];
      arr.forEach(tok => { if (tok) scenesList[i].devices.push({ t: 'dev', v: tok }); });
      scenesList[i].updated_at = new Date().toISOString();
      scenesMarkDirty();
      scenesRender();
    }, { multi: true, exclude: exclude });
  };
  window.scenesRemoveDevice = function (i, di) {
    if (!scenesList[i] || !Array.isArray(scenesList[i].devices)) return;
    scenesList[i].devices.splice(di, 1);
    scenesList[i].updated_at = new Date().toISOString();
    scenesMarkDirty();
    scenesRender();
  };
  // Set (or clear) a device's on/off state for this scene. Clicking the
  // already-active state clears it back to bare (no action). Any prior special
  // action (push/Page/say/…) is replaced — a scene is an on/off state list.
  window.scenesSetDeviceAction = function (i, di, action) {
    const seg = scenesList[i] && scenesList[i].devices && scenesList[i].devices[di];
    if (!seg) return;
    const p = scenesParseChip(seg.v);
    seg.v = (p.action === action) ? p.base : ((p.base || '') + ' ' + action);
    scenesList[i].updated_at = new Date().toISOString();
    scenesMarkDirty();
    scenesRender();
  };
  // Set EVERY device in a scene to on (or off) at once. Normalizes any prior
  // action (incl. special push/Page chips) to the chosen on/off state.
  window.scenesSetAllActions = function (i, action) {
    const s = scenesList[i];
    if (!s || !Array.isArray(s.devices) || !s.devices.length) return;
    s.devices.forEach(seg => { const p = scenesParseChip(seg.v); seg.v = (p.base || '') + ' ' + action; });
    s.updated_at = new Date().toISOString();
    scenesMarkDirty();
    scenesRender();
  };
  window.scenesSave = async function () {
    try {
      const r = await fetch('/api/dashboard-settings/' + encodeURIComponent(SCENES_STORAGE_KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: scenesList }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      scenesClearDirty();
      alert('Saved ' + scenesList.length + ' scene(s).');
    } catch (e) {
      alert('Save failed: ' + (e.message || e));
    }
  };
  window.scenesDiscard = async function () {
    if (scenesDirty && !confirm('Discard all unsaved changes and reload from server?')) return;
    await scenesLoad();
  };

  async function scenesLoad() {
    try {
      const r = await fetch('/api/dashboard-settings/' + encodeURIComponent(SCENES_STORAGE_KEY));
      if (!r.ok) { scenesList = []; scenesClearDirty(); scenesRender(); return; }
      const j = await r.json();
      scenesList = Array.isArray(j.value) ? j.value : [];
      scenesClearDirty();
      scenesRender();
    } catch (e) {
      scenesList = [];
      scenesClearDirty();
      scenesRender();
    }
  }
  window.scenesLoad = scenesLoad;
  window.addEventListener('DOMContentLoaded', scenesLoad);
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
  // _paused persists in localStorage so a Stop STAYS stopped — across page
  // navigations, tab close/reopen, new tabs, and browser restarts. The ONLY
  // thing that clears it is the user clicking Start. (Was sessionStorage, which
  // cleared on tab close → the feed "started itself" on the next open; that is
  // exactly the bug this fixes.) The init below is the sole auto-restore path.
  const PAUSE_KEY = 'corridorSim.paused';
  let _paused    = localStorage.getItem(PAUSE_KEY) === '1';
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

  // Keep the Stop/Start button visual + status badge matched to _paused. Called
  // every poll AND on the paused early-return, so the state reliably survives
  // page navigation (with the persisted _paused) without relying on the one-shot
  // restore in wireButtons.
  function syncPausedUI() {
    setStatus(_paused ? '⏸ paused' : '● live', _paused ? '#888' : '#3a7d44');
    const sb = document.getElementById('cs-events-stop');
    const tb = document.getElementById('cs-events-start');
    if (sb && tb) {
      sb.style.display = _paused ? 'none' : '';
      tb.style.display = _paused ? '' : 'none';
    }
  }

  async function poll() {
    // Skip all work unless the simulator is the active, visible tab — switching
    // to another Main Agent tab or backgrounding the browser does no network/DB.
    const _tab = document.getElementById('tab-corridor-sim');
    if (!_tab || !_tab.classList.contains('active') || document.hidden) return;
    // "Stop update" FREEZES THE WHOLE VIEW — events feed AND the device-state
    // cards (renderLiveState) AND the FR picker — and stops polling entirely.
    // Previously only the events feed was gated by _paused, so the device cards
    // kept refreshing every second after Stop ("it still updates itself").
    if (_paused) { syncPausedUI(); return; }
    try {
      const r = await fetch('/api/corridor-sim/state');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const s = await r.json();
      renderLiveState(s);
      const frUsers = s.fr && s.fr.board && s.fr.board.last_status && s.fr.board.last_status.users;
      renderFrUserPicker(frUsers);
      if (Array.isArray(s.events)) {
        const newKey = s.events.length ? `${s.events[0].ts}|${s.events[0].topic}` : '';
        const oldKey = _events.length  ? `${_events[0].ts}|${_events[0].topic}` : '';
        if (newKey !== oldKey) {
          _events = s.events;
          renderEvents(_events);
        }
      }
      syncPausedUI();
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
      localStorage.setItem(PAUSE_KEY, '1');
      stopBtn.style.display  = 'none';
      startBtn.style.display = '';
      setStatus('⏸ paused', '#888');
    };
    startBtn.onclick = () => {
      _paused = false;
      localStorage.removeItem(PAUSE_KEY);
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
