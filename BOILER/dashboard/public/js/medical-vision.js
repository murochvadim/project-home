// ══════════════════════════════════════════════════════════════
// Medical — Eye test (visual acuity), Tests tab.
// Laptop screen, calibrated (credit-card → px-per-mm + entered viewing
// distance). Per eye: a read-down chart of letters+numbers at decreasing
// logMAR sizes; the user taps the smallest line they can read → logMAR +
// Snellen per eye. Stored in medical_test_results (test_type='vision')
// via /api/medical/test-results (shared with the hearing test).
//
// Screening / relative-tracking tool — tests acuity WITH whatever correction
// the user is wearing; does NOT measure refractive error (prescription).
//
// No IIFE (inline onclick handlers must stay global). vt* names; reuses
// htEsc() from medical-hearing.js (loaded first).
// ══════════════════════════════════════════════════════════════

const VT_EYES    = ['right', 'left'];
// logMAR rows: 1.0 (6/60) down to 0.0 (6/6), 0.1 steps.
const VT_LOGMAR  = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0];
const VT_CHARSET = 'CDEHKNPRSVZ234689';   // unambiguous letters + digits
const VT_CARD_MM = 85.6;                  // ISO credit-card width
const VT_CALIB_KEY = 'med.vision.calib';  // localStorage {px_per_mm, distance_cm}

let vtState = null;   // { idx, results: {right:{logmar,snellen}, left:{…}} }

// ─── Calibration ────────────────────────────────────────────────
function vtGetCalib() {
  try { return JSON.parse(localStorage.getItem(VT_CALIB_KEY) || 'null'); } catch (e) { return null; }
}

function vtCardResize(px) {
  const card = document.getElementById('vt-card');
  if (card) card.style.width = px + 'px';
}

function vtSaveCalib() {
  const px = parseFloat((document.getElementById('vt-card-slider') || {}).value) || 0;
  const distance_cm = parseFloat((document.getElementById('vt-distance') || {}).value) || 0;
  if (px <= 0 || distance_cm <= 0) { alert('Set the card width and a viewing distance first.'); return; }
  const px_per_mm = px / VT_CARD_MM;
  localStorage.setItem(VT_CALIB_KEY, JSON.stringify({ px_per_mm, distance_cm, card_px: px }));
  vtUpdateCalibStatus();
}

function vtUpdateCalibStatus() {
  const c = vtGetCalib();
  const el = document.getElementById('vt-calib-status');
  if (el) el.textContent = c
    ? `✓ ${c.px_per_mm.toFixed(2)} px/mm · ${c.distance_cm} cm`
    : '⚠ not calibrated';
}

// Restore the slider + distance from a saved calibration (called on load).
function vtLoadCalibUI() {
  const c = vtGetCalib();
  if (c) {
    const slider = document.getElementById('vt-card-slider');
    const dist   = document.getElementById('vt-distance');
    if (slider && c.card_px) { slider.value = c.card_px; vtCardResize(c.card_px); }
    if (dist && c.distance_cm) dist.value = c.distance_cm;
  }
  vtUpdateCalibStatus();
}

// ─── Optotype sizing ────────────────────────────────────────────
// logMAR L → minimum angle of resolution = 10^L arcmin; an optotype's height
// subtends 5 × that. Convert that visual angle at the viewing distance to mm,
// then to CSS px via px-per-mm. Returns a font-size px for the chart line.
function vtSizePx(logmar, px_per_mm, distance_cm) {
  const letterArcmin = 5 * Math.pow(10, logmar);
  const angleRad = letterArcmin * (Math.PI / 180 / 60);
  const sizeMm = 2 * (distance_cm * 10) * Math.tan(angleRad / 2);
  return sizeMm * px_per_mm;
}

function vtSnellen(logmar) {
  const denom = 6 * Math.pow(10, logmar);
  return '6/' + (Math.round(denom * 10) / 10);
}

function vtRandLine(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += VT_CHARSET[Math.floor(Math.random() * VT_CHARSET.length)];
  return s.split('').join(' ');   // space the glyphs out
}

// ─── Test flow ──────────────────────────────────────────────────
function vtStart() {
  const c = vtGetCalib();
  if (!c) { alert('Calibrate the screen + distance first (the "Calibrate" section above).'); return; }
  vtState = { idx: 0, results: { right: {}, left: {} } };
  vtCloseResult();
  if (typeof htCloseChart === 'function') htCloseChart();
  document.getElementById('vt-setup').style.display  = 'none';
  document.getElementById('vt-finish').style.display = 'none';
  document.getElementById('vt-overlay').style.display = 'block';
  vtRenderChart();
}

