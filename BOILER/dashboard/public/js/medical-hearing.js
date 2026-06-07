// ══════════════════════════════════════════════════════════════
// Medical — Hearing test (Tests tab).
// Browser-native Web Audio pure-tone screening (descending staircase),
// audiogram via Chart.js, results stored in medical_test_results
// (test_type='hearing') through /api/medical/test-results.
//
// Uncalibrated screening tool — relative tracking + left/right comparison,
// NOT a clinical dB HL measurement. Needs wired headphones.
//
// NOTE: no IIFE — the inline onclick handlers in medical.html need these
// functions global. Uses htEsc() (not medical.js's `esc`) to avoid a
// duplicate top-level const declaration in the shared global scope.
// ══════════════════════════════════════════════════════════════

// Frequency bands the user can pick before starting (selector in the setup row).
// Extended/high-freq go up to 16 kHz — useful for early high-frequency loss,
// though many laptops/headphones (and adult ears) roll off near the top.
const HT_BANDS = {
  standard: [250, 500, 1000, 2000, 4000, 8000],
  extended: [250, 500, 1000, 2000, 4000, 8000, 12000, 16000],
  highfreq: [8000, 10000, 12000, 14000, 16000],
};
const HT_EARS     = ['right', 'left'];
const HT_STEP_DB  = 6;     // dB attenuation per staircase step
const HT_MAX_STEP = 8;     // step 0..8 → up to 48 dB below reference
const HT_REF_GAIN = 0.4;   // gain at step 0 (loudest presentation)

function htEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}

let htAudioCtx = null;
let htState    = null;   // { steps, idx, currentStep, lastHeard, results }
let htChart    = null;
let HT_RESULTS = [];

// gain for a given staircase step (higher step = quieter)
function htGain(step) { return HT_REF_GAIN * Math.pow(10, -(HT_STEP_DB * step) / 20); }

function htPlayTone(freq, ear, step) {
  if (!htAudioCtx) return;
  const t = htAudioCtx.currentTime;
  const osc = htAudioCtx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const g = htAudioCtx.createGain();
  const level = htGain(step);
  // 20 ms attack / release envelope so the tone doesn't click on/off.
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + 0.02);
  g.gain.setValueAtTime(level, t + 1.0);
  g.gain.linearRampToValueAtTime(0, t + 1.02);
  const pan = htAudioCtx.createStereoPanner();
  pan.pan.value = ear === 'right' ? 1 : -1;   // hard-pan to one ear
  osc.connect(g).connect(pan).connect(htAudioCtx.destination);
  osc.start(t);
  osc.stop(t + 1.06);
}

function htStart() {
  try {
    htAudioCtx = htAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (htAudioCtx.state === 'suspended') htAudioCtx.resume();
  } catch (e) { alert('Web Audio not available in this browser: ' + e.message); return; }
  const band = (document.getElementById('ht-band') || {}).value || 'standard';
  const freqs = HT_BANDS[band] || HT_BANDS.standard;
  const steps = [];
  for (const ear of HT_EARS) for (const freq of freqs) steps.push({ ear, freq });
  htState = { steps, idx: 0, currentStep: 1, lastHeard: null, results: { right: {}, left: {} }, band };
  htCloseChart();   // clear any graph from a previous test/view
  document.getElementById('ht-setup').style.display  = 'none';
  document.getElementById('ht-finish').style.display = 'none';
  document.getElementById('ht-runner').style.display = 'block';
  htPresent();
}

function htPresent() {
  const s = htState.steps[htState.idx];
  document.getElementById('ht-ear').textContent =
    (s.ear === 'right' ? 'RIGHT ear  👉👂' : 'LEFT ear  👂👈');
  document.getElementById('ht-freq').textContent = s.freq + ' Hz';
  document.getElementById('ht-progress-fill').style.width =
    Math.round(htState.idx / htState.steps.length * 100) + '%';
  document.getElementById('ht-progress-label').textContent =
    'Test ' + (htState.idx + 1) + ' of ' + htState.steps.length;
  htPlayTone(s.freq, s.ear, htState.currentStep);
}

