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
  // Two special options: empty (forces a choice) + "(no room)" for
  // devices that don't belong to any specific room (routers, modems,
  // closet-mounted gear). "(no room)" stores as NULL via the special
  // sentinel value "__none__" → translated on the way to the backend.
  sel.innerHTML = '<option value="">— pick a room —</option>'
    + `<option value="__none__"${selected === '__none__' ? ' selected' : ''}>(no room)</option>`
    + rooms.map(r => `<option value="${r.room}"${r.room === selected ? ' selected' : ''}>${r.room}</option>`).join('');
}

// Unified form — same fields for both behaviors. Only the Power section
// toggles based on Phase: 1 input for single phase, 3 for R.S.T.
function mdShowFields() {
  const phase = document.getElementById('md-phase').value;
  document.getElementById('md-fields-auto-single').style.display = (phase === 'R' || phase === 'S' || phase === 'T') ? '' : 'none';
  document.getElementById('md-fields-auto-rst').style.display    = (phase === 'RST') ? '' : 'none';
}

// Linked-device dropdown's onchange — reveal either the custom-name input
// (when "Other (custom)" picked) or the display-name override (when a real
// device is picked).
function mdHandleLinkedChange() {
  const v = document.getElementById('md-linked-device').value;
  const isCustom = (v === '__custom__');
  document.getElementById('md-custom-device-name-wrap').style.display = isCustom ? '' : 'none';
  document.getElementById('md-display-name-wrap').style.display       = (v && !isCustom) ? '' : 'none';
}

// Populated lazily the first time the user picks "auto"; refreshed each
// time the form opens so it reflects fresh adds/removes elsewhere.
// The "__custom__" option at the END lets the user register a device
// that isn't in the system (no smart control). Backend creates a
// virtual auto_<slug> device for that case.
async function mdLoadAvailableDevices(selected = '') {
  const sel = document.getElementById('md-linked-device');
  try {
    const r = await fetch('/api/power/devices/available');
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error('bad response');
    const byRoom = {};
    for (const row of rows) {
      const key = row.room || '(no room)';
      (byRoom[key] = byRoom[key] || []).push(row);
    }
    const opts = ['<option value="">— pick a device —</option>'];
    for (const room of Object.keys(byRoom).sort()) {
      opts.push(`<optgroup label="${mdEscHtml(room)}">`);
      for (const d of byRoom[room]) {
        const sel2 = d.id === selected ? ' selected' : '';
        opts.push(`<option value="${mdEscHtml(d.id)}"${sel2}>${mdEscHtml(d.name)}  (${mdEscHtml(d.device_type)})</option>`);
      }
      opts.push('</optgroup>');
    }
    opts.push(`<option value="__custom__"${selected === '__custom__' ? ' selected' : ''}>— Other (custom — not in system) —</option>`);
    sel.innerHTML = opts.join('');
    mdHandleLinkedChange();
  } catch (e) {
    sel.innerHTML = `<option value="">— error loading: ${mdEscHtml(e.message)} —</option>`;
  }
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
  mdLoadAvailableDevices();
}

