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
    // Exclude network:* alerts — those have their own home on the Project
    // Network page (System Alerts card filtered to alert_type LIKE 'network:%').
    // Showing them in both places was confusing.
    const qs = new URLSearchParams({ type_prefix_exclude: 'network:' });
    if (showResolvedAlerts) qs.set('include_resolved', 'true');
    const url = '/api/health/alerts?' + qs.toString();
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
        <td style="font-size:0.8rem; color:${r.resolved_local ? '#888' : color};">${escHtml(r.message)}${(!r.resolved_local && /^phonelink:/.test(r.alert_type || '')) ? plActionButtons(r.id) : ''}</td>
        <td style="font-size:0.75rem; color:#5a8a5a;">${r.resolved_local ? fmtTs(r.resolved_local) : ''}</td>
      </tr>`;
    }).join(''));
    try { localStorage.setItem(ALERTS_TBODY_CACHE, tbody.innerHTML); } catch (e) {}
  } catch (e) {
    document.getElementById('alerts-body').innerHTML =
      '<tr><td colspan="6" style="color:#b55e5e;">Failed to load</td></tr>';
  }
}

// Recovery buttons rendered on active phonelink:* alert rows. The dashboard runs
// ON the laptop, so these hit host-action endpoints (routes-phonelink.js) that
// run PowerShell locally. Light = restart (no re-pair); Hard = full reset (re-pair).
function plActionButtons(id) {
  return `<div data-pl-actions style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
    <button onclick="phonelinkFix(this,'restart',${id})" title="Restart Phone Link + re-register CrossDevice. No re-pair." style="font-size:0.72rem; padding:3px 8px; background:#b8860b; color:#fff; border:none; border-radius:4px; cursor:pointer;">&#128260; Restart Phone Link</button>
    <button onclick="phonelinkFix(this,'reset',${id})" title="Full reset: signs you out, you re-scan the QR on the phone." style="font-size:0.72rem; padding:3px 8px; background:#7a2020; color:#fff; border:none; border-radius:4px; cursor:pointer;">&#128295; Full Reset (re-pair)</button>
    <button onclick="phonelinkDismiss(this,${id})" title="Hide this alert. Returns in ~5 min if still broken." style="font-size:0.72rem; padding:3px 7px; background:#eee; color:#888; border:1px solid #ccc; border-radius:4px; cursor:pointer;">&#10005;</button>
  </div>`;
}

window.phonelinkFix = async function (btn, kind, id) {
  if (kind === 'reset' && !confirm('Full Reset signs you out of Phone Link — afterward you must sign in and re-scan the QR on your phone. Continue?')) return;
  const wrap = btn.closest('[data-pl-actions]');
  wrap.innerHTML = `<span style="font-size:0.72rem; color:#888;">${kind === 'reset' ? 'Resetting' : 'Restarting'} Phone Link… please wait (this can take up to ${kind === 'reset' ? '90' : '40'}s)</span>`;
  try {
    const r = await fetch('/api/phonelink/' + kind, { method: 'POST' }).then(x => x.json());
    wrap.innerHTML = `<span style="font-size:0.74rem; color:${r.ok ? '#3a7d44' : '#b55e5e'};">${escHtml(r.message || (r.ok ? 'done' : 'failed'))}</span>`;
  } catch (e) {
    wrap.innerHTML = '<span style="font-size:0.72rem; color:#b55e5e;">request failed — try again</span>';
  }
};

window.phonelinkDismiss = async function (btn, id) {
  try {
    await fetch('/api/phonelink/dismiss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  } catch (e) { /* best-effort */ }
  const tr = btn.closest('tr');
  if (tr) tr.style.display = 'none';
};

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
  document.getElementById('svc-lxc108').innerHTML = dot(r.lxc108?.ok);
  document.getElementById('svc-lxc109').innerHTML = dot(r.lxc109?.ok);
  document.getElementById('svc-lxc110').innerHTML = dot(r.lxc110?.ok);
  // RP01 cell + checkbox. Skipped briefly right after a toggle (server status is
  // cached ~60s) so a fresh toggle isn't reverted by stale data before it recomputes.
  if (Date.now() >= _rp01Grace) {
    const _t = r.rp01?.temp_c;
    const _tStr = (typeof _t === 'number')
      ? `<span style="margin-left:14px; font-size:0.8rem; color:${_t >= 80 ? '#c0392b' : _t >= 70 ? '#c08a3a' : '#5a8f3a'};">Temp - ${_t}°C</span>` : '';
    document.getElementById('svc-rp01').innerHTML = (r.rp01?.monitored === false)
      ? '<span style="color:#aaa;">⏸ monitoring off</span>' : dot(r.rp01?.ok) + _tStr;
    const _mcb = document.getElementById('mon-rp01'); if (_mcb) _mcb.checked = (r.rp01?.monitored !== false);
  }
  document.getElementById('svc-robot').innerHTML  = dot(r.robot?.ok);
  // AdGuard runs on RP01 — if RP01 monitoring is paused, show that instead of a false red.
  { const _agh = document.getElementById('svc-adguard');
    if (_agh) _agh.innerHTML = (r.rp01?.monitored === false)
      ? '<span style="color:#aaa;">⏸ (RP01 paused)</span>' : dot(r.adguard?.ok); }

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

  const plEl = document.getElementById('svc-phonelink');
  if (plEl) {
    const plOk = r.phonelink?.ok;
    plEl.innerHTML =
      plOk === null || plOk === undefined
        ? `<span style="color:#888; font-size:0.85rem;">⬤ unknown</span>`
        : dot(plOk) + (!plOk ? `<div style="font-size:0.7rem; color:#b55e5e; margin-top:3px;">offline / crash-loop — see alerts</div>` : '');
  }

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
    ['svc-postgres','svc-ha','svc-lxc100','svc-lxc102','svc-lxc103','svc-lxc104','svc-lxc105','svc-lxc106','svc-lxc107','svc-lxc108','svc-lxc109','svc-lxc110','svc-rp01','svc-robot','svc-adguard','svc-vm101',
     'svc-agent','svc-media-agents','svc-voice-agent','svc-phonelink','svc-auto-scan','svc-ha-to-pg','svc-pm2',
     'svc-orch-last-run','svc-collect-weather','svc-active-alerts','svc-boiler-last','svc-backup-jobs','svc-ups'
    ].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = dot(false); });
  }

  // Dashboard self-stats strip in the System Status h2 — independent of the
  // main status payload, cached 60 s server-side anyway.
  try {
    const ds = await fetch('/api/health/dashboard-stats').then(r => r.json());
    const fmtInt = (n) => Number(n || 0).toLocaleString();
    const locEl  = document.getElementById('ds-loc');
    const diskEl = document.getElementById('ds-disk');
    const ramEl  = document.getElementById('ds-ram');
    if (locEl)  locEl.textContent  = fmtInt(ds.loc);
    if (diskEl) diskEl.textContent = ds.disk_human || '—';
    if (ramEl)  ramEl.textContent  = `${ds.ram_process_human} / ${ds.ram_total_human} (${ds.ram_pct}%)`;
  } catch (_) { /* keep "—" placeholders */ }
}

// ── DB Volumes ───────────────────────────────────────────────
// Collapsible theme grouping — shared by the DB Volumes + Retention cards. State =
// a localStorage set of EXPANDED group names; absent → collapsed (default). The
// `group` field comes from the backend (server.js DBV_GROUPS, single source).
// Toggling a group flips it in BOTH cards at once + persists.
const DBV_EXP_KEY = 'health.dbGroupsExpanded';
function _dbExpanded() { try { return new Set(JSON.parse(localStorage.getItem(DBV_EXP_KEY) || '[]')); } catch (e) { return new Set(); } }
function _dbGroupRows(rows) {
  const order = [], byGroup = {};
  for (const r of rows) { const g = r.group || 'Other'; if (!byGroup[g]) { byGroup[g] = []; order.push(g); } byGroup[g].push(r); }
  return { order, byGroup };
}
function _dbPrettyBytes(n) { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i]; }
function _dbGroupHeader(group, ncols, parts, collapsed) {
  // parts = right-aligned, fixed-width columns (e.g. ['6 tables','12 MB']) so the
  // count + size line up vertically down the list, trimmed off the theme name.
  const meta = (parts || []).map(p => `<span style="min-width:78px; text-align:right;">${p}</span>`).join('');
  return `<tr class="dbgrp-head" data-dbgrp-h="${escHtml(group)}" onclick="toggleDbGroup(this.getAttribute('data-dbgrp-h'))" style="cursor:pointer; background:#efe9df;">
    <td colspan="${ncols}" style="padding:6px 9px;">
      <div style="display:flex; align-items:baseline; gap:10px;">
        <span style="font-weight:700; font-size:0.85rem;"><span class="dbgrp-caret">${collapsed ? '▸' : '▾'}</span> ${escHtml(group)}</span>
        <span style="margin-left:auto; font-weight:400; color:#999; font-size:0.78rem; display:inline-flex; gap:18px;">${meta}</span>
      </div>
    </td></tr>`;
}
window.toggleDbGroup = function (group) {
  const exp = _dbExpanded();
  if (exp.has(group)) exp.delete(group); else exp.add(group);
  try { localStorage.setItem(DBV_EXP_KEY, JSON.stringify([...exp])); } catch (e) {}
  const collapsed = !exp.has(group);
  document.querySelectorAll('tr[data-dbgrp="' + group.replace(/"/g, '\\"') + '"]').forEach(tr => { tr.style.display = collapsed ? 'none' : ''; });
  document.querySelectorAll('tr[data-dbgrp-h]').forEach(h => {
    if (h.getAttribute('data-dbgrp-h') === group) { const c = h.querySelector('.dbgrp-caret'); if (c) c.textContent = collapsed ? '▸' : '▾'; }
  });
};

async function loadMiniDlna() {
  const tbody = document.getElementById('volumes-body');
  document.getElementById('minidlna-row')?.remove();
  // Place the SQLite row inside its "External (MiniDLNA)" group (header is rendered
  // by loadVolumes); fall back to appending if that header isn't there yet.
  const _place = (tr) => {
    tr.id = 'minidlna-row';
    tr.setAttribute('data-dbgrp', 'External (MiniDLNA)');
    if (!_dbExpanded().has('External (MiniDLNA)')) tr.style.display = 'none';
    const head = document.querySelector('tr[data-dbgrp-h="External (MiniDLNA)"]');
    if (head) head.insertAdjacentElement('afterend', tr); else tbody.appendChild(tr);
  };
  try {
    const d = await fetch('/api/health/minidlna').then(r => r.json());
    if (d.error) throw new Error(d.error);
    const orphanColor = d.orphans > 0 ? '#c0392b' : '#2ecc71';
    const updated = d.last_updated
      ? new Date(d.last_updated).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
      : '— never';
    const tr = document.createElement('tr');
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
    _place(tr);
  } catch (e) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="9" style="color:#c0392b;font-size:0.82rem;">MiniDLNA: ${escHtml(e.message)}</td>`;
    _place(tr);
  }
}