function htReplay() {
  if (!htState || htState.idx >= htState.steps.length) return;
  const s = htState.steps[htState.idx];
  htPlayTone(s.freq, s.ear, htState.currentStep);
}

// Descending staircase: "I hear it" → quieter; "I hear nothing" → the
// threshold is the last step that WAS heard. If the very first (audible)
// level isn't heard, step louder until it is (or bottom out as "no response").
function htAnswer(heard) {
  if (!htState) return;
  if (heard) {
    htState.lastHeard = htState.currentStep;
    htState.currentStep += 1;
    if (htState.currentStep > HT_MAX_STEP) return htFinalizeStep(htState.lastHeard);
    htPresent();
  } else {
    if (htState.lastHeard !== null) return htFinalizeStep(htState.lastHeard);
    htState.currentStep -= 1;                       // never heard yet → louder
    if (htState.currentStep < 0) return htFinalizeStep(-1);  // no response even at loudest
    htPresent();
  }
}

function htFinalizeStep(step) {
  const s = htState.steps[htState.idx];
  // dB attenuation tolerated below reference; higher = better. -6 = no response.
  htState.results[s.ear][String(s.freq)] = step >= 0 ? step * HT_STEP_DB : -HT_STEP_DB;
  htState.idx += 1;
  htState.currentStep = 1;
  htState.lastHeard = null;
  if (htState.idx >= htState.steps.length) return htFinish();
  htPresent();
}

function htFinish() {
  document.getElementById('ht-runner').style.display = 'none';
  document.getElementById('ht-finish').style.display = 'block';
  renderAudiogram(htState.results, 'Just now (unsaved)');
}

function htCancel() {
  htState = null;
  document.getElementById('ht-runner').style.display = 'none';
  document.getElementById('ht-finish').style.display = 'none';
  document.getElementById('ht-setup').style.display  = 'block';
  htCloseChart();
}

// Hide the audiogram graph (manual ✕ Close, and auto on start/discard/save).
function htCloseChart() {
  const w = document.getElementById('ht-chart-wrap');
  if (w) w.style.display = 'none';
}

async function htSave() {
  if (!htState) return;
  const meta = {
    headphones: (document.getElementById('ht-headphones').value || '').trim(),
    notes:      (document.getElementById('ht-notes').value || '').trim(),
    band:       htState.band || 'standard',
  };
  const payload = { test_type: 'hearing', results: htState.results, meta };
  try {
    const r = await fetch('/api/medical/test-results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    htCancel();
    document.getElementById('ht-notes').value = '';
    await medTestsLoad();
  } catch (e) { alert('Save failed: ' + e.message); }
}

// ─── Audiogram ──────────────────────────────────────────────────
// Frequencies are derived from the result itself (union of both ears, sorted)
// so any band — standard, extended to 16 kHz, or high-freq-only — renders,
// including older saved tests with a different band.
function htFreqsOf(results) {
  const set = new Set();
  for (const ear of HT_EARS) for (const k of Object.keys(results[ear] || {})) set.add(Number(k));
  return Array.from(set).sort((a, b) => a - b);
}

function renderAudiogram(results, caption) {
  const wrap = document.getElementById('ht-chart-wrap');
  wrap.style.display = 'block';
  document.getElementById('ht-chart-caption').textContent =
    (caption ? caption + ' — ' : '') +
    'uncalibrated screening · higher = heard it quieter (better) · compare ears / track over time';
  const freqs = htFreqsOf(results);
  const labels = freqs.map(f => (f >= 1000 ? (f / 1000) + 'k' : '' + f));
  const dataset = (ear, color, style) => ({
    label: ear === 'right' ? 'Right' : 'Left',
    data: freqs.map(f => { const v = (results[ear] || {})[String(f)]; return v == null ? null : v; }),
    borderColor: color, backgroundColor: color,
    pointStyle: style, pointRadius: 6, borderWidth: 2, tension: 0.2, spanGaps: true,
  });
  if (htChart) htChart.destroy();
  const ctx = document.getElementById('ht-audiogram').getContext('2d');
  htChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [ dataset('right', '#c0392b', 'circle'), dataset('left', '#1565c0', 'crossRot') ] },
    options: {
      responsive: true,
      plugins: { legend: { position: 'top' }, title: { display: true, text: 'Audiogram (relative)' } },
      scales: {
        y: { title: { display: true, text: 'dB below reference — higher = better' } },
        x: { title: { display: true, text: 'Frequency (Hz)' } },
      },
    },
  });
}

