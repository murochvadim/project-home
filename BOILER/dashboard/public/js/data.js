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

async function loadRaw() {
  const limit = document.getElementById('raw-limit').value;
  try {
    const rows = await fetch(`/api/raw-data?limit=${limit}`).then(r => r.json());
    const tbody = document.getElementById('raw-body');
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${fmtTs(r.ts)}</td>
        <td>${fmtTemp(r.boiler_temp)}</td>
        <td>${fmtTemp(r.panel_temp)}</td>
        <td>${fmtValve(r.valve_state)}</td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('loadRaw error:', e);
  }
}

async function loadAgent() {
  const limit = document.getElementById('agent-limit').value;
  try {
    const rows = await fetch(`/api/agent-data?limit=${limit}`).then(r => r.json());
    const tbody = document.getElementById('agent-body');
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${fmtTs(r.ts)}</td>
        <td>${fmtTemp(r.boiler_temp)}</td>
        <td>${fmtTemp(r.panel_temp)}</td>
        <td>${fmtValve(r.valve_state)}</td>
        <td>${r.boiler_trend || '—'}</td>
        <td>${r.panel_trend || '—'}</td>
        <td>${fmtDecision(r.decision)}</td>
        <td style="font-size:0.78rem; color:${r.error && r.error.startsWith('ERR') ? '#e74c3c' : r.error && r.error.startsWith('WARN') ? '#e67e22' : '#555'}">${r.error || '—'}</td>
        <td>${fmtTs(r.next_ts)}</td>
        <td style="font-family:monospace">${fmtVersion(r.version)}</td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('loadAgent error:', e);
  }
}

async function refreshAll() {
  await Promise.all([loadRaw(), loadAgent()]);
  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

refreshAll();