async function loadVolumes() {
  try {
    const rows = await fetch('/api/health/db-volumes').then(r => r.json());
    const { order, byGroup } = _dbGroupRows(rows);
    const exp = _dbExpanded();
    const volRow = (r, collapsed) => {
      const fragColor = r.frag_pct >= 20 ? '#c0392b' : r.frag_pct >= 5 ? '#e67e22' : '#2ecc71';
      return `<tr id="vol-row-${r.table_name}" data-dbgrp="${escHtml(r.group || 'Other')}" style="${collapsed ? 'display:none;' : ''}">
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
    };
    let html = '';
    for (const g of order) {
      // within-group order unchanged: small → large by row count
      const grp = byGroup[g].slice().sort((a, b) => a.row_count - b.row_count);
      const bytes = grp.reduce((s, r) => s + (r.size_bytes || 0), 0);
      const collapsed = !exp.has(g);
      html += _dbGroupHeader(g, 9, [`${grp.length} table${grp.length > 1 ? 's' : ''}`, _dbPrettyBytes(bytes)], collapsed);
      html += grp.map(r => volRow(r, collapsed)).join('');
    }
    // External (MiniDLNA) group — SQLite DB on LXC 100, row filled by loadMiniDlna.
    html += _dbGroupHeader('External (MiniDLNA)', 9, ['SQLite · LXC 100'], !exp.has('External (MiniDLNA)'));
    setHTML(document.getElementById('volumes-body'), html);
    const totEl = document.getElementById('dbvol-total');
    if (totEl) totEl.textContent = `${rows.length} tables · ${_dbPrettyBytes(rows.reduce((s, r) => s + (r.size_bytes || 0), 0))}`;
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
    // Fetch volumes in parallel so we can sort retention rows by row_count to
    // match the DB Volumes card's ordering — operator sees the two cards in
    // the same order, scanning a table in one card finds it at the same
    // height in the other.
    const [rows, vols] = await Promise.all([
      fetch('/api/health/retention').then(r => r.json()),
      fetch('/api/health/db-volumes').then(r => r.json()).catch(() => []),
    ]);
    const rc = Object.fromEntries(vols.map(v => [v.table_name, v.row_count]));
    const { order, byGroup } = _dbGroupRows(rows);
    const exp = _dbExpanded();
    const retRow = (p, collapsed) => {
      const prot = !!p.protected, dis = prot ? 'disabled' : '', bg = prot ? '#ececec' : '#faf8f5';
      return `
      <tr id="row-${p.table_name}" data-dbgrp="${escHtml(p.group || 'Other')}" style="${collapsed ? 'display:none;' : ''}">
        <td><code>${p.table_name}</code></td>
        <td style="font-size:0.78rem; color:#666;">${p.description || '—'}</td>
        <td style="text-align:center;">
          <input type="number" min="1" value="${p.keep_days ?? ''}" placeholder="∞" ${dis}
            style="width:60px; text-align:center; font-size:0.8rem; border:1px solid #d0cbc4; border-radius:3px; padding:2px 4px; background:${bg};"
            id="keep-${p.table_name}">
        </td>
        <td style="text-align:center;">
          <input type="checkbox" ${p.auto_clean ? 'checked' : ''} ${dis} id="auto-${p.table_name}">
        </td>
        <td style="text-align:center;">
          <input type="number" min="1" value="${p.clean_interval_hours}" ${dis}
            style="width:55px; text-align:center; font-size:0.8rem; border:1px solid #d0cbc4; border-radius:3px; padding:2px 4px; background:${bg};"
            id="interval-${p.table_name}">
        </td>
        <td style="font-size:0.78rem; color:#666;">${fmtTs(p.last_cleaned_at)}</td>
        <td style="white-space:nowrap;">
          <div style="display:flex; align-items:center; gap:4px;">
            <button class="btn btn-secondary btn-sm" style="font-size:0.72rem; padding:3px 8px;"
              onclick="savePolicy('${p.table_name}')" ${dis}>Save</button>
            <button class="btn btn-secondary btn-sm" style="font-size:0.72rem; padding:3px 8px;"
              onclick="cleanTable('${p.table_name}')" ${(p.keep_days && !prot) ? '' : `disabled title="${prot ? 'Protected' : 'No retention limit set'}"`}>Clean</button>
            <span onclick="protectTable('${p.table_name}', ${!prot})" title="${prot ? 'Protected from cleaning — click to unprotect' : 'Click to protect from cleaning'}"
              style="margin-left:auto; width:1.4em; text-align:center; cursor:pointer; user-select:none; font-size:0.95rem; opacity:${prot ? '1' : '0.25'};">${prot ? '🔒' : '🔓'}</span>
          </div>
        </td>
      </tr>`;
    };
    let html = '';
    for (const g of order) {
      const grp = byGroup[g].slice().sort((a, b) => (rc[a.table_name] ?? Infinity) - (rc[b.table_name] ?? Infinity));
      const collapsed = !exp.has(g);
      html += _dbGroupHeader(g, 7, [`${grp.length} table${grp.length > 1 ? 's' : ''}`], collapsed);
      html += grp.map(p => retRow(p, collapsed)).join('');
    }
    setHTML(document.getElementById('retention-body'), html);
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
  if (!confirm('Run cleanup on all tables with a retention limit set?\n\n🔒 Protected tables (medical / privacy / health) are skipped.\nThis permanently deletes old rows and cannot be undone.')) return;
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

// Toggle a table's "protected" flag (locks it from keep-days/auto-clean/Clean +
// the server refuses to clean it). Confirm only when REMOVING the protection.
async function protectTable(name, prot) {
  if (!prot && !confirm(`Unprotect "${name}"?\n\nThis re-enables retention limits + cleaning for it. Only do this if you're sure. Continue?`)) return;
  try {
    const r = await fetch('/api/health/retention', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_name: name, protected: prot }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    await loadRetention();
  } catch (e) { showCleanupResult('✗ Protect failed: ' + escHtml(e.message), true); }
}

// RP01 monitoring toggle — unchecked pauses its health probe + drops it from the
// Status badge (dashboard_settings.health.node_monitoring map, merged so other
// nodes aren't clobbered). On the server, paused RP01 returns ok:null.
let _rp01Grace = 0;   // suppress renderStatus overriding the RP01 cell until the server recomputes
async function toggleRp01Monitor(checked) {
  _rp01Grace = Date.now() + 90000;   // ~90s: covers the server's ≤60s status recompute
  const cell = document.getElementById('svc-rp01');   // optimistic immediate feedback
  if (cell) cell.innerHTML = checked ? '<span style="color:#aaa;">…</span>' : '<span style="color:#aaa;">⏸ monitoring off</span>';
  try {
    const cur = await fetch('/api/dashboard-settings/health.node_monitoring').then(r => r.json()).catch(() => ({}));
    const map = (cur && cur.value && typeof cur.value === 'object') ? cur.value : {};
    map.rp01 = !!checked;
    await fetch('/api/dashboard-settings/health.node_monitoring', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: map }),
    });
    // no loadStatus() here — the cached status is still stale; the grace window lets
    // the optimistic state hold until the next recompute reconciles it.
  } catch (e) { _rp01Grace = 0; /* on failure, let the next poll re-sync from the server */ }
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
  if (dbTabActive)        { tasks.push(loadVolumes().then(loadMiniDlna), loadRetention()); }
  if (backupsTabActive)   { tasks.push(loadBackups()); }
  if (winBackupTabActive) { tasks.push(loadWinStorages(), loadWinJobs(), loadWinLog()); }
  await Promise.all(tasks);
  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

