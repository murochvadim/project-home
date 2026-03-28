// ── Sidebar alert indicator — runs on every page ──────────────
(function () {
  let prevCount = null;

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
      const data = await fetch('/api/health/alerts').then(r => r.json());
      const count  = data.rows?.filter(r => !r.resolved_local).length ?? 0;
      const worst  = count > 0 ? data.rows.find(r => !r.resolved_local)?.severity : null;

      const el = document.getElementById('alert-indicator');
      if (!el) return;

      if (count > 0) {
        el.style.display = 'inline-block';
        el.textContent   = count === 1 ? '⚠ 1 alert' : `⚠ ${count} alerts`;
        el.title         = `${count} active alert${count > 1 ? 's' : ''} — worst: ${worst}\nClick to go to Project Health`;
      } else {
        el.style.display = 'none';
      }

      // Sound only fires when count rises (new alert appeared)
      if (prevCount !== null && count > prevCount) {
        beep();
      }
      prevCount = count;
    } catch (e) {}
  }

  // First check after page settles, then every 60 s
  setTimeout(checkAlerts, 1500);
  setInterval(checkAlerts, 60000);
})();
