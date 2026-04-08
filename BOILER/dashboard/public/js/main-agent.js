// ── Main Agent — Rule Engine State Dashboard ──────────────────
(function () {
  let refreshTimer = null;

  // All known rooms (will be populated from DB data)
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

  function addClass(el, cls) {
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 300);
  }

  function parseJsonSafe(val) {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch (e) { return []; }
    }
    return [];
  }

  window.loadState = async function loadState() {
    try {
      const resp = await fetch('/api/rule-engine/state');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const s = data.state || {};
      const hb = data.heartbeat || {};

      // ── Home Status card ──
      const mode = s.home_mode || 'unknown';
      const modeEl = document.getElementById('home-mode');
      const iconEl = document.getElementById('home-icon');
      modeEl.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
      modeEl.className = 'card-value';
      iconEl.textContent = '\u{1F3E0}';
      if (mode === 'active') {
        modeEl.classList.add('status-active');
        iconEl.textContent = '\u{1F3E0}';
      } else if (mode === 'idle') {
        modeEl.classList.add('status-idle');
        iconEl.textContent = '\u{1F3E0}';
      } else if (mode === 'away') {
        modeEl.classList.add('status-away');
        iconEl.textContent = '\u{1F3DA}';
      }
      addClass(document.getElementById('card-home-status'), 'fade-update');

      // ── People Home card ──
      const people = parseInt(s.people_home) || 0;
      const peopleEl = document.getElementById('people-count');
      peopleEl.textContent = people;
      peopleEl.className = 'card-value';
      if (people === 0) peopleEl.classList.add('count-zero');
      else if (people === 1) peopleEl.classList.add('count-one');
      else peopleEl.classList.add('count-multi');
      addClass(document.getElementById('card-people'), 'fade-update');

      // ── Active Rooms card ──
      const activeCount = parseInt(s.active_room_count) || 0;
      const activeRooms = parseJsonSafe(s.active_rooms);
      document.getElementById('active-room-count').textContent = activeCount;
      const listEl = document.getElementById('active-room-list');
      listEl.innerHTML = '';
      activeRooms.forEach(r => {
        const pill = document.createElement('span');
        pill.className = 'room-pill';
        pill.textContent = r;
        listEl.appendChild(pill);
      });
      addClass(document.getElementById('card-active-rooms'), 'fade-update');

      // ── Last Motion card ──
      const lastRoom = s.last_motion_room || '—';
      const lastMotionTs = parseFloat(s['_timer:last_motion']) || 0;
      document.getElementById('last-motion-room').textContent = lastRoom;
      document.getElementById('last-motion-ago').textContent = lastMotionTs ? formatTimeAgo(lastMotionTs) : '—';
      addClass(document.getElementById('card-last-motion'), 'fade-update');

      // ── Engine Status ──
      const heartbeatAge = hb.ts ? (Date.now() - new Date(hb.ts).getTime()) / 1000 : Infinity;
      const isOnline = heartbeatAge < 120; // 2 min threshold
      const engineEl = document.getElementById('engine-status');
      engineEl.innerHTML = `<span class="engine-dot ${isOnline ? 'online' : 'offline'}"></span>${isOnline ? 'Online' : 'Offline'}`;

      document.getElementById('activity-level').textContent =
        s.activity_level ? s.activity_level.charAt(0).toUpperCase() + s.activity_level.slice(1) : '—';
      document.getElementById('last-heartbeat').textContent = hb.ts ? formatTimestamp(hb.ts) : '—';
      document.getElementById('last-decision').textContent = hb.decision || '—';
      document.getElementById('last-error').textContent = hb.error || 'None';
      document.getElementById('last-error').style.color = hb.error ? '#e74c3c' : '#085c28';

      // ── Room Occupancy Map ──
      const occupiedRooms = parseJsonSafe(s.occupied_rooms);
      const activeRoomSet = new Set(activeRooms.map(r => r.toLowerCase()));
      const occupiedSet = new Set(occupiedRooms.map(r => r.toLowerCase()));

      // Build room list from all sources
      const allRooms = new Set();
      occupiedRooms.forEach(r => allRooms.add(r));
      activeRooms.forEach(r => allRooms.add(r));
      // Add any rooms from previous loads
      ALL_ROOMS.forEach(r => allRooms.add(r));
      // If we got rooms from DB, use those
      if (data.rooms && data.rooms.length) {
        data.rooms.forEach(r => allRooms.add(r));
      }
      // Save for next refresh
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
          const rLower = room.toLowerCase();
          if (activeRoomSet.has(rLower)) {
            chip.classList.add('active-room');
          } else if (occupiedSet.has(rLower)) {
            chip.classList.add('occupied');
          }
          chip.innerHTML = `<span class="room-dot"></span>${room}`;
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

  // Initial load + auto-refresh
  loadState();
  refreshTimer = setInterval(loadState, 10000);
})();