// ── Proxmox Backups ──────────────────────────────────────────
// Proxmox retention can be a legacy scalar (maxfiles) OR a prune-backups object
// like {"keep-daily":"4"} — render the object as "4 daily" instead of "[object Object]".
function fmtRetention(r) {
  if (r == null || r === '') return '—';
  if (typeof r === 'object') {
    const parts = Object.entries(r).map(([k, v]) => `${v} ${String(k).replace(/^keep-/, '')}`);
    return parts.length ? parts.join(', ') : '—';
  }
  return String(r);
}

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
          <td style="font-size:0.78rem; color:#666;">${fmtRetention(j.retention)}</td>
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

// ─ Cloud Backup Retention (Settings tab) ─────────────────────
async function loadCloudRetention() {
  try {
    const j = await fetch('/api/dashboard-settings/privacy.cloud_retention').then(r => r.json());
    const v = (j && j.value) || {};
    document.getElementById('cr-project').value = v.project_days ?? 14;
    document.getElementById('cr-budget').value = v.budget_days ?? 30;
    document.getElementById('cr-db').value = v.db_days ?? 30;
    document.getElementById('cr-guests').value = v.guests_weeks ?? 4;
  } catch (_) {}
}
async function saveCloudRetention() {
  const clamp = (id, def, max) => {
    let n = parseInt(document.getElementById(id).value, 10);
    if (!Number.isFinite(n) || n < 1) n = def;
    if (n > max) n = max;
    document.getElementById(id).value = n;
    return n;
  };
  const value = {
    project_days: clamp('cr-project', 14, 3650),
    budget_days: clamp('cr-budget', 30, 3650),
    db_days: clamp('cr-db', 30, 3650),
    guests_weeks: clamp('cr-guests', 4, 520),
  };
  const st = document.getElementById('cr-status');
  try {
    const r = await fetch('/api/dashboard-settings/privacy.cloud_retention', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    }).then(r => r.json());
    st.style.color = r && r.ok ? '#2e7d32' : '#b03a2e';
    st.textContent = r && r.ok ? 'Saved ✓ (applies on the next backup run)' : 'Save failed';
  } catch (e) { st.style.color = '#b03a2e'; st.textContent = 'Error: ' + e.message; }
  setTimeout(() => { st.textContent = ''; }, 4000);
}

