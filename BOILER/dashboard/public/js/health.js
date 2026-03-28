const fmtTs = ts => ts
  ? new Date(ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
  : '—';

const dot = ok => `<span style="color:${ok ? '#7a9f5a' : '#b55e5e'}; font-size:0.85rem;">${ok ? '⬤ OK' : '⬤ Error'}</span>`;

// ── System Alerts ────────────────────────────────────────────
let showResolvedAlerts = false;
const ALERTS_TBODY_CACHE = '_health_alerts_tbody';

// Restore cached tbody immediately so table height is stable on load
try {
  const c = localStorage.getItem(ALERTS_TBODY_CACHE);
  if (c) document.getElementById('alerts-body').innerHTML = c;
} catch (e) {}

async function loadAlerts() {
  try {
    const url = `/api/health/alerts${showResolvedAlerts ? '?include_resolved=true' : ''}`;
    const data = await fetch(url).then(r => r.json());
    const rows = data.rows || [];
    const resolvedCount = parseInt(data.resolved_count) || 0;
    const tbody = document.getElementById('alerts-body');
    const badge = document.getElementById('alerts-badge');
    const histBtn  = document.getElementById('alerts-history-btn');
    const clearBtn = document.getElementById('alerts-clear-btn');

    const active = rows.filter(r => !r.resolved_local);

    // Badge
    if (active.length) {
      badge.textContent = `${active.length} active`;
      badge.style.display = 'inline';
      badge.style.background = active.some(a => a.severity === 'critical') ? '#7a2020'
        : active.some(a => a.severity === 'error') ? '#b55e5e' : '#b8860b';
      badge.style.color = '#fff';
    } else {
      badge.textContent = 'all clear';
      badge.style.display = 'inline';
      badge.style.background = '#e8f0e8';
      badge.style.color = '#5a8a5a';
    }

    // History / Clear buttons
    if (resolvedCount > 0) {
      histBtn.textContent = showResolvedAlerts ? 'Hide resolved' : `Show resolved (${resolvedCount})`;
      histBtn.style.display = 'inline-block';
      clearBtn.style.display = 'inline-block';
    } else {
      histBtn.style.display = 'none';
      clearBtn.style.display = 'none';
    }

    // Table
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:#aaa; text-align:center; padding:16px;">No active alerts</td></tr>';
      return;
    }

    const sevColor = { critical: '#7a2020', error: '#b55e5e', warn: '#b8860b', info: '#5a8a5a' };
    const sevBg    = { critical: '#fff0f0', error: '#fff5f5', warn: '#fffbf0' };
    const fmtTs    = ts => ts ? new Date(ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '—';

    tbody.innerHTML = rows.map(r => {
      const color = sevColor[r.severity] || '#555';
      const bg    = r.resolved_local ? 'transparent' : (sevBg[r.severity] || 'transparent');
      const opac  = r.resolved_local ? 'opacity:0.5;' : '';
      return `<tr style="background:${bg}; ${opac}">
        <td style="font-size:0.75rem; color:#888; white-space:nowrap;">${fmtTs(r.ts_local)}</td>
        <td style="text-align:center;">
          <span style="color:${r.resolved_local ? '#5a8a5a' : color}; font-size:0.75rem; font-weight:600;">${r.resolved_local ? '✓' : r.severity.toUpperCase()}</span>
        </td>
        <td style="font-size:0.78rem;">${r.affected_agent || '<span style="color:#aaa;">all</span>'}</td>
        <td style="font-size:0.75rem; color:#888;">${r.alert_type}</td>
        <td style="font-size:0.8rem; color:${r.resolved_local ? '#888' : color};">${r.message}</td>
        <td style="font-size:0.75rem; color:#5a8a5a;">${r.resolved_local ? fmtTs(r.resolved_local) : ''}</td>
      </tr>`;
    }).join('');
    try { localStorage.setItem(ALERTS_TBODY_CACHE, tbody.innerHTML); } catch (e) {}
  } catch (e) {
    document.getElementById('alerts-body').innerHTML =
      '<tr><td colspan="6" style="color:#b55e5e;">Failed to load</td></tr>';
  }
}

function toggleResolvedAlerts() {
  showResolvedAlerts = !showResolvedAlerts;
  loadAlerts();
}

async function clearResolvedAlerts() {
  if (!confirm('Delete all resolved alerts? This cannot be undone.')) return;
  try {
    await fetch('/api/health/alerts/resolved', { method: 'DELETE' });
    showResolvedAlerts = false;
    loadAlerts();
  } catch (e) {
    alert('Failed: ' + e.message);
  }
}

// ── System Status ────────────────────────────────────────────
const STATUS_CACHE_KEY = '_health_status_cache';

function renderStatus(r) {
  document.getElementById('svc-postgres').innerHTML = dot(r.postgres?.ok);
  document.getElementById('svc-ha').innerHTML       = dot(r.homeassistant?.ok);
  document.getElementById('svc-lxc').innerHTML      = dot(r.lxc103?.ok);
  document.getElementById('svc-lxc104').innerHTML   = dot(r.lxc104?.ok);

  const htp = r.ha_to_pg;
  if (htp) {
    const color = htp.data_ok ? '#7a9f5a' : '#b55e5e';
    const label = htp.data_ok ? '⬤ OK' : '⬤ Stale';
    const ageStr = htp.age_min != null ? `last data: ${Math.round(htp.age_min)}m ago` : '';
    const cronNote = !htp.cron_ok && htp.data_ok ? `<div style="font-size:0.7rem; color:#b8860b; margin-top:3px;">cron check unavailable (SSH)</div>` : '';
    document.getElementById('svc-ha-to-pg').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${label}</span>` +
      (ageStr ? `<div style="font-size:0.7rem; color:#888; margin-top:3px;">${ageStr}</div>` : '') +
      cronNote;
  }

  const agentOk = r.boiler_agent?.ok;
  const agentStatus = r.boiler_agent?.status || 'unknown';
  document.getElementById('svc-agent').innerHTML =
    `<span style="color:${agentOk ? '#7a9f5a' : '#b55e5e'}; font-size:0.85rem;">⬤ ${agentStatus}</span>`;

  const pm2Raw = r.pm2?.raw || '';
  document.getElementById('svc-pm2').innerHTML = dot(r.pm2?.ok) +
    (pm2Raw && pm2Raw !== 'pm2_unavailable'
      ? `<div style="font-size:0.7rem; color:#888; margin-top:3px; white-space:pre;">${pm2Raw}</div>`
      : '');

  const orch = r.orchestrator;
  if (orch) {
    document.getElementById('svc-orchestrator').innerHTML = dot(orch.ok) +
      (orch.ok ? '' : `<div style="font-size:0.7rem; color:#b55e5e; margin-top:3px;">timer: ${orch.timer || '?'} / quick: ${orch.quick || '?'}</div>`);
  }

  const olr = r.orchestrator_last_run;
  if (olr) {
    const color = olr.ok ? '#7a9f5a' : '#b55e5e';
    document.getElementById('svc-orch-last-run').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${olr.ok ? '⬤ OK' : '⬤ Overdue'}</span>` +
      (olr.age_min != null ? `<div style="font-size:0.7rem; color:#888; margin-top:3px;">${olr.age_min}m ago</div>` : '');
  }

  const cw = r.collect_weather;
  if (cw) {
    const color    = cw.data_ok ? '#7a9f5a' : '#b55e5e';
    const cronNote = !cw.cron_ok && cw.data_ok ? `<div style="font-size:0.7rem; color:#b8860b; margin-top:3px;">cron check unavailable (SSH)</div>` : '';
    document.getElementById('svc-collect-weather').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${cw.data_ok ? '⬤ OK' : '⬤ Stale'}</span>` +
      (cw.age_min != null ? `<div style="font-size:0.7rem; color:#888; margin-top:3px;">last data: ${cw.age_min}m ago</div>` : '') +
      cronNote;
  }

  const aa = r.active_alerts;
  if (aa) {
    const sevColor = { critical: '#7a2020', error: '#b55e5e', warn: '#b8860b' };
    const color = aa.ok ? '#7a9f5a' : (sevColor[aa.worst] || '#b55e5e');
    document.getElementById('svc-active-alerts').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${aa.ok ? '⬤ All clear' : `⬤ ${aa.count} active`}</span>` +
      (!aa.ok && aa.worst ? `<div style="font-size:0.7rem; color:${color}; margin-top:3px;">worst: ${aa.worst}</div>` : '');
  }

  const bld = r.boiler_last_decision;
  if (bld) {
    const color = bld.ok ? '#7a9f5a' : '#b55e5e';
    document.getElementById('svc-boiler-last').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${bld.ok ? '⬤ OK' : '⬤ Stale'}</span>` +
      (bld.age_min != null ? `<div style="font-size:0.7rem; color:#888; margin-top:3px;">${bld.age_min}m ago — ${bld.decision || '?'}</div>` : '');
  }
}

async function loadStatus() {
  // Show cached state instantly — no blank dash on navigation
  try {
    const cached = localStorage.getItem(STATUS_CACHE_KEY);
    if (cached) renderStatus(JSON.parse(cached));
  } catch (e) {}

  try {
    const r = await fetch('/api/health/status').then(r => r.json());
    renderStatus(r);
    try { localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(r)); } catch (e) {}
  } catch (e) {
    ['svc-postgres','svc-ha','svc-lxc','svc-lxc104','svc-agent','svc-ha-to-pg','svc-pm2',
     'svc-orchestrator','svc-orch-last-run','svc-collect-weather','svc-active-alerts','svc-boiler-last'
    ].forEach(id => { document.getElementById(id).innerHTML = dot(false); });
  }
}

// ── DB Volumes ───────────────────────────────────────────────
async function loadVolumes() {
  try {
    const rows = await fetch('/api/health/db-volumes').then(r => r.json());
    const tbody = document.getElementById('volumes-body');
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td><code>${r.table_name}</code></td>
        <td style="text-align:right;">${r.row_count.toLocaleString()}</td>
        <td style="text-align:right;">${r.total_size}</td>
        <td style="font-size:0.78rem; color:#666;">${fmtTs(r.oldest)}</td>
        <td style="font-size:0.78rem; color:#666;">${fmtTs(r.newest)}</td>
      </tr>`).join('');
  } catch (e) {
    document.getElementById('volumes-body').innerHTML =
      '<tr><td colspan="5" style="color:#b55e5e;">Failed to load</td></tr>';
  }
}

