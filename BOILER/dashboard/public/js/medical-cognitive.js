// Medical → Tests → 🧠 Cognitive short test.
// A ~2-3 min self-screen across 3 domains — reaction time, digit span, Stroop —
// stored as test_type='cognitive' via /api/medical/test-results and shown in the
// shared Test Results list (medical-hearing.js owns the list; it dispatches the
// cognitive row/summary/view to the ct* functions here).
//
// ⚠ Screening/self-monitoring only, NOT a diagnosis. Age drives a rough
// "below/average/above" rating from approximate reference midpoints — not a
// clinical instrument (MoCA/MMSE are clinician-administered).

// ── age helpers ──────────────────────────────────────────────────
function ctAgeFromDob(dob) {
  try {
    const d = new Date(dob), now = new Date();
    let a = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
    return a;
  } catch (e) { return null; }
}
function ctAgeBand(age) {
  if (age == null) return null;
  if (age < 40) return 'u40';
  if (age < 50) return '40';
  if (age < 60) return '50';
  if (age < 70) return '60';
  if (age < 80) return '70';
  return '80';
}
const CT_BAND_LABEL = { u40: 'under 40', '40': '40–49', '50': '50–59', '60': '60–69', '70': '70–79', '80': '80+' };

// Rough reference midpoints per age band (NOT clinical): rt = MEDIAN simple
// reaction time in ms (lower better); span = max forward digit span (higher
// better); stroop = CORRECT taps in 30 s (higher better).
// ⚠ These are rebased for THIS test's modality — a browser page tapped with a
// mouse/trackpad, which adds ~60–110 ms of display + input latency vs the
// keyboard/button-box setups the clinical literature uses. Lab RT norms (~270 ms)
// would flag a normal browser user as "below average", so the RT midpoints below
// carry a fixed browser offset and Stroop counts a click-realistic throughput.
const CT_NORMS = {
  u40: { rt: 330, span: 7.0, stroop: 22 },
  '40': { rt: 345, span: 7.0, stroop: 21 },
  '50': { rt: 360, span: 6.5, stroop: 19 },
  '60': { rt: 385, span: 6.0, stroop: 17 },
  '70': { rt: 410, span: 6.0, stroop: 15 },
  '80': { rt: 440, span: 5.5, stroop: 13 },
};
function ctRate(score, norm, dir, tol) {
  if (score == null || norm == null) return { label: '—', color: '#888' };
  const diff = score - norm;
  const good = dir === 'lower' ? diff <= -tol : diff >= tol;
  const bad  = dir === 'lower' ? diff >= tol : diff <= -tol;
  if (good) return { label: 'above average', color: '#166534' };
  if (bad)  return { label: 'below average', color: '#b91c1c' };
  return { label: 'average', color: '#854d0e' };
}

// ── state + flow ─────────────────────────────────────────────────
let ctState = null;

async function ctStart() {   // called by medPersonConfirm() after the person modal
  const uid = window._medTestUserId || null;
  let age = null;
  if (uid) {
    try {
      const profs = await (await fetch('/api/personal-health/profiles')).json();
      const p = (Array.isArray(profs) ? profs : []).find(x => String(x.user_id) === String(uid) && x.date_of_birth);
      if (p) age = ctAgeFromDob(p.date_of_birth);
    } catch (e) {}
  }
  ctState = { userId: uid, age, band: ctAgeBand(age), results: {} };
  document.getElementById('ct-setup').style.display = 'none';
  document.getElementById('ct-finish').style.display = 'none';
  const runner = document.getElementById('ct-runner');
  runner.style.display = 'block';
  if (ctState.band) ctIntro(); else ctAskAge();   // person had DOB → use it; else pick a band
}

function ctAskAge() {
  const runner = document.getElementById('ct-runner');
  runner.innerHTML = `<div style="font-size:0.9rem; margin-bottom:10px;">No age on file for this person — pick an age band (age-adjusts the rating):</div>
    <select id="ct-age-sel" style="padding:6px 9px; border:1px solid #d0cbc4; border-radius:5px; font-size:0.95rem;">
      <option value="">— select —</option>
      <option value="u40">under 40</option><option value="40">40–49</option><option value="50">50–59</option>
      <option value="60">60–69</option><option value="70">70–79</option><option value="80">80+</option>
    </select>
    <div style="margin-top:12px;"><button class="btn btn-success" id="ct-age-go">Continue</button>
      <button class="btn btn-secondary" onclick="ctCancel()">Cancel</button></div>`;
  document.getElementById('ct-age-go').onclick = () => {
    const b = document.getElementById('ct-age-sel').value;
    if (!b) { alert('Please select an age band.'); return; }
    ctState.band = b; ctIntro();
  };
}

