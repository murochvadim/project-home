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

function renderDevices(list) {
  const tbody = document.getElementById('devices-body');
  document.getElementById('device-count').textContent = `${list.length} devices`;
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="7" style="color:#aaa; text-align:center;">No devices found</td></tr>'; return; }
  tbody.innerHTML = list.map(d => {
    const online   = isOnline(d);
    const dot      = online ? '<span style="color:#2ecc71;">⬤</span>' : '<span style="color:#e74c3c;">⬤</span>';
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
async function loadPorts() {
  try {
    const rawPorts = await fetch('/api/network/ports').then(r => r.json());
    // Keep only physical ports 1/1 – 1/28
    allPorts = rawPorts.filter(p => /^1\/([1-9]|1\d|2[0-8])$/.test(p.if_name));
    renderPorts(allPorts);
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
async function refreshAll() {
  await Promise.all([loadSummary(), loadDevices(), loadPorts(), loadTimers()]);
  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

// Init
refreshAll();
clearInterval(timerInterval);
timerInterval = setInterval(tickTimers, 1000);
// Refresh timers every 5 min to stay accurate
setInterval(loadTimers, 5 * 60 * 1000);
