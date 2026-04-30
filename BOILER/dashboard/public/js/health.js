const fmtTs = ts => ts
  ? new Date(ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
  : '—';

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return escHtml(s).replace(/'/g,'&#39;');
}

function setHTML(el, html) {
  el.innerHTML = html;
}

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
    setHTML(tbody, rows.map(r => {
      const color = sevColor[r.severity] || '#555';
      const bg    = r.resolved_local ? 'transparent' : (sevBg[r.severity] || 'transparent');
      const opac  = r.resolved_local ? 'opacity:0.5;' : '';
      return `<tr style="background:${bg}; ${opac}">
        <td style="font-size:0.75rem; color:#888; white-space:nowrap;">${fmtTs(r.ts_local)}</td>
        <td style="text-align:center;">
          <span style="color:${r.resolved_local ? '#5a8a5a' : color}; font-size:0.75rem; font-weight:600;">${r.resolved_local ? '✓' : r.severity.toUpperCase()}</span>
        </td>
        <td style="font-size:0.78rem;">${r.affected_agent ? escHtml(r.affected_agent) : '<span style="color:#aaa;">all</span>'}</td>
        <td style="font-size:0.75rem; color:#888;">${escHtml(r.alert_type)}</td>
        <td style="font-size:0.8rem; color:${r.resolved_local ? '#888' : color};">${escHtml(r.message)}</td>
        <td style="font-size:0.75rem; color:#5a8a5a;">${r.resolved_local ? fmtTs(r.resolved_local) : ''}</td>
      </tr>`;
    }).join(''));
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

  // VM + LXC
  document.getElementById('svc-vm101').innerHTML  = dot(r.vm101?.ok);
  document.getElementById('svc-lxc100').innerHTML = dot(r.lxc100?.ok);
  document.getElementById('svc-lxc102').innerHTML = dot(r.lxc102?.ok);
  document.getElementById('svc-lxc103').innerHTML = dot(r.lxc103?.ok);
  document.getElementById('svc-lxc104').innerHTML = dot(r.lxc104?.ok);
  document.getElementById('svc-lxc105').innerHTML = dot(r.lxc105?.ok);
  document.getElementById('svc-lxc106').innerHTML = dot(r.lxc106?.ok);
  document.getElementById('svc-lxc107').innerHTML = dot(r.lxc107?.ok);

  const htp = r.ha_to_pg;
  if (htp) {
    const color = htp.data_ok ? '#7a9f5a' : '#b55e5e';
    document.getElementById('svc-ha-to-pg').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${htp.data_ok ? '⬤ OK' : '⬤ Stale'}</span>` +
      (htp.age_min != null ? `<div style="font-size:0.7rem; color:#888; margin-top:3px;">last data: ${Math.round(htp.age_min)}m ago</div>` : '');
  }

  const agentOk = r.boiler_agent?.ok;
  document.getElementById('svc-agent').innerHTML =
    agentOk === null
      ? `<span style="color:#888; font-size:0.85rem;">⬤ unknown</span>`
      : dot(agentOk) + (!agentOk ? `<div style="font-size:0.7rem; color:#b55e5e; margin-top:3px;">service down — see alerts</div>` : '');

  const voiceOk = r.voice_agent?.ok;
  document.getElementById('svc-voice-agent').innerHTML =
    voiceOk === null || voiceOk === undefined
      ? `<span style="color:#888; font-size:0.85rem;">⬤ unknown</span>`
      : dot(voiceOk) + (!voiceOk ? `<div style="font-size:0.7rem; color:#b55e5e; margin-top:3px;">whisper-http down</div>` : '');

  const re = r.rule_engine;
  if (re) {
    const color = re.ok ? '#7a9f5a' : '#b55e5e';
    let label;
    if (re.service_ok === false) label = '⬤ Service down';
    else if (!re.heartbeat_ok)   label = '⬤ Stale heartbeat';
    else                          label = '⬤ OK';
    document.getElementById('svc-rule-engine').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${label}</span>` +
      (re.age_min != null ? `<div style="font-size:0.7rem; color:#888; margin-top:3px;">heartbeat ${re.age_min}m ago</div>` : '');
  }

  const ma = r.media_agents;
  if (ma) {
    const agents = [
      { name: 'analyzer', ok: ma.analyzer },
      { name: 'player',   ok: ma.player   },
      { name: 'ingest',   ok: ma.ingest   },
    ];
    document.getElementById('svc-media-agents').innerHTML = agents.map(a =>
      `<span style="color:${a.ok === null ? '#888' : a.ok ? '#7a9f5a' : '#b55e5e'}; font-size:0.82rem; margin-right:6px;">⬤ ${a.name}</span>`
    ).join('');
  }

  const pm2Raw = r.pm2?.raw || '';
  document.getElementById('svc-pm2').innerHTML = dot(r.pm2?.ok) +
    (pm2Raw && pm2Raw !== 'pm2_unavailable'
      ? `<div style="font-size:0.7rem; color:#888; margin-top:3px; white-space:pre;">${pm2Raw}</div>`
      : '');

  const olr = r.orchestrator_last_run;
  if (olr) {
    const color = olr.ok ? '#7a9f5a' : '#b55e5e';
    document.getElementById('svc-orch-last-run').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${olr.ok ? '⬤ OK' : '⬤ Overdue'}</span>` +
      (olr.age_min != null ? `<div style="font-size:0.7rem; color:#888; margin-top:3px;">${olr.age_min}m ago</div>` : '');
  }

  const as = r.auto_scan;
  if (as) {
    const color = as.ok ? '#7a9f5a' : '#b55e5e';
    document.getElementById('svc-auto-scan').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${as.ok ? '⬤ OK' : '⬤ Stale'}</span>` +
      (as.age_sec != null ? `<div style="font-size:0.7rem; color:#888; margin-top:3px;">last run: ${as.age_sec}s ago</div>` : '');
  }

  const cw = r.collect_weather;
  if (cw) {
    const color = cw.data_ok ? '#7a9f5a' : '#b55e5e';
    document.getElementById('svc-collect-weather').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${cw.data_ok ? '⬤ OK' : '⬤ Stale'}</span>` +
      (cw.age_min != null ? `<div style="font-size:0.7rem; color:#888; margin-top:3px;">last data: ${cw.age_min}m ago</div>` : '');
  }

  const bld = r.boiler_last_decision;
  if (bld) {
    const color = bld.ok ? '#7a9f5a' : '#b55e5e';
    document.getElementById('svc-boiler-last').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${bld.ok ? '⬤ OK' : '⬤ Stale'}</span>` +
      (bld.age_min != null ? `<div style="font-size:0.7rem; color:#888; margin-top:3px;">${bld.age_min}m ago — ${bld.decision || '?'}</div>` : '');
  }

  const bj = r.backup_jobs;
  if (bj && bj.length) {
    const allOk = bj.every(j => j.ok);
    const neverRan = bj.filter(j => j.age_hours === null);
    const overdue  = bj.filter(j => j.age_hours !== null && !j.ok);
    const color = allOk ? '#7a9f5a' : '#b55e5e';
    const label = allOk ? '⬤ OK' : `⬤ ${overdue.length} overdue`;
    const detail = bj.map(j =>
      `<div style="font-size:0.7rem; color:${j.ok ? '#888' : '#b55e5e'}; margin-top:2px;">${j.name}: ${j.age_hours !== null ? j.age_hours + 'h ago' : 'never ran'}</div>`
    ).join('');
    document.getElementById('svc-backup-jobs').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${label}</span>${detail}`;
  } else if (bj) {
    document.getElementById('svc-backup-jobs').innerHTML =
      `<span style="color:#aaa; font-size:0.85rem;">⬤ no jobs</span>`;
  }

  const aa = r.active_alerts;
  if (aa) {
    const sevColor = { critical: '#7a2020', error: '#b55e5e', warn: '#b8860b' };
    const color = aa.ok ? '#7a9f5a' : (sevColor[aa.worst] || '#b55e5e');
    document.getElementById('svc-active-alerts').innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${aa.ok ? '⬤ All clear' : `⬤ ${aa.count} active`}</span>` +
      (!aa.ok && aa.worst ? `<div style="font-size:0.7rem; color:${color}; margin-top:3px;">worst: ${aa.worst}</div>` : '');
  }

  const ups = r.ups;
  const upsEl = document.getElementById('svc-ups');
  if (ups && upsEl) {
    const color = ups.ok ? '#7a9f5a' : '#b55e5e';
    let label;
    if (ups.stale) {
      const mins = ups.age_sec != null ? Math.round(ups.age_sec / 60) : '?';
      label = `⬤ Stale (${mins}m)`;
    } else if (ups.status) {
      label = `⬤ ${ups.status}`;
    } else {
      label = `⬤ ${ups.msg || 'no data'}`;
    }
    const detail = ups.battery_pct != null
      ? `<div style="font-size:0.7rem; color:#888; margin-top:3px;">${Math.round(ups.battery_pct)}% · ${Math.round(ups.runtime_min || 0)}m · ${Math.round(ups.line_volt || 0)}V</div>`
      : '';
    upsEl.innerHTML =
      `<span style="color:${color}; font-size:0.85rem;">${label}</span>${detail}`;
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
    ['svc-postgres','svc-ha','svc-lxc100','svc-lxc102','svc-lxc103','svc-lxc104','svc-lxc105','svc-lxc106','svc-lxc107','svc-vm101',
     'svc-agent','svc-media-agents','svc-voice-agent','svc-auto-scan','svc-ha-to-pg','svc-pm2',
     'svc-orch-last-run','svc-collect-weather','svc-active-alerts','svc-boiler-last','svc-backup-jobs','svc-ups'
    ].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = dot(false); });
  }
}