function ctIntro() {
  const runner = document.getElementById('ct-runner');
  runner.innerHTML = `<div style="font-size:0.9rem; margin-bottom:8px;">3 quick tasks — reaction, memory, attention.</div>
    <div style="font-size:0.78rem; color:#888; margin-bottom:12px;">Age band: <b>${CT_BAND_LABEL[ctState.band]}</b>${ctState.age ? ' (age ' + ctState.age + ')' : ''}</div>
    <button class="btn btn-success" id="ct-intro-go">▶ Start task 1</button>
    <button class="btn btn-secondary" onclick="ctCancel()">Cancel</button>`;
  document.getElementById('ct-intro-go').onclick = () => ctReaction(r => {
    ctState.results.reaction = r;
    ctDigitSpan(r2 => {
      ctState.results.digit_span = r2;
      ctStroop(r3 => { ctState.results.stroop = r3; ctFinish(); });
    });
  });
}

// ── Task 1: reaction time ────────────────────────────────────────
function ctReaction(next) {
  const runner = document.getElementById('ct-runner');
  const TRIALS = 5, times = [];
  let trial = 0, greenAt = 0, waiting = false, timer = null;
  function trialView() {
    runner.innerHTML = `<div style="font-size:0.9rem; color:#555; margin-bottom:8px;">Task 1/3 · Reaction time — trial ${trial + 1}/${TRIALS}</div>
      <div id="ct-rt-box" style="width:230px; height:130px; margin:0 auto; border-radius:10px; background:#9ca3af; display:flex; align-items:center; justify-content:center; color:#fff; font-size:1.1rem; cursor:pointer; user-select:none;">Wait for green…</div>
      <div style="font-size:0.78rem; color:#888; margin-top:8px;">Tap the box the instant it turns green.</div>`;
    const box = document.getElementById('ct-rt-box');
    waiting = true; greenAt = 0;
    timer = setTimeout(() => { box.style.background = '#16a34a'; box.textContent = 'TAP!'; greenAt = performance.now(); waiting = false; }, 1200 + Math.random() * 2600);
    box.onclick = () => {
      if (waiting) { clearTimeout(timer); box.style.background = '#b91c1c'; box.textContent = 'Too early — wait for green'; setTimeout(trialView, 900); return; }
      if (greenAt) {
        times.push(Math.round(performance.now() - greenAt)); greenAt = 0; trial++;
        if (trial >= TRIALS) {
          // MEDIAN (not mean) so a single attention lapse can't inflate the score.
          const sorted = times.slice().sort((a, b) => a - b);
          const n = sorted.length;
          const median = n % 2 ? sorted[(n - 1) / 2] : Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
          const mean = Math.round(times.reduce((a, b) => a + b, 0) / n);
          next({ avg_ms: median, median_ms: median, mean_ms: mean, trials: times });
        } else trialView();
      }
    };
  }
  runner.innerHTML = `<div style="font-size:0.95rem; margin-bottom:10px;">🖱️ <b>Reaction time</b> (Task 1 of 3)</div>
    <div style="font-size:0.85rem; color:#555; margin-bottom:12px;">A box turns <b style="color:#16a34a;">green</b> after a random wait — tap it as fast as you can. 5 trials (don't tap early).</div>
    <button class="btn btn-success" id="ct-rt-go">Begin</button>`;
  document.getElementById('ct-rt-go').onclick = trialView;
}

