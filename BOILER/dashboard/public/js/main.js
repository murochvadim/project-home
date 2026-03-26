let autoRefreshTimer = null;
let runIntervalMin = 5;

async function refreshAll() {
  await Promise.all([loadReport(), loadSettings(), loadNextProbe()]);
  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
  scheduleAutoRefresh();
}

async function loadNextProbe() {
  try {
    const r = await fetch('/api/next-probe').then(r => r.json());
    const el = document.getElementById('next-probe');
    if (r.next_probe) {
      el.textContent = new Date(r.next_probe).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    } else {
      el.textContent = '—';
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
    const statusEl = document.getElementById('agent-status');
    statusEl.textContent = agentEnabled ? 'ENABLED' : 'DISABLED';
    statusEl.className = 'value ' + (agentEnabled ? 'on' : 'off');

    const toggleBtn = document.getElementById('toggle-btn');
    toggleBtn.textContent = agentEnabled ? 'Stop Agent' : 'Start Agent';
    toggleBtn.className = 'btn btn-sm ' + (agentEnabled ? 'btn-danger' : 'btn-success');

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
      const decEl = document.getElementById('last-decision');
      decEl.innerHTML = `<span class="badge badge-${dec}">${dec}</span>`;
      document.getElementById('why-decision').textContent = rep.why_decision || '—';

      document.getElementById('last-error').textContent = fmt(rep.error);

      const ts = new Date(rep.ts);
      document.getElementById('report-ts').textContent =
        ts.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

      if (rep.next_ts) {
        const nts = new Date(rep.next_ts);
        document.getElementById('next-run').textContent =
          nts.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
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
    document.getElementById('s-run-interval').value  = cfg.run_interval_min ?? '';
    document.getElementById('s-valid-after-on').value  = cfg.panel_temp_valid_after_on ?? '';
    document.getElementById('s-valid-after-off').value = cfg.panel_temp_valid_after_off ?? '';
    document.getElementById('s-trend-runs').value   = cfg.trend_runs ?? '';
    document.getElementById('s-debounce').value          = cfg.temp_debounce ?? '';
    document.getElementById('s-probe-interval').value    = cfg.probe_interval_min ?? '';
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
  };
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    const msg = document.getElementById('settings-msg');
    if (r.ok) {
      msg.textContent = 'Saved ✓';
      runIntervalMin = body.run_interval_min;
      scheduleAutoRefresh();
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
    await Promise.all([loadReport(), loadNextProbe()]);
  } catch (e) {
    console.error('toggleAgent error:', e);
  }
}

async function deploy() {
  const out = document.getElementById('deploy-output');
  out.style.display = 'block';
  out.textContent = 'Deploying…';
  try {
    const r = await fetch('/api/deploy', { method: 'POST' }).then(r => r.json());
    if (r.error) {
      out.textContent = 'ERROR: ' + r.error;
    } else {
      out.textContent = '--- git pull ---\n' + (r.pull || '(no output)') +
                        '\n\n--- restart ---\n' + (r.restart || '(no output)');
    }
  } catch (e) {
    out.textContent = 'ERROR: ' + e.message;
  }
}

function scheduleAutoRefresh() {
  clearTimeout(autoRefreshTimer);
  autoRefreshTimer = setTimeout(refreshAll, runIntervalMin * 60 * 1000);
}

refreshAll();
