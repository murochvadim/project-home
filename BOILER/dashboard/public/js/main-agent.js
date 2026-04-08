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
    const topic = enabled ? 'enable' : 'disable';
    // Publish via API — we'll add this endpoint later. For now log.
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
      document.getElementById('stat-motion-ago').textContent = lastMotionTs ? formatTimeAgo(lastMotionTs) : '—';

      // ── Engine status row ──
      const heartbeatAge = hb.ts ? (Date.now() - new Date(hb.ts).getTime()) / 1000 : Infinity;
      const isOnline = heartbeatAge < 120;
      document.getElementById('engine-dot').className = 'engine-dot ' + (isOnline ? 'online' : 'offline');
      document.getElementById('engine-label').textContent = isOnline ? 'Online' : 'Offline';

      const actLevel = s.activity_level || '—';
      document.getElementById('activity-level').textContent = actLevel.charAt(0).toUpperCase() + actLevel.slice(1);
      document.getElementById('last-heartbeat').textContent = hb.ts ? formatTimestamp(hb.ts) : '—';
      document.getElementById('last-decision').textContent = hb.decision || '—';

      // ── Home Activity tab ──
      document.getElementById('ha-mode').textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
      document.getElementById('ha-mode').style.color = mode === 'active' ? '#1a7a3a' : mode === 'idle' ? '#f39c12' : '#95a5a6';
      document.getElementById('ha-people').textContent = people;
      document.getElementById('ha-people').style.color = people === 0 ? '#95a5a6' : people === 1 ? '#2980b9' : '#1a7a3a';
      document.getElementById('ha-activity').textContent = actLevel.charAt(0).toUpperCase() + actLevel.slice(1);
      document.getElementById('ha-room-count').textContent = activeCount;
      document.getElementById('ha-last-room').textContent = s.last_motion_room || '—';
      document.getElementById('ha-last-time').textContent = lastMotionTs ? formatTimeAgo(lastMotionTs) : '—';

      // Active rooms pills
      const activeRooms = parseJsonSafe(s.active_rooms);
      const listEl = document.getElementById('active-room-list');
      listEl.innerHTML = '';
      if (activeRooms.length === 0) {
        listEl.innerHTML = '<span style="color:#888;font-size:0.85rem;">No active rooms</span>';
      } else {
        activeRooms.forEach(r => {
          const pill = document.createElement('span');
          pill.className = 'room-pill';
          pill.textContent = r;
          listEl.appendChild(pill);
        });
      }

      // Occupied rooms pills
      const occupiedRooms = parseJsonSafe(s.occupied_rooms);
      const occEl = document.getElementById('occupied-room-list');
      occEl.innerHTML = '';
      if (occupiedRooms.length === 0) {
        occEl.innerHTML = '<span style="color:#888;font-size:0.85rem;">No occupied rooms</span>';
      } else {
        occupiedRooms.forEach(r => {
          const pill = document.createElement('span');
          pill.className = 'room-pill';
          pill.textContent = r;
          occEl.appendChild(pill);
        });
      }

      // ── Rules tab ──
      const rules = parseJsonSafe(s._rules);
      const disabledRules = new Set(parseJsonSafe(s._disabled_rules));
      const rulesBody = document.getElementById('rules-body');
      if (rules.length === 0) {
        rulesBody.innerHTML = '<tr><td colspan="4" style="color:#aaa">No rules loaded</td></tr>';
      } else {
        rulesBody.innerHTML = rules.map(r => {
          const enabled = !disabledRules.has(r.name);
          return `<tr>
            <td class="rule-name">${escHtml(r.name)}</td>
            <td class="rule-desc">${escHtml(r.description)}</td>
            <td class="rule-cat">${escHtml(r.category)}</td>
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
