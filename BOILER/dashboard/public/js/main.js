function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let autoRefreshTimer  = null;
let runIntervalMin    = 5;
let countdownTimer      = null;
let nextRunTarget       = null;
let nextProbeTarget     = null;
let probeOutsideHours   = false;
let postRunRefreshPending = false;
let lastDecision        = null;

async function loadSolarScore() {
  try {
    const s = await fetch('/api/weather/scores').then(r => r.json());
    if (s.error) return;
    const el    = document.getElementById('solar-score');
    const label = document.getElementById('solar-score-label');
    const score   = s.solar_score;
    const color   = score >= 8 ? '#7a9f5a' : score >= 5 ? '#b5a040' : '#a07050';
    const quality = score >= 8 ? 'Excellent' : score >= 6 ? 'Good' : score >= 4 ? 'Fair' : 'Poor';
    let text;
    if (s.is_forecast) {
      const at = s.next_sunrise ? ` at ${s.next_sunrise}` : '';
      text = `Tomorrow${at} — ${quality} (forecast)`;
    } else {
      text = score >= 8 ? 'Excellent — panels will heat well'
           : score >= 6 ? 'Good — partial heating expected'
           : score >= 4 ? 'Fair — limited solar gain'
           :              'Poor — minimal heating today';
    }
    if (el)    { el.textContent = score; el.style.color = color; }
    if (label) { label.textContent = text; label.style.color = color; }
  } catch (e) { console.error('loadSolarScore error:', e); }
}

function startCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const now = Date.now();

    const runEl = document.getElementById('next-run-countdown');
    if (!nextRunTarget) { runEl.textContent = ''; }
    else {
      const diff = Math.floor((nextRunTarget - now) / 1000);
      if (diff <= 0) {
        runEl.textContent = 'run';
        if (!postRunRefreshPending) {
          postRunRefreshPending = true;
          setTimeout(() => { postRunRefreshPending = false; refreshAll(); }, 15000);
        }
      } else {
        const m = Math.floor(diff/60), s = String(diff%60).padStart(2,'0');
        runEl.textContent = `${m}:${s}`;
      }
    }

    const probeEl = document.getElementById('next-probe-countdown');
    if (probeOutsideHours) { /* leave "Outside hours" text alone */ }
    else if (!nextProbeTarget) { probeEl.textContent = ''; }
    else {
      const diff = Math.floor((nextProbeTarget - now) / 1000);
      if (diff <= 0) probeEl.textContent = '';
      else { const m = Math.floor(diff/60), s = String(diff%60).padStart(2,'0'); probeEl.textContent = `${m}:${s}`; }
    }
  }, 1000);
}

async function loadStatus() {
  try {
    const s = await fetch('/api/status').then(r => r.json());
    document.getElementById('status-db').style.color = s.db ? '#8a9f78' : '#b55e5e';
    document.getElementById('status-ha').style.color = s.ha ? '#8a9f78' : '#b55e5e';
  } catch (e) {
    document.getElementById('status-db').style.color = '#b55e5e';
    document.getElementById('status-ha').style.color = '#b55e5e';
  }
}

