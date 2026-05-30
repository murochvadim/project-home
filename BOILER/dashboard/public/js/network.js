let allDevices = [];
let allPorts   = [];
let netChart   = null;
let timerInterval = null;
let arpNextMs  = null;
let snmpNextMs = null;

function showTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'graph') loadNetGraph();
}

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

function fmtMmSs(ms) {
  if (ms === null || ms === undefined) return '—:——';
  const sec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Summary / gauges ──────────────────────────────────────────
async function loadSummary() {
  try {
    const s = await fetch('/api/network/summary').then(r => r.json());
    document.getElementById('gauge-online').textContent  = s.total_online ?? '—';
    document.getElementById('gauge-offline').textContent = s.total_offline ?? '—';
    document.getElementById('gauge-ever').textContent    = s.total_ever_seen ?? '—';
    if (s.last_scan) {
      document.getElementById('gauge-last-scan').textContent = fmtTs(s.last_scan);
      const ageMin = Math.round((Date.now() - new Date(s.last_scan)) / 60000);
      document.getElementById('gauge-scan-age').textContent  = `${ageMin} min ago`;
    }
  } catch (e) { console.error('loadSummary error:', e); }
}

// ── Timers countdown ──────────────────────────────────────────
async function loadTimers() {
  try {
    const t = await fetch('/api/network/timers').then(r => r.json());
    arpNextMs  = t.arp?.next  ? t.arp.next  - Date.now() : null;
    snmpNextMs = t.snmp?.next ? t.snmp.next - Date.now() : null;
  } catch (e) { /* timers unavailable */ }
}

function tickTimers() {
  if (arpNextMs  !== null) arpNextMs  -= 1000;
  if (snmpNextMs !== null) snmpNextMs -= 1000;
  document.getElementById('timer-arp').textContent  = fmtMmSs(arpNextMs);
  document.getElementById('timer-snmp').textContent = fmtMmSs(snmpNextMs);
  // When a timer hits 0 reload its next time after a short delay
  if (arpNextMs !== null && arpNextMs <= 0)  { arpNextMs  = null; setTimeout(loadTimers, 4000); }
  if (snmpNextMs !== null && snmpNextMs <= 0) { snmpNextMs = null; setTimeout(loadTimers, 4000); }
}

// ── Devices ───────────────────────────────────────────────────
async function loadDevices() {
  try {
    const raw = await fetch('/api/network/devices').then(r => r.json());
    // Sort by IP numerically
    allDevices = raw.sort((a, b) => {
      const toNum = ip => ip ? ip.split('.').reduce((acc, o) => acc * 256 + parseInt(o), 0) : 0;
      return toNum(a.ip) - toNum(b.ip);
    });
    renderDevices(allDevices);
  } catch (e) { console.error('loadDevices error:', e); }
}

function isOnline(d) {
  if (!d.last_online) return false;
  return (Date.now() - new Date(d.last_online)) < 10 * 60 * 1000; // seen in last 10 min
}

// Manual ARP-scan trigger — fires the systemd one-shot on LXC 104, animates
// a progress bar for ~6 s (typical scan completes in ~5 s with --retry=4),
// then reloads the devices table. Button is disabled during the run to
// prevent overlapping invocations (systemd queues them but the UX is
// confusing if the bar resets mid-animation).
async function triggerManualScan() {
  const btn  = document.getElementById('manual-scan-btn');
  const wrap = document.getElementById('manual-scan-progress');
  const bar  = document.getElementById('manual-scan-bar');
  if (!btn || !wrap || !bar) return;
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  wrap.style.visibility = 'visible';
  bar.style.width = '0%';
  // Animate the bar over 6 s (typical ARP scan ~5 s + watchdog ~40 ms,
  // measured). Real completion triggers the reload regardless of where
  // the bar is.
  const startTs = Date.now();
  const ESTIMATED_MS = 6000;
  const tick = setInterval(() => {
    const pct = Math.min(98, ((Date.now() - startTs) / ESTIMATED_MS) * 100);
    bar.style.width = pct.toFixed(1) + '%';
  }, 100);
  try {
    const r = await fetch('/api/network/scan', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.statusText);
  } catch (e) {
    bar.style.background = '#c0392b';
    btn.textContent = `Failed: ${e.message}`.slice(0, 32);
  } finally {
    clearInterval(tick);
    bar.style.width = '100%';
    // Reload summary + devices + ALERTS — the watchdog just ran, so any
    // resolved/new IP-collision / cloud-only / stale-local alerts should
    // appear immediately.
    try { await loadSummary(); }   catch (_) {}
    try { await loadDevices(); }   catch (_) {}
    try { await loadNetAlerts(); } catch (_) {}
    // Reset UI after a brief moment so the user sees the bar fill.
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '↻ Scan now';
      wrap.style.visibility = 'hidden';
      bar.style.background = '#7a9ab8';
      bar.style.width = '0%';
    }, 600);
  }
}