// ─── Results list / persistence ─────────────────────────────────
function medTestsInit() { medTestsLoad(); }

async function medTestsLoad() {
  try {
    const r = await fetch('/api/medical/test-results?type=hearing').then(r => r.json());
    HT_RESULTS = Array.isArray(r) ? r : [];
  } catch (e) { HT_RESULTS = []; }
  htRenderResultsList();
}

function htAvgDb(ear, results) {
  const vals = Object.values(results[ear] || {});
  if (!vals.length) return '—';
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) + ' dB';
}

// Human-readable band label for a saved test. Prefers meta.band; falls back to
// the min–max frequency range derived from the result (older rows w/o meta.band).
function htBandLabel(t) {
  const map = {
    standard: 'Standard · 0.25–8 kHz',
    extended: 'Extended · 0.25–16 kHz',
    highfreq: 'High-freq · 8–16 kHz',
  };
  const b = t.meta && t.meta.band;
  if (b && map[b]) return map[b];
  const fs = htFreqsOf(t.results || {});
  if (!fs.length) return '';
  const fmt = f => (f >= 1000 ? (f / 1000) + 'k' : '' + f);
  return fmt(fs[0]) + '–' + fmt(fs[fs.length - 1]) + ' Hz';
}

function htRenderResultsList() {
  const el = document.getElementById('ht-results-list');
  document.getElementById('ht-result-count').textContent = HT_RESULTS.length ? '(' + HT_RESULTS.length + ')' : '';
  if (!HT_RESULTS.length) {
    el.innerHTML = '<div class="med-empty">No hearing tests yet — run one above.</div>';
    return;
  }
  el.innerHTML = HT_RESULTS.map(htRowHtml).join('');
}

function htRowHtml(t) {
  const d  = new Date(t.tested_at).toLocaleString('en-GB', { hour12: false });
  const hp = (t.meta && t.meta.headphones) || '';
  const nt = (t.meta && t.meta.notes) || '';
  return `<div class="med-list-card">
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <span class="med-chip" style="background:#e0f2fe; color:#075985;">🔊 Hearing</span>
      <span class="med-chip" style="background:#fef3c7; color:#854d0e;">${htEsc(htBandLabel(t))}</span>
      <b>${htEsc(d)}</b>
      <span style="flex:1;"></span>
      <button class="btn btn-secondary btn-sm" onclick="htView(${t.id})">View</button>
      <button class="btn btn-secondary btn-sm" onclick="htDelete(${t.id})">✕</button>
    </div>
    <div class="med-meta">Right avg ${htEsc(htAvgDb('right', t.results))} · Left avg ${htEsc(htAvgDb('left', t.results))}${hp ? ' · 🎧 ' + htEsc(hp) : ''}</div>
    ${nt ? `<div class="med-meta">📝 ${htEsc(nt)}</div>` : ''}
  </div>`;
}

function htView(id) {
  const t = HT_RESULTS.find(x => x.id === id);
  if (!t) return;
  const d = new Date(t.tested_at).toLocaleString('en-GB', { hour12: false });
  renderAudiogram(t.results, d + ((t.meta && t.meta.headphones) ? ' · ' + t.meta.headphones : ''));
  document.getElementById('ht-chart-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function htDelete(id) {
  if (!confirm('Delete this hearing test?')) return;
  try {
    const r = await fetch('/api/medical/test-results/' + id, { method: 'DELETE' }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    await medTestsLoad();
  } catch (e) { alert('Delete failed: ' + e.message); }
}