async function loadUsageToday() {
  try {
    const r = await fetch('/api/consumptions/today').then(r => r.json());
    const fmt = v => v !== null && v !== undefined ? v : '—';
    document.getElementById('usage-count').textContent    = fmt(r.count);
    document.getElementById('usage-human').textContent    = 'Human: '   + fmt(r.human);
    document.getElementById('usage-panel').textContent    = 'Panel: '   + fmt(r.panel);
    document.getElementById('usage-thermal').textContent  = 'Thermal: ' + fmt(r.thermal);
    document.getElementById('usage-boiler').textContent   = 'Boiler: '  + fmt(r.boiler);
    document.getElementById('usage-unknown').textContent  = 'Unknown: ' + fmt(r.unknown);
    document.getElementById('usage-max-drop').textContent = r.max_drop ? parseFloat(r.max_drop).toFixed(1) + ' °C' : '—';
    document.getElementById('usage-avg-drop').textContent = r.avg_drop ? parseFloat(r.avg_drop).toFixed(1) + ' °C' : '—';
    document.getElementById('usage-last-ts').textContent  = r.last_ts
      ? new Date(r.last_ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '—';
  } catch (e) { console.error('loadUsageToday error:', e); }
}

async function loadTimer() {
  try {
    const t = await fetch('/api/timer').then(r => r.json());
    const dot   = document.getElementById('timer-state-dot');
    const state = document.getElementById('timer-state');
    const colors = { active: '#2ecc71', idle: '#e74c3c', paused: '#e67e22' };
    dot.style.color   = colors[t.state] || '#e74c3c';
    state.textContent = t.state || '—';
  } catch (e) { console.error('loadTimer error:', e); }
}

async function refreshAll() {
  await Promise.all([loadReport(), loadSettings(), loadStatus(), loadSolarScore(), loadUsageToday(), loadTimer()]);
  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
  scheduleAutoRefresh();
}

async function loadNextProbe(currentDecision) {
  try {
    const r = await fetch('/api/next-probe').then(r => r.json());
    const el = document.getElementById('next-probe');
    const nowIL = new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
    const hourIL = new Date(nowIL).getHours();
    const inOperationalHours = hourIL >= 7 && hourIL < 19;

    const probeCountdownEl = document.getElementById('next-probe-countdown');

    const setProbe = (explanation, explanationColor, showCountdown) => {
      el.textContent               = explanation;
      el.style.color               = explanationColor || '';
      probeCountdownEl.textContent = '';
      if (showCountdown) nextProbeTarget = showCountdown;
      else nextProbeTarget = null;
    };

    if (!r.agent_enabled || r.valve_is_on || !inOperationalHours) {
      probeOutsideHours = !inOperationalHours && r.agent_enabled;
      setProbe('—', '#888', null);
    } else if (!r.next_probe) {
      if (r.probe_feasible === false)
        setProbe(`Too late — ${r.minutes_to_end}m left`, '#a08040', null);
      else
        setProbe('Ready', '#2ecc71', null);
    } else {
      const nextProbeDate = new Date(r.next_probe);
      if (nextProbeDate <= new Date()) {
        if (r.probe_feasible === false)
          setProbe(`Too late — ${r.minutes_to_end}m left`, '#a08040', null);
        else
          setProbe('Ready', '#2ecc71', null);
      } else if (r.probe_feasible === false) {
        setProbe(`Too late — ${r.minutes_to_end}m left`, '#a08040', null);
      } else {
        setProbe(nextProbeDate.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }), '', nextProbeDate.getTime());
      }
    }

    const originEl = document.getElementById('turn-on-origin');
    const inWaiting = currentDecision === 'waiting';
    const probeActive = r.agent_enabled && r.valve_is_on && r.last_turn_on_origin === 'probe' && r.last_turn_on_ts && inWaiting && inOperationalHours;
    if (probeActive && r.last_turn_on_ts) {
      const t = new Date(r.last_turn_on_ts).toLocaleTimeString('he-IL',
        { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
      originEl.innerHTML = `<span style="font-size:0.72rem;color:#2e2e2e;">Probe started at ${t}</span>`;
    } else {
      originEl.innerHTML = '';
    }
  } catch (e) {
    console.error('loadNextProbe error:', e);
  }
}

async function loadReport() {
  try {
    const [rep, cfg] = await Promise.all([
      fetch('/api/last-report').then(r => r.json()),
      fetch('/api/settings').then(r => r.json()),
    ]);

    const agentEnabled = cfg.agent_enabled;
    const toggleBtn = document.getElementById('toggle-btn');
    toggleBtn.textContent = agentEnabled ? 'ENABLED' : 'DISABLED';
    toggleBtn.className = 'btn btn-sm ' + (agentEnabled ? 'btn-success' : 'btn-danger');

    if (rep && rep.ts) {
      const fmt = v => v !== undefined && v !== null ? v : '—';
      const fmtTemp = v => v !== undefined && v !== null ? parseFloat(v).toFixed(1) + ' °C' : '—';

      document.getElementById('boiler-temp').textContent = fmtTemp(rep.boiler_temp);
      document.getElementById('panel-temp').textContent  = fmtTemp(rep.panel_temp);

      const valveEl = document.getElementById('valve-state');
      valveEl.textContent = rep.valve_state ? 'ON' : 'OFF';
      valveEl.className = 'value ' + (rep.valve_state ? 'on' : 'off');

      document.getElementById('boiler-trend').textContent = fmt(rep.boiler_trend);
      document.getElementById('panel-trend').textContent  = fmt(rep.panel_trend);

      const dec = rep.decision || '—';
      lastDecision = rep.decision || null;
      const decEl = document.getElementById('last-decision');
      decEl.innerHTML = `<span class="badge badge-${escHtml(dec)}">${escHtml(dec)}</span>`;
      document.getElementById('why-decision').textContent = rep.why_decision || '—';
      await loadNextProbe(lastDecision);

      document.getElementById('last-error').textContent = fmt(rep.error);

      const ts = new Date(rep.ts);
      document.getElementById('report-ts').textContent =
        ts.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

      if (!agentEnabled) {
        document.getElementById('next-run').textContent = '—';
        document.getElementById('next-run-countdown').textContent = '';
        nextRunTarget = null;
      } else if (rep.next_ts) {
        const nts = new Date(rep.next_ts);
        document.getElementById('next-run').textContent =
          nts.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        nextRunTarget = nts.getTime();
        startCountdown();
      } else {
        nextRunTarget = null;
        document.getElementById('next-run-countdown').textContent = '';
      }
    } else {
      ['boiler-temp','panel-temp','valve-state','boiler-trend','panel-trend',
       'last-decision','why-decision','last-error','report-ts','next-run'].forEach(id => {
        document.getElementById(id).textContent = '—';
      });
    }
  } catch (e) {
    console.error('loadReport error:', e);
  }
}

async function loadSettings() {
  try {
    const cfg = await fetch('/api/settings').then(r => r.json());
    document.getElementById('s-run-interval').value      = cfg.run_interval_min ?? '';
    document.getElementById('s-valid-after-on').value    = cfg.panel_temp_valid_after_on ?? '';
    document.getElementById('s-valid-after-off').value   = cfg.panel_temp_valid_after_off ?? '';
    document.getElementById('s-trend-runs').value        = cfg.trend_runs ?? '';
    document.getElementById('s-debounce').value          = cfg.temp_debounce ?? '';
    document.getElementById('s-probe-interval').value    = cfg.probe_interval_min ?? '';
    document.getElementById('s-consumption-temp').value   = cfg.consumption_temp_delta ?? '';
    document.getElementById('s-consumption-time').value   = cfg.consumption_time_delta ?? '';
    document.getElementById('s-probe-max-boiler').value   = cfg.probe_max_boiler_temp ?? '';
    document.getElementById('s-probe-max-delta').value    = cfg.probe_max_delta ?? '';
    document.getElementById('s-glitch-drop').value        = cfg.glitch_drop_threshold_c ?? '';
    document.getElementById('s-glitch-bounce').value      = cfg.glitch_bounce_recovery_c ?? '';
    runIntervalMin = cfg.run_interval_min || 5;
  } catch (e) {
    console.error('loadSettings error:', e);
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const body = {
    run_interval_min:           parseInt(document.getElementById('s-run-interval').value),
    panel_temp_valid_after_on:  parseInt(document.getElementById('s-valid-after-on').value),
    panel_temp_valid_after_off: parseInt(document.getElementById('s-valid-after-off').value),
    trend_runs:                 parseInt(document.getElementById('s-trend-runs').value),
    temp_debounce:              parseFloat(document.getElementById('s-debounce').value),
    probe_interval_min:         parseInt(document.getElementById('s-probe-interval').value),
    consumption_temp_delta:     parseFloat(document.getElementById('s-consumption-temp').value),
    consumption_time_delta:     parseInt(document.getElementById('s-consumption-time').value),
    probe_max_boiler_temp:      parseInt(document.getElementById('s-probe-max-boiler').value),
    probe_max_delta:            parseInt(document.getElementById('s-probe-max-delta').value),
    glitch_drop_threshold_c:    parseFloat(document.getElementById('s-glitch-drop').value),
    glitch_bounce_recovery_c:   parseFloat(document.getElementById('s-glitch-bounce').value),
  };
  // Refuse to POST if any field is empty / non-numeric. An empty input
  // becomes NaN → JSON.stringify → null, which would corrupt NOT NULL
  // numeric columns in agent_settings and crash the boiler agent next run.
  const invalid = Object.entries(body).filter(([, v]) => !Number.isFinite(v));
  if (invalid.length) {
    const msgEl = document.getElementById('settings-msg');
    msgEl.style.color = '#e74c3c';
    msgEl.textContent = 'Missing / invalid fields: ' + invalid.map(([k]) => k).join(', ');
    setTimeout(() => { msgEl.textContent = ''; }, 5000);
    return;
  }
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    const msg = document.getElementById('settings-msg');
    if (r.ok) {
      msg.style.color = '#2ecc71';
      msg.textContent = 'Saved ✓';
      runIntervalMin = body.run_interval_min;
      scheduleAutoRefresh();
      await loadNextProbe(lastDecision);
      setTimeout(() => msg.textContent = '', 3000);
    } else {
      msg.style.color = '#e74c3c';
      msg.textContent = 'Error: ' + (r.error || 'unknown');
    }
  } catch (e) {
    console.error('saveSettings error:', e);
  }
}

async function toggleAgent() {
  try {
    await fetch('/api/agent/toggle', { method: 'POST' });
    await loadReport();
  } catch (e) {
    console.error('toggleAgent error:', e);
  }
}

function scheduleAutoRefresh() {
  clearTimeout(autoRefreshTimer);
  autoRefreshTimer = setTimeout(refreshAll, runIntervalMin * 60 * 1000);
}

refreshAll();
startCountdown();