// ── Retention Policies ───────────────────────────────────────
async function loadRetention() {
  try {
    const rows = await fetch('/api/health/retention').then(r => r.json());
    const tbody = document.getElementById('retention-body');
    tbody.innerHTML = rows.map(p => `
      <tr id="row-${p.table_name}">
        <td><code>${p.table_name}</code></td>
        <td style="font-size:0.78rem; color:#666;">${p.description || '—'}</td>
        <td style="text-align:center;">
          <input type="number" min="1" value="${p.keep_days ?? ''}" placeholder="∞"
            style="width:60px; text-align:center; font-size:0.8rem; border:1px solid #d0cbc4; border-radius:3px; padding:2px 4px; background:#faf8f5;"
            id="keep-${p.table_name}">
        </td>
        <td style="text-align:center;">
          <input type="checkbox" ${p.auto_clean ? 'checked' : ''} id="auto-${p.table_name}">
        </td>
        <td style="text-align:center;">
          <input type="number" min="1" value="${p.clean_interval_hours}"
            style="width:55px; text-align:center; font-size:0.8rem; border:1px solid #d0cbc4; border-radius:3px; padding:2px 4px; background:#faf8f5;"
            id="interval-${p.table_name}">
        </td>
        <td style="font-size:0.78rem; color:#666;">${fmtTs(p.last_cleaned_at)}</td>
        <td style="text-align:center; white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" style="font-size:0.72rem; padding:3px 8px; margin-right:4px;"
            onclick="savePolicy('${p.table_name}')">Save</button>
          <button class="btn btn-secondary btn-sm" style="font-size:0.72rem; padding:3px 8px;"
            onclick="cleanTable('${p.table_name}')" ${p.keep_days ? '' : 'disabled title="No retention limit set"'}>Clean</button>
        </td>
      </tr>`).join('');
  } catch (e) {
    document.getElementById('retention-body').innerHTML =
      '<tr><td colspan="7" style="color:#b55e5e;">Failed to load</td></tr>';
  }
}