// ─ Restore tab ───────────────────────────────────────────────
async function loadRestoreSources() {
  const pb = document.getElementById('rst-project-body');
  const bb = document.getElementById('rst-budget-body');
  try {
    const s = await fetch('/api/restore/sources').then(r => r.json());
    const projRows = [
      ...s.project.qnap.map(x => ({ src: 'qnap', ref: x.ref, label: x.label, contents: 'full (+deps)' })),
      ...s.project.drive.map(x => ({ src: 'drive', ref: x.ref, label: x.label, contents: 'code (no deps)' })),
    ];
    pb.innerHTML = projRows.length ? projRows.map(r => `<tr>
      <td style="font-size:0.82rem;">${r.src === 'qnap' ? '🏠 QNAP' : '☁️ Drive (encrypted)'}</td>
      <td style="font-size:0.82rem; color:#555;">${escHtml(r.label)}</td>
      <td style="font-size:0.78rem; color:#888;">${r.contents}</td>
      <td style="text-align:center;"><button class="btn btn-secondary btn-sm" style="font-size:0.78rem;"
        onclick="doRestore('project','${r.src}','${escHtml(r.ref)}', this)">Restore ▸</button></td>
    </tr>`).join('') : '<tr><td colspan="4" style="color:#aaa;">No backups found</td></tr>';

    const budRows = [
      ...s.budget.qnap.map(x => ({ src: 'qnap', ref: x.ref, label: x.label })),
      ...s.budget.drive.map(x => ({ src: 'drive', ref: x.ref, label: x.label })),
    ];
    bb.innerHTML = budRows.length ? budRows.map(r => `<tr>
      <td style="font-size:0.82rem;">${r.src === 'qnap' ? '🏠 QNAP' : '☁️ Drive'}</td>
      <td style="font-size:0.82rem; color:#555;">${escHtml(r.label)}</td>
      <td style="text-align:center;"><button class="btn btn-secondary btn-sm" style="font-size:0.78rem;"
        onclick="doRestore('budget','${r.src}','${escHtml(r.ref)}', this)">Restore ▸</button></td>
    </tr>`).join('') : '<tr><td colspan="3" style="color:#aaa;">No backups found</td></tr>';

    // Database (Drive dumps → safe restore into a NEW scratch DB)
    const dbRows = (s.database && s.database.drive) || [];
    const dbb = document.getElementById('rst-db-body');
    if (dbb) dbb.innerHTML = dbRows.length ? dbRows.map(r => `<tr>
      <td style="font-size:0.82rem;">☁️ Drive</td>
      <td style="font-size:0.82rem; color:#555;">${escHtml(r.label)}</td>
      <td style="font-size:0.8rem;"><code>home_data_restore</code></td>
      <td style="text-align:center;"><button class="btn btn-secondary btn-sm" style="font-size:0.78rem;"
        onclick="doRestore('db','drive','${escHtml(r.ref)}', this)">Restore ▸</button></td>
    </tr>`).join('') : '<tr><td colspan="4" style="color:#aaa;">No DB backups yet</td></tr>';

    // Guest images — visibility only (restore via Proxmox)
    const guests = s.guests || [];
    const gb = document.getElementById('rst-guests-body');
    if (gb) gb.innerHTML = guests.length ? guests.map(x => `<tr>
      <td style="font-size:0.82rem;">${x.id == 101 ? 'VM ' : 'LXC '}${escHtml(String(x.id))}</td>
      <td style="font-size:0.82rem; color:#555;">${escHtml(x.date || '—')}</td>
      <td style="font-size:0.82rem; color:#555;">${Math.round((x.size || 0) / 1024 / 1024)} MB</td>
    </tr>`).join('') : '<tr><td colspan="3" style="color:#aaa;">No guest images yet (first full run: Sunday 04:00)</td></tr>';
  } catch (e) {
    pb.innerHTML = `<tr><td colspan="4" style="color:#b55e5e;">Failed: ${escHtml(e.message)}</td></tr>`;
  }
}

