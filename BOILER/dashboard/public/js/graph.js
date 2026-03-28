let chart = null;

async function loadGraph() {
  const range      = document.getElementById('range').value;
  const resolution = document.getElementById('resolution').value;

  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });

  try {
    const rangeMs = { '1h': 3600000, '6h': 21600000, '24h': 86400000 }[range] || 21600000;
    const fromIso = new Date(Date.now() - rangeMs).toISOString();

    const [rows, consumptions] = await Promise.all([
      fetch(`/api/graph?range=${range}&resolution=${resolution}`).then(r => r.json()),
      fetch(`/api/consumptions?from=${encodeURIComponent(fromIso)}`).then(r => r.json()),
    ]);

    const labels      = rows.map(r => new Date(r.t).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' }));
    const boilerTemps = rows.map(r => r.boiler_temp !== null ? parseFloat(r.boiler_temp) : null);
    const panelTemps  = rows.map(r => r.panel_temp  !== null ? parseFloat(r.panel_temp)  : null);
    const valveOn     = rows.map(r => r.valve_state ? 1 : 0);

    // Map each consumption start_ts to the nearest row index.
    // Also build spikeConsumption (index → object) for unambiguous tooltip lookup.
    const rowTimes       = rows.map(r => new Date(r.t).getTime());
    const spikeData      = new Array(rows.length).fill(null);
    const spikeRadii     = new Array(rows.length).fill(0);
    const spikeConsumption = {};  // dataIndex → consumption object

    consumptions.forEach(c => {
      const cTs = new Date(c.start_ts).getTime();
      let nearest = 0, minDiff = Infinity;
      rowTimes.forEach((t, i) => {
        const diff = Math.abs(t - cTs);
        if (diff < minDiff) { minDiff = diff; nearest = i; }
      });
      spikeData[nearest]        = parseFloat(c.start_temp);
      spikeRadii[nearest]       = 9;
      spikeConsumption[nearest] = c;
    });

    if (chart) chart.destroy();

    chart = new Chart(document.getElementById('tempChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Boiler Temp (°C)',
            data: boilerTemps,
            borderColor: '#4a9eff',
            backgroundColor: 'transparent',
            tension: 0.3,
            pointRadius: 2,
            yAxisID: 'yTemp',
          },
          {
            label: 'Panel Temp (°C)',
            data: panelTemps,
            borderColor: '#e67e22',
            backgroundColor: 'transparent',
            tension: 0.3,
            pointRadius: 2,
            yAxisID: 'yTemp',
          },
          {
            label: 'Valve (ON=1 / OFF=0)',
            data: valveOn,
            borderColor: '#2ecc71',
            backgroundColor: 'rgba(46,204,113,0.15)',
            fill: true,
            stepped: true,
            pointRadius: 0,
            borderWidth: 1.5,
            yAxisID: 'yValve',
          },
          {
            label: 'Consumption',
            data: spikeData,
            showLine: false,
            pointStyle: 'triangle',
            pointRotation: 180,
            pointRadius: spikeRadii,
            pointHoverRadius: 11,
            backgroundColor: '#e74c3c',
            borderColor: '#e74c3c',
            yAxisID: 'yTemp',
          },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            ticks: { maxTicksLimit: 12, font: { size: 11 } },
          },
          yTemp: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: 'Temperature (°C)', font: { size: 11 } },
            ticks: { font: { size: 11 }, callback: v => v.toFixed(1) },
          },
          yValve: {
            type: 'linear',
            position: 'right',
            min: 0,
            max: 1.5,
            ticks: {
              font: { size: 11 },
              stepSize: 1,
              callback: v => v === 1 ? 'ON' : v === 0 ? 'OFF' : '',
            },
            grid: { drawOnChartArea: false },
          },
        },
        plugins: {
          legend: { labels: { font: { size: 12 } } },
          tooltip: {
            callbacks: {
              label: ctx => {
                if (ctx.dataset.label === 'Consumption' && ctx.raw !== null) {
                  const c = spikeConsumption[ctx.dataIndex];
                  return c
                    ? `Consumption: ▼${parseFloat(c.drop_c).toFixed(1)}°C (${c.duration_min} min)`
                    : `Consumption: ${ctx.raw}°C`;
                }
                return `${ctx.dataset.label}: ${typeof ctx.raw === 'number' ? ctx.raw.toFixed(1) : ctx.raw}`;
              },
            },
          },
        },
      },
    });
  } catch (e) {
    console.error('loadGraph error:', e);
  }
}

document.getElementById('range').addEventListener('change', loadGraph);
document.getElementById('resolution').addEventListener('change', loadGraph);

loadGraph();

// ── AI Investigation ───────────────────────────────────────────
const AI_STORAGE_KEY = 'boiler_ai_investigation';
let aiChart = null;

async function runInvestigation() {
  const btn      = document.getElementById('ai-btn');
  const btnIcon  = document.getElementById('ai-btn-icon');
  const btnLabel = document.getElementById('ai-btn-label');
  const errEl    = document.getElementById('ai-error');

  btn.disabled = true;
  btnIcon.innerHTML = '<span class="ai-spinner"></span>';
  btnLabel.textContent = 'Thinking\u2026';
  errEl.style.display = 'none';

  const fromVal = document.getElementById('ai-from').value;
  const toVal   = document.getElementById('ai-to').value;

  try {
    const r = await fetch('/api/ai-investigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_hour:          parseInt(fromVal.split(':')[0]),
        to_hour:            parseInt(toVal.split(':')[0]),
        include_weather:    document.getElementById('ai-weather').checked,
        include_outlook:    document.getElementById('ai-outlook').checked,
        include_agent_data: document.getElementById('ai-agent').checked,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Investigation failed');
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(data));
    renderInvestigation(data, false);
  } catch (e) {
    errEl.textContent = 'Error: ' + e.message;
    errEl.style.display = 'inline';
  } finally {
    btn.disabled = false;
    btnIcon.innerHTML = '&#129504;';
    btnLabel.textContent = 'Investigate';
  }
}