// Classify why a device is red. Based on the verified probe results of
// 2026-05-30 — most "offline" devices fall into 5 categories and a LAN
// scan can't fix any of them. The tooltip explains the most likely
// cause so the user stops re-clicking Scan trying to revive a device
// that's powered off / cloud-only / sleeping.
//
// Inputs:
//   d.last_online          — string ISO timestamp
//   d.d_protocol           — null for transient MACs, else: local/cloud/esp/zigbee/zwave/ring/ha_api/awtrix/pixoo/hasp/alexa/vacuum/virtual/mqtt
//   d.d_device_type        — e.g. 'remote' (IR hub), 'tv', 'media_player'
//   d.d_last_source        — what channel the device-agent is using now
//   d.vendor               — OUI vendor string from arp-scan
function _classifyOfflineReason(d) {
  const ageMs = Date.now() - new Date(d.last_online || 0).getTime();
  const ageMin = Math.round(ageMs / 60000);
  const ageDays = ageMs / 86400000;
  // Category 5 — dead net_devices row (very old)
  if (ageDays > 30) {
    return `Dead row — last responded ${Math.round(ageDays)} days ago. IP likely reassigned, MAC may be randomized (phone/guest), or device gone. Safe to ignore.`;
  }
  if (ageDays > 7) {
    return `Not seen in ${Math.round(ageDays)} days — device is genuinely offline (powered off, moved, or unplugged).`;
  }
  // Category 2 — Tuya IR remote: cloud-only by design
  if (d.d_protocol === 'cloud' && d.d_device_type === 'remote') {
    return `Tuya IR hub (cloud-only by design) — never responds to LAN probes. Liveness comes from cloud heartbeat; check Devices page for last_seen.`;
  }
  // Category 4 — Tuya local on ha_api fallback for a long time = Mode B/C alert territory
  if (d.d_protocol === 'local' && d.d_last_source === 'ha_api' && ageMin > 60) {
    return `Local TCP channel broken — device-agent fell back to cloud (ha_api). Check Project Health → System Alerts for Mode B/C details. May need device power-cycle.`;
  }
  // Category 3 — known sparse-responders (WiFi power-save / Ring / Aqara FP2 etc.)
  const vendor = (d.vendor || '').toLowerCase();
  if (vendor.startsWith('ring')) {
    return `Ring devices use WiFi power-saving — they ignore broadcast ARP/ICMP between cloud events. LAN scan can't reliably detect them; check Ring app for true status.`;
  }
  if (vendor.includes('lumi united')) {
    return `Aqara devices often suppress broadcast LAN traffic to save power. Liveness comes via HA WebSocket; check Devices page.`;
  }
  if (vendor.includes('samsung electronics') && (d.name || '').match(/tv/i)) {
    return `Samsung TV — when powered off the WiFi sleeps. Will respond again once the TV is turned on.`;
  }
  if (vendor.includes('locally administered') || vendor === '') {
    return `Randomized / locally-administered MAC — usually a phone or guest device. Disappears when the device leaves the LAN or rotates its privacy MAC.`;
  }
  // Category 1 — recent flake
  if (ageMin <= 15) {
    return `Just missed the last scan (${ageMin} min ago) — usually recovers on the next sweep. Click Scan now to retry.`;
  }
  // Generic fallback
  return `Not seen in ${ageMin} min — likely powered off, in WiFi power-save, or has moved IP. LAN scanning cannot wake a sleeping device.`;
}