// ── DB Volumes ───────────────────────────────────────────────
async function loadMiniDlna() {
  const tbody = document.getElementById('volumes-body');
  // remove previous minidlna row if exists
  document.getElementById('minidlna-row')?.remove();
  try {
    const d = await fetch('/api/health/minidlna').then(r => r.json());
    if (d.error) throw new Error(d.error);
    const orphanColor = d.orphans > 0 ? '#c0392b' : '#2ecc71';
    const updated = d.last_updated
      ? new Date(d.last_updated).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
      : '— never';
    const tr = document.createElement('tr');
    tr.id = 'minidlna-row';
    tr.style.background = '#f5f0e8';
    tr.innerHTML = `
      <td><code>minidlna · files.db</code> <span style="font-size:0.7rem;color:#888;margin-left:4px;">SQLite · LXC 100</span></td>
      <td style="text-align:right;">${d.indexed.toLocaleString()}</td>
      <td style="text-align:right;">${d.size_pretty}</td>
      <td style="font-size:0.78rem;color:#666;">—</td>
      <td style="font-size:0.78rem;color:#666;">—</td>
      <td style="text-align:right;font-size:0.82rem;color:${orphanColor};">${d.orphans}</td>
      <td style="text-align:right;color:#aaa;">—</td>
      <td style="font-size:0.78rem;color:#888;">${updated}</td>
      <td></td>
    `;
    tbody.appendChild(tr);
  } catch (e) {
    const tr = document.createElement('tr');
    tr.id = 'minidlna-row';
    tr.innerHTML = `<td colspan="9" style="color:#c0392b;font-size:0.82rem;">MiniDLNA: ${escHtml(e.message)}</td>`;
    tbody.appendChild(tr);
  }
}

async function loadVolumes() {
  try {
    const rows = await fetch('/api/health/db-volumes').then(r => r.json());
    const tbody = document.getElementById('volumes-body');
    setHTML(tbody, rows.map(r => {
      const fragColor = r.frag_pct >= 20 ? '#c0392b' : r.frag_pct >= 5 ? '#e67e22' : '#2ecc71';
      return `<tr id="vol-row-${r.table_name}">
        <td><code>${r.table_name}</code></td>
        <td style="text-align:right;">${r.row_count.toLocaleString()}</td>
        <td style="text-align:right;">${r.total_size}</td>
        <td style="font-size:0.78rem; color:#666;">${fmtTs(r.oldest)}</td>
        <td style="font-size:0.78rem; color:#666;">${fmtTs(r.newest)}</td>
        <td style="text-align:right; font-size:0.82rem;" id="vol-dead-${r.table_name}">${r.dead_tup.toLocaleString()}</td>
        <td style="text-align:right; font-weight:600; color:${fragColor};" id="vol-frag-${r.table_name}">${r.frag_pct}%</td>
        <td style="font-size:0.78rem; color:${r.last_vacuumed ? '#888' : (r.dead_tup > 50 ? '#c0392b' : '#aaa')};">${r.last_vacuumed ? fmtTs(r.last_vacuumed) : (r.dead_tup > 50 ? '— never' : '— not needed')}</td>
        <td style="text-align:center;">
          <button class="btn btn-secondary btn-sm" style="font-size:0.72rem;" onclick="vacuumTable('${r.table_name}', this)">Vacuum</button>
        </td>
      </tr>`;
    }).join(''));
  } catch (e) {
    document.getElementById('volumes-body').innerHTML =
      '<tr><td colspan="9" style="color:#b55e5e;">Failed to load</td></tr>';
  }
}

async function vacuumTable(tableName, btn) {
  const origText = btn.textContent;
  btn.blur(); // drop focus before disabling — prevents browser auto-scrolling to the next focusable element (which is in Retention Policies)
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const r = await fetch('/api/health/vacuum', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_name: tableName })
    }).then(r => r.json());
    if (r.error) { btn.textContent = '✗'; btn.style.color = '#b55e5e'; return; }
    const fragColor = r.frag_pct >= 20 ? '#c0392b' : r.frag_pct >= 5 ? '#e67e22' : '#2ecc71';
    const deadEl = document.getElementById(`vol-dead-${tableName}`);
    const fragEl = document.getElementById(`vol-frag-${tableName}`);
    if (deadEl) deadEl.textContent = r.dead_tup.toLocaleString();
    if (fragEl) { fragEl.textContent = r.frag_pct + '%'; fragEl.style.color = fragColor; }
    btn.textContent = '✓';
    btn.style.color = '#5a8a5a';
    setTimeout(() => { btn.textContent = origText; btn.style.color = ''; btn.disabled = false; }, 2000);
  } catch (e) {
    btn.textContent = '✗';
    btn.style.color = '#b55e5e';
    setTimeout(() => { btn.textContent = origText; btn.style.color = ''; btn.disabled = false; }, 2000);
  }
}