function renderInvestigation(data, fromStorage) {
  document.getElementById('ai-results').style.display = 'block';

  const ranAt = new Date(data.ran_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  document.getElementById('ai-last-run').textContent =
    (fromStorage ? 'Restored \u2014 last run: ' : 'Ran: ') + ranAt +
    '  |  Window: ' + data.from_hour + ':00 \u2013 ' + data.to_hour + ':00';

  document.getElementById('ai-summary').textContent = data.summary || '';

  if (data._debug) {
    document.getElementById('ai-prompt-system').textContent = data._debug.system_prompt || '';
    document.getElementById('ai-prompt-user').textContent   = data._debug.user_content  || '';
    document.getElementById('ai-prompt-btn').style.display  = '';
    document.getElementById('ai-prompt-details').style.display = 'none';
  } else {
    document.getElementById('ai-prompt-btn').style.display  = 'none';
    document.getElementById('ai-prompt-details').style.display = 'none';
  }

  const tbody    = document.getElementById('ai-settings-body');
  const table    = document.getElementById('ai-settings-table');
  const noChange = document.getElementById('ai-no-changes');
  tbody.innerHTML = '';

  const applyWrap = document.getElementById('ai-apply-wrap');
  if (!data.settings || data.settings.length === 0) {
    table.style.display = 'none';
    noChange.style.display = 'block';
    applyWrap.style.display = 'none';
  } else {
    table.style.display = '';
    noChange.style.display = 'none';
    applyWrap.style.display = 'block';
    document.getElementById('ai-apply-msg').style.display = 'none';
    data.settings.forEach(s => {
      const changed = s.suggested !== s.current;
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><code>' + s.param + '</code></td>' +
        '<td>' + s.current + '</td>' +
        '<td style="color:' + (changed ? '#2e7d32' : '#888') + '; font-weight:' + (changed ? '600' : 'normal') + ';">' + s.suggested + '</td>' +
        '<td style="font-size:0.8rem; color:#666;">' + s.reason + '</td>';
      tbody.appendChild(tr);
    });
  }

  if (data.prediction && data.prediction.length > 0) {
    const labels     = data.prediction.map(p => p.time);
    const boilerLine = data.prediction.map(p => p.boiler_temp);
    const panelLine  = data.prediction.map(p => p.panel_temp);
    const valveLine  = data.prediction.map(p => p.valve ? 1 : 0);

    if (aiChart) aiChart.destroy();
    aiChart = new Chart(document.getElementById('aiChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Predicted Boiler (\u00b0C)',
            data: boilerLine,
            borderColor: '#4a9eff',
            backgroundColor: 'transparent',
            borderDash: [6, 3],
            tension: 0.4,
            pointRadius: 3,
            yAxisID: 'yTemp',
          },
          {
            label: 'Predicted Panel (\u00b0C)',
            data: panelLine,
            borderColor: '#e67e22',
            backgroundColor: 'transparent',
            borderDash: [6, 3],
            tension: 0.4,
            pointRadius: 3,
            yAxisID: 'yTemp',
          },
          {
            label: 'Predicted Valve',
            data: valveLine,
            borderColor: '#2ecc71',
            backgroundColor: 'rgba(46,204,113,0.12)',
            fill: true,
            stepped: true,
            pointRadius: 0,
            borderWidth: 1.5,
            borderDash: [4, 2],
            yAxisID: 'yValve',
          },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { font: { size: 11 } } },
          yTemp: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: 'Temperature (\u00b0C)', font: { size: 11 } },
            ticks: { font: { size: 11 }, callback: v => v.toFixed(1) },
          },
          yValve: {
            type: 'linear',
            position: 'right',
            min: 0,
            max: 1.5,
            ticks: { font: { size: 11 }, stepSize: 1, callback: v => v === 1 ? 'ON' : v === 0 ? 'OFF' : '' },
            grid: { drawOnChartArea: false },
          },
        },
        plugins: { legend: { labels: { font: { size: 12 } } } },
      },
    });
  }
}

async function applySuggestedSettings() {
  const stored = localStorage.getItem(AI_STORAGE_KEY);
  if (!stored) return;
  const data = JSON.parse(stored);
  if (!data.settings || data.settings.length === 0) return;

  const msgEl = document.getElementById('ai-apply-msg');
  msgEl.style.display = 'inline';
  msgEl.style.color = '#888';
  msgEl.textContent = 'Applying\u2026';

  try {
    const current = await fetch('/api/settings').then(r => r.json());
    data.settings.forEach(s => { current[s.param] = s.suggested; });
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(current),
    });
    if (!r.ok) throw new Error('Save failed');
    msgEl.style.color = '#2e7d32';
    msgEl.textContent = '\u2713 Applied';
  } catch (e) {
    msgEl.style.color = '#c0392b';
    msgEl.textContent = 'Error: ' + e.message;
  }
}

function togglePrompt() {
  const el  = document.getElementById('ai-prompt-details');
  const btn = document.getElementById('ai-prompt-btn');
  const visible = el.style.display !== 'none';
  el.style.display  = visible ? 'none' : 'block';
  btn.textContent   = visible ? 'View Prompt' : 'Hide Prompt';
}

function clearInvestigation() {
  localStorage.removeItem(AI_STORAGE_KEY);
  document.getElementById('ai-results').style.display = 'none';
  if (aiChart) { aiChart.destroy(); aiChart = null; }
}

// Stored investigation is restored lazily when the AI tab is first opened (see graph.html showGraphTab)