function renderDevices(list) {
  const tbody = document.getElementById('devices-body');
  document.getElementById('device-count').textContent = `${list.length} devices`;
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="7" style="color:#aaa; text-align:center;">No devices found</td></tr>'; return; }
  tbody.innerHTML = list.map(d => {
    const online      = isOnline(d);
    const dotTip      = online ? 'Responded to ARP within the last 10 min' : _classifyOfflineReason(d);
    const dotTipAttr  = dotTip.replace(/"/g, '&quot;');
    const dot         = `<span style="color:${online ? '#2ecc71' : '#e74c3c'}; cursor:help;" title="${dotTipAttr}">⬤</span>`;
    const nameCell = `<span style="font-size:0.78rem; color:#aaa; cursor:pointer;" onclick="editDeviceName('${d.mac}', this)" title="Click to edit">${d.name || '— add name —'}</span>`;
    return `<tr>
      <td style="text-align:center;">${dot}</td>
      <td style="font-family:monospace; font-size:0.82rem;">${d.ip || '—'}</td>
      <td style="font-family:monospace; font-size:0.82rem;">${d.mac}</td>
      <td style="font-size:0.78rem; color:#666;">${d.vendor || '—'}</td>
      <td>${nameCell}</td>
      <td style="font-size:0.78rem;">${fmtTs(d.last_online)}</td>
      <td style="font-size:0.78rem; color:#aaa;">${fmtTs(d.first_seen)}</td>
    </tr>`;
  }).join('');
}

function filterDevices() {
  const q       = document.getElementById('device-search').value.toLowerCase();
  const offline = document.getElementById('show-offline').checked;
  const filtered = allDevices.filter(d => {
    if (offline && isOnline(d)) return false;
    if (!q) return true;
    return (d.ip || '').includes(q) || d.mac.includes(q) ||
           (d.name || '').toLowerCase().includes(q) ||
           (d.vendor || '').toLowerCase().includes(q);
  });
  renderDevices(filtered);
}

async function editDeviceName(mac, el) {
  const current = el.textContent === '— add name —' ? '' : el.textContent;
  const name = prompt('Device name for ' + mac + ':', current);
  if (name === null) return;
  try {
    await fetch(`/api/network/devices/${encodeURIComponent(mac)}/name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    el.textContent = name || '— add name —';
    const d = allDevices.find(x => x.mac === mac);
    if (d) d.name = name || null;
  } catch (e) { alert('Save failed: ' + e.message); }
}

// ── Ports ─────────────────────────────────────────────────────
// localStorage key for the "Show UP only" checkbox state.
// Default is ON (true) — most users only care about live ports. The setting
// persists across page navigations so the user doesn't have to re-check it
// every time they come back to Project Network.
const PORTS_SHOW_UP_KEY = 'network.showUpOnly';
function _restoreShowUpOnly() {
  const cb = document.getElementById('show-up-only');
  if (!cb) return true;
  const raw = localStorage.getItem(PORTS_SHOW_UP_KEY);
  // First-ever load: keep the HTML default (`checked`) → true.
  // Otherwise honor the stored choice.
  const checked = raw === null ? true : raw === '1';
  cb.checked = checked;
  return checked;
}

async function loadPorts() {
  try {
    const rawPorts = await fetch('/api/network/ports').then(r => r.json());
    // Keep only physical ports 1/1 – 1/28
    allPorts = rawPorts.filter(p => /^1\/([1-9]|1\d|2[0-8])$/.test(p.if_name));
    // Apply the persisted "Show UP only" checkbox state on initial render so
    // the table never flashes the full list before the filter kicks in.
    const upOnly = _restoreShowUpOnly();
    renderPorts(upOnly ? allPorts.filter(p => p.status === 'up') : allPorts);
  } catch (e) { console.error('loadPorts error:', e); }
}

function renderPorts(list) {
  const tbody = document.getElementById('ports-body');
  const up    = list.filter(p => p.status === 'up').length;
  document.getElementById('port-count').textContent = `${up} up / ${list.length - up} down`;
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="4" style="color:#aaa; text-align:center;">No port data</td></tr>'; return; }
  tbody.innerHTML = list.map(p => {
    const dot      = p.status === 'up'
      ? '<span style="color:#2ecc71;">⬤</span> up'
      : '<span style="color:#e74c3c;">⬤</span> down';
    const nameCell = `<span style="font-size:0.78rem; color:#aaa; cursor:pointer;" onclick="editPortName(${p.port_index}, this)" title="Click to edit">${p.port_name || '— add name —'}</span>`;
    return `<tr>
      <td style="font-family:monospace; font-size:0.82rem;">${p.if_name || p.port_index}</td>
      <td>${dot}</td>
      <td>${nameCell}</td>
      <td style="font-size:0.78rem; color:#aaa;">${fmtTs(p.last_changed)}</td>
    </tr>`;
  }).join('');
}

function filterPorts() {
  const upOnly = document.getElementById('show-up-only').checked;
  // Persist for next page load / cross-tab consistency.
  try { localStorage.setItem(PORTS_SHOW_UP_KEY, upOnly ? '1' : '0'); } catch (_) {}
  renderPorts(upOnly ? allPorts.filter(p => p.status === 'up') : allPorts);
}

async function editPortName(idx, el) {
  const current = el.textContent === '— add name —' ? '' : el.textContent;
  const name = prompt('Port name for port ' + idx + ':', current);
  if (name === null) return;
  try {
    await fetch(`/api/network/ports/${idx}/name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    el.textContent = name || '— add name —';
    const p = allPorts.find(x => x.port_index === idx);
    if (p) p.port_name = name || null;
  } catch (e) { alert('Save failed: ' + e.message); }
}

// ── Graph ─────────────────────────────────────────────────────
async function loadNetGraph() {
  const limit = document.getElementById('graph-limit').value;
  try {
    const rows = await fetch(`/api/network/history?limit=${limit}`).then(r => r.json());
    const labels  = rows.map(r => new Date(r.ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' }));
    const online  = rows.map(r => r.total_online);
    const offline = rows.map(r => r.total_offline);
    const ever    = rows.map(r => r.total_ever_seen);

    if (netChart) netChart.destroy();
    netChart = new Chart(document.getElementById('netChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Online',    data: online,  borderColor: '#2ecc71', backgroundColor: 'rgba(46,204,113,0.1)', fill: true, tension: 0.3, pointRadius: 1 },
          { label: 'Offline',   data: offline, borderColor: '#e74c3c', backgroundColor: 'rgba(231,76,60,0.08)',  fill: true, tension: 0.3, pointRadius: 1 },
          { label: 'Ever Seen', data: ever,    borderColor: '#7a9ab8', backgroundColor: 'transparent',           tension: 0.3, pointRadius: 1 },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 12, font: { size: 11 } } },
          y: { title: { display: true, text: 'Devices', font: { size: 11 } }, ticks: { font: { size: 11 } } },
        },
        plugins: { legend: { labels: { font: { size: 12 } } } },
      },
    });
  } catch (e) { console.error('loadNetGraph error:', e); }
}