// ── Task 2: digit span ───────────────────────────────────────────
function ctDigitSpan(next) {
  const runner = document.getElementById('ct-runner');
  let len = 3, maxPassed = 0, attempts = 0, seq = [];
  function flash() {
    seq = Array.from({ length: len }, () => Math.floor(Math.random() * 10));
    runner.innerHTML = `<div style="font-size:0.9rem; color:#555; margin-bottom:8px;">Task 2/3 · Digit span — length ${len}</div>
      <div id="ct-ds-flash" style="font-size:2.8rem; font-weight:700; letter-spacing:6px; height:64px;">&nbsp;</div>
      <div style="font-size:0.78rem; color:#888;">Memorise the digits…</div>`;
    const el = document.getElementById('ct-ds-flash');
    let i = 0;
    (function tick() {
      if (!el) return;
      if (i >= seq.length) { el.innerHTML = '&nbsp;'; setTimeout(askInput, 450); return; }
      el.textContent = seq[i]; i++;
      setTimeout(() => { if (el) el.innerHTML = '&nbsp;'; setTimeout(tick, 180); }, 650);
    })();
  }
  function askInput() {
    runner.innerHTML = `<div style="font-size:0.9rem; color:#555; margin-bottom:8px;">Task 2/3 · Digit span — length ${len}</div>
      <div style="font-size:0.85rem; margin-bottom:8px;">Type the digits in order:</div>
      <input id="ct-ds-input" inputmode="numeric" autocomplete="off" style="font-size:1.4rem; letter-spacing:4px; text-align:center; width:210px; padding:6px; border:1px solid #d0cbc4; border-radius:6px;">
      <div style="margin-top:10px;"><button class="btn btn-success" id="ct-ds-ok">OK</button></div>`;
    const inp = document.getElementById('ct-ds-input'); inp.focus();
    const submit = () => {
      const ok = (inp.value || '').replace(/\D/g, '') === seq.join('');
      if (ok) { maxPassed = len; len++; attempts = 0; flash(); }
      else { attempts++; if (attempts >= 2) next({ max_span: maxPassed }); else flash(); }
    };
    document.getElementById('ct-ds-ok').onclick = submit;
    inp.onkeydown = e => { if (e.key === 'Enter') submit(); };
  }
  runner.innerHTML = `<div style="font-size:0.95rem; margin-bottom:10px;">🔢 <b>Digit span</b> (Task 2 of 3)</div>
    <div style="font-size:0.85rem; color:#555; margin-bottom:12px;">Digits flash one at a time — then type them back in order. Each round gets longer until you miss (2 tries per length).</div>
    <button class="btn btn-success" id="ct-ds-begin">Begin</button>`;
  document.getElementById('ct-ds-begin').onclick = flash;
}

// ── Task 3: Stroop ───────────────────────────────────────────────
function ctStroop(next) {
  const runner = document.getElementById('ct-runner');
  const COLORS = [{ name: 'RED', hex: '#dc2626' }, { name: 'GREEN', hex: '#16a34a' }, { name: 'BLUE', hex: '#2563eb' }, { name: 'YELLOW', hex: '#ca8a04' }];
  let correct = 0, wrong = 0, cur = null, endAt = 0, running = false, ticker = null;
  function draw() {
    const remain = Math.max(0, Math.ceil((endAt - performance.now()) / 1000));
    runner.innerHTML = `<div id="ct-st-hdr" style="font-size:0.9rem; color:#555; margin-bottom:6px;">Task 3/3 · Stroop — tap the INK colour · ${remain}s · ✔${correct} ✗${wrong}</div>
      <div style="font-size:2.6rem; font-weight:800; margin:14px 0; color:${COLORS[cur.ink].hex};">${cur.word}</div>
      <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
        ${COLORS.map((c, i) => `<button class="btn" style="background:${c.hex}; color:#fff; min-width:82px;" data-ci="${i}">${c.name}</button>`).join('')}</div>
      <div style="font-size:0.76rem; color:#888; margin-top:8px;">Tap the colour the word is <b>printed in</b> — not what it says.</div>`;
    runner.querySelectorAll('[data-ci]').forEach(b => b.onclick = () => {
      if (!running) return;
      if (parseInt(b.dataset.ci) === cur.ink) correct++; else wrong++;
      nextWord();
    });
  }
  function nextWord() {
    const w = Math.floor(Math.random() * 4);
    let ink = Math.floor(Math.random() * 4);
    while (ink === w) ink = Math.floor(Math.random() * 4);
    cur = { word: COLORS[w].name, ink };
    draw();
  }
  function begin() {
    running = true; endAt = performance.now() + 30000; nextWord();
    ticker = setInterval(() => {
      const remain = Math.max(0, Math.ceil((endAt - performance.now()) / 1000));
      const hdr = document.getElementById('ct-st-hdr');
      if (hdr) hdr.textContent = `Task 3/3 · Stroop — tap the INK colour · ${remain}s · ✔${correct} ✗${wrong}`;
      if (performance.now() >= endAt) { clearInterval(ticker); running = false; next({ correct, wrong, score: correct, net: Math.max(0, correct - wrong) }); }
    }, 250);
  }
  runner.innerHTML = `<div style="font-size:0.95rem; margin-bottom:10px;">🎨 <b>Stroop</b> (Task 3 of 3)</div>
    <div style="font-size:0.85rem; color:#555; margin-bottom:12px;">A colour word appears in a <b>different</b> ink colour. Tap the <b>ink colour</b> (not the word). 30 seconds — as many as you can.</div>
    <button class="btn btn-success" id="ct-st-begin">Begin</button>`;
  document.getElementById('ct-st-begin').onclick = begin;
}