async function savePolicy(tableName) {
  const keep     = document.getElementById(`keep-${tableName}`).value;
  const auto     = document.getElementById(`auto-${tableName}`).checked;
  const interval = document.getElementById(`interval-${tableName}`).value;
  try {
    await fetch('/api/health/retention', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table_name: tableName,
        keep_days: keep ? parseInt(keep) : null,
        auto_clean: auto,
        clean_interval_hours: parseInt(interval) || 24
      })
    });
    showCleanupResult(`✓ Saved policy for ${tableName}`);
  } catch (e) {
    showCleanupResult(`✗ Failed: ${e.message}`, true);
  }
}

async function cleanTable(tableName) {
  const keepEl = document.getElementById(`keep-${tableName}`);
  const days = keepEl?.value || '?';
  if (!confirm(`Delete all rows older than ${days} days from "${tableName}"?\n\nThis cannot be undone.`)) return;
  showCleanupResult('Running cleanup…');
  try {
    const r = await fetch('/api/health/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_name: tableName })
    }).then(r => r.json());
    const deleted = r.results?.[0]?.deleted ?? 0;
    showCleanupResult(`✓ Deleted ${deleted} rows from ${tableName}`);
    await loadVolumes();
    await loadRetention();
  } catch (e) {
    showCleanupResult(`✗ Failed: ${e.message}`, true);
  }
}