// ── Full refresh ──────────────────────────────────────────────
// ── Network-scoped System Alerts card (mirror of Health page, filtered to network:%) ──
let netShowResolvedAlerts = false;
const NET_ALERTS_TBODY_CACHE = '_net_alerts_tbody';
const NET_ALERTS_COLLAPSED   = '_net_alerts_collapsed';

// Show / hide the alerts body. State persists across page loads via localStorage.
function netToggleAlertsCard() {
  const wrap = document.getElementById('net-alerts-body-wrap');
  const btn  = document.getElementById('net-alerts-toggle');
  if (!wrap || !btn) return;
  const isHidden = wrap.style.display === 'none';
  wrap.style.display = isHidden ? '' : 'none';
  btn.textContent    = isHidden ? '▾ Hide' : '▸ Show';
  try { localStorage.setItem(NET_ALERTS_COLLAPSED, isHidden ? '0' : '1'); } catch (e) {}
}

// Restore collapsed state on first render.
(function _restoreNetAlertsCollapsed() {
  try {
    if (localStorage.getItem(NET_ALERTS_COLLAPSED) === '1') {
      const wrap = document.getElementById('net-alerts-body-wrap');
      const btn  = document.getElementById('net-alerts-toggle');
      if (wrap) wrap.style.display = 'none';
      if (btn)  btn.textContent    = '▸ Show';
    }
  } catch (e) {}
})();
function escNet(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function netFmtTs(t) {
  if (!t) return '';
  try { return new Date(t).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }); }
  catch (e) { return String(t); }
}
try {
  const c = localStorage.getItem(NET_ALERTS_TBODY_CACHE);
  if (c) document.getElementById('net-alerts-body').innerHTML = c;
} catch (e) {}

