// Kazir 15 Network — read-only monitor page.
//
// Reads /api/kazir15/status (board eth/host summary, from esp_boards.last_status)
// + /api/kazir15/hosts (the discovered host list from kazir15_hosts, filled by
// the LXC-104 kazir15-ingest daemon). Scan Now fires the board's `scan_now`
// action via the standard esp command endpoint. KZ15 data is fully separate
// from the home network inventory.

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(t) {
  if (!t) return '—';
  try { return new Date(t).toLocaleString('en-GB', { hour12: false }); } catch (e) { return '—'; }
}

async function kzLoad() {
  if (window._kzEditing) return;   // don't clobber a name being typed mid-refresh
  document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString();
  try {
    const [st, hosts, cats] = await Promise.all([
      fetch('/api/kazir15/status').then(r => r.json()),
      fetch('/api/kazir15/hosts').then(r => r.json()),
      fetch('/api/kazir15/summary').then(r => r.json()),
    ]);
    renderSummary(st || {}, cats || {});
    renderHosts(Array.isArray(hosts) ? hosts : []);
  } catch (e) {
    document.getElementById('kz-summary').innerHTML =
      '<span style="color:#c0392b;">Failed to load: ' + escHtml(e.message) + '</span>';
  }
}

function renderSummary(st, cats) {
  const s = st.last_status || {};
  const c = cats || {};
  const oo = (o) => { o = o || {}; return `<span style="color:#16a34a;">${o.on || 0} on</span> <span style="color:#bbb;">· ${o.off || 0} off</span>`; };
  const online = st.last_seen && (Date.now() - new Date(st.last_seen).getTime()) < 180000;
  const link = s.eth_link || 'down';
  const linkUp = link === 'up';
  const scanning = !!s.scanning;
  const item = (label, val, cls) =>
    `<div class="item"><label>${label}</label><div class="value ${cls || ''}">${val}</div></div>`;
  document.getElementById('kz-summary').innerHTML =
      item('Board', online ? '<span class="kz-pill up">online</span>' : '<span class="kz-pill down">offline</span>')
    + item('EK15 Link', `<span class="kz-pill ${linkUp ? 'up' : 'down'}">${escHtml(link)}</span>`)
    + item('EK15 IP', s.eth_ip ? escHtml(s.eth_ip) : '—', s.eth_ip ? '' : 'dim')
    + item('Gateway', s.eth_gw ? escHtml(s.eth_gw) : '—', s.eth_gw ? '' : 'dim')
    + item('Subnet', s.eth_subnet ? escHtml(s.eth_subnet) + '.0/24' : '—', s.eth_subnet ? '' : 'dim')
    + item('Cameras', oo(c.cameras))
    + item('Access Points', oo(c.aps))
    + item('Deco', oo(c.deco))
    + item('Scan', scanning
        ? `<span class="kz-pill scan">scanning ${s.scan_progress || 0}%</span>`
        : '<span style="color:#888;">idle</span>')
    + item('Firmware', st.sketch_version ? escHtml(st.sketch_version) : '—', st.sketch_version ? '' : 'dim');
}

// A device counts as CONNECTED if it answered within this window — even if it
// missed the most recent sweep. Power-save devices (the KZ15 Deco APs) don't
// answer every single sweep; this is the same 15-min "online grace" the home
// ARP scanner uses, so the list doesn't flicker.
const GRACE_MS = 15 * 60 * 1000;
const ipNum = ip => ip.split('.').reduce((a, o) => a * 256 + (+o), 0);

// Server returns every named device (online + offline) + unnamed-connected, with
// an `online` flag. Online = green "connected"; offline = red "disconnected"
// (same red as Project Network). "Show offline only" filters to the down ones.
function renderHosts(hosts) {
  const offlineOnly = document.getElementById('kz-offline-only') && document.getElementById('kz-offline-only').checked;
  const onCount  = hosts.filter(h => h.online).length;
  const offCount = hosts.length - onCount;
  const rows = offlineOnly ? hosts.filter(h => !h.online) : hosts;
  const tb = document.getElementById('kz-hosts');
  document.getElementById('kz-count').textContent = `(${onCount} connected · ${offCount} disconnected)`;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="5" class="kz-empty">' +
      (offlineOnly ? 'No disconnected devices.' : 'No devices — plug the board into KZ15, or hit Scan Now.') +
      '</td></tr>';
    return;
  }
  tb.innerHTML = rows.map(h => {
    const on = !!h.online;
    return `
    <tr${on ? '' : ' style="background:#fdf3f2;"'}>
      <td>${on
        ? '<span class="kz-dot up"></span>connected'
        : '<span class="kz-dot down"></span><span style="color:#c0392b; font-weight:600;">disconnected</span>'}</td>
      <td class="mono">${h.ip ? escHtml(h.ip) : '<span style="color:#bbb;">—</span>'}</td>
      <td class="mono">${h.mac ? escHtml(h.mac) : '<span style="color:#bbb;">—</span>'}</td>
      <td>${h.mac
        ? `<input class="kz-name" data-mac="${escHtml(h.mac)}" value="${escHtml(h.name || '')}" placeholder="name…" onfocus="window._kzEditing=true" onblur="kzSaveName(this)" onkeydown="if(event.key==='Enter'){this.blur();}">`
        : '<span style="color:#bbb;">—</span>'}</td>
      <td>${fmtTime(h.last_seen)}</td>
    </tr>`;
  }).join('');
}

// Save (or clear, if blank) a device name — keyed by MAC so it survives IP
// changes + pruning. Fires on blur / Enter. _kzEditing gates the auto-refresh
// so it can't wipe the field mid-type.
async function kzSaveName(inp) {
  window._kzEditing = false;
  try {
    await fetch('/api/kazir15/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: inp.dataset.mac, name: inp.value.trim() }),
    });
  } catch (e) { /* ignore — next refresh reflects DB truth */ }
  kzLoad();
}

async function kzScanNow() {
  try {
    const r = await fetch('/api/esp/boards/kazir_15/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'scan_now' }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    setTimeout(kzLoad, 1500);   // give the board a moment, then refresh
  } catch (e) {
    alert('Scan Now failed: ' + e.message);
  }
}

kzLoad();
setInterval(kzLoad, 8000);
