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

  // Tab switching
  window.switchTab = function (id, btn) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-bar button').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + id).classList.add('active');
    btn.classList.add('active');
  };

  window.loadState = async function loadState() {
    try {
      const resp = await fetch('/api/rule-engine/state');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const s = data.state || {};
      const hb = data.heartbeat || {};

      // ── Stats bar ──
      const mode = s.home_mode || 'unknown';
      const modeEl = document.getElementById('home-mode');
      const chipMode = document.getElementById('chip-mode');
      modeEl.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
      chipMode.className = 'stat-chip mode-' + mode;

      const people = parseInt(s.people_home) || 0;
      const peopleEl = document.getElementById('people-count');
      const chipPeople = document.getElementById('chip-people');
      peopleEl.textContent = people;
      chipPeople.className = 'stat-chip ' + (people === 0 ? 'people-0' : people === 1 ? 'people-1' : 'people-multi');

      const activeCount = parseInt(s.active_room_count) || 0;
      const chipRooms = document.getElementById('chip-rooms');
      document.getElementById('active-room-count').textContent = activeCount;
      chipRooms.className = 'stat-chip' + (activeCount > 0 ? ' rooms-active' : '');

      const lastRoom = s.last_motion_room || '—';
      document.getElementById('last-motion-room').textContent = lastRoom;

      const lastMotionTs = parseFloat(s['_timer:last_motion']) || 0;
      document.getElementById('last-motion-ago').textContent = lastMotionTs ? formatTimeAgo(lastMotionTs) : '—';

      // ── Engine status ──
      const heartbeatAge = hb.ts ? (Date.now() - new Date(hb.ts).getTime()) / 1000 : Infinity;
      const isOnline = heartbeatAge < 120;
      const dotEl = document.getElementById('engine-dot');
      dotEl.className = 'engine-dot ' + (isOnline ? 'online' : 'offline');
      document.getElementById('engine-label').textContent = isOnline ? 'Online' : 'Offline';

      const actLevel = s.activity_level || '—';
      document.getElementById('activity-level').textContent = actLevel.charAt(0).toUpperCase() + actLevel.slice(1);
      document.getElementById('last-heartbeat').textContent = hb.ts ? formatTimestamp(hb.ts) : '—';
      document.getElementById('last-decision').textContent = hb.decision || '—';

      // ── Active rooms pills ──
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

      const occupiedRooms = parseJsonSafe(s.occupied_rooms);
      document.getElementById('occupied-label').textContent =
        occupiedRooms.length > 0 ? 'Occupied: ' + occupiedRooms.join(', ') : '';

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
          if (occupiedSet.has(room.toLowerCase())) {
            chip.classList.add('occupied');
          }
          chip.innerHTML = '<span class="room-dot"></span>' + room;
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
