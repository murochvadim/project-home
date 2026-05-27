// Project Power — P1 dashboard logic.
// Polls /api/power/status every 5 s and renders Card 1 (3-phase live status
// for Shelly 3EM). No attribution, no history — those land in P2-P7.

const POLL_INTERVAL_MS = 5000;
let pollTimer = null;

function colorForVoltage(v) {
  if (v == null) return '#888';
  if (v < 215 || v > 245) return '#c0392b';   // red — out of nominal
  if (v < 220 || v > 240) return '#e67e22';   // amber — fringe
  return '#27ae60';                            // green — nominal
}
function colorForPower(w) {
  if (w == null) return '#888';
  if (w > 3000) return '#c0392b';              // red — heavy
  if (w > 1000) return '#e67e22';              // amber — moderate
  return '#27ae60';                            // green — light
}
function colorForPF(pf) {
  if (pf == null) return '#888';
  if (pf < 0.8) return '#c0392b';              // red — poor PF
  if (pf < 0.9) return '#e67e22';              // amber — fair PF
  return '#27ae60';                            // green — good PF
}
function colorForImbalance(pct) {
  if (pct == null) return '#888';
  if (pct > 60) return '#c0392b';
  if (pct > 30) return '#e67e22';
  return '#27ae60';
}

function fmt(v, digits = 0) {
  if (v == null) return '—';
  return Number(v).toFixed(digits);
}

function renderPhaseCol(label, p, va) {
  const v_color = colorForVoltage(p.v);
  const w_color = colorForPower(p.w);
  const pf_color = colorForPF(p.pf);
  return `
    <div style="border:1px solid #e6e1da; border-radius:6px; padding:14px;">
      <div style="font-size:0.86rem; font-weight:700; color:#1a1a1a; margin-bottom:10px;">${label}</div>
      <div style="font-size:0.72rem; color:#888; margin-top:6px;">Voltage</div>
      <div style="font-size:1.3rem; font-weight:600; color:${v_color};">${fmt(p.v, 1)} <span style="font-size:0.78rem; color:#888;">V</span></div>
      <div style="font-size:0.72rem; color:#888; margin-top:8px;">Current</div>
      <div style="font-size:1.3rem; font-weight:600;">${fmt(p.a, 2)} <span style="font-size:0.78rem; color:#888;">A</span></div>
      <div style="font-size:0.72rem; color:#888; margin-top:8px;">Power</div>
      <div style="font-size:1.3rem; font-weight:600; color:${w_color};">${fmt(p.w, 0)} <span style="font-size:0.78rem; color:#888;">W</span></div>
      <div style="font-size:0.72rem; color:#888; margin-top:8px;">Power factor</div>
      <div style="font-size:1.3rem; font-weight:600; color:${pf_color};">${fmt(p.pf, 2)}</div>
      <div style="font-size:0.72rem; color:#888; margin-top:8px;">Energy (cumulative)</div>
      <div style="font-size:0.96rem; font-weight:600;">${fmt(p.kwh, 2)} <span style="font-size:0.72rem; color:#888;">kWh</span></div>
    </div>
  `;
}

// Render a value with the unit absolutely-positioned to the right so the
// numeric part stays naturally centered by the parent's text-align:center.
// Without this, "830 W" centers as a whole — the W shifts the visual
// center of the digits LEFT, and the label above appears offset to the
// right of the number. Hanging the unit absolute fixes that.
function lcdValueHTML(numStr, unit, fontSize, color) {
  const colorCss  = color ? `color:${color};text-shadow:0 0 10px currentColor;` : '';
  const unitHTML  = unit
    ? `<span style="position:absolute; left:100%; bottom:0.45rem; padding-left:6px; font-size:0.85rem; color:#3a8a52; font-weight:500; white-space:nowrap; text-shadow:none;">${unit}</span>`
    : '';
  return `
    <div style="position:relative; display:inline-block; line-height:1.05;">
      <span style="font-size:${fontSize}; font-weight:700; ${colorCss}">${numStr}</span>
      ${unitHTML}
    </div>
  `;
}