// ── Retention Policies ───────────────────────────────────────
async function loadRetention() {
  try {
    const rows = await fetch('/api/health/retention').then(r => r.json());
    const tbody = document.getElementById('retention-body');
    setHTML(tbody, rows.map(p => `
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
      </tr>`).join(''));
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
    showCleanupResult(`✗ Failed: ${escHtml(e.message)}`, true);
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
    showCleanupResult(`✗ Failed: ${escHtml(e.message)}`, true);
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
    showCleanupResult(`✗ Failed: ${escHtml(e.message)}`, true);
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

    setHTML(tbody, rows.map(r => {
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
        <td style="font-size:0.8rem; color:${color};">${escHtml(r.message)}</td>
      </tr>`;
    }).join(''));

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
  const dbTabActive        = document.getElementById('tab-database')?.classList.contains('active');
  const orchLogActive      = document.getElementById('tab-orch-log')?.classList.contains('active');
  const backupsTabActive   = document.getElementById('tab-backups')?.classList.contains('active');
  const winBackupTabActive = document.getElementById('tab-win-backup')?.classList.contains('active');
  const tasks = [loadAlerts(), loadStatus()];
  if (orchLogActive)      { tasks.push(loadOrchLog()); }
  if (dbTabActive)        { tasks.push(loadVolumes(), loadMiniDlna(), loadRetention()); }
  if (backupsTabActive)   { tasks.push(loadBackups()); }
  if (winBackupTabActive) { tasks.push(loadWinStorages(), loadWinJobs(), loadWinLog()); }
  await Promise.all(tasks);
  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

// ── Proxmox Backups ──────────────────────────────────────────
async function loadBackups() {
  const jobsTbody   = document.getElementById('backup-jobs-body');
  const tasksTbody  = document.getElementById('backup-tasks-body');
  try {
    const data = await fetch('/api/backups/proxmox').then(r => r.json());
    if (data.error) throw new Error(data.error);

    // Jobs table
    if (!data.jobs?.length) {
      jobsTbody.innerHTML = '<tr><td colspan="9" style="color:#aaa; text-align:center; padding:16px;">No backup jobs configured</td></tr>';
    } else {
      jobsTbody.innerHTML = data.jobs.map(j => {
        const enabled = j.enabled
          ? '<span style="color:#7a9f5a; font-size:0.8rem; font-weight:600;">⬤ Yes</span>'
          : '<span style="color:#aaa; font-size:0.8rem;">⬤ Off</span>';
        const lastRunTs = j.lastRun?.starttime
          ? new Date(j.lastRun.starttime * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
          : '—';
        const statusRaw = j.lastRun?.status || '';
        const statusOk  = statusRaw === 'OK';
        const statusColor = !j.lastRun ? '#aaa' : (statusOk ? '#7a9f5a' : '#b55e5e');
        const statusText  = !j.lastRun ? '—' : (statusOk ? '✓ OK' : '✗ ' + statusRaw.slice(0, 30));
        return `<tr>
          <td style="font-size:0.78rem; color:#888; font-family:monospace;">${j.id}</td>
          <td style="text-align:center;">${enabled}</td>
          <td style="font-size:0.82rem;">${j.schedule}</td>
          <td style="font-size:0.82rem;">${j.storage}</td>
          <td style="font-size:0.78rem;">${j.vmid}</td>
          <td style="font-size:0.78rem; color:#666;">${j.mode}</td>
          <td style="font-size:0.78rem; color:#666;">${j.retention}</td>
          <td style="font-size:0.75rem; color:#888; white-space:nowrap;">${lastRunTs}</td>
          <td style="text-align:center; font-size:0.8rem; font-weight:600; color:${statusColor};">${statusText}</td>
        </tr>`;
      }).join('');
    }

    // Tasks table
    if (!data.tasks?.length) {
      tasksTbody.innerHTML = '<tr><td colspan="5" style="color:#aaa; text-align:center; padding:16px;">No recent tasks</td></tr>';
    } else {
      tasksTbody.innerHTML = data.tasks.map(t => {
        const start   = new Date(t.starttime * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        const dur     = (t.endtime && t.endtime > t.starttime)
          ? Math.round((t.endtime - t.starttime) / 60) + 'm'
          : 'running…';
        const statusOk    = t.status === 'OK';
        const statusColor = t.status ? (statusOk ? '#7a9f5a' : '#b55e5e') : '#888';
        const statusText  = t.status || 'running';
        return `<tr>
          <td style="font-size:0.75rem; color:#888; white-space:nowrap;">${start}</td>
          <td style="font-size:0.78rem;">${t.node || '—'}</td>
          <td style="text-align:center; font-size:0.82rem; font-weight:600;">${t.id || '—'}</td>
          <td style="text-align:center; font-size:0.78rem; color:#666;">${dur}</td>
          <td style="text-align:center; font-size:0.8rem; font-weight:600; color:${statusColor};">${statusText}</td>
        </tr>`;
      }).join('');
    }
  } catch (e) {
    jobsTbody.innerHTML  = `<tr><td colspan="9" style="color:#b55e5e;">Failed: ${escHtml(e.message)}</td></tr>`;
    tasksTbody.innerHTML = `<tr><td colspan="5" style="color:#b55e5e;">Failed: ${escHtml(e.message)}</td></tr>`;
  }
}

// ── Documents ────────────────────────────────────────────────
const DOC_THEMES = ['General', 'PostgreSQL', 'Orchestrator', 'Agents', 'Voice', 'Backups'];

const fileIcon = url => {
  const ext = (url.split('.').pop() || '').toLowerCase().split('?')[0];
  return { svg: '🗺', pdf: '📄', md: '📝', png: '🖼', jpg: '🖼', jpeg: '🖼', html: '🌐' }[ext] || '📎';
};

function isLocalDoc(url) {
  return !url.startsWith('http://') && !url.startsWith('https://');
}

function docHref(url, title) {
  if (!isLocalDoc(url)) return url;
  const ext = (url.split('.').pop() || '').toLowerCase().split('?')[0];
  if (ext === 'svg') {
    return `viewer.html?path=${encodeURIComponent(url)}&title=${encodeURIComponent(title || url)}`;
  }
  return `/api/documents/file?path=${encodeURIComponent(url)}`;
}

async function loadDocuments() {
  try {
    const docs = await fetch('/api/documents').then(r => r.json());
    renderDocuments(docs);
  } catch (e) {
    document.getElementById('docs-container').innerHTML = `<div class="card" style="color:#b55e5e;">Failed to load documents: ${escHtml(e.message)}</div>`;
  }
}

function renderDocuments(docs) {
  const container = document.getElementById('docs-container');
  const byTheme = {};
  DOC_THEMES.forEach(t => byTheme[t] = []);
  docs.forEach(d => { if (byTheme[d.theme]) byTheme[d.theme].push(d); else byTheme['General'].push(d); });

  container.innerHTML = DOC_THEMES.map(theme => {
    const items = byTheme[theme];
    const rows = items.map(d => `
      <div style="display:flex; align-items:center; gap:12px; padding:10px 0; border-bottom:1px solid #f0ede8;">
        <span style="font-size:1.3rem; min-width:24px; text-align:center;">${fileIcon(d.url)}</span>
        <div style="flex:1; min-width:0;">
          <div style="font-size:0.88rem; font-weight:500; color:#2e2e2e; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escHtml(d.title)}</div>
          <div style="font-size:0.72rem; color:#aaa; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escHtml(d.url)}</div>
        </div>
        <a href="${docHref(d.url, d.title)}" target="_blank" rel="noopener"
           style="font-size:0.78rem; padding:4px 12px; background:#3a5a8a; color:#fff; border-radius:4px; text-decoration:none; white-space:nowrap;">Open</a>
        <button onclick="deleteDoc(${d.id})"
          style="font-size:0.78rem; padding:4px 10px; background:transparent; color:#b55e5e; border:1px solid #b55e5e; border-radius:4px; cursor:pointer; white-space:nowrap;">✕</button>
      </div>`).join('');

    return `<div class="card" style="margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <h2 style="margin:0;">${theme}</h2>
        <button onclick="showAddDocForm('${theme}')" class="btn btn-secondary btn-sm" style="font-size:0.78rem;">+ Add</button>
      </div>
      <div id="add-form-${theme}" style="display:none; background:#f5f3f0; border-radius:6px; padding:12px; margin-bottom:12px;">
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end;">
          <div style="flex:1; min-width:160px;">
            <div style="font-size:0.72rem; color:#888; margin-bottom:3px;">Title</div>
            <input id="doc-title-${theme}" type="text" placeholder="e.g. Architecture Overview"
              style="width:100%; font-size:0.82rem; padding:5px 8px; border:1px solid #d0cbc4; border-radius:4px; background:#fff;">
          </div>
          <div style="flex:2; min-width:200px;">
            <div style="font-size:0.72rem; color:#888; margin-bottom:3px;">Path or URL (relative to project_home/docs/)</div>
            <input id="doc-url-${theme}" type="text" placeholder="e.g. architecture.svg or https://..."
              style="width:100%; font-size:0.82rem; padding:5px 8px; border:1px solid #d0cbc4; border-radius:4px; background:#fff;">
          </div>
          <div style="display:flex; gap:6px;">
            <button onclick="addDoc('${theme}')" class="btn btn-success btn-sm" style="font-size:0.78rem;">Save</button>
            <button onclick="hideAddDocForm('${theme}')" class="btn btn-secondary btn-sm" style="font-size:0.78rem;">Cancel</button>
          </div>
        </div>
        <div id="doc-err-${theme}" style="font-size:0.75rem; color:#b55e5e; margin-top:6px; display:none;"></div>
      </div>
      ${rows || `<div style="font-size:0.82rem; color:#aaa; padding:10px 0;">No documents yet — click + Add to add one.</div>`}
    </div>`;
  }).join('');
}

function showAddDocForm(theme) {
  document.getElementById(`add-form-${theme}`).style.display = 'block';
  document.getElementById(`doc-title-${theme}`).focus();
}

function hideAddDocForm(theme) {
  document.getElementById(`add-form-${theme}`).style.display = 'none';
  document.getElementById(`doc-title-${theme}`).value = '';
  document.getElementById(`doc-url-${theme}`).value = '';
  document.getElementById(`doc-err-${theme}`).style.display = 'none';
}

async function addDoc(theme) {
  const title = document.getElementById(`doc-title-${theme}`).value.trim();
  const url   = document.getElementById(`doc-url-${theme}`).value.trim();
  const errEl = document.getElementById(`doc-err-${theme}`);
  if (!title || !url) { errEl.textContent = 'Title and path are required.'; errEl.style.display = 'block'; return; }
  try {
    const r = await fetch('/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, url, theme })
    }).then(r => r.json());
    if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
    await loadDocuments();
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
}

async function deleteDoc(id) {
  if (!confirm('Remove this document link?')) return;
  try {
    await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    await loadDocuments();
  } catch (e) { alert('Failed: ' + e.message); }
}

// ── Windows Backup ───────────────────────────────────────────

function fmtBytes(b) {
  if (!b && b !== 0) return '—';
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
  return b + ' B';
}

function fmtDuration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return '—';
  const sec = Math.round((new Date(finishedAt) - new Date(startedAt)) / 1000);
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + 'm ' + s + 's';
}

// ─ Storages ──────────────────────────────────────────────────
let _winStorages = [];

async function loadWinStorages() {
  try {
    const rows = await fetch('/api/backup/storages').then(r => r.json());
    _winStorages = rows;
    const tbody = document.getElementById('win-storages-body');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:#aaa; text-align:center; padding:16px;">No storages configured</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(s => `<tr>
      <td style="font-size:0.85rem; font-weight:500;">${escHtml(s.name)}</td>
      <td style="font-size:0.78rem; color:#888;">${escHtml(s.type)}</td>
      <td style="font-size:0.78rem; color:#666;">${escHtml(s.host)}</td>
      <td style="font-size:0.78rem; color:#666;">${escHtml(s.share)}</td>
      <td style="font-size:0.78rem; color:#888;">${escHtml(s.description || '—')}</td>
      <td style="text-align:center; vertical-align:middle; white-space:nowrap;">
        <button style="font-size:0.8rem; padding:4px 10px; border-radius:4px; cursor:pointer; border:none; font-weight:500; background:#c0392b; color:#fff;"
          onclick="deleteWinStorage(${s.id}, this)">✕</button>
      </td>
    </tr>`).join('');
    // Populate storage select in add-job form
    const sel = document.getElementById('wj-storage');
    if (sel) {
      sel.innerHTML = '<option value="">— select —</option>' +
        rows.map(s => `<option value="${s.id}">${escHtml(s.name)} (${escHtml(s.share)})</option>`).join('');
    }
  } catch (e) {
    document.getElementById('win-storages-body').innerHTML =
      `<tr><td colspan="6" style="color:#b55e5e;">Failed: ${escHtml(e.message)}</td></tr>`;
  }
}

async function deleteWinStorage(id, btn) {
  if (!confirm('Delete this storage? Jobs using it will lose their storage reference.')) return;
  btn.blur();
  btn.disabled = true;
  try {
    const r = await fetch(`/api/backup/storages/${id}`, { method: 'DELETE' }).then(r => r.json());
    if (r.error) { alert('Error: ' + r.error); btn.disabled = false; return; }
    await loadWinStorages();
  } catch (e) { alert('Failed: ' + e.message); btn.disabled = false; }
}

function showAddWinStorageForm() {
  document.getElementById('win-add-storage-form').style.display = 'block';
  document.getElementById('ws-name').focus();
}

function hideAddWinStorageForm() {
  document.getElementById('win-add-storage-form').style.display = 'none';
  ['ws-name','ws-host','ws-share','ws-user','ws-pass','ws-mount','ws-desc'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const err = document.getElementById('win-storage-err');
  err.style.display = 'none'; err.textContent = '';
}

async function addWinStorage() {
  const name  = document.getElementById('ws-name').value.trim();
  const host  = document.getElementById('ws-host').value.trim();
  const share = document.getElementById('ws-share').value.trim();
  const user  = document.getElementById('ws-user').value.trim();
  const pass  = document.getElementById('ws-pass').value;
  const desc  = document.getElementById('ws-desc').value.trim();
  const errEl = document.getElementById('win-storage-err');
  errEl.style.display = 'none';
  if (!name || !host || !share) {
    errEl.textContent = 'Name, Host, and Share are required.';
    errEl.style.display = 'block'; return;
  }
  try {
    const r = await fetch('/api/backup/storages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: 'smb', host, share, smb_user: user, smb_pass: pass, mount_path: document.getElementById('ws-mount').value.trim() || null, description: desc })
    }).then(r => r.json());
    if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
    hideAddWinStorageForm();
    await loadWinStorages();
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
}

// ─ Jobs ──────────────────────────────────────────────────────
async function loadWinJobs() {
  try {
    const rows = await fetch('/api/backup/jobs').then(r => r.json());
    const tbody = document.getElementById('win-jobs-body');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="10" style="color:#aaa; text-align:center; padding:16px;">No backup jobs configured</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(j => {
      const lastRun = j.last_started
        ? new Date(j.last_started).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
        : '—';
      const statusColor = !j.last_status ? '#aaa'
        : j.last_status === 'ok' ? '#7a9f5a'
        : j.last_status === 'unreachable' ? '#b8860b' : '#b55e5e';
      const statusText = !j.last_status ? '—'
        : j.last_status === 'ok' ? '✓ OK'
        : j.last_status === 'unreachable' ? '⚡ offline' : '✗ failed';
      const toggleBg    = j.enabled ? '#7a9f5a' : '#b0a89e';
      const toggleLabel = j.enabled ? '● On' : '○ Off';
      const btnBase = 'font-size:0.8rem; padding:4px 10px; margin-right:4px; border-radius:4px; cursor:pointer; border:none; font-weight:500;';
      return `<tr id="wj-row-${j.id}">
        <td style="font-size:0.85rem; font-weight:500;">${j.name}</td>
        <td style="font-size:0.72rem; color:#666; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
            title="${j.source_path}">${j.source_path}</td>
        <td style="font-size:0.78rem; color:#666;">${j.storage_name || '—'}</td>
        <td style="text-align:center; font-size:0.78rem; color:#666;">${j.max_age_hours}h</td>
        <td style="text-align:center; font-size:0.78rem; color:#666;">${j.retention}</td>
        <td style="font-size:0.75rem; color:#888; white-space:nowrap;">${lastRun}</td>
        <td style="text-align:center; font-size:0.8rem; font-weight:600; color:${statusColor};">${statusText}</td>
        <td style="text-align:right; font-size:0.78rem; color:#666;">${fmtBytes(j.last_size)}</td>
        <td style="text-align:center; vertical-align:middle; white-space:nowrap;">
          <button style="${btnBase} background:${toggleBg}; color:#fff;"
            onclick="toggleWinJob(${j.id}, ${j.enabled}, this)">${toggleLabel}</button>
          <button style="${btnBase} background:#3a5a8a; color:#fff;"
            onclick="winJobRunNow(${j.id}, this)">▶ Run</button>
          <button style="${btnBase} background:#e8e4de; color:#2e2e2e; margin-right:0;"
            onclick="editWinJob(${j.id})">✎ Edit</button>
        </td>
        <td style="text-align:center; vertical-align:middle; width:46px;">
          <button style="${btnBase} background:#c0392b; color:#fff; margin-right:0;"
            onclick="deleteWinJob(${j.id}, this)">✕</button>
        </td>
      </tr>`;
    }).join('');
  } catch (e) {
    document.getElementById('win-jobs-body').innerHTML =
      `<tr><td colspan="10" style="color:#b55e5e;">Failed: ${escHtml(e.message)}</td></tr>`;
  }
}

async function toggleWinJob(id, currentEnabled, btn) {
  btn.blur();
  btn.disabled = true;
  try {
    const r = await fetch(`/api/backup/jobs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !currentEnabled })
    }).then(r => r.json());
    if (r.error) { alert('Error: ' + r.error); btn.disabled = false; return; }
    await loadWinJobs();
  } catch (e) { alert('Failed: ' + e.message); btn.disabled = false; }
}