async function doRestore(type, source, ref, btn) {
  let dest = 'db';
  if (type === 'project') {
    dest = document.querySelector('input[name="rst-dest"]:checked')?.value || 'qnap';
    if (!confirm(`Restore the project folder from this ${source === 'qnap' ? 'QNAP snapshot' : 'encrypted Drive backup'} into a NEW folder on ${dest === 'qnap' ? 'QNAP (Restores\\)' : 'the laptop (Restore\\)'}?\n\nYour live project folder is NOT touched.`)) return;
  } else if (type === 'db') {
    if (!confirm('Restore this database backup into a NEW database "home_data_restore"?\n\nYour LIVE database is NOT touched. This can take a few minutes.')) return;
  } else {
    if (!confirm(`Restore the Budget from this ${source === 'qnap' ? 'QNAP' : 'Drive'} backup?\n\nThis REPLACES your current Budget data — your current one is auto-saved as a rollback first. You'll unlock it in the Budget tab to view.`)) return;
  }
  const result = document.getElementById('rst-result');
  const old = btn.textContent; btn.textContent = 'Restoring…'; btn.disabled = true;
  result.style.display = 'block';
  result.style.background = '#eef4fb'; result.style.color = '#2c5777';
  result.textContent = 'Running restore…';
  try {
    const r = await fetch('/api/restore/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, source, ref, dest }),
    }).then(r => r.json());
    if (r.ok) {
      result.style.background = '#e8f6ee'; result.style.color = '#1d6f42';
      result.innerHTML = type === 'project'
        ? `✅ Restored to <b>${escHtml(r.target || '(new folder)')}</b>`
        : type === 'db'
        ? `✅ Restored into <b>home_data_restore</b> — your live database is untouched. Inspect it, copy out what you need, then drop it when done.`
        : `✅ Budget restored (current saved as rollback). Open the <b>Budget</b> tab on the Privacy page and unlock to view.`;
    } else {
      result.style.background = '#fdecea'; result.style.color = '#b03a2e';
      result.textContent = '❌ Restore failed: ' + (r.error || r.output || 'unknown');
    }
  } catch (e) {
    result.style.background = '#fdecea'; result.style.color = '#b03a2e';
    result.textContent = '❌ ' + e.message;
  } finally {
    btn.textContent = old; btn.disabled = false;
  }
}

// ─ Storages ──────────────────────────────────────────────────
let _winStorages = [];

// Backups status strip in the Backup Storages header (project: home QNAP time +
// cloud Drive time + folder link). Not sensitive (times + a link).
async function loadStorageCloudStatus() {
  try {
    const j = await fetch('/api/privacy/project-backup-status').then(r => r.json());
    const home = document.getElementById('bk-st-home');
    const cloud = document.getElementById('bk-st-cloud');
    const link = document.getElementById('bk-st-link');
    if (home) home.textContent = '🏠 Home: ' + (j.home_last_ok || 'never');
    if (cloud) cloud.textContent = '☁️ Cloud: ' + (j.cloud_last_ok || 'never');
    if (link && j.drive_folder_url) link.href = j.drive_folder_url;
  } catch (_) {
    const home = document.getElementById('bk-st-home');
    if (home) home.textContent = '🏠 Home: —';
  }
}

async function loadWinStorages() {
  loadStorageCloudStatus();
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
  } finally {
    btn.disabled = false;
    // Toggling SAFETY_MODE flips the SHUTDOWN ON/OFF state — refresh the
    // Shutdown Settings card right away (badge + Run-orchestrator button label
    // + LIVE/dry-run warning) instead of waiting for the next 60 s poll.
    if (name === 'safety_on' || name === 'safety_off') upsLoadSettings();
  }
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
    // Also drives the "Run orchestrator" button label/style so the user can
    // see at a glance whether clicking it does a real halt or a logged dry-run.
    const badge = document.getElementById('ups-settings-badge');
    const dryBtn = document.getElementById('ups-btn-dryrun');
    const dryWarn = document.getElementById('ups-dryrun-warning');
    if (s.safety_mode === 'absent') {
      badge.textContent = 'SHUTDOWN ON';
      badge.style.background = '#2e7d32';        // green — UPS protection ACTIVE (the good state)
      if (dryBtn) {
        dryBtn.textContent = 'Run orchestrator (LIVE — will halt EVERYTHING)';
        dryBtn.style.borderColor = '#c0392b';
        dryBtn.style.color = '#c0392b';
        dryBtn.dataset.armed = '1';
      }
      if (dryWarn) {
        // SAFETY_MODE off → this button is LIVE → warn in red.
        dryWarn.style.color = '#c0392b';
        dryWarn.innerHTML = '<b>⚠ LIVE — SAFETY_MODE is OFF.</b> Clicking this runs the real shutdown: it halts QNAP, stops every LXC + VM, and powers off the PVE mini-PC. You will need to physically power-cycle the mini-PC to bring it back.';
      }
    } else if (s.safety_mode === 'present') {
      badge.textContent = 'SHUTDOWN OFF';
      badge.style.background = '#c0392b';        // red — protection DISABLED (no graceful halt on a real outage)
      if (dryBtn) {
        dryBtn.textContent = 'Run orchestrator (dry-run — SAFETY_MODE on, logs only)';
        dryBtn.style.borderColor = '';
        dryBtn.style.color = '';
        dryBtn.dataset.armed = '0';
      }
      if (dryWarn) {
        // SAFETY_MODE on → dry-run only → neutral dark-grey text.
        dryWarn.style.color = '#444';
        dryWarn.innerHTML = 'Dry-run — SAFETY_MODE is ON, so this only writes to the log. Nothing shuts down.';
      }
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
  'ups-rec-battgate':  { field: 'battery_gate_pct',      type: 'int',  min: 0, max: 99,  unit: '%',
                         confirmAt: v => parseInt(v,10) >= 70 ? 'High gate (≥70 %) — guests may stay off for 30+ min after a deep outage while UPS recharges. Confirm?' : null },
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
      ['ups-rec-auto','ups-rec-bcharge','ups-rec-online','ups-rec-bootdelay','ups-rec-markerage','ups-rec-battgate']
        .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
      return;
    }
    const fmt = (v, suf) => (Number.isFinite(v) ? `${v}${suf || ''}` : '—');
    const recAutoEl = document.getElementById('ups-rec-auto');
    recAutoEl.textContent = ({yes:'Yes', no:'No'})[s.recover_auto] || s.recover_auto || '—';
    // Color the value like the AUTO-RECOVER badge: amber when OFF, green when ON.
    recAutoEl.style.display = 'inline-block';
    recAutoEl.style.padding = '2px 14px';
    recAutoEl.style.borderRadius = '8px';
    recAutoEl.style.color = '#fff';
    document.getElementById('ups-rec-bcharge').textContent   = fmt(s.min_bcharge_pct, ' %');
    document.getElementById('ups-rec-online').textContent    = fmt(s.require_online_sec, ' s');
    document.getElementById('ups-rec-bootdelay').textContent = fmt(s.boot_delay_sec, ' s');
    document.getElementById('ups-rec-markerage').textContent = fmt(s.marker_max_age_hours, ' h');
    document.getElementById('ups-rec-battgate').textContent  = (s.battery_gate_pct === 0) ? 'Off' : fmt(s.battery_gate_pct, ' %');
    if (s.recover_auto === 'yes') {
      badge.textContent = 'AUTO-RECOVER ON';
      badge.style.background = '#2e7d32';
      recAutoEl.style.background = '#2e7d32';
    } else {
      badge.textContent = 'AUTO-RECOVER OFF';
      badge.style.background = '#7a5a00';
      recAutoEl.style.background = '#7a5a00';
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
  { kind: 'vm',   id: 101, label: 'Home Assistant' },
  { kind: 'lxc',  id: 102, label: 'Postgres' },
  { kind: 'lxc',  id: 103, label: 'Agents' },
  { kind: 'lxc',  id: 104, label: 'Servers' },
  { kind: 'lxc',  id: 105, label: 'Main Agent' },
  { kind: 'lxc',  id: 106, label: 'Voice' },
  { kind: 'lxc',  id: 107, label: 'MQTT' },
  { kind: 'lxc',  id: 108, label: 'NetBird' },
  { kind: 'lxc',  id: 109, label: 'Privacy' },
  { kind: 'lxc',  id: 110, label: 'Email' },
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
    // Timing column — only shown DURING an action, where we have a real
    // anchor (action start time). In idle, we have no real transition
    // timestamp, so showing "for 5m" would be misleading (it'd actually
    // be "since the page first observed this state"). Drop it in idle.
    let took = '';
    const k = _upsKey(d);
    if (_upsAction) {
      const t = _upsAction.doneAt[k];
      if (t != null) {
        took = `${Math.round(t / 1000)} s`;            // real transition time
      } else if (_upsIsTargetState(_upsAction.action, isRunning)) {
        took = `${Math.round((Date.now() - _upsAction.startedAt) / 1000)} s`;
      } else {
        took = '…';
      }
    }
    const border = i < _UPS_DEVICES.length - 1 ? 'border-bottom:1px solid rgba(0,0,0,0.08);' : '';
    return `<div style="display:flex;align-items:center;gap:10px;padding:7px 4px;${border}font-family:monospace;font-size:0.85rem;">
      <span style="color:${color};width:14px;">${dot}</span>
      ${idCol}
      <span style="flex:1;font-family:inherit;">${d.label}</span>
      <span style="color:${color};font-size:0.78rem;width:80px;">${lbl}</span>
      <span style="color:#888;font-size:0.78rem;width:90px;text-align:right;">${took}</span>
    </div>`;
  }).join('');
}