function renderTotalCol(d) {
  const total_pf_color = colorForPF(d.system_pf);
  // Per-phase totals not exposed by the endpoint as separate fields;
  // sum amps on the client (system-wide current = R + S + T amps).
  const amps = [d.r?.a, d.s?.a, d.t?.a].filter(x => typeof x === 'number');
  const total_a = amps.length === 3 ? amps.reduce((a, b) => a + b, 0) : null;

  // Map the W/B traffic-light colors to LCD-friendly equivalents.
  const lcdPowerColor = (() => {
    const c = colorForPower((d.total_w || 0) / 3);
    return c === '#27ae60' ? '#4afc7e' : c === '#e67e22' ? '#ffd560' : '#ff6e6e';
  })();
  const lcdPfColor = total_pf_color === '#27ae60' ? '#4afc7e'
                   : total_pf_color === '#e67e22' ? '#ffd560'
                   : '#ff6e6e';

  return `
    <div style="
      border:2px solid #2a2a2a;
      border-radius:10px;
      padding:6px;
      background:linear-gradient(180deg, #1a1a1a, #0d0d0d);
      box-shadow:inset 0 2px 6px rgba(0,0,0,0.6), 0 2px 4px rgba(0,0,0,0.3);
      text-align:center;
    ">
      <!-- Inner LCD screen -->
      <div style="
        background:#020a04;
        border:1px solid #0a1a0e;
        border-radius:6px;
        padding:18px 14px;
        font-family:'Roboto Mono','Consolas','Courier New',monospace;
        font-feature-settings:'tnum';
        color:#4afc7e;
        text-shadow:0 0 6px rgba(74,252,126,0.45);
      ">
        <div style="
          font-size:1.4rem;
          font-weight:700;
          letter-spacing:3px;
          margin-bottom:26px;
          color:#7eff9e;
          text-shadow:0 0 10px rgba(126,255,158,0.6);
        ">TOTAL</div>

        <!-- Row 1 — Total Power + Total Current (hero) -->
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:30px;">
          <div>
            <div style="font-size:0.7rem; color:#3a8a52; letter-spacing:1.5px; margin-bottom:4px;">TOTAL POWER</div>
            ${lcdValueHTML(fmt(d.total_w, 0), 'W', '2.4rem', lcdPowerColor)}
            <!-- Always-on baseline (sum of all power_devices.mean_w) — same hero
                 size as TOTAL POWER so the two readouts stack visually equal. -->
            <div style="margin-top:30px; font-size:0.7rem; color:#8a7a3a; letter-spacing:1.5px; margin-bottom:4px;">ALWAYS-ON</div>
            ${lcdValueHTML(fmt(d.always_on_w, 0), 'W', '2.4rem', '#ffd560')}
          </div>
          <div>
            <div style="font-size:0.7rem; color:#3a8a52; letter-spacing:1.5px; margin-bottom:4px;">TOTAL CURRENT</div>
            ${lcdValueHTML(fmt(total_a, 2), 'A', '2.4rem', '')}
          </div>
        </div>

        <!-- Row 2 — Frequency (alone, centered across full card width) -->
        <div style="margin-bottom:28px;">
          <div style="font-size:0.7rem; color:#3a8a52; letter-spacing:1.5px; margin-bottom:4px;">FREQ</div>
          ${lcdValueHTML(d.frequency_hz, 'Hz', '1.5rem', '')}
        </div>

        <!-- Row 3 — System PF + Total Energy -->
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:28px;">
          <div>
            <div style="font-size:0.7rem; color:#3a8a52; letter-spacing:1.5px; margin-bottom:4px;">SYS PF</div>
            ${lcdValueHTML(fmt(d.system_pf, 2), '', '1.5rem', lcdPfColor)}
          </div>
          <div>
            <div style="font-size:0.7rem; color:#3a8a52; letter-spacing:1.5px; margin-bottom:4px;">TOTAL ENERGY</div>
            ${lcdValueHTML(fmt(d.total_kwh, 2), 'kWh', '1.5rem', '')}
          </div>
        </div>

        <!-- Row 4 — Total Apparent (alone, centered across full card width) -->
        <div>
          <div style="font-size:0.7rem; color:#3a8a52; letter-spacing:1.5px; margin-bottom:4px;">TOTAL APPARENT</div>
          ${lcdValueHTML(fmt(d.total_va, 0), 'VA', '1.5rem', '')}
        </div>
      </div>
    </div>
  `;
}

function ageString(sec) {
  if (sec == null) return '—';
  if (sec < 2) return 'just now';
  if (sec < 60) return `${Math.round(sec)} s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} m ago`;
  return `${Math.round(sec / 3600)} h ago`;
}

