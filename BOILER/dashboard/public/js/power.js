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

function renderPhaseCol(label, p, va, periodKwh) {
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
      <div style="font-size:0.72rem; color:#2980b9; margin-top:8px;">Period</div>
      <div style="font-size:0.96rem; font-weight:600; color:#2980b9;">${fmt(periodKwh, 2)} <span style="font-size:0.72rem; color:#2980b9;">kWh</span></div>
    </div>
  `;
}

// Render a value with the unit absolutely-positioned to the right so the
// numeric part stays naturally centered by the parent's text-align:center.
// Without this, "830 W" centers as a whole — the W shifts the visual
// center of the digits LEFT, and the label above appears offset to the
// right of the number. Hanging the unit absolute fixes that.
// Unit-label dim color: derive from the number color so blue numbers get
// blue units, etc. Default = dim green (matches the original LCD scheme).
function _lcdUnitColor(numColor) {
  if (!numColor)                  return '#3a8a52';      // default green
  if (numColor === '#ff6e6e')     return '#8a3a3a';      // red → dim red
  if (numColor === '#ffd560')     return '#8a7a3a';      // yellow → dim yellow
  if (numColor === '#7eb8ff')     return '#3a6a8a';      // blue → dim blue
  return '#3a8a52';                                       // fallback dim green
}

function lcdValueHTML(numStr, unit, fontSize, color) {
  const colorCss  = color ? `color:${color};text-shadow:0 0 10px currentColor;` : '';
  const unitColor = _lcdUnitColor(color);
  const unitHTML  = unit
    ? `<span style="position:absolute; left:100%; bottom:0.45rem; padding-left:6px; font-size:0.85rem; color:${unitColor}; font-weight:500; white-space:nowrap; text-shadow:none;">${unit}</span>`
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

        <!-- Row 1 — Total Power + Total Current (hero). Font reduced two
             steps from the original 2.4rem so the LCD sits more compact. -->
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:30px;">
          <div>
            <div style="font-size:0.7rem; color:#3a8a52; letter-spacing:1.5px; margin-bottom:4px;">TOTAL POWER</div>
            ${lcdValueHTML(fmt(d.total_w, 0), 'W', '1.8rem', lcdPowerColor)}
            <!-- Always-on baseline (sum of all power_devices.mean_w) — same hero
                 size as TOTAL POWER so the two readouts stack visually equal. -->
            <div style="margin-top:30px; font-size:0.7rem; color:#8a7a3a; letter-spacing:1.5px; margin-bottom:4px;">ALWAYS-ON</div>
            ${lcdValueHTML(fmt(d.always_on_w, 0), 'W', '1.8rem', '#ffd560')}
          </div>
          <div>
            <div style="font-size:0.7rem; color:#3a8a52; letter-spacing:1.5px; margin-bottom:4px;">TOTAL CURRENT</div>
            ${lcdValueHTML(fmt(total_a, 2), 'A', '1.8rem', '')}
          </div>
        </div>

        <!-- DEVICES ON / DEVICES OFF moved to the Device Registry card
             header (sits next to the rows it describes). -->

        <!-- Row 3 — Billing-period total kWh + cost (since current period
             start). Blue tint distinguishes the "money" readouts from the
             green "live power" readouts above. -->
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:28px;">
          <div>
            <div style="font-size:0.7rem; color:#3a6a8a; letter-spacing:1.5px; margin-bottom:4px;">PERIOD ENERGY</div>
            ${lcdValueHTML(fmt(d.period?.total_kwh, 2), 'kWh', '1.8rem', '#7eb8ff')}
            <div style="font-size:0.66rem; color:#3a6a8a; margin-top:4px;">since ${d.period?.start || '—'}</div>
          </div>
          <div>
            <div style="font-size:0.7rem; color:#3a6a8a; letter-spacing:1.5px; margin-bottom:4px;">PERIOD COST</div>
            ${lcdValueHTML(fmt(d.period?.cost, 2), d.period?.currency || '₪', '1.8rem', '#7eb8ff')}
            <div style="font-size:0.66rem; color:#3a6a8a; margin-top:4px;">day ${d.period?.days_elapsed || 0} of ${d.period?.days_total || 0} (${d.period?.elapsed_pct || 0}%)</div>
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

    const period = d.period || {};
    document.getElementById('power-phases').innerHTML =
      renderPhaseCol('Phase R', d.r, d.r_va, period.r_kwh) +
      renderPhaseCol('Phase S', d.s, d.s_va, period.s_kwh) +
      renderPhaseCol('Phase T', d.t, d.t_va, period.t_kwh) +
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
        vq.textContent = '215-245V ⚠';
        vq.style.color = '#e67e22';
      } else {
        vq.textContent = '220-240V band ✓';
        vq.style.color = '#27ae60';
      }
    } else {
      vq.textContent = '—';
    }

    document.getElementById('last-update-age').textContent = ageString(d.age_sec);
    // Israel grid nominal 50 Hz. Within ±0.5 Hz = green; otherwise amber.
    const freqEl = document.getElementById('freq-val');
    freqEl.textContent = `${d.frequency_hz} Hz`;
    freqEl.style.color = (typeof d.frequency_hz === 'number' && Math.abs(d.frequency_hz - 50) <= 0.5)
      ? '#27ae60' : '#e67e22';
    document.getElementById('last-refresh').textContent = `Refreshed at ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    document.getElementById('power-phases').innerHTML =
      `<div style="grid-column:span 4; color:#c0392b;">Fetch error: ${e.message}</div>`;
  }
}

