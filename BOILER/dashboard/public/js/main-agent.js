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
      if (rules.length === 0) {
        rulesBody.innerHTML = '<tr><td colspan="7" style="color:#aaa">No rules loaded</td></tr>';
      } else {
        rulesBody.innerHTML = rules.map(r => {
          const enabled = !disabledRules.has(r.name);
          const st = r.stats || {};
          const runs = st.count || 0;
          const avg = runs > 0 ? (st.total_ms / runs).toFixed(1) + 'ms' : '—';
          const max = st.max_ms ? st.max_ms.toFixed(1) + 'ms' : '—';
          return `<tr>
            <td class="rule-name">${escHtml(r.name)}</td>
            <td class="rule-desc">${escHtml(r.description)}</td>
            <td class="rule-cat">${escHtml(r.category)}</td>
            <td style="text-align:center">${runs}</td>
            <td style="text-align:center">${avg}</td>
            <td style="text-align:center">${max}</td>
            <td>
              <label class="toggle">
                <input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleRule('${escHtml(r.name)}', this.checked)">
                <span class="slider"></span>
              </label>
            </td>
          </tr>`;
        }).join('');
      }

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
})();
