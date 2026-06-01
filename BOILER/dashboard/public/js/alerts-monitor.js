// ── Sidebar alert indicator — runs on every page ──────────────
(function () {
  // 2-tick smoothing: a single failed tick (e.g. WiFi blip on the Windows host
  // briefly making every TCP-port-22 probe + DB query fail in the same poll)
  // does NOT flip the badge — only sustained changes that persist for 2
  // consecutive 60 s ticks do. Eliminates the "all red for 1 minute then back
  // to green" cosmetic flapping. Real outages still surface, just 60 s slower.
  // Direction flips are smoothed; in-state count changes (red 3 → red 5) apply
  // immediately so the user sees worsening problems without delay.
  let prevCount = null;     // last APPLIED count (what the badge currently shows)
  let pendingDir = null;    // direction of pending opposite observation: true=red, false=green, null=none
  let pendingTicks = 0;     // consecutive ticks the pending direction has held
  const STORE_KEY = '_alert_indicator';

  function applyState(count) {
    const el = document.getElementById('alert-indicator');
    if (!el) return;
    if (count > 0) {
      el.textContent = count === 1 ? '⚠ 1 issue' : `⚠ ${count} issues`;
      el.title       = `${count} problem${count > 1 ? 's' : ''} detected\nClick to go to Project Health`;
      el.classList.add('has-alerts');
    } else {
      el.textContent = '✓ OK';
      el.title       = 'All systems OK';
      el.classList.remove('has-alerts');
    }
  }

  // Restore last known state instantly + seed prevCount so the smoother can
  // compare from tick 1 (otherwise navigation would bypass smoothing on the
  // first tick after each page load).
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved !== null) {
      const c = parseInt(saved, 10);
      if (!Number.isNaN(c)) {
        applyState(c);
        prevCount = c;
      }
    }
  } catch (e) {}

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25].forEach(delay => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0, ctx.currentTime + delay);
        gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.3);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + 0.3);
      });
    } catch (e) {}
  }

  async function checkAlerts() {
    try {
      const r = await fetch('/api/health/status').then(r => r.json());

      // Count every failed check across the full status response
      const checks = [
        // Infrastructure (dashboard direct checks)
        r.postgres?.ok,
        r.homeassistant?.ok,
        // VM + LXC (dashboard TCP checks)
        r.vm101?.ok,
        r.lxc100?.ok,
        r.lxc102?.ok,
        r.lxc103?.ok,
        r.lxc104?.ok,
        r.lxc105?.ok,
        r.lxc106?.ok,
        // Server
        r.pm2?.ok,
        // Scripts (data freshness — DB queries)
        r.ha_to_pg?.data_ok,
        r.collect_weather?.data_ok,
        // Data freshness
        r.orchestrator_last_run?.ok,
        r.boiler_last_decision?.ok,
        // Orchestrator verdict (covers agent services + errors)
        r.active_alerts?.ok,
        // UPS (master daemon comm + polling freshness)
        r.ups?.ok,
      ];
      const rawCount = checks.filter(v => v === false).length;

      if (!document.getElementById('alert-indicator')) return;

      // Apply the smoothed state, persist, beep on rising count.
      function commit(newCount) {
        applyState(newCount);
        try { localStorage.setItem(STORE_KEY, newCount); } catch (e) {}
        if (prevCount !== null && newCount > prevCount) beep();
        prevCount    = newCount;
        pendingDir   = null;
        pendingTicks = 0;
      }

      // Cold start (no prior cached state): trust the immediate observation.
      if (prevCount === null) { commit(rawCount); return; }

      const prevIsRed = prevCount > 0;
      const rawIsRed  = rawCount  > 0;

      // Same colour: in-state count changes apply immediately; clear pending.
      if (rawIsRed === prevIsRed) {
        if (rawCount !== prevCount) commit(rawCount);
        else { pendingDir = null; pendingTicks = 0; }
        return;
      }

      // Direction-flipping tick: smooth across 2 consecutive observations.
      if (pendingDir === rawIsRed) {
        pendingTicks++;
        if (pendingTicks >= 2) commit(rawCount);
        return;
      }

      // First tick of a new opposite direction — start the counter, hold badge.
      pendingDir   = rawIsRed;
      pendingTicks = 1;
    } catch (e) {}
  }

  // ── Battery low-count badge ──────────────────────────────────
  const BATT_STORE = '_batt_low_count';

  function applyBattState(count) {
    const el = document.getElementById('batt-indicator');
    if (!el) return;
    if (count > 0) {
      el.textContent = `Batt Low - ${count}`;
      el.title = `${count} device${count > 1 ? 's' : ''} with low/offline battery\nClick to see Battery tab`;
      el.style.background = '#5c0e0e';
      el.style.color = '#fff';
    } else {
      el.textContent = 'Batt ✓';
      el.title = 'All batteries OK';
      el.style.background = '#3a7d44';
      el.style.color = '#fff';
    }
  }

  // Restore last known battery state
  try {
    const saved = localStorage.getItem(BATT_STORE);
    if (saved !== null) applyBattState(parseInt(saved, 10));
  } catch (e) {}

  // Devices that appear in the Batt Devices grid by allowlist (no battery
  // DPS, just connectivity tracking). Must mirror the FORCE_BATT_DEVICES
  // set in devices.js → renderBatteryTab(). When one is stale (no fresh
  // last_seen in NON_BATT_STALE_SEC) it counts toward the Batt Low badge
  // so the badge stays consistent with the grid's red-filled offline icon.
  const FORCE_BATT_DEVICES = new Set([
    'bf96fc9abc525374913juz',  // Maya Bedroom Remote (Tuya ZCZK IR hub)
  ]);
  const NON_BATT_STALE_SEC = 7200;  // 2h — matches IR-hub keepalive cadence (hourly)

  async function checkBattery() {
    try {
      const [devRes, settRes] = await Promise.all([
        fetch('/api/devices').then(r => r.json()),
        fetch('/api/dashboard-settings/battery_thresholds').then(r => r.json()),
      ]);
      const thresh = settRes.value || { good: 60, low: 20 };
      let lowCount = 0;
      for (const d of devRes) {
        if (d.enabled === false) continue;
        const labels = d.dps_labels || {};
        let battKey = null;
        for (const [k, v] of Object.entries(labels)) {
          if (typeof v === 'string' && v.toLowerCase() === 'battery') { battKey = k; break; }
        }
        if (battKey) {
          // Real battery device: low or missing value counts as bad.
          const val = (d.last_state || {})[battKey];
          if (val == null || (typeof val === 'number' && val < thresh.low)) lowCount++;
        } else if (FORCE_BATT_DEVICES.has(d.id)) {
          // Non-battery device tracked for connectivity only: count if stale.
          if (!d.last_seen) {
            lowCount++;
          } else {
            const ageSec = (Date.now() - new Date(d.last_seen)) / 1000;
            if (ageSec > NON_BATT_STALE_SEC) lowCount++;
          }
        }
      }
      applyBattState(lowCount);
      try { localStorage.setItem(BATT_STORE, lowCount); } catch (e) {}
    } catch (e) {}
  }

  // ── Integrations badge (device-group stall alerts) ───────────
  const INTEG_STORE = '_integ_stale_count';

  function applyIntegState(count, groups) {
    const el = document.getElementById('integrations-indicator');
    if (!el) return;
    if (count > 0) {
      el.textContent = count === 1
        ? 'Device Integration ✗ 1 stuck'
        : `Device Integration ✗ ${count} stuck`;
      el.title = `${count} device integration${count > 1 ? 's' : ''} stalled:\n${(groups || []).join('\n')}\nClick to see Health page`;
      el.style.background = '#5c0e0e';
      el.style.color = '#fff';
    } else {
      el.textContent = 'Device Integration ✓';
      el.title = 'All device integrations OK';
      el.style.background = '#3a7d44';
      el.style.color = '#fff';
    }
  }

  try {
    const saved = localStorage.getItem(INTEG_STORE);
    if (saved !== null) applyIntegState(parseInt(saved, 10), []);
  } catch (e) {}

  async function checkIntegrations() {
    try {
      const r = await fetch('/api/health/integrations').then(r => r.json());
      applyIntegState(r.count || 0, r.groups || []);
      try { localStorage.setItem(INTEG_STORE, r.count || 0); } catch (e) {}
    } catch (e) {}
  }

  // ── Network Integration badge (per-device LAN reachability alerts) ───
  // Sibling to Device Integration. Counts active `network:*` alerts. Click
  // goes to Project Network where the same alerts render in detail.
  const NETWORK_STORE = '_network_alert_count';

  function applyNetworkState(count, groups) {
    const el = document.getElementById('network-indicator');
    if (!el) return;
    if (count > 0) {
      el.textContent = `Network Integration ${count}`;
      el.title = `${count} network alert${count > 1 ? 's' : ''}:\n${(groups || []).join('\n')}\nClick to see Project Network`;
      el.style.background = '#5c0e0e';
      el.style.color = '#fff';
    } else {
      el.textContent = 'Network Integration ✓';
      el.title = 'All network integrations OK';
      el.style.background = '#3a7d44';
      el.style.color = '#fff';
    }
  }

  try {
    const saved = localStorage.getItem(NETWORK_STORE);
    if (saved !== null) applyNetworkState(parseInt(saved, 10), []);
  } catch (e) {}

  async function checkNetwork() {
    try {
      const r = await fetch('/api/health/network-integrations').then(r => r.json());
      applyNetworkState(r.count || 0, r.groups || []);
      try { localStorage.setItem(NETWORK_STORE, r.count || 0); } catch (e) {}
    } catch (e) {}
  }

  // ── NetBird badge (peers online + active netbird:* alerts) ──────────
  // Goes alongside the other infra badges. Click → Project Gateway.
  // 503 from the endpoint = token missing → render the badge in amber
  // so the dashboard surfaces that NetBird isn't fully wired yet.
  const NETBIRD_STORE = '_netbird_status';

  function applyNetbirdState(state) {
    const el = document.getElementById('netbird-indicator');
    if (!el) return;
    const { peersOnline = 0, peersTotal = 0, alerts = 0, tokenMissing = false } = state || {};
    if (tokenMissing) {
      el.textContent = 'NetBird Integration ⚠ no token';
      el.title = 'NETBIRD_API_TOKEN not configured. Add it to BOILER/dashboard/.env and restart.';
      el.style.background = '#5c0e0e';
      return;
    }
    if (alerts > 0) {
      el.textContent = `NetBird Integration ✗ ${alerts} alert${alerts > 1 ? 's' : ''}`;
      el.title = `${alerts} active NetBird tenant alert${alerts > 1 ? 's' : ''}. Click for Project Gateway.`;
      el.style.background = '#5c0e0e';
      return;
    }
    if (peersTotal > 0 && peersOnline < peersTotal) {
      el.textContent = `NetBird Integration ${peersTotal - peersOnline}`;
      el.title = `${peersOnline} of ${peersTotal} NetBird peers online (${peersTotal - peersOnline} offline). Click for Project Gateway.`;
      el.style.background = '#5c0e0e';
      return;
    }
    el.textContent = 'NetBird Integration ✓';
    el.title = peersTotal > 0
      ? `All ${peersTotal} NetBird peers online. Click for Project Gateway.`
      : 'No peers in tenant yet.';
    el.style.background = '#3a7d44';
  }

  try {
    const saved = localStorage.getItem(NETBIRD_STORE);
    if (saved) applyNetbirdState(JSON.parse(saved));
  } catch (e) {}

  async function checkNetbird() {
    try {
      const resp = await fetch('/api/gateway/status');
      const d = await resp.json().catch(() => ({}));
      const state = (resp.status === 503)
        ? { tokenMissing: true }
        : {
            peersOnline: d.peers?.online || 0,
            peersTotal:  d.peers?.total  || 0,
            alerts:      d.alerts?.active || 0,
          };
      applyNetbirdState(state);
      try { localStorage.setItem(NETBIRD_STORE, JSON.stringify(state)); } catch (e) {}
    } catch (e) {}
  }

  // First check after page settles, then every 60 s
  setTimeout(checkAlerts, 1500);
  setTimeout(checkBattery, 2000);
  setTimeout(checkIntegrations, 2500);
  setTimeout(checkNetwork, 3000);
  setTimeout(checkNetbird, 3500);
  setInterval(checkAlerts, 60000);
  setInterval(checkBattery, 60000);
  setInterval(checkIntegrations, 60000);
  setInterval(checkNetwork, 60000);
  setInterval(checkNetbird, 60000);
})();