loadPower();
pollTimer = setInterval(loadPower, POLL_INTERVAL_MS);

// ─── Tab switcher (Status / Settings) ─────────────────────────
function powerSwitchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'settings') { psLoad(); pbLoad(); }
}

// ─── Past Bills card — list + paste modal + AI extract ────────
async function pbLoad() {
  try {
    const r = await fetch('/api/power/bills');
    const rows = await r.json();
    const tbody = document.getElementById('pb-tbody');
    if (!Array.isArray(rows) || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="padding:14px; color:#aaa; text-align:center;">No bills yet. The first row will auto-insert at the next cycle rollover; you can also paste one with the button above.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(b => {
      const est = b.est_cost_ils != null ? Number(b.est_cost_ils).toFixed(2) : '—';
      const act = b.total_cost_ils != null ? Number(b.total_cost_ils).toFixed(2) : '<span style="color:#aaa;">—</span>';
      let diffCell = '—';
      if (b.total_cost_ils != null && b.est_cost_ils != null) {
        const diff = Number(b.total_cost_ils) - Number(b.est_cost_ils);
        const pct  = (Math.abs(diff) / Number(b.est_cost_ils)) * 100;
        const col  = Math.abs(pct) <= 5 ? '#27ae60' : Math.abs(pct) <= 15 ? '#e67e22' : '#c0392b';
        diffCell = `<span style="color:${col}; font-weight:600;">${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (${pct.toFixed(1)}%)</span>`;
      }
      // Postgres serializes DATE as full ISO timestamp with TZ offset; trim
      // to YYYY-MM-DD for display so the date doesn't shift across timezones.
      const fmtDate = (s) => (s ? String(s).slice(0, 10) : '?');
      const period = (b.period_start || b.period_end)
        ? `${fmtDate(b.period_start)} → ${fmtDate(b.period_end)}`
        : '<span style="color:#aaa;">—</span>';
      const upISO = b.uploaded_at ? new Date(b.uploaded_at).toLocaleDateString() : '—';
      return `
        <tr style="border-bottom:1px solid #e6e1da;">
          <td style="padding:10px 14px;">${period}</td>
          <td style="padding:10px 14px; text-align:right;">${b.total_kwh != null ? Number(b.total_kwh).toFixed(1) : '—'}</td>
          <td style="padding:10px 14px; text-align:right;">${est}</td>
          <td style="padding:10px 14px; text-align:right;">${act}</td>
          <td style="padding:10px 14px; text-align:right;">${diffCell}</td>
          <td style="padding:10px 14px; color:#666; font-size:0.78rem;">${mdEscHtml(b.source || '')}</td>
          <td style="padding:10px 14px; color:#888;">${upISO}</td>
          <td style="padding:10px 14px; text-align:center;">
            <button class="btn btn-secondary btn-sm" style="color:#c0392b; padding:4px 10px;" onclick="pbDelete(${b.id})">×</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    document.getElementById('pb-tbody').innerHTML =
      `<tr><td colspan="8" style="padding:14px; color:#c0392b; text-align:center;">Load failed: ${mdEscHtml(e.message)}</td></tr>`;
  }
}

// PDF upload — single click → file picker → POST to /api/power/bills/upload
// which extracts fields server-side (pdf-parse + regex, no LLM), inserts
// the row, and returns a `diff` array if any tariff field on the bill
// drifted > 1 % from current Settings (IEC rate update). The drift modal
// lets the user sync Settings with one click.
async function pbUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const msg = document.getElementById('pb-upload-msg');
  msg.textContent = `Reading "${file.name}"…`;
  msg.style.color = '#666';
  const fd = new FormData();
  fd.append('pdf', file);
  try {
    const r = await fetch('/api/power/bills/upload', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) {
      msg.textContent = `Failed: ${d.error || r.statusText}`;
      msg.style.color = '#c0392b';
      return;
    }
    const row = d.row || {};
    msg.textContent = `✓ Saved — ${row.period_start || '?'} → ${row.period_end || '?'}, ${row.total_kwh || '?'} kWh, ₪${row.total_cost_ils || '?'}`;
    msg.style.color = '#27ae60';
    setTimeout(() => { msg.textContent = ''; }, 6000);
    pbLoad();

    // Tariff-drift detection: if the server flagged any fields that have
    // changed since the previous bill / current Settings, prompt the user
    // to sync. Modal is shown only when at least one diff entry exists.
    if (Array.isArray(d.diff) && d.diff.length > 0) {
      pbShowDriftModal(d.diff, d.parsed || {});
    }
  } catch (e) {
    msg.textContent = `Upload error: ${e.message}`;
    msg.style.color = '#c0392b';
  } finally {
    event.target.value = '';
  }
}

// Drift modal — shown when uploaded bill's rates differ > 1 % from
// current Settings. User picks "Update Settings" to apply the new
// values, or "Keep current" to dismiss.
function pbShowDriftModal(diff, parsed) {
  const rows = diff.map(d => `
    <tr style="border-bottom:1px solid #e6e1da;">
      <td style="padding:8px 14px;">${mdEscHtml(d.label)}</td>
      <td style="padding:8px 14px; text-align:right; color:#888;">${d.current}</td>
      <td style="padding:8px 14px; text-align:right; color:#c0392b; font-weight:600;">→ ${d.new}</td>
    </tr>
  `).join('');
  const html = `
    <div id="pb-drift-modal" style="position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:1010; display:flex; align-items:center; justify-content:center;">
      <div style="background:#fff; max-width:600px; width:90%; max-height:90vh; overflow-y:auto; border-radius:8px; padding:24px;">
        <h2 style="margin-top:0; color:#c0392b;">⚠ Tariff change detected</h2>
        <p style="font-size:0.95rem; color:#444;">
          The bill you just uploaded has rates that don't match your current Settings.
          IEC likely published an update.
        </p>
        <table style="width:100%; border-collapse:collapse; font-size:0.9rem; margin-top:14px;">
          <thead>
            <tr style="background:#fafaf6;">
              <th style="text-align:left;  padding:8px 14px;">Field</th>
              <th style="text-align:right; padding:8px 14px;">Current</th>
              <th style="text-align:right; padding:8px 14px;">From bill</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:22px; display:flex; gap:10px;">
          <button class="btn btn-primary btn-sm"   onclick="pbApplyDrift()"  style="padding:9px 22px; font-size:0.95rem;">Update Settings</button>
          <button class="btn btn-secondary btn-sm" onclick="pbCloseDrift()" style="padding:9px 18px; font-size:0.95rem;">Keep current</button>
        </div>
      </div>
    </div>
  `;
  // Stash the diff payload so pbApplyDrift can read it without a closure.
  window._pbDriftDiff = diff;
  document.body.insertAdjacentHTML('beforeend', html);
}

function pbCloseDrift() {
  const el = document.getElementById('pb-drift-modal');
  if (el) el.remove();
  window._pbDriftDiff = null;
}

async function pbApplyDrift() {
  const diff = window._pbDriftDiff || [];
  if (diff.length === 0) { pbCloseDrift(); return; }
  // Load current settings first so we can do a merge-PUT (the PUT handler
  // expects the full tariff block; we only override the drifted fields).
  try {
    const cur = await (await fetch('/api/power/settings')).json();
    const tariff = { ...(cur.tariff || {}) };
    for (const d of diff) tariff[d.field] = d.new;
    const r = await fetch('/api/power/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tariff, billing: cur.billing }),
    });
    const data = await r.json();
    if (!r.ok) { alert(`Update failed: ${data.error || r.statusText}`); return; }
    pbCloseDrift();
    psLoad();    // refresh Settings form so the user sees the new values
  } catch (e) {
    alert(`Update error: ${e.message}`);
  }
}

async function pbDelete(id) {
  if (!confirm('Delete this bill record?')) return;
  try {
    const r = await fetch(`/api/power/bills/${id}`, { method: 'DELETE' });
    if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || r.statusText); return; }
    pbLoad();
  } catch (e) { alert(e.message); }
}

// ─── Settings tab — load + save (discovery + billing + tariff) ─────
function psShowTaoz() {
  const t = document.getElementById('ps-tariff-type').value;
  document.getElementById('ps-taoz-block').style.display = (t === 'taoz') ? '' : 'none';
}

async function psLoad() {
  try {
    const r = await fetch('/api/power/settings');
    const d = await r.json();
    // Discovery knobs live in apartment.rule_sentences (sentence-driven);
    // see the (future) P3 rule. No UI here.
    // Billing
    const bl = d.billing || {};
    document.getElementById('ps-billing-start-day').value     = bl.start_day ?? '';
    document.getElementById('ps-billing-length').value        = bl.length_months ?? '';
    document.getElementById('ps-billing-current-start').value = bl.current_period_start_date ?? '';
    // Tariff
    const t = d.tariff || {};
    document.getElementById('ps-tariff-type').value           = t.type ?? 'flat';
    document.getElementById('ps-tariff-flat').value           = t.flat_rate_ils_per_kwh ?? '';
    document.getElementById('ps-tariff-fixed-fee').value      = t.fixed_monthly_fee_ils ?? '';
    document.getElementById('ps-tariff-kva-rate').value       = t.kva_rate_ils_per_year ?? '';
    document.getElementById('ps-tariff-connection-kva').value = t.connection_kva ?? '';
    document.getElementById('ps-tariff-direct-debit').value   = t.direct_debit_credit_ils ?? '';
    document.getElementById('ps-tariff-vat').value            = t.vat_pct ?? '';
    document.getElementById('ps-tariff-currency').value       = t.currency_symbol ?? '₪';
    document.getElementById('ps-tariff-peak-rate').value     = t.taoz_peak_rate ?? '';
    document.getElementById('ps-tariff-peak-hours').value    = t.taoz_peak_hours ?? '';
    document.getElementById('ps-tariff-shoulder-rate').value = t.taoz_shoulder_rate ?? '';
    document.getElementById('ps-tariff-shoulder-hours').value= t.taoz_shoulder_hours ?? '';
    document.getElementById('ps-tariff-offpeak-rate').value  = t.taoz_off_peak_rate ?? '';
    document.getElementById('ps-tariff-offpeak-hours').value = t.taoz_off_peak_hours ?? '';
    psShowTaoz();
  } catch (e) {
    const msg = document.getElementById('ps-save-msg');
    msg.textContent = `Load error: ${e.message}`; msg.style.color = '#c0392b';
  }
}

async function psSave() {
  const msg = document.getElementById('ps-save-msg');
  msg.textContent = '';
  const body = {
    billing: {
      start_day:                 parseInt(document.getElementById('ps-billing-start-day').value, 10),
      length_months:             parseInt(document.getElementById('ps-billing-length').value, 10),
      current_period_start_date: document.getElementById('ps-billing-current-start').value || null,
    },
    tariff: {
      type:                    document.getElementById('ps-tariff-type').value,
      flat_rate_ils_per_kwh:   parseFloat(document.getElementById('ps-tariff-flat').value),
      taoz_peak_rate:          parseFloat(document.getElementById('ps-tariff-peak-rate').value),
      taoz_shoulder_rate:      parseFloat(document.getElementById('ps-tariff-shoulder-rate').value),
      taoz_off_peak_rate:      parseFloat(document.getElementById('ps-tariff-offpeak-rate').value),
      taoz_peak_hours:         document.getElementById('ps-tariff-peak-hours').value,
      taoz_shoulder_hours:     document.getElementById('ps-tariff-shoulder-hours').value,
      taoz_off_peak_hours:     document.getElementById('ps-tariff-offpeak-hours').value,
      fixed_monthly_fee_ils:   parseFloat(document.getElementById('ps-tariff-fixed-fee').value),
      kva_rate_ils_per_year:   parseFloat(document.getElementById('ps-tariff-kva-rate').value),
      connection_kva:          parseFloat(document.getElementById('ps-tariff-connection-kva').value),
      direct_debit_credit_ils: parseFloat(document.getElementById('ps-tariff-direct-debit').value),
      vat_pct:                 parseFloat(document.getElementById('ps-tariff-vat').value),
      currency_symbol:         document.getElementById('ps-tariff-currency').value,
    },
  };
  const btn = document.getElementById('ps-save-btn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/power/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) { msg.textContent = `Save failed: ${d.error || r.statusText}`; msg.style.color = '#c0392b'; return; }
    msg.textContent = '✓ Saved'; msg.style.color = '#27ae60';
    setTimeout(() => { msg.textContent = ''; }, 2500);
  } catch (e) {
    msg.textContent = `Save error: ${e.message}`; msg.style.color = '#c0392b';
  } finally {
    btn.disabled = false;
  }
}

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
// Channel-aware composite picker: each multi-channel switch (Kitchen Switch,
// Bedroom Main Switch, etc.) expands to one option PER enabled channel — so
// the user registers the load (e.g. "Kitchen Switch – High Light", channel
// key "1") not the parent switch. Single-channel devices stay as one option.
// The option value encodes `<device_id>::<channel>` (channel = '' for single-
// channel); mdSave splits this back into linked_device_id + channel.
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
        const compositeId = `${d.id}::${d.channel || ''}`;
        const sel2 = compositeId === selected ? ' selected' : '';
        opts.push(`<option value="${mdEscHtml(compositeId)}"${sel2}>${mdEscHtml(d.name)}  (${mdEscHtml(d.device_type)})</option>`);
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

async function mdOpenEdit(rowId) {
  rowId = Number(rowId);
  const row = mdRowsCache.find(r => Number(r.row_id) === rowId);
  if (!row) return;
  mdFormMode = `edit:${row.row_id}`;
  document.getElementById('md-form').style.display = '';
  const displayName = row.display_name || (row.channel_name ? `${row.name} – ${row.channel_name}` : row.name);
  document.getElementById('md-form-mode-tag').textContent = `(editing ${displayName})`;
  document.getElementById('md-add-btn').textContent = '× Close form';
  mdResetFormFields();

  // Phase prefill
  document.getElementById('md-phase').value = row.is_three_phase ? 'RST' : (row.phase || '');

  // Behavior radio prefill — derive from source:
  //   manual_unmanaged / manual_linked → always_on
  //   auto_pending / auto_custom / auto_discovered → auto
  //   state_known → state_known
  let behavior = 'auto';
  if (row.source === 'manual_unmanaged' || row.source === 'manual_linked') behavior = 'always_on';
  else if (row.source === 'state_known') behavior = 'state_known';
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
  // and prefill the custom name. For linked rows, inject a transient option
  // (the row is registered → filtered from the available list).
  await mdLoadAvailableDevices();
  const sel = document.getElementById('md-linked-device');
  const isVirtual = row.device_id.startsWith('manual_') || row.device_id.startsWith('auto_');
  if (isVirtual) {
    sel.value = '__custom__';
    document.getElementById('md-custom-device-name').value = row.display_name || row.name;
  } else {
    const compositeId = `${row.device_id}::${row.channel || ''}`;
    const opt = document.createElement('option');
    opt.value = compositeId;
    const labelSuffix = row.channel_name ? ` – ${row.channel_name}` : (row.channel ? ` – Ch ${row.channel}` : '');
    opt.textContent = `${row.name}${labelSuffix} (currently registered)`;
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
  document.getElementById('md-add-btn').textContent = '+ Add Device';
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
  // a phase with expected power(s). The dropdown stores composite id
  // `<device_id>::<channel>` (channel = '' for single-channel devices) so
  // multiple channels of the same parent switch are individually pickable.
  const linkedSel = document.getElementById('md-linked-device').value;
  const isCustom = (linkedSel === '__custom__');
  if (!linkedSel) { msg.textContent = 'Pick a device (or "Other custom")'; return; }
  let linked_device_id = null;
  let channel = null;
  let custom_device_name = null;
  if (isCustom) {
    custom_device_name = document.getElementById('md-custom-device-name').value.trim();
    if (!custom_device_name) { msg.textContent = 'Custom device name is required'; return; }
  } else {
    // Split "<device_id>::<channel>" back into its parts. Empty channel
    // segment means single-channel device.
    const sep = linkedSel.lastIndexOf('::');
    if (sep >= 0) {
      linked_device_id = linkedSel.slice(0, sep);
      const chanPart = linkedSel.slice(sep + 2);
      channel = chanPart || null;
    } else {
      linked_device_id = linkedSel;
    }
  }
  const display_name = (document.getElementById('md-display-name').value || '').trim() || null;

  const body = {
    behavior,
    linked_device_id, channel, custom_device_name, display_name,
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

  // Edit uses row_id (synthetic PK); create POSTs to the list endpoint.
  const url = mdFormMode === 'create'
    ? '/api/power/devices'
    : `/api/power/devices/${mdFormMode.slice(5)}`;   // 'edit:<row_id>' → row_id
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

async function mdDelete(rowId) {
  rowId = Number(rowId);
  const row = mdRowsCache.find(r => Number(r.row_id) === rowId);
  const name = row ? (row.display_name || (row.channel_name ? `${row.name} – ${row.channel_name}` : row.name)) : `row ${rowId}`;
  if (!confirm(`Delete "${name}" from the registry?`)) return;
  try {
    const r = await fetch(`/api/power/devices/${rowId}`, { method: 'DELETE' });
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

// Behavior derived from power_devices.source.
//   manual_unmanaged → always_on, custom virtual device
//   manual_linked    → always_on, real linked device (e.g. fridge)
//   auto_pending     → auto, real linked device
//   auto_custom      → auto, custom virtual device
//   auto_discovered  → auto, P3 rule discovered
//   state_known      → state, TV/Alexa — Power Known State rule reads device.dps.state
function mdBehavior(source) {
  if (source === 'manual_unmanaged' || source === 'manual_linked') return 'always_on';
  if (source === 'state_known') return 'state';
  return 'auto';
}
function mdTypeLabel(source) {
  const b = mdBehavior(source);
  if (b === 'always_on') return 'always-on';
  if (b === 'state')     return 'known state';
  return 'auto';
}
// Always-on devices burn power 24/7 (red, attention-grabbing).
// State-known devices show their wattage when HA says ON (purple).
// Auto devices contribute only when the discovery rule detects them ON (blue).
function mdConsumptionColor(source) {
  const b = mdBehavior(source);
  if (b === 'always_on') return '#c0392b';
  if (b === 'state')     return '#7d3c98';
  return '#2980b9';
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

// Drag-to-reorder for registry rows. Mirrors wirePlaylistDragReorder
// in media.js: handle = the ⋮⋮ cell, drop target = the whole row.
// On drop, POST the new order to /api/power/devices/reorder which
// writes sort_order back to power_devices.
let _mdDragId = null;
function mdWireDragReorder(tbody) {
  const rows = Array.from(tbody.querySelectorAll('tr[data-row-id]'));
  for (const row of rows) {
    const handle = row.querySelector('[data-md-drag-handle]');
    if (handle) {
      handle.addEventListener('dragstart', (e) => {
        _mdDragId = row.dataset.rowId;
        row.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', _mdDragId); } catch (_) {}
      });
      handle.addEventListener('dragend', () => {
        row.style.opacity = '';
        _mdDragId = null;
      });
    }
    row.addEventListener('dragover', (e) => {
      if (!_mdDragId) return;
      e.preventDefault();
      if (row.dataset.rowId === _mdDragId) return;
      row.style.background = '#f0f6ff';
    });
    row.addEventListener('dragleave', () => { row.style.background = ''; });
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.style.background = '';
      if (!_mdDragId || row.dataset.rowId === _mdDragId) return;
      const targetId = row.dataset.rowId;
      // Compute the new order — pull the moved row_id out, insert before target.
      const current = Array.from(tbody.querySelectorAll('tr[data-row-id]'))
                           .map(r => r.dataset.rowId);
      const fromIdx = current.indexOf(_mdDragId);
      if (fromIdx >= 0) current.splice(fromIdx, 1);
      const toIdx = current.indexOf(targetId);
      current.splice(toIdx, 0, _mdDragId);
      try {
        const r = await fetch('/api/power/devices/reorder', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ order: current }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          alert(`Reorder failed: ${d.error || r.statusText}`);
        }
        mdLoadDevices();   // re-render in the server-confirmed order
      } catch (err) {
        alert(`Reorder failed: ${err.message || err}`);
      }
    });
  }
}

function mdSourceTag(source) {
  if (source === 'manual_unmanaged') return '<span style="background:#fff3e0; color:#8b5a2a; padding:2px 8px; border-radius:10px; font-size:0.72rem;">manual</span>';
  if (source === 'manual_linked')    return '<span style="background:#fff3e0; color:#8b5a2a; padding:2px 8px; border-radius:10px; font-size:0.72rem;">manual (linked)</span>';
  if (source === 'auto_pending')     return '<span style="background:#e3f2fd; color:#1565c0; padding:2px 8px; border-radius:10px; font-size:0.72rem;">auto (linked)</span>';
  if (source === 'auto_custom')      return '<span style="background:#f3e5f5; color:#6a1b9a; padding:2px 8px; border-radius:10px; font-size:0.72rem;">auto (custom)</span>';
  if (source === 'auto_discovered')  return '<span style="background:#d8e8f0; color:#2a4a6a; padding:2px 8px; border-radius:10px; font-size:0.72rem;">auto</span>';
  if (source === 'state_known')      return '<span style="background:#ede7f6; color:#5e35b1; padding:2px 8px; border-radius:10px; font-size:0.72rem;">known state</span>';
  return source || '—';
}

// ON/OFF semantics matching the LCD's /api/power/status SQL counter:
//   ON  = manual_unmanaged / manual_linked rows + any row with live.on=true
//   OFF = auto_pending / auto_custom / auto_discovered / state_known rows
//         whose live.on is FALSE or NULL
function mdComputeOnOffCounts(rows) {
  let on = 0, off = 0;
  for (const r of rows) {
    const isAlwaysOn = (r.source === 'manual_unmanaged' || r.source === 'manual_linked');
    const isOn      = isAlwaysOn || !!(r.live && r.live.on === true);
    const isAutoLike = ['auto_pending','auto_custom','auto_discovered','state_known'].includes(r.source);
    if (isOn) on++;
    else if (isAutoLike) off++;
  }
  return { on, off };
}

async function mdLoadDevices() {
  try {
    const r = await fetch('/api/power/devices');
    const rows = await r.json();
    mdRowsCache = Array.isArray(rows) ? rows : [];
    const tbody = document.getElementById('md-tbody');
    const tfoot = document.getElementById('md-tfoot');
    tfoot.innerHTML = '';  // no footer row (user removed per-phase totals here — same info now lives in the LCD)
    // Header counters (sit in the Device Registry h2 — moved out of LCD).
    const counts = mdComputeOnOffCounts(mdRowsCache);
    const onEl = document.getElementById('md-devices-on');
    const offEl = document.getElementById('md-devices-off');
    if (onEl)  onEl.textContent  = counts.on;
    if (offEl) offEl.textContent = counts.off;
    if (mdRowsCache.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" style="color:#aaa; text-align:center;">No devices registered yet. Click <b>+ Add Device</b> to start.</td></tr>';
      return;
    }
    tbody.innerHTML = mdRowsCache.map(row => {
      // Row name = display_name override, else parent device name + channel
      // suffix when this is a channel-scoped row.
      const channelSuffix = row.channel_name
        ? ` – ${row.channel_name}`
        : (row.channel ? ` – Ch ${row.channel}` : '');
      const rowName  = row.display_name || `${row.name}${channelSuffix}`;
      const typeLabel = mdTypeLabel(row.source);
      const powerSpec = mdPowerSpec(row);
      const roomCell = row.room ? mdEscHtml(row.room) : '<span style="color:#aaa; font-style:italic;">(no room)</span>';
      const phaseDisplay = row.is_three_phase ? 'R.S.T' : (row.phase || '—');
      const cColor = mdConsumptionColor(row.source);
      const liveCell = mdLiveCell(row);
      const lastSeenCell = mdLastSeenCell(row);
      const actions = `
        <button class="btn btn-secondary btn-sm" onclick="mdOpenEdit(${row.row_id})">Edit</button>
        <button class="btn btn-secondary btn-sm" style="color:#c0392b;" onclick="mdDelete(${row.row_id})">Delete</button>
      `;
      return `
        <tr data-row-id="${row.row_id}" style="border-bottom:1px solid #e6e1da;">
          <td style="cursor:grab; color:#bbb; user-select:none; text-align:center;" title="Drag to reorder" data-md-drag-handle="1" draggable="true">⋮⋮</td>
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

    mdWireDragReorder(tbody);
  } catch (e) {
    document.getElementById('md-tbody').innerHTML =
      `<tr><td colspan="10" style="padding:14px; color:#c0392b; text-align:center;">Fetch error: ${e.message}</td></tr>`;
  }
}

mdLoadDevices();