async function winJobRunNow(id, btn) {
  btn.blur();
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const r = await fetch(`/api/backup/jobs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_now: true })
    }).then(r => r.json());
    if (r.error) { btn.textContent = '✗'; btn.style.color = '#b55e5e'; return; }
    btn.textContent = '✓ queued';
    setTimeout(() => { btn.textContent = '▶ Run'; btn.disabled = false; }, 3000);
  } catch (e) { btn.textContent = '✗'; btn.style.color = '#b55e5e'; btn.disabled = false; }
}

async function deleteWinJob(id, btn) {
  if (!confirm('Delete this backup job and its log history?')) return;
  btn.blur();
  btn.disabled = true;
  try {
    const r = await fetch(`/api/backup/jobs/${id}`, { method: 'DELETE' }).then(r => r.json());
    if (r.error) { alert('Error: ' + r.error); btn.disabled = false; return; }
    await loadWinJobs();
    await loadWinLog();
  } catch (e) { alert('Failed: ' + e.message); btn.disabled = false; }
}

let _editingJobId = null;

function showAddWinJobForm() {
  _editingJobId = null;
  const titleEl = document.getElementById('win-job-form-title');
  titleEl.textContent = 'New Backup Job';
  titleEl.style.display = 'block';
  document.getElementById('win-job-save-btn').textContent = 'Save';
  // Clear fields
  ['wj-name','wj-source','wj-dest-new'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('wj-maxage').value = 26;
  document.getElementById('wj-retention').value = 7;
  const sel = document.getElementById('wj-storage');
  sel.innerHTML = '<option value="">— select —</option>' +
    _winStorages.map(s => `<option value="${s.id}">${s.name} (${s.share})</option>`).join('');
  const destSel = document.getElementById('wj-dest-select');
  destSel.innerHTML = '<option value="">— select storage first —</option>';
  document.getElementById('wj-dest-new').style.display = 'none';
  document.getElementById('win-add-job-form').style.display = 'block';
  document.getElementById('wj-name').focus();
}

async function editWinJob(id) {
  _editingJobId = id;

  // Fetch both in parallel; ensure storages cache is populated
  const [jobs, storages] = await Promise.all([
    fetch('/api/backup/jobs').then(r => r.json()),
    _winStorages.length ? Promise.resolve(_winStorages) : fetch('/api/backup/storages').then(r => r.json())
  ]);
  if (storages !== _winStorages) _winStorages = storages;

  const j = jobs.find(x => x.id === id);
  if (!j) return;

  document.getElementById('win-job-form-title').textContent = `Edit: ${j.name}`;
  document.getElementById('win-job-form-title').style.display = 'block';
  document.getElementById('win-job-save-btn').textContent = 'Update';
  document.getElementById('win-job-err').style.display = 'none';

  // Populate text fields
  document.getElementById('wj-name').value      = j.name;
  document.getElementById('wj-source').value    = j.source_path;
  document.getElementById('wj-maxage').value    = j.max_age_hours;
  document.getElementById('wj-retention').value = j.retention;

  // Populate storage dropdown — use String() to match option values
  const sel = document.getElementById('wj-storage');
  sel.innerHTML = '<option value="">— select —</option>' +
    _winStorages.map(s => `<option value="${s.id}">${s.name} (${s.share})</option>`).join('');
  sel.value = String(j.storage_id || '');

  document.getElementById('win-add-job-form').style.display = 'block';

  // Load folders via same function used by the storage onchange,
  // then pre-select the current dest_subdir
  await loadWjFolders();

  const destSel = document.getElementById('wj-dest-select');
  // Ensure current dest_subdir is in the list (it may not exist on QNAP yet)
  if (j.dest_subdir && ![...destSel.options].some(o => o.value === j.dest_subdir)) {
    const opt = document.createElement('option');
    opt.value = j.dest_subdir; opt.textContent = j.dest_subdir;
    destSel.insertBefore(opt, destSel.options[1]); // after "— select folder —"
  }
  destSel.value = j.dest_subdir || '';
  onWjDestChange();
}

// ─ Windows path browser ──────────────────────────────────────
async function openWinBrowser() {
  const current = document.getElementById('wj-source').value.trim() || 'C:/Users/muroc';
  await browseWinPath(current);
}

async function browseWinPath(p) {
  const browser  = document.getElementById('win-browser');
  const pathEl   = document.getElementById('win-browser-path');
  const listEl   = document.getElementById('win-browser-list');
  browser.style.display = 'block';
  pathEl.textContent = p;
  listEl.innerHTML = '<div style="padding:6px 10px; color:#aaa;">Loading…</div>';
  try {
    const data = await fetch(`/api/backup/windows/browse?path=${encodeURIComponent(p)}`).then(r => r.json());
    if (data.error) throw new Error(data.error);
    const normalized = p.replace(/\\/g, '/').replace(/\/$/, '');
    // Up button (not at root like C:/)
    const parts = normalized.split('/');
    let upHtml = '';
    if (parts.length > 1 && !(parts.length === 2 && parts[1] === '')) {
      const parent = parts.slice(0, -1).join('/') || parts[0] + '/';
      upHtml = `<div onclick="browseWinPath('${escAttr(parent)}')"
        style="padding:5px 10px; cursor:pointer; color:#3a5a8a; border-bottom:1px solid #f0ede8;"
        onmouseover="this.style.background='#f5f3f0'" onmouseout="this.style.background=''">⬆ ..</div>`;
    }
    const rows = data.dirs.map(d => {
      const full = normalized + '/' + d;
      return `<div style="display:flex; justify-content:space-between; align-items:center; padding:4px 10px; border-bottom:1px solid #f0ede8; cursor:pointer;"
        onmouseover="this.style.background='#f5f3f0'" onmouseout="this.style.background=''">
        <span onclick="browseWinPath('${escAttr(full)}')" style="flex:1; color:#2e2e2e;">📁 ${escHtml(d)}</span>
        <button onclick="selectWinPath('${escAttr(full)}')" class="btn btn-secondary btn-sm"
          style="font-size:0.7rem; padding:2px 7px; margin-left:8px;">Select</button>
      </div>`;
    }).join('');
    listEl.innerHTML = upHtml + (rows || '<div style="padding:6px 10px; color:#aaa;">No subfolders</div>');
  } catch (e) {
    listEl.innerHTML = `<div style="padding:6px 10px; color:#b55e5e;">${escHtml(e.message)}</div>`;
  }
}

function selectWinPath(p) {
  document.getElementById('wj-source').value = p;
  document.getElementById('win-browser').style.display = 'none';
}

function clearWinBrowser() {
  document.getElementById('win-browser').style.display = 'none';
}

async function loadWjFolders() {
  const storageId = document.getElementById('wj-storage').value;
  const destSel   = document.getElementById('wj-dest-select');
  const destNew   = document.getElementById('wj-dest-new');
  if (!storageId) {
    destSel.innerHTML = '<option value="">— select storage first —</option>';
    destNew.style.display = 'none'; destNew.value = '';
    return;
  }
  destSel.innerHTML = '<option value="">Loading…</option>';
  destNew.style.display = 'none'; destNew.value = '';
  try {
    const folders = await fetch(`/api/backup/storages/${storageId}/folders`).then(r => r.json());
    if (folders.error) throw new Error(folders.error);
    destSel.innerHTML =
      (folders.length ? '<option value="">— select folder —</option>' : '') +
      folders.map(f => `<option value="${f}">${f}</option>`).join('') +
      '<option value="__new__">+ Create new folder…</option>';
  } catch (e) {
    destSel.innerHTML = '<option value="">— select folder —</option><option value="__new__">+ Create new folder…</option>';
  }
  onWjDestChange();
}

function onWjDestChange() {
  const destSel = document.getElementById('wj-dest-select');
  const destNew = document.getElementById('wj-dest-new');
  if (destSel.value === '__new__') {
    destNew.style.display = 'block';
    // Pre-fill with job name as suggested folder name
    if (!destNew.value) {
      const jobName = document.getElementById('wj-name').value.trim();
      if (jobName) destNew.value = jobName;
    }
    destNew.focus();
  } else {
    destNew.style.display = 'none';
    destNew.value = '';
  }
}

function hideAddWinJobForm() {
  _editingJobId = null;
  document.getElementById('win-add-job-form').style.display = 'none';
  document.getElementById('win-job-form-title').style.display = 'none';
  const wb = document.getElementById('win-browser'); if (wb) wb.style.display = 'none';
  ['wj-name','wj-source','wj-dest-new'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const destSel = document.getElementById('wj-dest-select');
  if (destSel) destSel.innerHTML = '<option value="">— select storage first —</option>';
  const destNew = document.getElementById('wj-dest-new');
  if (destNew) destNew.style.display = 'none';
  const err = document.getElementById('win-job-err');
  err.style.display = 'none'; err.textContent = '';
}

async function saveWinJob() {
  const name      = document.getElementById('wj-name').value.trim();
  const source    = document.getElementById('wj-source').value.trim();
  const storageId = document.getElementById('wj-storage').value;
  const destSelVal = document.getElementById('wj-dest-select').value;
  const dest      = destSelVal === '__new__'
    ? document.getElementById('wj-dest-new').value.trim()
    : destSelVal;
  const maxAge    = parseInt(document.getElementById('wj-maxage').value) || 26;
  const retention = parseInt(document.getElementById('wj-retention').value) || 7;
  const errEl     = document.getElementById('win-job-err');
  errEl.style.display = 'none';
  if (!name) { errEl.textContent = 'Job name is required.'; errEl.style.display = 'block'; return; }
  if (!source) { errEl.textContent = 'Source Path is required.'; errEl.style.display = 'block'; return; }
  if (!storageId) { errEl.textContent = 'Please select a Storage.'; errEl.style.display = 'block'; return; }
  if (!dest) { errEl.textContent = destSelVal === '__new__' ? 'Enter a name for the new folder.' : 'Please select a Dest Subfolder.'; errEl.style.display = 'block'; return; }
  try {
    let r;
    if (_editingJobId) {
      r = await fetch(`/api/backup/jobs/${_editingJobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(name       && { name }),
          ...(source     && { source_path: source }),
          ...(storageId  && { storage_id: parseInt(storageId) }),
          ...(dest       && { dest_subdir: dest }),
          max_age_hours: maxAge,
          retention
        })
      }).then(r => r.json());
    } else {
      r = await fetch('/api/backup/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, source_host: 'muroc@192.168.1.128', source_path: source, storage_id: parseInt(storageId), dest_subdir: dest, max_age_hours: maxAge, retention })
      }).then(r => r.json());
    }
    if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
    hideAddWinJobForm();
    await loadWinJobs();
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
}