// ── finish / save / cancel ───────────────────────────────────────
function ctFinish() {
  document.getElementById('ct-runner').style.display = 'none';
  document.getElementById('ct-runner').innerHTML = '';
  document.getElementById('ct-finish').style.display = 'block';
  const s = ctScores({ results: ctState.results });
  document.getElementById('ct-finish-msg').innerHTML =
    `Done — reaction <b>${s.rt} ms</b> · digit span <b>${s.span}</b> · Stroop <b>${s.stroop}</b>. Save to keep it.`;
}
async function ctSave() {
  if (!ctState) return;
  const meta = { notes: (document.getElementById('ct-notes').value || '').trim() || null, age: ctState.age, age_band: ctState.band };
  try {
    const r = await fetch('/api/medical/test-results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_type: 'cognitive', results: ctState.results, meta, user_id: ctState.userId }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
    ctCancel();
    if (typeof medTestsLoad === 'function') medTestsLoad();
  } catch (e) { alert('Save failed: ' + (e.message || e)); }
}
function ctCancel() {
  const runner = document.getElementById('ct-runner');
  runner.style.display = 'none'; runner.innerHTML = '';
  document.getElementById('ct-finish').style.display = 'none';
  document.getElementById('ct-setup').style.display = 'block';
  const nt = document.getElementById('ct-notes'); if (nt) nt.value = '';
  ctState = null;
}

// ── results rendering (called by medical-hearing.js) ─────────────
function ctScores(t) {
  const r = (t && t.results) || {};
  return {
    rt: r.reaction && r.reaction.avg_ms != null ? r.reaction.avg_ms : null,
    span: r.digit_span && r.digit_span.max_span != null ? r.digit_span.max_span : null,
    stroop: r.stroop ? (r.stroop.score != null ? r.stroop.score : (r.stroop.correct != null ? r.stroop.correct : (r.stroop.net != null ? r.stroop.net : null))) : null,
  };
}
function ctBandOf(t) { return (t.meta && t.meta.age_band) || ctAgeBand(t.meta && t.meta.age); }
function ctRatings(t) {
  const s = ctScores(t), n = CT_NORMS[ctBandOf(t)] || null;
  return {
    rt: ctRate(s.rt, n && n.rt, 'lower', 45),
    span: ctRate(s.span, n && n.span, 'higher', 1.0),
    stroop: ctRate(s.stroop, n && n.stroop, 'higher', 3),
  };
}
function ctRowSummary(t) {
  const s = ctScores(t);
  return `Reaction ${s.rt != null ? s.rt + ' ms' : '—'} · Span ${s.span != null ? s.span : '—'} · Stroop ${s.stroop != null ? s.stroop : '—'}`;
}
function ctRenderResult(t) {
  const s = ctScores(t), rt = ctRatings(t), band = ctBandOf(t);
  const row = (label, val, unit, r) => `<tr style="border-bottom:1px solid #f0f0f0;">
    <td style="padding:6px 10px;">${label}</td>
    <td style="padding:6px 10px; text-align:right; font-weight:600;">${val != null ? val + (unit || '') : '—'}</td>
    <td style="padding:6px 10px; color:${r.color};">${r.label}</td></tr>`;
  document.getElementById('ct-result-body').innerHTML =
    `<div style="font-size:0.85rem; color:#555; margin-bottom:6px;">Age band: <b>${CT_BAND_LABEL[band] || '—'}</b> · <span style="color:#9a3412;">a screen, not a diagnosis</span></div>
     <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
       <tr style="color:#666; border-bottom:2px solid #eee;"><th style="text-align:left; padding:6px 10px;">Domain</th><th style="text-align:right; padding:6px 10px;">Score</th><th style="text-align:left; padding:6px 10px;">vs age</th></tr>
       ${row('🖱️ Reaction time', s.rt, ' ms', rt.rt)}
       ${row('🔢 Digit span', s.span, '', rt.span)}
       ${row('🎨 Stroop (correct / 30 s)', s.stroop, '', rt.stroop)}
     </table>`;
  const wrap = document.getElementById('ct-result-wrap');
  wrap.style.display = 'block';
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function ctCloseResult() { const w = document.getElementById('ct-result-wrap'); if (w) w.style.display = 'none'; }