// Master toggle: select all / none.
// Always-all-devices: per the user's "UPS recovery/shutdown always = ALL"
// rule, the per-device checkboxes were removed. The action runner sends an
// empty `devices` array so the server's recovery/shutdown helpers fall back
// to their "no SELECTION = act on every device" code path.

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
    window._upsLastRefresh = Date.now();
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
  if (typeof refuseWhen === 'function') {
    const reason = refuseWhen(_upsLastInv);
    if (reason) { alert(reason); return; }
  }
  const labels = _UPS_DEVICES.map(d => '  • ' + d.label).join('\n');
  const msg = `WARNING — ${statusLabel} on ALL ${_UPS_DEVICES.length} device(s):\n${labels}\n\nType ${confirmWord} to proceed, or click Cancel to abort.`;
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
      // Empty devices array = no SELECTION env on the server side = act on all
      body: JSON.stringify({ value: { trigger: actionName, ts: Date.now() } }),
    });
  } catch (e) { /* keep going to final refreshes */ }
  clearInterval(_upsPollHandle); _upsPollHandle = null;
  await upsLoadInventory();
  setTimeout(upsLoadInventory, 2000);
  _upsLockButtons(false);
  const elapsed = Math.round((Date.now() - _upsAction.startedAt) / 1000);
  _upsSetStatus(`${statusLabel} complete (${elapsed} s elapsed)`, '#2e7d32');
  // Clear the action session so the background poll (every 5 s) resumes
  // taking over for live ●/○ updates. Keep the elapsed-status message
  // showing — the row's per-device "took N s" was already rendered.
  _upsAction = null;
}