async function mdOpenEdit(deviceId) {
  const row = mdRowsCache.find(r => r.device_id === deviceId);
  if (!row) return;
  mdFormMode = `edit:${row.device_id}`;
  document.getElementById('md-form').style.display = '';
  document.getElementById('md-form-mode-tag').textContent = `(editing ${row.display_name || row.name})`;
  document.getElementById('md-add-btn').textContent = '× Close form';
  mdResetFormFields();

  // Phase prefill
  document.getElementById('md-phase').value = row.is_three_phase ? 'RST' : (row.phase || '');

  // Behavior radio prefill — derive from source:
  //   manual_unmanaged → always_on
  //   auto_pending / auto_custom / auto_discovered → auto
  const behavior = (row.source === 'manual_unmanaged') ? 'always_on' : 'auto';
  const br = document.querySelector(`input[name="md-behavior"][value="${behavior}"]`);
  if (br) br.checked = true;

  // Power values come from power_devices.config (new path) OR from the
  // virtual device's dps_config.nominal_w (old manual_unmanaged path).
  const cfg = row.config || {};
  const dcfg = row.dps_config || {};
  if (row.is_three_phase) {
    document.getElementById('md-r-expected-w').value = cfg.r_expected_w ?? 0;
    document.getElementById('md-s-expected-w').value = cfg.s_expected_w ?? 0;
    document.getElementById('md-t-expected-w').value = cfg.t_expected_w ?? 0;
    // Max defaults: show the stored value if it's > expected, else leave
    // blank (the user explicitly didn't set a range).
    if (cfg.r_max_w != null && cfg.r_max_w > (cfg.r_expected_w ?? 0)) document.getElementById('md-r-max-w').value = cfg.r_max_w;
    if (cfg.s_max_w != null && cfg.s_max_w > (cfg.s_expected_w ?? 0)) document.getElementById('md-s-max-w').value = cfg.s_max_w;
    if (cfg.t_max_w != null && cfg.t_max_w > (cfg.t_expected_w ?? 0)) document.getElementById('md-t-max-w').value = cfg.t_max_w;
  } else {
    const exp = cfg.expected_w ?? dcfg.nominal_w ?? 0;
    document.getElementById('md-expected-w').value = exp;
    if (cfg.max_w != null && cfg.max_w > exp) document.getElementById('md-max-w').value = cfg.max_w;
  }

  // Device dropdown — needs to be populated first, then preselected.
  // For manual_<slug> / auto_<slug> virtual devices, pick "Other (custom)"
  // and prefill the custom name. For linked-auto rows, pick the real id.
  await mdLoadAvailableDevices();
  const sel = document.getElementById('md-linked-device');
  const isVirtual = row.device_id.startsWith('manual_') || row.device_id.startsWith('auto_');
  if (isVirtual) {
    // Virtual rows aren't in the available list (already-registered).
    // Use the __custom__ option and prefill the typed name.
    sel.value = '__custom__';
    document.getElementById('md-custom-device-name').value = row.display_name || row.name;
  } else {
    // Linked-auto: the real device is already in the registry so it's
    // NOT in the available list. Inject it as a transient option so the
    // dropdown can show + preselect it during edit.
    const opt = document.createElement('option');
    opt.value = row.device_id;
    opt.textContent = `${row.name} (currently registered)`;
    opt.selected = true;
    sel.appendChild(opt);
    if (row.display_name) document.getElementById('md-display-name').value = row.display_name;
  }
  mdHandleLinkedChange();
  mdShowFields();
  mdPopulateRoomsDropdown(row.room || '__none__');
}

function mdCancel() {
  mdFormMode = '';
  document.getElementById('md-form').style.display = 'none';
  document.getElementById('md-form-mode-tag').textContent = '';
  document.getElementById('md-add-btn').textContent = '+ Add Unmanaged Device';
  document.getElementById('md-form-msg').textContent = '';
}

