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