async function upsShutdown(btn) {
  await _upsRunAction('shutdown', 'SHUTDOWN', '_ups_test_rehearse',
    'Shutdown',
    (inv) => {
      if (!inv) return null;
      const anyRunning = inv.qnap_reachable
        || (inv.lxcs || []).some(x => x.status === 'running')
        || (inv.vms  || []).some(x => x.status === 'running');
      return anyRunning ? null : 'Everything is already stopped.';
    });
}
async function upsRecover(btn) {
  await _upsRunAction('recover', 'RECOVER', '_ups_test_recover',
    'Recovery',
    (inv) => {
      if (!inv) return null;
      const anyStopped = !inv.qnap_reachable
        || (inv.lxcs || []).some(x => x.status !== 'running')
        || (inv.vms  || []).some(x => x.status !== 'running');
      return anyStopped ? null : 'Everything is already running.';
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

// Background auto-refresh — keeps the Shutdown Propagation card + UPS live
// status fresh when the UPS tab is active. 30s is the right rate: each
// inventory poll SSHes to PVE (pct/qm/QNAP-SSH = ~1-2s of work). State
// transitions (halt/recover) take 5-60s, so 30s is fast enough to catch
// them in 1-2 ticks while keeping idle SSH duty-cycle near 5%. During an
// active shutdown/recover session, the action handler runs its own 2s
// poll (faster feedback while operations are in flight) — skipped here
// to avoid double-polling.
setInterval(() => {
  if (!document.getElementById('tab-ups')?.classList.contains('active')) return;
  if (_upsAction) return;
  upsLoadInventory();
  upsLoadLive();
}, 30000);

// "Last refreshed" indicator on the inventory status line — updates every
// 1 s so the user can tell data freshness honestly. Set by upsLoadInventory
// (`_upsLastRefresh`). Goes red after 60 s without refresh = something stuck.
setInterval(() => {
  const el = document.getElementById('ups-inventory-status');
  if (!el || !window._upsLastRefresh || _upsAction) return;
  const ageSec = Math.round((Date.now() - window._upsLastRefresh) / 1000);
  const ts = new Date(window._upsLastRefresh).toLocaleTimeString();
  el.textContent = `last refresh: ${ts} (${ageSec}s ago)`;
  el.style.color = ageSec > 60 ? '#b55e5e' : '#888';
}, 1000);
window.upsRunTest = upsRunTest;

// Click handler for the "Run orchestrator" button. Two modes:
//   SAFETY_MODE present (button data-armed=0) → logged dry-run, no halt → fire directly
//   SAFETY_MODE absent  (button data-armed=1) → REAL shutdown → require typed confirm
function upsTriggerDryRun(btn) {
  if (btn && btn.dataset.armed === '1') {
    const msg = 'WARNING — SAFETY_MODE is OFF.\n\n' +
                'This will run /etc/apcupsd/doshutdown for REAL:\n' +
                '  • Halt QNAP (SSH poweroff)\n' +
                '  • Stop every LXC and VM\n' +
                '  • Halt PVE itself\n\n' +
                'You will need to power-cycle the mini PC to bring it back.\n\n' +
                'Type SHUTDOWN to proceed, or click Cancel to abort.';
    if (prompt(msg) !== 'SHUTDOWN') return;
  }
  upsRunTest('dryrun', btn);
}
window.upsTriggerDryRun = upsTriggerDryRun;

// ============================================================
// AdGuard tab — read-only view of AdGuard Home running on RP01.
// Data comes via the routes-adguard.js proxy (/api/adguard/*).
// ALL the DNS logic + logging lives on the Pi; this only displays it.
// ============================================================
let _aghTimer = null;

function adguardOnTabShow() {
  loadAdguard();
  if (_aghTimer) clearInterval(_aghTimer);
  _aghTimer = setInterval(() => {
    if (!document.getElementById('tab-adguard')?.classList.contains('active')) return;
    if (document.hidden) return;
    loadAdguard();
  }, 10000);
}
window.adguardOnTabShow = adguardOnTabShow;

function _aghEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

function _aghClientNames(clients) {
  // ip/id -> friendly name, from persistent clients + auto (ARP/rDNS) clients.
  const map = {};
  (clients?.auto_clients || []).forEach(c => { if (c.ip && c.name) map[c.ip] = c.name; });
  (clients?.clients || []).forEach(c => (c.ids || []).forEach(id => { if (c.name) map[id] = c.name; }));
  return map;
}

async function loadAdguard() {
  const health = document.getElementById('agh-health');
  try {
    const [summary, qlog] = await Promise.all([
      fetch('/api/adguard/summary').then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))),
      fetch('/api/adguard/querylog?limit=400').then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
    ]);
    const st = summary.status || {}, stats = summary.stats || {};
    const names = _aghClientNames(summary.clients);

    const prot = st.protection_enabled;
    health.innerHTML =
      `<b style="color:${prot ? '#5a8f3a' : '#b55e5e'};">${prot ? '● protection ON' : '● protection OFF'}</b>` +
      ` · v${_aghEsc(st.version || '?')} · DNS :${st.dns_port || 53}`;

    // Overview tiles (24 h)
    const q = stats.num_dns_queries || 0;
    const b = stats.num_blocked_filtering || 0;
    const pct = q ? (100 * b / q) : 0;
    const avgMs = stats.avg_processing_time != null ? (stats.avg_processing_time * 1000) : null;
    const nClients = (stats.top_clients || []).length;
    const tile = (label, val, color) =>
      `<div style="min-width:110px;"><div style="font-size:1.5rem; font-weight:600; color:${color||'#444'};">${val}</div>` +
      `<div style="font-size:0.72rem; color:#888; text-transform:uppercase; letter-spacing:.03em;">${label}</div></div>`;
    document.getElementById('agh-overview').innerHTML =
      tile('DNS queries', q.toLocaleString()) +
      tile('Blocked', b.toLocaleString(), '#b55e5e') +
      tile('Block %', pct.toFixed(1) + '%', '#b55e5e') +
      tile('Avg resp', avgMs == null ? '—' : avgMs.toFixed(1) + ' ms') +
      tile('Active devices', nClients);

    // Per-device egress — aggregate the recent query log by client.
    const agg = {};
    (qlog.data || []).forEach(e => {
      const cip = e.client || '?';
      const dom = e.question?.name || '';
      const blocked = /^Filtered/.test(e.reason || '');
      const a = agg[cip] || (agg[cip] = { count: 0, blocked: 0, domains: {} });
      a.count++; if (blocked) a.blocked++;
      if (dom) a.domains[dom] = (a.domains[dom] || 0) + 1;
    });
    const devRows = Object.entries(agg).sort((x, y) => y[1].count - x[1].count).slice(0, 30).map(([ip, a]) => {
      const label = names[ip] ? `${_aghEsc(names[ip])} <span style="color:#aaa;">${_aghEsc(ip)}</span>` : _aghEsc(ip);
      const top = Object.entries(a.domains).sort((m, n) => n[1] - m[1]).slice(0, 4).map(d => _aghEsc(d[0])).join(', ');
      return `<tr><td>${label}</td><td>${a.count}</td><td style="color:${a.blocked ? '#b55e5e' : '#888'};">${a.blocked}</td><td style="font-size:0.8rem; color:#666;">${top}</td></tr>`;
    });
    document.getElementById('agh-devices').innerHTML = devRows.length ? devRows.join('') :
      '<tr><td colspan="4" style="color:#aaa;">No queries yet — point a device’s DNS at 192.168.1.217 to populate this.</td></tr>';

    // Top domains
    const domRows = (arr) => ((arr || []).slice(0, 12).map(o => {
      const [d, c] = Object.entries(o)[0] || ['', 0];
      return `<tr><td style="font-size:0.82rem;">${_aghEsc(d)}</td><td>${c}</td></tr>`;
    }).join('') || '<tr><td colspan="2" style="color:#aaa;">—</td></tr>');
    document.getElementById('agh-top-blocked').innerHTML = domRows(stats.top_blocked_domains);
    document.getElementById('agh-top-queried').innerHTML = domRows(stats.top_queried_domains);

    // Recent lookups
    const logRows = (qlog.data || []).slice(0, 40).map(e => {
      const t = e.time ? new Date(e.time).toLocaleTimeString('en-GB', { hour12: false }) : '';
      const cip = e.client || '';
      const cname = names[cip] || cip;
      const dom = e.question?.name || '';
      const blocked = /^Filtered/.test(e.reason || '');
      const res = blocked ? '<span style="color:#b55e5e;">blocked</span>' : '<span style="color:#5a8f3a;">allowed</span>';
      return `<tr><td style="color:#888; font-size:0.78rem;">${t}</td><td style="font-size:0.8rem;">${_aghEsc(cname)}</td><td style="font-size:0.8rem;">${_aghEsc(dom)}</td><td>${res}</td></tr>`;
    }).join('');
    document.getElementById('agh-log').innerHTML = logRows || '<tr><td colspan="4" style="color:#aaa;">No lookups yet.</td></tr>';

  } catch (e) {
    if (health) health.innerHTML = `<span style="color:#b55e5e;">⚠ AdGuard unavailable — ${_aghEsc(e.message)} (is RP01 up?)</span>`;
    const ov = document.getElementById('agh-overview'); if (ov) ov.innerHTML = '<span style="color:#aaa;">unavailable</span>';
    [['agh-devices',4],['agh-top-blocked',2],['agh-top-queried',2],['agh-log',4]].forEach(([id, cols]) => {
      const el = document.getElementById(id); if (el) el.innerHTML = `<tr><td colspan="${cols}" style="color:#aaa;">unavailable</td></tr>`;
    });
  }
}