function vtRenderChart() {
  const c = vtGetCalib();
  const eye = VT_EYES[vtState.idx];
  document.getElementById('vt-eye-prompt').textContent =
    eye === 'right' ? 'Cover your LEFT eye — test the RIGHT eye'
                    : 'Now cover your RIGHT eye — test the LEFT eye';
  const chart = document.getElementById('vt-chart');
  chart.innerHTML = VT_LOGMAR.map(lm => {
    const px = Math.max(6, vtSizePx(lm, c.px_per_mm, c.distance_cm));
    return `<div onclick="vtPickLine(${lm})" title="Tap if this is the smallest line you can read"
                 style="cursor:pointer; font-family:monospace; font-weight:700; letter-spacing:2px;
                        line-height:1.25; font-size:${px.toFixed(1)}px; padding:2px 0;">
              ${vtRandLine(5)}
            </div>`;
  }).join('');
}

function vtPickLine(logmar) {
  if (!vtState) return;
  const eye = VT_EYES[vtState.idx];
  vtState.results[eye] = { logmar: logmar, snellen: vtSnellen(logmar) };
  vtAdvance();
}

function vtCantRead() {
  if (!vtState) return;
  const eye = VT_EYES[vtState.idx];
  // Worse than the top line (6/60) — record a below-chart sentinel.
  vtState.results[eye] = { logmar: 1.3, snellen: '6/120', noresponse: true };
  vtAdvance();
}

function vtAdvance() {
  vtState.idx += 1;
  if (vtState.idx >= VT_EYES.length) return vtFinish();
  vtRenderChart();
}

function vtFinish() {
  const c = vtGetCalib();
  document.getElementById('vt-overlay').style.display = 'none';
  document.getElementById('vt-finish').style.display = 'block';
  renderVision({
    results: Object.assign({}, vtState.results, { distance_cm: c.distance_cm, px_per_mm: c.px_per_mm }),
    meta: { correction: (document.getElementById('vt-correction') || {}).value || 'none' },
  });
}

function vtCancel() {
  vtState = null;
  document.getElementById('vt-overlay').style.display = 'none';
  document.getElementById('vt-finish').style.display = 'none';
  document.getElementById('vt-setup').style.display  = 'block';
  vtCloseResult();
}

function vtCloseResult() {
  const w = document.getElementById('vt-result-wrap');
  if (w) w.style.display = 'none';
}

async function vtSave() {
  if (!vtState) return;
  const c = vtGetCalib();
  const results = Object.assign({}, vtState.results, { distance_cm: c.distance_cm, px_per_mm: c.px_per_mm });
  const meta = {
    correction: (document.getElementById('vt-correction') || {}).value || 'none',
    notes:      (document.getElementById('vt-notes').value || '').trim(),
  };
  try {
    const r = await fetch('/api/medical/test-results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_type: 'vision', results, meta }),
    }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    vtCancel();
    document.getElementById('vt-notes').value = '';
    if (typeof medTestsLoad === 'function') await medTestsLoad();
  } catch (e) { alert('Save failed: ' + e.message); }
}

// ─── Rendering (preview + view from the results list) ────────────
function vtEyeLine(label, eye) {
  if (!eye || eye.logmar == null) return `${label}: —`;
  const tag = eye.noresponse ? ' (worse than 6/60)' : '';
  return `${label}: <b>${htEsc(eye.snellen)}</b> <span style="color:#888;">(logMAR ${eye.logmar.toFixed(1)})${tag}</span>`;
}

function renderVision(t) {
  const wrap = document.getElementById('vt-result-wrap');
  const body = document.getElementById('vt-result-body');
  const r = t.results || {};
  const corr = (t.meta && t.meta.correction) || 'none';
  body.innerHTML =
    `<div style="font-size:1.05rem; margin-bottom:6px;">👁 Visual acuity</div>
     <div style="margin:2px 0;">${vtEyeLine('Right eye', r.right)}</div>
     <div style="margin:2px 0;">${vtEyeLine('Left eye',  r.left)}</div>
     <div class="med-meta" style="margin-top:8px;">Wearing: ${htEsc(corr)} · distance ${htEsc(r.distance_cm || '?')} cm · ${r.px_per_mm ? r.px_per_mm.toFixed(2) + ' px/mm' : 'uncalibrated'}</div>
     <div class="med-meta" style="margin-top:4px; color:#999;">Screening only — acuity with your current correction; does NOT measure your prescription. Depends on honest distance + calibration.</div>`;
  wrap.style.display = 'block';
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// One-line summary for the unified Test Results list (called from medical-hearing.js).
function vtRowSummary(t) {
  const r = t.results || {};
  const rr = (r.right && r.right.snellen) || '—';
  const ll = (r.left  && r.left.snellen)  || '—';
  return `R ${htEsc(rr)} · L ${htEsc(ll)}${r.distance_cm ? ' · ' + htEsc(r.distance_cm) + ' cm' : ''}`;
}

// Restore calibration UI on load (DOM exists — script is at end of body).
vtLoadCalibUI();