async function cleanAll() {
  if (!confirm('Run cleanup on ALL tables with a retention limit set?\n\nThis will permanently delete old rows and cannot be undone.')) return;
  showCleanupResult('Running full cleanup…');
  try {
    const r = await fetch('/api/health/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_name: null })
    }).then(r => r.json());
    const total = r.results?.reduce((s, x) => s + x.deleted, 0) ?? 0;
    const detail = r.results?.map(x => `${x.table_name}: ${x.deleted}`).join(', ') || '—';
    showCleanupResult(`✓ Total deleted: ${total} rows (${detail})`);
    await loadVolumes();
    await loadRetention();
  } catch (e) {
    showCleanupResult(`✗ Failed: ${e.message}`, true);
  }
}

function showCleanupResult(msg, isError = false) {
  const el = document.getElementById('cleanup-result');
  el.textContent = msg;
  el.style.color = isError ? '#b55e5e' : '#5a8a5a';
}

// ── Orchestrator Log ─────────────────────────────────────────
const ORCH_TBODY_CACHE = '_health_orch_tbody';

try {
  const c = localStorage.getItem(ORCH_TBODY_CACHE);
  if (c) document.getElementById('orch-body').innerHTML = c;
} catch (e) {}

async function loadOrchLog() {
  const limit = document.getElementById('orch-limit').value;
  try {
    const rows = await fetch(`/api/health/orch-log?limit=${limit}`).then(r => r.json());
    const tbody = document.getElementById('orch-body');

    const colorMap = { info: '#555', warn: '#b8860b', error: '#b55e5e', critical: '#7a2020' };
    const bgMap    = { info: 'transparent', warn: '#fffbf0', error: '#fff5f5', critical: '#fff0f0' };

    tbody.innerHTML = rows.map(r => {
      const isResolved = r.message.startsWith('ALERT resolved');
      const isRaised   = r.message.startsWith('ALERT raised');
      const color = isResolved ? '#5a8a5a' : (colorMap[r.severity] || '#555');
      const bg    = isResolved ? 'transparent' : (isRaised ? (bgMap[r.severity] || 'transparent') : 'transparent');
      const opac  = isResolved ? 'opacity:0.6;' : '';
      const ts    = r.ts_local ? new Date(r.ts_local).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '—';
      const label = isResolved ? 'RESOLVED' : (isRaised ? r.severity.toUpperCase() : r.severity.toUpperCase());
      const labelColor = isResolved ? '#5a8a5a' : color;
      return `<tr style="background:${bg}; ${opac}">
        <td style="font-size:0.75rem; color:#888; white-space:nowrap;">${ts}</td>
        <td style="text-align:center;">
          <span style="color:${labelColor}; font-size:0.75rem; font-weight:600;">${label}</span>
        </td>
        <td style="font-size:0.8rem; color:${color};">${r.message}</td>
      </tr>`;
    }).join('');

    // Summary: last run time + status
    const lastRun = rows.find(r => r.message.startsWith('Run complete'));
    const summary = lastRun
      ? `Last run: ${new Date(lastRun.ts_local).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' })} — ${lastRun.message.includes('all OK') ? '✓ OK' : '⚠ Issues'}`
      : '';
    document.getElementById('orch-summary').textContent = summary;
    document.getElementById('orch-summary').style.color = lastRun?.message.includes('all OK') ? '#5a8a5a' : '#b8860b';
    try { localStorage.setItem(ORCH_TBODY_CACHE, tbody.innerHTML); } catch (e) {}

  } catch (e) {
    document.getElementById('orch-body').innerHTML =
      '<tr><td colspan="3" style="color:#b55e5e;">Failed to load</td></tr>';
  }
}

async function refreshAll() {
  document.getElementById('last-refresh').textContent = 'Loading…';
  const dbTabActive = document.getElementById('tab-database')?.classList.contains('active');
  const tasks = [loadAlerts(), loadStatus(), loadOrchLog()];
  if (dbTabActive) { tasks.push(loadVolumes(), loadRetention()); }
  await Promise.all(tasks);
  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

// Initial load — System tab only
loadAlerts();
loadStatus();
loadOrchLog();

// Auto-refresh: only status grid (no table reloads = no scroll jump)
// Alerts and orch log tables refresh only on manual ↺ click
setInterval(() => {
  if (!document.getElementById('tab-database')?.classList.contains('active')) {
    loadStatus();
  }
}, 60000);