// ─ Log ───────────────────────────────────────────────────────
async function loadWinLog() {
  const limit = document.getElementById('win-log-limit')?.value || 20;
  try {
    const rows = await fetch(`/api/backup/log?limit=${limit}`).then(r => r.json());
    const tbody = document.getElementById('win-log-body');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:#aaa; text-align:center; padding:16px;">No log entries yet</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const statusColor = r.status === 'ok' ? '#7a9f5a'
        : r.status === 'unreachable' ? '#b8860b'
        : r.status === 'running' ? '#3a5a8a' : '#b55e5e';
      const statusText = r.status === 'ok' ? '✓ OK'
        : r.status === 'unreachable' ? '⚡ offline'
        : r.status === 'running' ? '⏳ running' : '✗ failed';
      return `<tr>
        <td style="font-size:0.82rem; font-weight:500;">${r.job_name || '—'}</td>
        <td style="font-size:0.75rem; color:#888; white-space:nowrap;">${r.started_at ? new Date(r.started_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '—'}</td>
        <td style="text-align:center; font-size:0.78rem; color:#666;">${fmtDuration(r.started_at, r.finished_at)}</td>
        <td style="text-align:center; font-size:0.8rem; font-weight:600; color:${statusColor};">${statusText}</td>
        <td style="text-align:right; font-size:0.78rem; color:#666;">${fmtBytes(r.size_bytes)}</td>
        <td style="font-size:0.78rem; color:#888; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
            title="${(r.message || '').replace(/"/g, '&quot;')}">${r.message || '—'}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    document.getElementById('win-log-body').innerHTML =
      `<tr><td colspan="6" style="color:#b55e5e;">Failed: ${escHtml(e.message)}</td></tr>`;
  }
}

// Initial load — System tab only
loadAlerts();
loadStatus();

// Auto-refresh: only status grid (no table reloads = no scroll jump)
// Alerts and orch log tables refresh only on manual ↺ click
setInterval(() => {
  if (!document.getElementById('tab-database')?.classList.contains('active')) {
    loadStatus();
  }
}, 60000);

// ─── UPS tab (apcupsd master on PVE, NIS slave on LXC 105) ─────────────────
// Endpoints used (all in-handler proxies on the existing /api/dashboard-settings/:key):
//   _ups_live          → latest ups_status row + age_sec
//   _ups_history       → recent rows for chart (default 7 days)
//   _ups_events        → tail of /var/log/apcupsd.events on PVE via SSH
//   _ups_test_<name>   → SSH-execute named test on PVE, return stdout/stderr/code

const UPS_STATUS_COLORS = {
  ONLINE:        { color: '#fff', bg: '#3a7d44' },
  'ONLINE SLAVE':{ color: '#fff', bg: '#3a7d44' },
  ONBATT:        { color: '#fff', bg: '#d4a017' },
  'LOWBATT':     { color: '#fff', bg: '#c0392b' },
  COMMLOST:      { color: '#fff', bg: '#c0392b' },
  'SHUTTING DOWN':{ color: '#fff', bg: '#c0392b' },
};

// Statuses that mean "all good"
const UPS_OK_STATES = new Set(['ONLINE', 'ONLINE SLAVE']);

async function upsLoadLive() {
  try {
    const r = await fetch('/api/dashboard-settings/_ups_live').then(r => r.json());
    const d = r && r.value;
    if (!d) {
      document.getElementById('ups-status-badge').textContent = 'no data';
      document.getElementById('ups-age').textContent = 'no row in ups_status yet — wait for first poll (60 s cadence)';
      return;
    }
    const status = (d.status || '').trim();
    const badge = document.getElementById('ups-status-badge');
    const style = UPS_STATUS_COLORS[status.toUpperCase()] || { color: '#fff', bg: '#c0392b' };
    badge.textContent = status || 'NO DATA';
    badge.style.background = style.bg;
    badge.style.color = style.color;

    // Big visible alert banner at the top of Card 1 when status is not OK,
    // OR when polling data is stale > 3 min (timer not firing / DB write failing).
    let alertEl = document.getElementById('ups-alert-banner');
    const isOk = UPS_OK_STATES.has(status.toUpperCase());
    const stale = (d.age_sec || 0) > 180;
    if (!isOk || stale) {
      if (!alertEl) {
        alertEl = document.createElement('div');
        alertEl.id = 'ups-alert-banner';
        alertEl.style.cssText = 'background:#c0392b;color:#fff;padding:10px 14px;margin-bottom:12px;border-radius:6px;font-weight:600;display:flex;align-items:center;gap:10px;';
        const card1 = document.getElementById('ups-status-badge').closest('.card');
        card1.insertBefore(alertEl, card1.firstChild);
      }
      const reason = stale
        ? `⚠ UPS data is stale (last poll ${Math.round((d.age_sec || 0)/60)} min ago) — polling daemon may not be running on LXC 105`
        : status === 'COMMLOST'
        ? `⚠ UPS COMMUNICATION LOST — apcupsd cannot reach the UPS via USB. Check the cable.`
        : status === 'ONBATT'
        ? `⚠ UPS ON BATTERY — mains power lost. Runtime: ${d.runtime_min} min remaining.`
        : `⚠ UPS state: ${status}`;
      alertEl.textContent = reason;
    } else if (alertEl) {
      alertEl.remove();
    }

    const fmt = (v, suffix, decimals = 1) =>
      (v == null || isNaN(v)) ? '—' : (Number(v).toFixed(decimals) + (suffix || ''));
    document.getElementById('ups-bcharge').textContent = fmt(d.battery_pct, '%', 0);
    document.getElementById('ups-runtime').textContent = fmt(d.runtime_min, ' min', 0);
    document.getElementById('ups-linev').textContent   = fmt(d.line_volt, ' V', 0);
    document.getElementById('ups-load').textContent    = fmt(d.load_pct, '%', 0);
    document.getElementById('ups-battv').textContent   = fmt(d.battery_volt, ' V');
    document.getElementById('ups-model').textContent   = (d.model || '—').trim();
    document.getElementById('ups-serial').textContent  = (d.serial || '—').trim();
    document.getElementById('ups-lastxfer').textContent= (d.last_xfer || '—').trim();

    const age = d.age_sec || 0;
    const ageStr = age < 90 ? `${age}s ago` : `${Math.round(age/60)} min ago`;
    const ageEl = document.getElementById('ups-age');
    ageEl.textContent = ageStr;
    ageEl.style.color = age > 180 ? '#c0392b' : '#888';
  } catch (e) {
    console.error('upsLoadLive', e);
    document.getElementById('ups-status-badge').textContent = 'error';
  }
}

let _upsBattChart = null;
async function upsLoadHistory() {
  try {
    const r = await fetch('/api/dashboard-settings/_ups_history?days=7').then(r => r.json());
    const rows = (r && r.value) || [];
    if (!rows.length) return;
    const labels = rows.map(x => new Date(x.ts).toLocaleString('he-IL', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }));
    const battv  = rows.map(x => x.battery_volt);
    const ctx = document.getElementById('ups-batt-chart');
    if (!ctx || typeof Chart === 'undefined') return;
    if (_upsBattChart) _upsBattChart.destroy();
    _upsBattChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'BATTV (V)', data: battv, borderColor: '#3a7d44', backgroundColor: 'rgba(58,125,68,0.1)',
          fill: true, tension: 0.2, pointRadius: 0, borderWidth: 1.5,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
        scales: {
          y: { suggestedMin: 24, suggestedMax: 28, title: { display: true, text: 'Volts' }, grid: { color: 'rgba(0,0,0,0.05)' } },
          x: { ticks: { autoSkip: true, maxTicksLimit: 8 }, grid: { display: false } },
        },
      },
    });
  } catch (e) { console.error('upsLoadHistory', e); }
}

async function upsLoadEvents() {
  try {
    const r = await fetch('/api/dashboard-settings/_ups_events').then(r => r.json());
    // Backward-compat: old shape was an array; new shape is {lines, mtime_unix}
    const v = (r && r.value) || {};
    const lines = Array.isArray(v) ? v : (v.lines || []);
    const mtime_unix = Array.isArray(v) ? null : v.mtime_unix;
    document.getElementById('ups-events').textContent =
      lines.length ? lines.join('\n') : '(no events yet)';
    // Render "file last modified" — explains why the list looks frozen during quiet
    // periods (apcupsd only writes on real UPS state transitions).
    const tag = document.getElementById('ups-events-mtime');
    if (tag) {
      if (mtime_unix) {
        const ageS = Math.max(0, Math.floor(Date.now() / 1000 - mtime_unix));
        let ago;
        if (ageS < 60)             ago = `${ageS} s ago`;
        else if (ageS < 3600)      ago = `${Math.floor(ageS / 60)} min ago`;
        else if (ageS < 86400)     ago = `${Math.floor(ageS / 3600)} h ago`;
        else                       ago = `${Math.floor(ageS / 86400)} d ago`;
        const dt = new Date(mtime_unix * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        tag.textContent = `file last modified: ${dt} (${ago})`;
      } else {
        tag.textContent = '';
      }
    }
  } catch (e) {
    document.getElementById('ups-events').textContent = '(failed to load events)';
  }
}

async function upsRunTest(name, btn) {
  const out = document.getElementById('ups-test-out-' + name);
  // Remove any prior Clear button so we don't end up with stale ones during a re-run
  document.getElementById('ups-test-clear-' + name)?.remove();
  if (out) out.textContent = 'running…';
  btn.disabled = true;
  try {
    const r = await fetch('/api/dashboard-settings/_ups_test_' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { trigger: 'dashboard', ts: Date.now() } }),
    }).then(r => r.json());
    if (out) {
      if (r.error) {
        out.textContent = 'ERROR: ' + r.error;
        out.style.color = '#c0392b';
      } else {
        const v = r.value || {};
        out.textContent = `[exit ${v.code ?? '?'}] ${v.stdout || ''}${v.stderr ? '\n--- stderr ---\n' + v.stderr : ''}`;
        out.style.color = (v.code === 0) ? '#2e2e2e' : '#c0392b';
      }
      // Inject a ✕ Clear button after the <pre> so the user can dismiss the output
      const clearBtn = document.createElement('button');
      clearBtn.id = 'ups-test-clear-' + name;
      clearBtn.className = 'btn btn-secondary btn-sm';
      clearBtn.style.cssText = 'margin-top:4px;font-size:0.7rem;padding:2px 10px;';
      clearBtn.textContent = '✕ Clear';
      clearBtn.onclick = () => { out.textContent = ''; clearBtn.remove(); };
      out.parentNode.insertBefore(clearBtn, out.nextSibling);
    }
  } finally { btn.disabled = false; }
}

async function upsLoadSettings() {
  try {
    const r = await fetch('/api/dashboard-settings/_ups_settings').then(r => r.json());
    const s = r.value;
    if (!s) {
      document.getElementById('ups-settings-badge').textContent = 'unreachable';
      document.getElementById('ups-settings-badge').style.background = '#888';
      return;
    }
    const fmt    = (v, suf) => (Number.isFinite(v) ? `${v}${suf || ''}` : '—');
    const fmtOff = (v, suf) => (v === 0 ? 'Off' : fmt(v, suf));
    document.getElementById('ups-set-battlvl').textContent  = fmt(s.battery_level, ' %');
    document.getElementById('ups-set-minutes').textContent  = fmtOff(s.minutes, ' min');
    document.getElementById('ups-set-timeout').textContent  = fmtOff(s.timeout, ' s');
    document.getElementById('ups-set-onbdelay').textContent = fmt(s.onbattery_delay, ' s');
    document.getElementById('ups-set-safety').textContent   = ({present:'On',absent:'Off'})[s.safety_mode] || s.safety_mode || '—';
    document.getElementById('ups-set-atboot').textContent   = ({enabled:'Yes',disabled:'No'})[s.at_boot]    || s.at_boot    || '—';
    // Binary state badge — SHUTDOWN OFF (safe state) vs SHUTDOWN ON (live).
    // Colors preserved from the previous PARANOID-SAFE / PRODUCTION palette.
    const badge = document.getElementById('ups-settings-badge');
    if (s.safety_mode === 'absent') {
      badge.textContent = 'SHUTDOWN ON';
      badge.style.background = '#2e7d32';        // production green — live
    } else if (s.safety_mode === 'present') {
      badge.textContent = 'SHUTDOWN OFF';
      badge.style.background = '#7a9f5a';        // paranoid-safe green-ish — installed but disabled
    } else {
      badge.textContent = '—';
      badge.style.background = '#aaa';
    }
    _upsAttachEditHandlers();
  } catch (e) {
    document.getElementById('ups-settings-badge').textContent = 'error';
    document.getElementById('ups-settings-badge').style.background = '#c0392b';
  }
}

// Inline-edit metadata for the 11 editable Trigger Settings tiles. The keys
// are DOM ids (matching the value spans rendered by upsLoadSettings /
// upsLoadRecoverSettings). meta.field is the server-side field name passed
// to /api/dashboard-settings/_ups_settings_set.
const _UPS_FIELD_BY_DOM = {
  'ups-set-battlvl':   { field: 'battery_level',         type: 'int',  min: 1, max: 99,    unit: '%',
                         confirmAt: v => parseInt(v,10) >= 50 ? 'High threshold (≥50 %) — typical mains-pull test territory. Confirm?' : null },
  'ups-set-minutes':   { field: 'minutes',               type: 'int',  min: 0, max: 60,    unit: 'min' },
  'ups-set-timeout':   { field: 'timeout',               type: 'int',  min: 0, max: 86400, unit: 's' },
  'ups-set-onbdelay':  { field: 'onbattery_delay',       type: 'int',  min: 0, max: 60,    unit: 's' },
  'ups-set-safety':    { field: 'safety_mode',           type: 'enum', allowed: ['present','absent'],
                         confirmAt: v => v === 'absent' ? 'GOING LIVE: real shutdown will fire on next real outage. Confirm?' : null },
  'ups-set-atboot':    { field: 'at_boot',               type: 'enum', allowed: ['enabled','disabled'],
                         confirmAt: v => v === 'disabled' ? 'Disabling auto-start: apcupsd will not run after PVE reboot. Confirm?' : null },
  'ups-rec-auto':      { field: 'recover_auto',          type: 'enum', allowed: ['yes','no'],
                         confirmAt: v => v === 'yes' ? 'Auto-recovery will fire on next PVE boot if marker file is present. Confirm?' : null },
  'ups-rec-bcharge':   { field: 'min_bcharge_pct',       type: 'int',  min: 0, max: 100, unit: '%' },
  'ups-rec-online':    { field: 'require_online_sec',    type: 'int',  min: 0, max: 600, unit: 's' },
  'ups-rec-bootdelay': { field: 'boot_delay_sec',        type: 'int',  min: 0, max: 600, unit: 's' },
  'ups-rec-markerage': { field: 'marker_max_age_hours',  type: 'int',  min: 1, max: 720, unit: 'h' },
};

// Attach click-to-edit on all editable tiles. Idempotent — safe to re-call
// after each upsLoadSettings / upsLoadRecoverSettings refresh.
function _upsAttachEditHandlers() {
  for (const [domId, meta] of Object.entries(_UPS_FIELD_BY_DOM)) {
    const el = document.getElementById(domId);
    if (!el || el.dataset.upsEditBound === '1') continue;
    el.dataset.upsEditBound = '1';
    el.style.cursor = 'pointer';
    el.title = 'Click to edit';
    el.addEventListener('click', (e) => {
      // Skip if user clicked inside an active edit input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
      upsBeginEdit(domId);
    });
  }
}

function upsBeginEdit(domId) {
  const meta = _UPS_FIELD_BY_DOM[domId]; if (!meta) return;
  const el = document.getElementById(domId);  if (!el)   return;
  const currentText = el.textContent.trim();
  let inputHtml;
  if (meta.type === 'enum') {
    inputHtml = `<select id="${domId}-input" style="font-size:1rem;font-weight:600;padding:2px 4px;">` +
      meta.allowed.map(o => {
        // Try to pre-select current value (handles "On"/"Off" -> "present"/"absent" mapping etc.)
        const cur = currentText.toLowerCase();
        const lo  = o.toLowerCase();
        const sel = (cur === lo || cur.includes(lo) || (cur === 'on' && lo === 'present') || (cur === 'off' && lo === 'absent')
                    || (cur === 'yes' && lo === 'yes') || (cur === 'no' && lo === 'no')) ? ' selected' : '';
        return `<option value="${o}"${sel}>${o}</option>`;
      }).join('') + `</select>`;
  } else {
    const cur = parseInt(currentText, 10) || 0;
    inputHtml = `<input id="${domId}-input" type="number" min="${meta.min}" max="${meta.max}" value="${cur}" style="font-size:1rem;font-weight:600;width:80px;padding:2px 4px;">${meta.unit ? ' ' + meta.unit : ''}`;
  }
  el.innerHTML = inputHtml +
    ` <button onclick="upsSaveEdit('${domId}')" style="margin-left:6px;padding:1px 8px;background:#2e7d32;color:#fff;border:0;border-radius:3px;cursor:pointer;font-size:0.8rem;">✓ Save</button>` +
    ` <button onclick="upsCancelEdit('${domId}')" style="margin-left:2px;padding:1px 8px;background:#888;color:#fff;border:0;border-radius:3px;cursor:pointer;font-size:0.8rem;">✕</button>`;
  // Auto-focus the input
  const inp = document.getElementById(`${domId}-input`);
  if (inp) inp.focus();
}

async function upsSaveEdit(domId) {
  const meta = _UPS_FIELD_BY_DOM[domId]; if (!meta) return;
  const inputEl = document.getElementById(`${domId}-input`); if (!inputEl) return;
  const v = String(inputEl.value).trim();
  // Optional confirm dialog for dangerous changes
  if (typeof meta.confirmAt === 'function') {
    const msg = meta.confirmAt(v);
    if (msg && !confirm(msg)) { upsCancelEdit(domId); return; }
  }
  const el = document.getElementById(domId);
  el.innerHTML = '<span style="font-size:0.85rem;color:#7a5a00;">saving…</span>';
  try {
    const r = await fetch('/api/dashboard-settings/_ups_settings_set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { field: meta.field, value: v } }),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    // Refresh both settings sections so badges + values resync
    await upsLoadSettings();
    await upsLoadRecoverSettings();
    _upsAttachEditHandlers();
  } catch (e) {
    el.innerHTML = `<span style="color:#c0392b;font-size:0.85rem;">error: ${e.message}</span>`;
    setTimeout(() => { upsLoadSettings(); upsLoadRecoverSettings(); _upsAttachEditHandlers(); }, 3000);
  }
}

function upsCancelEdit(domId) {
  // Re-render from server (reverts whatever was typed)
  upsLoadSettings();
  upsLoadRecoverSettings();
  _upsAttachEditHandlers();
}
window.upsBeginEdit  = upsBeginEdit;
window.upsSaveEdit   = upsSaveEdit;
window.upsCancelEdit = upsCancelEdit;

// Auto-Recovery Settings — read /etc/apcupsd/recover.conf via the dashboard
// proxy and render the 5 values into the sub-section. Color the master-switch
// badge red when recover_auto=no (installed but disabled), green when yes.
async function upsLoadRecoverSettings() {
  const badge = document.getElementById('ups-recover-badge');
  if (!badge) return;
  try {
    const r = await fetch('/api/dashboard-settings/_ups_recover_settings').then(r => r.json());
    const s = r.value;
    if (!s || !s.installed) {
      badge.textContent = 'NOT INSTALLED';
      badge.style.background = '#aaa';
      ['ups-rec-auto','ups-rec-bcharge','ups-rec-online','ups-rec-bootdelay','ups-rec-markerage']
        .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
      return;
    }
    const fmt = (v, suf) => (Number.isFinite(v) ? `${v}${suf || ''}` : '—');
    document.getElementById('ups-rec-auto').textContent      = ({yes:'Yes', no:'No'})[s.recover_auto] || s.recover_auto || '—';
    document.getElementById('ups-rec-bcharge').textContent   = fmt(s.min_bcharge_pct, ' %');
    document.getElementById('ups-rec-online').textContent    = fmt(s.require_online_sec, ' s');
    document.getElementById('ups-rec-bootdelay').textContent = fmt(s.boot_delay_sec, ' s');
    document.getElementById('ups-rec-markerage').textContent = fmt(s.marker_max_age_hours, ' h');
    if (s.recover_auto === 'yes') {
      badge.textContent = 'AUTO-RECOVER ON';
      badge.style.background = '#2e7d32';
    } else {
      badge.textContent = 'AUTO-RECOVER OFF';
      badge.style.background = '#7a5a00';
    }
    _upsAttachEditHandlers();
  } catch (e) {
    badge.textContent = 'error';
    badge.style.background = '#c0392b';
  }
}

// ── Shutdown Propagation card ────────────────────────────────
// Per-row live state + per-device timing. The user clicks Shutdown or
// Recover, and during the action each row transitions stopped/running with
// a "took N s" duration computed by the JS as it polls every 2 s.

// Curated display list — order shown to user, always visible regardless of
// current state. Ids match what pct/qm return.
const _UPS_DEVICES = [
  { kind: 'qnap', label: 'QNAP NAS' },
  { kind: 'lxc',  id: 100, label: 'Media' },
  { kind: 'lxc',  id: 102, label: 'Postgres' },
  { kind: 'lxc',  id: 103, label: 'Agents' },
  { kind: 'lxc',  id: 104, label: 'Servers' },
  { kind: 'lxc',  id: 105, label: 'Main Agent' },
  { kind: 'lxc',  id: 106, label: 'Voice' },
  { kind: 'lxc',  id: 107, label: 'MQTT' },
  { kind: 'vm',   id: 101, label: 'Home Assistant' },
];

// Per-action session: tracks when an action started + per-device transition
// times. Keys: action ('shutdown'|'recover'|null), startedAt, doneAt {key->ms}.
let _upsAction = null;
let _upsLastInv = null;
let _upsPollHandle = null;
// Idle polling — keeps the inventory fresh while the UPS tab is visible.
let _upsIdlePollHandle = null;
// Per-device "in current state since" map: { 'lxc-100': { state: 'running', sinceTs: <ms> } }
// Used for the duration column ("for 5 min", "for 2 h"). Reset on state change.
const _upsStateSince = {};

// Format a duration in ms as "for 5 s" / "for 12 min" / "for 1 h 12 min" / "for 2 d 5 h"
function _upsFmtDuration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60)        return `for ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60)        return `for ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24)        return `for ${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return `for ${d} d ${h % 24} h`;
}

function _upsKey(d)         { return d.kind === 'qnap' ? 'qnap' : `${d.kind}-${d.id}`; }
function _upsIsTargetState(action, isRunning) {
  // shutdown wants stopped (isRunning=false); recover wants running (isRunning=true)
  return action === 'shutdown' ? !isRunning : isRunning;
}

function _upsResolveStatus(d, inv) {
  if (d.kind === 'qnap') return inv.qnap_reachable ? 'running' : 'stopped';
  const arr = d.kind === 'lxc' ? inv.lxcs : inv.vms;
  const m   = (arr || []).find(x => x.id === d.id);
  return m ? m.status : 'stopped';
}

function _upsRenderRows(inv) {
  return _UPS_DEVICES.map((d, i) => {
    const isRunning = _upsResolveStatus(d, inv) === 'running';
    const color = isRunning ? '#2e7d32' : '#888';
    const dot   = isRunning ? '●' : '○';
    const lbl   = d.kind === 'qnap'
      ? (isRunning ? 'online'  : 'offline')
      : (isRunning ? 'running' : 'stopped');
    const idCol = d.kind === 'qnap' ? '' : `<span style="color:#888;width:38px;display:inline-block;text-align:right;">${d.id}</span>`;
    // Timing column — duration in current state (always shown after the
    // first observation), with extra precision during active actions.
    let took = '—';
    const k = _upsKey(d);
    if (_upsAction) {
      const t = _upsAction.doneAt[k];
      if (t != null) {
        // We just transitioned during this action — show the seconds it took
        took = `${Math.round(t / 1000)} s`;
      } else if (_upsIsTargetState(_upsAction.action, isRunning)) {
        // Transition is happening right now (target state reached this poll)
        took = `${Math.round((Date.now() - _upsAction.startedAt) / 1000)} s`;
      } else {
        // Still in pre-action state during the action — running clock
        took = '…';
      }
    } else {
      // Idle polling — show how long we've been observing the current state
      const trk = _upsStateSince[k];
      if (trk && trk.state === lbl) took = _upsFmtDuration(Date.now() - trk.sinceTs);
    }
    const border = i < _UPS_DEVICES.length - 1 ? 'border-bottom:1px solid rgba(0,0,0,0.08);' : '';
    // Checkbox: token = "qnap" or numeric id, used for SELECTION env var
    const token = d.kind === 'qnap' ? 'qnap' : String(d.id);
    return `<div style="display:flex;align-items:center;gap:10px;padding:7px 4px;${border}font-family:monospace;font-size:0.85rem;">
      <input type="checkbox" class="ups-dev-cb" data-token="${token}" checked onchange="upsCbChanged()" style="cursor:pointer;">
      <span style="color:${color};width:14px;">${dot}</span>
      ${idCol}
      <span style="flex:1;font-family:inherit;">${d.label}</span>
      <span style="color:${color};font-size:0.78rem;width:80px;">${lbl}</span>
      <span style="color:#888;font-size:0.78rem;width:90px;text-align:right;">${took}</span>
    </div>`;
  }).join('');
}

// Master toggle: select all / none.
function upsToggleAll(master) {
  document.querySelectorAll('.ups-dev-cb').forEach(cb => { cb.checked = master.checked; });
}
window.upsToggleAll = upsToggleAll;

// Keep the master checkbox in sync when user clicks individual rows.
function upsCbChanged() {
  const all = document.querySelectorAll('.ups-dev-cb');
  const checkedN = Array.from(all).filter(cb => cb.checked).length;
  const master = document.getElementById('ups-select-all');
  if (master) {
    master.checked = checkedN === all.length;
    master.indeterminate = checkedN > 0 && checkedN < all.length;
  }
}
window.upsCbChanged = upsCbChanged;

// Returns the list of currently-checked tokens — what we send to the server.
function _upsSelectedTokens() {
  return Array.from(document.querySelectorAll('.ups-dev-cb'))
    .filter(cb => cb.checked)
    .map(cb => cb.dataset.token);
}

async function upsLoadInventory() {
  const box = document.getElementById('ups-inventory');
  if (!box) return;
  try {
    const r = await fetch('/api/dashboard-settings/_ups_inventory').then(r => r.json());
    const inv = r.value;
    if (!inv) { box.innerHTML = '<span style="color:#c0392b;">unreachable</span>'; return; }
    // If a session is active, mark per-device transition timestamps the first
    // time each one reaches the target state.
    if (_upsAction) {
      for (const d of _UPS_DEVICES) {
        const k = _upsKey(d);
        if (_upsAction.doneAt[k] != null) continue;
        const isRunning = _upsResolveStatus(d, inv) === 'running';
        if (_upsIsTargetState(_upsAction.action, isRunning)) {
          _upsAction.doneAt[k] = Date.now() - _upsAction.startedAt;
        }
      }
    }
    // Idle state-since tracking: detect transitions between polls so the time
    // column can show "for 5 min" / "for 2 h" continuously.
    const now = Date.now();
    for (const d of _UPS_DEVICES) {
      const k = _upsKey(d);
      const isRunning = _upsResolveStatus(d, inv) === 'running';
      const lbl = d.kind === 'qnap'
        ? (isRunning ? 'online'  : 'offline')
        : (isRunning ? 'running' : 'stopped');
      const trk = _upsStateSince[k];
      if (!trk || trk.state !== lbl) {
        _upsStateSince[k] = { state: lbl, sinceTs: now };
      }
    }
    _upsLastInv = inv;
    box.innerHTML = _upsRenderRows(inv);
  } catch (e) {
    box.innerHTML = `<span style="color:#c0392b;">error: ${e.message}</span>`;
  }
}

function _upsSetStatus(text, color) {
  const el = document.getElementById('ups-inventory-status');
  if (el) { el.textContent = text; el.style.color = color || '#888'; }
}

function _upsLockButtons(disabled) {
  ['ups-btn-shutdown', 'ups-btn-recover'].forEach(id => {
    const b = document.getElementById(id); if (b) b.disabled = disabled;
  });
}

async function _upsRunAction(actionName, confirmWord, endpoint, statusLabel, refuseWhen) {
  // Refusal cases
  const tokens = _upsSelectedTokens();
  if (tokens.length === 0) {
    alert('Select at least one device.');
    return;
  }
  if (typeof refuseWhen === 'function') {
    const reason = refuseWhen(tokens, _upsLastInv);
    if (reason) { alert(reason); return; }
  }
  // Confirm with the list of devices the user is about to act on
  const labels = _UPS_DEVICES
    .filter(d => tokens.includes(d.kind === 'qnap' ? 'qnap' : String(d.id)))
    .map(d => '  • ' + d.label).join('\n');
  const msg = `WARNING — ${statusLabel} on these ${tokens.length} device(s):\n${labels}\n\nType ${confirmWord} to proceed, or click Cancel to abort.`;
  if (prompt(msg) !== confirmWord) return;

  _upsAction = { action: actionName, startedAt: Date.now(), doneAt: {} };
  _upsLockButtons(true);
  _upsSetStatus(`${statusLabel} in progress…`, '#7a5a00');
  if (_upsPollHandle) clearInterval(_upsPollHandle);
  _upsPollHandle = setInterval(() => upsLoadInventory(), 2000);
  try {
    await fetch('/api/dashboard-settings/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { trigger: actionName, ts: Date.now(), devices: tokens } }),
    });
  } catch (e) { /* keep going to final refreshes */ }
  clearInterval(_upsPollHandle); _upsPollHandle = null;
  await upsLoadInventory();
  setTimeout(upsLoadInventory, 2000);
  _upsLockButtons(false);
  const elapsed = Math.round((Date.now() - _upsAction.startedAt) / 1000);
  _upsSetStatus(`${statusLabel} complete (${elapsed} s elapsed)`, '#2e7d32');
}