function mdResetFormFields() {
  for (const id of ['md-phase','md-custom-device-name','md-display-name',
                    'md-expected-w','md-max-w',
                    'md-r-expected-w','md-s-expected-w','md-t-expected-w',
                    'md-r-max-w','md-s-max-w','md-t-max-w']) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  document.querySelectorAll('input[name="md-behavior"]').forEach(r => r.checked = false);
  for (const id of ['md-fields-auto-single','md-fields-auto-rst',
                    'md-custom-device-name-wrap','md-display-name-wrap']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  document.getElementById('md-form-msg').textContent = '';
  const ld = document.getElementById('md-linked-device');
  if (ld) ld.innerHTML = '<option value="">— loading… —</option>';
}

async function mdSave() {
  const msg = document.getElementById('md-form-msg');
  msg.textContent = '';
  const phase = document.getElementById('md-phase').value;
  const room  = document.getElementById('md-room').value;
  const behavior = document.querySelector('input[name="md-behavior"]:checked')?.value || '';

  if (!behavior) { msg.textContent = 'Behavior is required'; return; }
  if (!phase) { msg.textContent = 'Phase is required'; return; }
  if (!room)  { msg.textContent = 'Room is required'; return; }
  const roomValue = room === '__none__' ? null : room;
  const isThreePhase = (phase === 'RST');
  const phaseValue = isThreePhase ? null : phase;

  // Unified shape — every row registers a device (linked OR custom) on
  // a phase with expected power(s). Behavior decides the LCD's baseline
  // treatment: always_on subtracts continuously; auto contributes only
  // when the discovery rule detects ON.
  const linkedSel = document.getElementById('md-linked-device').value;
  const isCustom = (linkedSel === '__custom__');
  if (!linkedSel) { msg.textContent = 'Pick a device (or "Other custom")'; return; }
  let linked_device_id = null;
  let custom_device_name = null;
  if (isCustom) {
    custom_device_name = document.getElementById('md-custom-device-name').value.trim();
    if (!custom_device_name) { msg.textContent = 'Custom device name is required'; return; }
  } else {
    linked_device_id = linkedSel;
  }
  const display_name = (document.getElementById('md-display-name').value || '').trim() || null;

  const body = {
    behavior,
    linked_device_id, custom_device_name, display_name,
    phase: phaseValue, is_three_phase: isThreePhase, room: roomValue,
  };
  if (isThreePhase) {
    body.r_expected_w = parseFloat(document.getElementById('md-r-expected-w').value) || 0;
    body.s_expected_w = parseFloat(document.getElementById('md-s-expected-w').value) || 0;
    body.t_expected_w = parseFloat(document.getElementById('md-t-expected-w').value) || 0;
    if (body.r_expected_w + body.s_expected_w + body.t_expected_w <= 0) {
      msg.textContent = 'At least one of R/S/T power must be > 0'; return;
    }
    // Max defaults to Expected if blank, per phase.
    body.r_max_w = parseFloat(document.getElementById('md-r-max-w').value) || body.r_expected_w;
    body.s_max_w = parseFloat(document.getElementById('md-s-max-w').value) || body.s_expected_w;
    body.t_max_w = parseFloat(document.getElementById('md-t-max-w').value) || body.t_expected_w;
    for (const [exp, mx, ph] of [[body.r_expected_w, body.r_max_w, 'R'], [body.s_expected_w, body.s_max_w, 'S'], [body.t_expected_w, body.t_max_w, 'T']]) {
      if (mx < exp) { msg.textContent = `${ph}-max must be ≥ ${ph}-expected`; return; }
    }
  } else {
    body.expected_w = parseFloat(document.getElementById('md-expected-w').value) || 0;
    if (body.expected_w <= 0) { msg.textContent = 'Expected power must be > 0'; return; }
    body.max_w = parseFloat(document.getElementById('md-max-w').value) || body.expected_w;
    if (body.max_w < body.expected_w) { msg.textContent = 'Max power must be ≥ Expected'; return; }
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

// Behavior derived from power_devices.source. Cyclic is no longer a
// separate behavior — all rows are either always_on or auto.
function mdBehavior(source) {
  if (source === 'manual_unmanaged' || source === 'manual_seed') return 'always_on';
  return 'auto';
}
function mdTypeLabel(source) {
  return mdBehavior(source) === 'always_on' ? 'always-on' : 'auto';
}
// Always-on devices burn power 24/7 (red, attention-grabbing).
// Auto devices contribute only when the rule detects them ON (blue).
function mdConsumptionColor(source) {
  return mdBehavior(source) === 'always_on' ? '#c0392b' : '#2980b9';
}
// Live wattage cell — what the rule currently sees:
//   * always_on rows always render as ON in red with their expected
//     wattage (they're on by definition; no rule detection needed).
//   * auto rows default to "Off" in grey; flip to red live wattage when
//     the future P3 rule sets power_devices.live = {on:true, w, r/s/t_w}.
// 3-phase rows show per-phase live values when ON.
const _OFF_COLOR  = '#888';
const _ON_COLOR   = '#c0392b';
function mdLiveCell(row) {
  const beh  = mdBehavior(row.source);
  const live = row.live || { on: false };
  const cfg  = row.config || {};
  const dcfg = row.dps_config || {};
  // always_on devices are continuously on by definition
  const isOn = (beh === 'always_on') || !!live.on;
  if (!isOn) return `<span style="color:${_OFF_COLOR};">OFF</span>`;
  // Build the wattage string. Prefer live measurements when present;
  // otherwise fall back to the expected signature.
  if (row.is_three_phase) {
    const r = (live.r_w ?? cfg.r_expected_w) ?? 0;
    const s = (live.s_w ?? cfg.s_expected_w) ?? 0;
    const t = (live.t_w ?? cfg.t_expected_w) ?? 0;
    return `<span style="color:${_ON_COLOR}; font-weight:700;">R:${Math.round(r)} &nbsp; S:${Math.round(s)} &nbsp; T:${Math.round(t)} <span style="opacity:0.7; font-weight:400;">W</span></span>`;
  }
  const w = (live.w ?? cfg.expected_w ?? dcfg.nominal_w) ?? 0;
  return `<span style="color:${_ON_COLOR}; font-weight:700;">${Math.round(w)} W</span>`;
}

// Last-seen cell — relative timestamp of the last on/off transition the
// rule logged. always_on rows have no transitions so render "—". The P3
// rule will set power_devices.live.ts (or update last_observed_at) when
// it detects a state change.
function mdLastSeenCell(row) {
  if (mdBehavior(row.source) === 'always_on') return '—';
  const ts = row.live?.ts || row.last_observed_at;
  if (!ts) return '<span style="color:#bbb;">never</span>';
  const ageSec = (Date.now() - new Date(ts).getTime()) / 1000;
  if (ageSec < 60)    return `${Math.round(ageSec)} s ago`;
  if (ageSec < 3600)  return `${Math.round(ageSec / 60)} m ago`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)} h ago`;
  return `${Math.round(ageSec / 86400)} d ago`;
}

// Unified power display. Shows expected-max range when they differ
// (variable-power device like a dishwasher), single value otherwise.
function _rangeStr(exp, mx) {
  if (typeof exp !== 'number') return '—';
  if (typeof mx === 'number' && mx > exp) return `${exp}-${mx}`;
  return `${exp}`;
}
function mdPowerSpec(row) {
  const cfg = row?.config || {};
  const dcfg = row?.dps_config || {};
  if (row?.is_three_phase) {
    const r = _rangeStr(cfg.r_expected_w, cfg.r_max_w);
    const s = _rangeStr(cfg.s_expected_w, cfg.s_max_w);
    const t = _rangeStr(cfg.t_expected_w, cfg.t_max_w);
    return `R:${r} &nbsp; S:${s} &nbsp; T:${t} <span style="opacity:0.7; font-weight:400;">W</span>`;
  }
  const exp = (typeof cfg.expected_w === 'number') ? cfg.expected_w : dcfg.nominal_w;
  const mx  = (typeof cfg.max_w === 'number') ? cfg.max_w : exp;
  if (typeof exp !== 'number') return '—';
  return `${_rangeStr(exp, mx)} W`;
}

function mdSourceTag(source) {
  if (source === 'manual_unmanaged') return '<span style="background:#fff3e0; color:#8b5a2a; padding:2px 8px; border-radius:10px; font-size:0.72rem;">manual</span>';
  if (source === 'manual_seed')      return '<span style="background:#e8f0d8; color:#4a6a2a; padding:2px 8px; border-radius:10px; font-size:0.72rem;">seed</span>';
  if (source === 'auto_pending')     return '<span style="background:#e3f2fd; color:#1565c0; padding:2px 8px; border-radius:10px; font-size:0.72rem;">auto (linked)</span>';
  if (source === 'auto_custom')      return '<span style="background:#f3e5f5; color:#6a1b9a; padding:2px 8px; border-radius:10px; font-size:0.72rem;">auto (custom)</span>';
  if (source === 'auto_discovered')  return '<span style="background:#d8e8f0; color:#2a4a6a; padding:2px 8px; border-radius:10px; font-size:0.72rem;">auto</span>';
  return source || '—';
}

async function mdLoadDevices() {
  try {
    const r = await fetch('/api/power/devices');
    const rows = await r.json();
    mdRowsCache = Array.isArray(rows) ? rows : [];
    const tbody = document.getElementById('md-tbody');
    const tfoot = document.getElementById('md-tfoot');
    tfoot.innerHTML = '';  // no footer row (user removed per-phase totals here — same info now lives in the LCD)
    if (mdRowsCache.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="color:#aaa; text-align:center;">No devices registered yet. Click <b>+ Add Unmanaged Device</b> to start.</td></tr>';
      return;
    }
    tbody.innerHTML = mdRowsCache.map(row => {
      const rowName  = row.display_name || row.name;
      const typeLabel = mdTypeLabel(row.source);
      const powerSpec = mdPowerSpec(row);
      const roomCell = row.room ? mdEscHtml(row.room) : '<span style="color:#aaa; font-style:italic;">(no room)</span>';
      const phaseDisplay = row.is_three_phase ? 'R.S.T' : (row.phase || '—');
      const cColor = mdConsumptionColor(row.source);
      const liveCell = mdLiveCell(row);
      const lastSeenCell = mdLastSeenCell(row);
      const actions = `
        <button class="btn btn-secondary btn-sm" onclick="mdOpenEdit('${row.device_id}')">Edit</button>
        <button class="btn btn-secondary btn-sm" style="color:#c0392b;" onclick="mdDelete('${row.device_id}')">Delete</button>
      `;
      return `
        <tr style="border-bottom:1px solid #e6e1da;">
          <td style="font-weight:600;">${mdEscHtml(rowName)}</td>
          <td style="text-align:center;">${phaseDisplay}</td>
          <td style="text-align:center; color:#666;">${typeLabel}</td>
          <td style="text-align:center; color:${cColor}; font-weight:600;">${powerSpec}</td>
          <td style="text-align:center;">${liveCell}</td>
          <td style="text-align:center; color:#888; font-size:0.82rem;">${lastSeenCell}</td>
          <td style="text-align:center; color:#666;">${roomCell}</td>
          <td style="text-align:center;">${mdSourceTag(row.source)}</td>
          <td style="text-align:center; white-space:nowrap;">${actions}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    document.getElementById('md-tbody').innerHTML =
      `<tr><td colspan="7" style="padding:14px; color:#c0392b; text-align:center;">Fetch error: ${e.message}</td></tr>`;
  }
}

mdLoadDevices();