// "Check Devices" — opens a popup with a health checklist fed by the server-side
// /api/adguard/impact report (per-device blocked-log analysis + a live
// check_host of every device-control cloud). All logic on the server; the popup
// just renders each checked parameter as a green/red row.
function aghCloseImpact() {
  const m = document.getElementById('agh-impact-modal');
  if (m) m.style.display = 'none';
}
window.aghCloseImpact = aghCloseImpact;

function _aghRow(icon, label, value, color) {
  return `<div style="display:flex; align-items:center; gap:10px; padding:9px 2px; border-bottom:1px solid #eee;">`
    + `<span style="font-size:1.1rem; width:22px; text-align:center;">${icon}</span>`
    + `<span style="flex:1; color:#333;">${label}</span>`
    + `<b style="color:${color || '#444'}; white-space:nowrap;">${value}</b></div>`;
}

async function adguardCheckDevices(btn) {
  const modal = document.getElementById('agh-impact-modal');
  const body  = document.getElementById('agh-impact-body');
  if (modal) modal.style.display = 'flex';
  if (body)  body.innerHTML = '<div style="color:#888; padding:6px 0;">Checking devices + control clouds…</div>';
  if (btn) btn.disabled = true;
  try {
    const d = await fetch('/api/adguard/impact').then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)));
    const GREEN = '#5a8f3a', RED = '#c0392b', GREY = '#777';
    let rows = '';

    // 1 — the headline the user asked for
    rows += _aghRow(d.devices_losing === 0 ? '✅' : '⛔', 'Devices losing communication',
      d.devices_losing, d.devices_losing === 0 ? GREEN : RED);
    if (d.devices_losing > 0) rows += `<div style="font-size:0.8rem; color:${RED}; padding:0 0 8px 34px;">`
      + (d.devices_losing_list || []).map(x => `<div><b>${_aghEsc(x.device)}</b>: ${(x.domains || []).map(_aghEsc).join(', ')}</div>`).join('')
      + `<div style="color:#999; margin-top:2px;">These are custom rules you added — whitelist in AdGuard → Filters if one is a device’s cloud.</div></div>`;

    // 2 — device control clouds reachable (live check_host)
    const cloudsOk = d.control_blocked === 0;
    rows += _aghRow(cloudsOk ? '✅' : '⛔', 'Device control clouds reachable',
      `${d.control_tested - d.control_blocked}/${d.control_tested}`, cloudsOk ? GREEN : RED);
    if (!cloudsOk) rows += `<div style="font-size:0.8rem; color:${RED}; padding:0 0 8px 34px;">Blocked: ${(d.control_blocked_list || []).map(_aghEsc).join(', ')}</div>`;

    // 3 — protection on
    rows += _aghRow(d.protection ? '✅' : '⛔', 'AdGuard protection', d.protection ? 'ON' : 'OFF', d.protection ? GREEN : RED);

    // 4 — security saves (informative)
    rows += _aghRow('🛡️', 'Phishing / malware blocked', d.security_blocks, d.security_blocks ? '#b06a2a' : GREY);
    if (d.security_blocks > 0) rows += `<div style="font-size:0.8rem; color:#b06a2a; padding:0 0 8px 34px;">`
      + (d.security_list || []).map(s => `<div><b>${_aghEsc(s.device)}</b> → ${_aghEsc(s.domain)}</div>`).join('') + `</div>`;

    // 5-6 — context
    rows += _aghRow('📡', 'Devices monitored', d.monitored, GREY);
    rows += _aghRow('🚫', 'Blocked (24 h)', `${(d.blocked_24h || 0).toLocaleString()} (${d.block_pct}%)`, GREY);

    const allGood = d.devices_losing === 0 && cloudsOk && d.protection;
    const banner = allGood
      ? `<div style="background:#eaf5e1; color:${GREEN}; border:1px solid #cfe6bd; border-radius:6px; padding:9px 11px; margin-bottom:10px; font-weight:600;">✅ All good — no device loses communication.</div>`
      : `<div style="background:#fdecea; color:${RED}; border:1px solid #f5c6c0; border-radius:6px; padding:9px 11px; margin-bottom:10px; font-weight:600;">⚠ Review the flagged item(s) below.</div>`;
    body.innerHTML = banner + rows
      + `<div style="text-align:right; margin-top:14px;"><button class="tab-btn" onclick="aghCloseImpact()" style="cursor:pointer;">OK</button></div>`;
  } catch (e) {
    if (body) body.innerHTML = `<div style="color:#c0392b;">Check failed: ${_aghEsc(e.message)} — is RP01 up?</div>`
      + `<div style="text-align:right; margin-top:12px;"><button class="tab-btn" onclick="aghCloseImpact()" style="cursor:pointer;">Close</button></div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}
window.adguardCheckDevices = adguardCheckDevices;
