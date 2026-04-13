// ── Sidebar alert indicator — runs on every page ──────────────
(function () {
  let prevCount = null;
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

  // Restore last known state instantly (no flash on navigation)
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved !== null) applyState(parseInt(saved, 10));
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
      ];
      const count = checks.filter(v => v === false).length;

      const el = document.getElementById('alert-indicator');
      if (!el) return;

      applyState(count);
      try { localStorage.setItem(STORE_KEY, count); } catch (e) {}

      // Sound only fires when count rises (new problem appeared)
      if (prevCount !== null && count > prevCount) beep();
      prevCount = count;
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
        if (!battKey) continue;
        const val = (d.last_state || {})[battKey];
        if (val == null || (typeof val === 'number' && val < thresh.low)) lowCount++;
      }
      applyBattState(lowCount);
      try { localStorage.setItem(BATT_STORE, lowCount); } catch (e) {}
    } catch (e) {}
  }

  // First check after page settles, then every 60 s
  setTimeout(checkAlerts, 1500);
  setTimeout(checkBattery, 2000);
  setInterval(checkAlerts, 60000);
  setInterval(checkBattery, 60000);
})();