async function upsShutdown(btn) {
  await _upsRunAction('shutdown', 'SHUTDOWN', '_ups_test_rehearse',
    'Shutdown',
    (tokens, inv) => {
      // Refuse if every selected device is already stopped
      if (!inv) return null;
      const anyRunning = tokens.some(t => {
        if (t === 'qnap') return inv.qnap_reachable;
        const id = parseInt(t, 10);
        const lxc = (inv.lxcs || []).find(x => x.id === id);
        if (lxc) return lxc.status === 'running';
        const vm  = (inv.vms  || []).find(x => x.id === id);
        return vm && vm.status === 'running';
      });
      return anyRunning ? null : 'All selected devices are already stopped.';
    });
}
async function upsRecover(btn) {
  await _upsRunAction('recover', 'RECOVER', '_ups_test_recover',
    'Recovery',
    (tokens, inv) => {
      // Refuse if every selected device is already running
      if (!inv) return null;
      const anyStopped = tokens.some(t => {
        if (t === 'qnap') return !inv.qnap_reachable;
        const id = parseInt(t, 10);
        const lxc = (inv.lxcs || []).find(x => x.id === id);
        if (lxc) return lxc.status !== 'running';
        const vm  = (inv.vms  || []).find(x => x.id === id);
        return vm && vm.status !== 'running';
      });
      return anyStopped ? null : 'All selected devices are already running.';
    });
}
window.upsShutdown = upsShutdown;
window.upsRecover  = upsRecover;

function upsLoadAll() {
  upsLoadLive();
  upsLoadHistory();
  upsLoadEvents();
  upsLoadSettings();
  upsLoadRecoverSettings();
  upsLoadInventory();
}
window.upsRunTest = upsRunTest;