async function loadNetAlerts() {
  const tbody  = document.getElementById('net-alerts-body');
  const badge  = document.getElementById('net-alerts-badge');
  const histBtn  = document.getElementById('net-alerts-history-btn');
  const clearBtn = document.getElementById('net-alerts-clear-btn');
  if (!tbody) return;
  try {
    const qs   = new URLSearchParams({ type_prefix: 'network:' });
    if (netShowResolvedAlerts) qs.set('include_resolved', 'true');
    const data = await fetch('/api/health/alerts?' + qs.toString()).then(r => r.json());
    const rows = data.rows || [];
    const resolvedCount = parseInt(data.resolved_count) || 0;
    const active = rows.filter(r => !r.resolved_local);

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

    if (resolvedCount > 0) {
      histBtn.textContent = netShowResolvedAlerts ? 'Hide resolved' : `Show resolved (${resolvedCount})`;
      histBtn.style.display = 'inline-block';
      clearBtn.style.display = 'inline-block';
    } else {
      histBtn.style.display = 'none';
      clearBtn.style.display = 'none';
    }

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:#aaa; text-align:center; padding:16px;">No active alerts</td></tr>';
      return;
    }

    const sevColor = { critical: '#7a2020', error: '#b55e5e', warn: '#b8860b', info: '#5a8a5a' };
    const sevBg    = { critical: '#fff0f0', error: '#fff5f5', warn: '#fffbf0' };
    tbody.innerHTML = rows.map(r => {
      const color = sevColor[r.severity] || '#555';
      const bg    = r.resolved_local ? 'transparent' : (sevBg[r.severity] || 'transparent');
      const opac  = r.resolved_local ? 'opacity:0.5;' : '';
      return `<tr style="background:${bg}; ${opac}">
        <td style="font-size:0.75rem; color:#888; white-space:nowrap;">${netFmtTs(r.ts_local)}</td>
        <td style="text-align:center;">
          <span style="color:${r.resolved_local ? '#5a8a5a' : color}; font-size:0.75rem; font-weight:600;">${r.resolved_local ? '✓' : (r.severity||'').toUpperCase()}</span>
        </td>
        <td style="font-size:0.78rem;">${r.affected_agent ? escNet(r.affected_agent) : '<span style="color:#aaa;">all</span>'}</td>
        <td style="font-size:0.75rem; color:#888;">${escNet(r.alert_type)}</td>
        <td style="font-size:0.8rem; color:${r.resolved_local ? '#888' : color};">${escNet(r.message)}</td>
        <td style="font-size:0.75rem; color:#5a8a5a;">${r.resolved_local ? netFmtTs(r.resolved_local) : ''}</td>
      </tr>`;
    }).join('');
    try { localStorage.setItem(NET_ALERTS_TBODY_CACHE, tbody.innerHTML); } catch (e) {}
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:#b55e5e;">Failed to load</td></tr>';
  }
}

function netToggleResolvedAlerts() {
  netShowResolvedAlerts = !netShowResolvedAlerts;
  loadNetAlerts();
}
async function netClearResolvedAlerts() {
  if (!confirm('Delete all resolved alerts? This cannot be undone.')) return;
  try {
    await fetch('/api/health/alerts/resolved', { method: 'DELETE' });
    netShowResolvedAlerts = false;
    loadNetAlerts();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function refreshAll() {
  await Promise.all([loadSummary(), loadDevices(), loadPorts(), loadTimers(), loadNetAlerts()]);
  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

// Init
refreshAll();
clearInterval(timerInterval);
timerInterval = setInterval(tickTimers, 1000);
// Refresh timers every 5 min to stay accurate
setInterval(loadTimers, 5 * 60 * 1000);
// Network alerts refresh — independent 60 s cadence, matches Health page.
setInterval(loadNetAlerts, 60 * 1000);