async function loadPower() {
  try {
    const r = await fetch('/api/power/status');
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      document.getElementById('power-phases').innerHTML =
        `<div style="grid-column:span 4; color:#c0392b;">Error: ${err.error || r.statusText}</div>`;
      return;
    }
    const d = await r.json();

    document.getElementById('power-phases').innerHTML =
      renderPhaseCol('Phase R', d.r, d.r_va) +
      renderPhaseCol('Phase S', d.s, d.s_va) +
      renderPhaseCol('Phase T', d.t, d.t_va) +
      renderTotalCol(d);

    const imb = document.getElementById('imbalance-val');
    const imbTag = document.getElementById('imbalance-tag');
    if (d.imbalance_pct != null) {
      imb.textContent = `${d.imbalance_pct.toFixed(1)} %`;
      imb.style.color = colorForImbalance(d.imbalance_pct);
      imbTag.textContent =
        d.imbalance_pct > 60 ? '(high) ⚠' :
        d.imbalance_pct > 30 ? '(moderate)' :
        '(balanced) ✓';
      imbTag.style.color = colorForImbalance(d.imbalance_pct);
    } else {
      imb.textContent = '—';
      imbTag.textContent = '';
    }

    // Voltage quality summary (all 3 in nominal band? amber? red?)
    const vs = [d.r?.v, d.s?.v, d.t?.v].filter(x => typeof x === 'number');
    const vq = document.getElementById('voltage-quality');
    if (vs.length === 3) {
      const worst = Math.max(...vs.map(v => Math.abs(v - 230)));
      if (vs.some(v => v < 215 || v > 245)) {
        vq.textContent = 'OUT OF RANGE ⚠';
        vq.style.color = '#c0392b';
      } else if (worst > 10) {
        vq.textContent = 'fringe (within 215-245V)';
        vq.style.color = '#e67e22';
      } else {
        vq.textContent = 'all phases in nominal 220-240V band ✓';
        vq.style.color = '#27ae60';
      }
    } else {
      vq.textContent = '—';
    }

    document.getElementById('last-update-age').textContent = ageString(d.age_sec);
    document.getElementById('last-refresh').textContent = `Refreshed at ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    document.getElementById('power-phases').innerHTML =
      `<div style="grid-column:span 4; color:#c0392b;">Fetch error: ${e.message}</div>`;
  }
}

loadPower();
pollTimer = setInterval(loadPower, POLL_INTERVAL_MS);

// ─── Manual Device Registry (P2) ────────────────────────────────
// State: open form is either "create" or "edit:<device_id>". Empty = closed.
let mdFormMode = '';
let mdRoomsCache = null;
let mdRowsCache = [];   // last loaded /api/power/devices result; Edit/Delete look up by id here
                         // (avoids quoting names through onclick attributes — that was breaking
                         //  the Delete button when the JSON-stringified name contained "")
function mdEscHtml(s) {
  // Mirrors the dashboard's existing escHtml convention (devices.js / health.js / esp-boards.js).
  // Applied to free-form TEXT fields (row.name, row.room) before template-inserting into HTML.
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function mdLoadRooms() {
  if (mdRoomsCache) return mdRoomsCache;
  try {
    const r = await fetch('/api/rooms');
    if (!r.ok) return [];
    mdRoomsCache = await r.json();
    return mdRoomsCache;
  } catch { return []; }
}

async function mdPopulateRoomsDropdown(selected = '') {
  const sel = document.getElementById('md-room');
  if (!sel) return;
  const rooms = await mdLoadRooms();
  // /api/rooms returns rows shaped {room, device_count}, not {name}.
  // Required field — no "none" option.
  sel.innerHTML = '<option value="">— pick a room —</option>' +
    rooms.map(r => `<option value="${r.room}"${r.room === selected ? ' selected' : ''}>${r.room}</option>`).join('');
}

function mdShowFields() {
  const lt = document.querySelector('input[name="md-load-type"]:checked')?.value;
  document.getElementById('md-fields-always').style.display = (lt === 'always_on') ? '' : 'none';
  document.getElementById('md-fields-cyclic').style.display = (lt === 'cyclic') ? '' : 'none';
  mdUpdateCyclicPreview();
}

function mdUpdateCyclicPreview() {
  const peak = parseFloat(document.getElementById('md-peak-w').value) || 0;
  const duty = parseFloat(document.getElementById('md-duty-pct').value) || 0;
  document.getElementById('md-cyclic-preview').textContent = `${Math.round(peak * duty / 100)} W`;
}

function mdToggleForm() {
  if (mdFormMode) { mdCancel(); return; }
  mdOpenCreate();
}

function mdOpenCreate() {
  mdFormMode = 'create';
  document.getElementById('md-form').style.display = '';
  document.getElementById('md-form-mode-tag').textContent = '(creating new)';
  document.getElementById('md-add-btn').textContent = '× Close form';
  mdResetFormFields();
  mdPopulateRoomsDropdown();
  document.getElementById('md-name').focus();
}

function mdOpenEdit(deviceId) {
  const row = mdRowsCache.find(r => r.device_id === deviceId);
  if (!row) return;
  mdFormMode = `edit:${row.device_id}`;
  document.getElementById('md-form').style.display = '';
  document.getElementById('md-form-mode-tag').textContent = `(editing ${row.name})`;
  document.getElementById('md-add-btn').textContent = '× Close form';
  mdResetFormFields();
  document.getElementById('md-name').value = row.name;
  document.getElementById('md-phase').value = row.phase || '';
  const dcfg = row.dps_config || {};
  const lt = dcfg.load_type || 'always_on';
  const lr = document.querySelector(`input[name="md-load-type"][value="${lt}"]`);
  if (lr) lr.checked = true;
  if (dcfg.nominal_w != null) document.getElementById('md-nominal-w').value = dcfg.nominal_w;
  if (dcfg.peak_w != null)    document.getElementById('md-peak-w').value = dcfg.peak_w;
  if (dcfg.duty_cycle_pct != null) document.getElementById('md-duty-pct').value = dcfg.duty_cycle_pct;
  mdShowFields();
  mdPopulateRoomsDropdown(row.room || '');
}

function mdCancel() {
  mdFormMode = '';
  document.getElementById('md-form').style.display = 'none';
  document.getElementById('md-form-mode-tag').textContent = '';
  document.getElementById('md-add-btn').textContent = '+ Add Unmanaged Device';
  document.getElementById('md-form-msg').textContent = '';
}

function mdResetFormFields() {
  document.getElementById('md-name').value = '';
  document.getElementById('md-phase').value = '';
  document.getElementById('md-nominal-w').value = '';
  document.getElementById('md-peak-w').value = '';
  document.getElementById('md-duty-pct').value = '';
  document.querySelectorAll('input[name="md-load-type"]').forEach(r => r.checked = false);
  document.getElementById('md-fields-always').style.display = 'none';
  document.getElementById('md-fields-cyclic').style.display = 'none';
  document.getElementById('md-cyclic-preview').textContent = '— W';
  document.getElementById('md-form-msg').textContent = '';
}

async function mdSave() {
  const msg = document.getElementById('md-form-msg');
  msg.textContent = '';
  const name = document.getElementById('md-name').value.trim();
  const phase = document.getElementById('md-phase').value;
  const room  = document.getElementById('md-room').value;
  const load_type = document.querySelector('input[name="md-load-type"]:checked')?.value || '';

  if (!name)  { msg.textContent = 'Name is required'; return; }
  if (!phase) { msg.textContent = 'Phase is required'; return; }
  if (!room)  { msg.textContent = 'Room is required'; return; }
  if (!load_type) { msg.textContent = 'Load type is required'; return; }

  const body = { name, phase, load_type, room };
  if (load_type === 'always_on') {
    body.nominal_w = parseFloat(document.getElementById('md-nominal-w').value) || 0;
    if (body.nominal_w <= 0) { msg.textContent = 'Always-on wattage must be > 0'; return; }
  }
  if (load_type === 'cyclic') {
    body.peak_w        = parseFloat(document.getElementById('md-peak-w').value) || 0;
    body.duty_cycle_pct = parseFloat(document.getElementById('md-duty-pct').value) || 0;
    if (body.peak_w <= 0)        { msg.textContent = 'Peak wattage must be > 0'; return; }
    if (body.duty_cycle_pct <= 0 || body.duty_cycle_pct > 100)
      { msg.textContent = 'Duty cycle must be 1-100 %'; return; }
  }

  const url = mdFormMode === 'create'
    ? '/api/power/devices'
    : `/api/power/devices/${mdFormMode.slice(5)}`;
  const method = mdFormMode === 'create' ? 'POST' : 'PATCH';

  const btn = document.getElementById('md-save-btn');
  btn.disabled = true;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) { msg.textContent = `Error: ${data.error || r.statusText}`; return; }
    mdCancel();
    mdLoadDevices();
  } catch (e) {
    msg.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function mdDelete(deviceId) {
  const row = mdRowsCache.find(r => r.device_id === deviceId);
  const name = row?.name || deviceId;
  if (!confirm(`Delete "${name}" from the manual registry?`)) return;
  try {
    const r = await fetch(`/api/power/devices/${deviceId}`, { method: 'DELETE' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(`Delete failed: ${d.error || r.statusText}`);
      return;
    }
    mdLoadDevices();
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
  }
}

function mdLoadTypeLabel(lt, dcfg) {
  if (lt === 'always_on')    return `always-on (${dcfg?.nominal_w ?? '?'} W)`;
  if (lt === 'cyclic')       return `cyclic (peak ${dcfg?.peak_w ?? '?'} W × ${dcfg?.duty_cycle_pct ?? '?'} %)`;
  if (lt === 'intermittent') return 'intermittent (not auto-subtracted)';
  return '—';
}

function mdSourceTag(source) {
  if (source === 'manual_unmanaged') return '<span style="background:#fff3e0; color:#8b5a2a; padding:2px 8px; border-radius:10px; font-size:0.72rem;">manual</span>';
  if (source === 'manual_seed')      return '<span style="background:#e8f0d8; color:#4a6a2a; padding:2px 8px; border-radius:10px; font-size:0.72rem;">seed</span>';
  if (source === 'auto_discovered')  return '<span style="background:#d8e8f0; color:#2a4a6a; padding:2px 8px; border-radius:10px; font-size:0.72rem;">auto</span>';
  return source || '—';
}

async function mdLoadDevices() {
  try {
    const r = await fetch('/api/power/devices');
    const rows = await r.json();
    mdRowsCache = Array.isArray(rows) ? rows : [];
    const tbody = document.getElementById('md-tbody');
    if (mdRowsCache.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:14px; color:#aaa; text-align:center;">No devices registered yet. Click <b>+ Add Unmanaged Device</b> to start.</td></tr>';
      return;
    }
    tbody.innerHTML = mdRowsCache.map(row => {
      const dcfg = row.dps_config || {};
      const isManual = row.source === 'manual_unmanaged';
      const ltLabel = mdLoadTypeLabel(dcfg.load_type, dcfg);
      const meanW = row.mean_w != null ? `${Math.round(Number(row.mean_w))} W` : '—';
      // Pass only the device_id to Edit/Delete handlers; they look up the row
      // from mdRowsCache so quotes in names can't break the onclick attribute.
      const actions = isManual
        ? `<button class="btn btn-secondary btn-sm" onclick="mdOpenEdit('${row.device_id}')">Edit</button>
           <button class="btn btn-secondary btn-sm" style="color:#c0392b;" onclick="mdDelete('${row.device_id}')">Delete</button>`
        : '<span style="color:#aaa; font-size:0.78rem;">(managed by engine)</span>';
      return `
        <tr style="border-bottom:1px solid #e6e1da;">
          <td style="padding:8px 14px; font-weight:600;">${mdEscHtml(row.name)}</td>
          <td style="padding:8px 14px; text-align:center;">${row.phase || '—'}</td>
          <td style="padding:8px 14px; color:#666;">${ltLabel}</td>
          <td style="padding:8px 22px 8px 14px; text-align:right; font-weight:600;">${meanW}</td>
          <td style="padding:8px 14px; color:#666;">${mdEscHtml(row.room) || '—'}</td>
          <td style="padding:8px 14px;">${mdSourceTag(row.source)}</td>
          <td style="padding:8px 14px; text-align:center; white-space:nowrap;">${actions}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    document.getElementById('md-tbody').innerHTML =
      `<tr><td colspan="7" style="padding:14px; color:#c0392b; text-align:center;">Fetch error: ${e.message}</td></tr>`;
  }
}

// Wire up the cyclic-preview listeners + initial load
['md-peak-w', 'md-duty-pct'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', mdUpdateCyclicPreview);
});
mdLoadDevices();
