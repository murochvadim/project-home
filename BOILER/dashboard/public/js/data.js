const RAW_CACHE         = '_data_raw_tbody';
const AGENT_CACHE       = '_data_agent_tbody';
const CONSUMPTION_CACHE = '_data_consumption_tbody';

// Restore cached tbodys instantly — prevents height jump on page load
try { const c = localStorage.getItem(RAW_CACHE);         if (c) document.getElementById('raw-body').innerHTML         = c; } catch(e) {}
try { const c = localStorage.getItem(AGENT_CACHE);       if (c) document.getElementById('agent-body').innerHTML       = c; } catch(e) {}
try { const c = localStorage.getItem(CONSUMPTION_CACHE); if (c) document.getElementById('consumption-body').innerHTML = c; } catch(e) {}

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
}
function fmtTemp(v) {
  return v !== null && v !== undefined ? parseFloat(v).toFixed(1) + ' °C' : '—';
}
function fmtValve(v) {
  return v ? '<span style="color:#2ecc71;font-weight:600">ON</span>'
           : '<span style="color:#e74c3c;font-weight:600">OFF</span>';
}
function fmtDecision(d) {
  if (!d) return '—';
  return `<span class="badge badge-${d}">${d}</span>`;
}
function fmtVersion(v) {
  return v ? v.slice(0, 7) : '—';
}
function fmtWhy(w) {
  if (!w) return '<span style="color:#bbb">—</span>';
  const short = w.length > 45 ? w.slice(0, 45) + '…' : w;
  const escaped = w.replace(/"/g, '&quot;');
  return `<span title="${escaped}" style="cursor:default">${short}</span>`;
}

function setHTML(el, html) {
  el.innerHTML = html;
}

async function loadRaw() {
  const limit = document.getElementById('raw-limit').value;
  try {
    const rows = await fetch(`/api/raw-data?limit=${limit}`).then(r => r.json());
    const tbody = document.getElementById('raw-body');
    const html = rows.map(r => `
      <tr>
        <td>${fmtTs(r.ts)}</td>
        <td>${fmtTemp(r.boiler_temp)}</td>
        <td>${fmtTemp(r.panel_temp)}</td>
        <td>${fmtValve(r.valve_state)}</td>
      </tr>
    `).join('');
    setHTML(tbody, html);
    try { localStorage.setItem(RAW_CACHE, html); } catch(e) {}
  } catch (e) {
    console.error('loadRaw error:', e);
  }
}

async function loadAgent() {
  const limit = document.getElementById('agent-limit').value;
  try {
    const rows = await fetch(`/api/agent-data?limit=${limit}`).then(r => r.json());
    const tbody = document.getElementById('agent-body');
    const html = rows.map(r => `
      <tr>
        <td>${fmtTs(r.ts)}</td>
        <td>${fmtTemp(r.boiler_temp)}</td>
        <td>${fmtTemp(r.panel_temp)}</td>
        <td>${fmtValve(r.valve_state)}</td>
        <td>${r.boiler_trend || '—'}</td>
        <td>${r.panel_trend || '—'}</td>
        <td>${fmtDecision(r.decision)}</td>
        <td style="font-size:0.75rem; color:#666; max-width:200px;">${fmtWhy(r.why_decision)}</td>
        <td style="font-size:0.78rem; color:${r.error && r.error.startsWith('ERR') ? '#e74c3c' : r.error && r.error.startsWith('WARN') ? '#e67e22' : '#555'}">${r.error || '—'}</td>
        <td>${fmtTs(r.next_ts)}</td>
        <td style="font-family:monospace">${fmtVersion(r.version)}</td>
      </tr>
    `).join('');
    setHTML(tbody, html);
    try { localStorage.setItem(AGENT_CACHE, html); } catch(e) {}
  } catch (e) {
    console.error('loadAgent error:', e);
  }
}

async function loadConsumptions() {
  const limit = document.getElementById('consumption-limit').value;
  try {
    const rows = await fetch(`/api/consumptions?limit=${limit}`).then(r => r.json());
    const tbody = document.getElementById('consumption-body');
    const empty = document.getElementById('consumption-empty');
    if (!rows.length) {
      setHTML(tbody, '');
      empty.style.display = '';
      try { localStorage.removeItem(CONSUMPTION_CACHE); } catch(e) {}
      return;
    }
    empty.style.display = 'none';
    const html = rows.map(r => `
      <tr>
        <td>${fmtTs(r.start_ts)}</td>
        <td>${fmtTs(r.end_ts)}</td>
        <td>${fmtTemp(r.start_temp)}</td>
        <td>${fmtTemp(r.end_temp)}</td>
        <td style="color:#e67e22; font-weight:600;">▼ ${parseFloat(r.drop_c).toFixed(1)}</td>
        <td>${r.duration_min} min</td>
      </tr>
    `).join('');
    setHTML(tbody, html);
    try { localStorage.setItem(CONSUMPTION_CACHE, html); } catch(e) {}
  } catch (e) {
    console.error('loadConsumptions error:', e);
  }
}

async function refreshDataAll() {
  await Promise.all([loadRaw(), loadAgent(), loadConsumptions()]);
  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

refreshDataAll();
