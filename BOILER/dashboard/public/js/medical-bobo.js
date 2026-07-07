/* medical-bobo.js — "BoBo Balance Board" CALIBRATION wizard (Medical → Settings).
 *
 * The ESP32 bridge (balcony_bridge) publishes a live ~10 Hz position stream to MQTT
 * `mur/home/esp/balcony_bridge/pos` = {ch:[9 raw], x, y} (x = left/right, y = forward/back,
 * each −100..100). This card:
 *   - subscribes to that stream over the browser MQTT-WS bridge (mosquitto :9001, user
 *     dashboard_browser — same pattern as the ESP-Boards live console / Awtrix tab),
 *   - shows the live raw channels + a 2-D position pad,
 *   - runs a ONE-CLICK guided 5-pose calibration (Neutral → Left → Right → Forward → Back),
 *     computes each axis, and PUSHES it via POST /api/esp/boards/balcony_bridge/parameters
 *     → MQTT .../config → the ESP32 saves it to EEPROM and applies it to every frame,
 *   - exposes a Sensitivity slider (cal_sens, applied on the board) and a "Show live values"
 *     toggle that drops the MQTT subscription to free browser resources.
 *
 * All runtime math lives on the ESP32; the dashboard only calibrates + renders.
 */
(function () {
  const DEVICE_ID  = 'balcony_bridge';
  const BROKER_URL = 'ws://192.168.1.189:9001';
  const BROKER_USR = 'dashboard_browser';
  const POS_TOPIC  = 'mur/home/esp/' + DEVICE_ID + '/pos';
  const LIVE_MS    = 3000;   // no pos frame within this window ⇒ "not live" (nobody on BoBo)

  // Default channel names (9-axis IMU: Accel/Gyro/Orient X-Y-Z). Display only.
  const CH_NAMES = ['Accel X','Accel Y','Accel Z','Gyro X','Gyro Y','Gyro Z','Orient X','Orient Y','Orient Z'];

  let _mqtt = null, _mqttUp = false, _liveOn = true;
  let _ch = new Array(9).fill(0), _x = 0, _y = 0, _lastMsg = 0, _live = false;
  let _axMax = new Array(9).fill(1);
  let _cap = null;            // when an array, each incoming frame's ch[] is pushed (capture window)
  let _wizRunning = false;
  let _lastCal = null;        // {ts, x:{ch_x,sign_x,center_x,scale_x,...}, y:{...}}
  let _tick = null, _wired = false;

  const $   = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const visible = () => { const p = $('tab-settings'); return p && p.offsetParent !== null; };
  const clampI = (v) => Math.max(-32000, Math.min(32000, Math.round(v)));

  function status(msg, color) { const s = $('bobo-status'); if (s) { s.textContent = msg; s.style.color = color || '#888'; } }

  // ── live rendering ──────────────────────────────────────────────
  function renderAxesInit() {
    const el = $('bobo-axes'); if (!el || el.dataset.built) return;
    el.dataset.built = '1';
    el.innerHTML = CH_NAMES.map((nm, i) => `
      <div style="display:flex;flex-direction:column;align-items:center;min-width:64px;padding:4px 6px;background:#f7f4ef;border-radius:6px;">
        <span style="font-size:0.62rem;color:#888;">${nm}</span>
        <span data-ax="${i}" style="font-weight:700;font-size:0.8rem;font-variant-numeric:tabular-nums;color:#333;">—</span>
        <div style="position:relative;width:52px;height:5px;background:#e2ddd4;border-radius:3px;margin-top:3px;">
          <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:#c3bcb0;"></div>
          <div data-axb="${i}" style="position:absolute;top:0;bottom:0;width:3px;border-radius:2px;background:#2563eb;left:calc(50% - 1.5px);transition:left .08s linear;"></div>
        </div>
      </div>`).join('');
  }

  function patchLive() {
    for (let i = 0; i < 9; i++) {
      const v = _ch[i] || 0;
      const t = document.querySelector(`[data-ax="${i}"]`); if (t) t.textContent = String(v);
      _axMax[i] = Math.max(_axMax[i] || 1, Math.abs(v));
      const off = Math.max(-24, Math.min(24, (v / _axMax[i]) * 24));
      const b = document.querySelector(`[data-axb="${i}"]`); if (b) b.style.left = `calc(50% - 1.5px + ${off}px)`;
    }
    const px = 50 + (_x / 100) * 45;    // x: −100..100 → left..right
    const py = 50 - (_y / 100) * 45;    // y+ (forward) → up
    const dot = $('bobo-dot'); if (dot) { dot.style.left = `calc(${px}% - 9px)`; dot.style.top = `calc(${py}% - 9px)`; }
    const xv = $('bobo-xval'); if (xv) xv.textContent = (_live ? (_x > 0 ? '+' : '') + _x : '—');
    const yv = $('bobo-yval'); if (yv) yv.textContent = (_live ? (_y > 0 ? '+' : '') + _y : '—');
  }

  function onMsg(_topic, payload) {
    let m; try { m = JSON.parse(payload.toString()); } catch (e) { return; }
    if (Array.isArray(m.ch)) _ch = m.ch;
    if (typeof m.x === 'number') _x = m.x;
    if (typeof m.y === 'number') _y = m.y;
    _lastMsg = Date.now();
    if (_cap) _cap.push(_ch.slice());
    if (visible()) patchLive();
  }

  function tick() {
    _live = (Date.now() - _lastMsg) < LIVE_MS;
    // "Show live values" is an AUTO-DRIVEN indicator of the board link: checked only while BoBo is
    // connected (streaming), unchecked when it disconnects. Disabled so it reads as a status, not a
    // manual switch — the MQTT stream stays connected the whole time so we can detect BoBo returning.
    const cb = $('bobo-live-toggle'); if (cb) { cb.checked = _live; cb.disabled = true; }
    const c = $('bobo-conn');
    if (c) {
      if (!_mqttUp)      { c.textContent = 'connecting to sensor stream…'; c.style.color = '#888'; }
      else if (_live)    { c.textContent = '● live — BoBo connected' + (_lastCal ? '  ·  last calibrated ' + calAge() : ''); c.style.color = '#16a34a'; }
      else               { c.textContent = 'waiting — stand on BoBo to see live data' + (_lastCal ? '  ·  last calibrated ' + calAge() : ''); c.style.color = '#b8860b'; }
    }
    const b = $('bobo-start'); if (b && !_wizRunning) b.disabled = !_live;
  }

  // Enable/disable the live stream. Off = drop the MQTT WS + rendering (frees browser resources).
  function setLive(on) {
    _liveOn = on;
    try { localStorage.setItem('bobo.liveValues', on ? '1' : '0'); } catch (e) { /* ignore */ }
    const cb = $('bobo-live-toggle'); if (cb) cb.checked = on;
    if (on) { connectMqtt(); }
    else {
      if (_mqtt) { try { _mqtt.end(true); } catch (e) { /* ignore */ } _mqtt = null; }
      _mqttUp = false; _live = false;
      const xv = $('bobo-xval'); if (xv) xv.textContent = '—';
      const yv = $('bobo-yval'); if (yv) yv.textContent = '—';
    }
    tick();
  }

  function calAge() {
    if (!_lastCal || !_lastCal.ts) return '';
    try { return new Date(_lastCal.ts).toLocaleString('en-GB', { hour12: false }); } catch (e) { return ''; }
  }

  // ── MQTT (browser WS, dashboard_browser) ────────────────────────
  async function connectMqtt() {
    if (_mqtt || !_liveOn || typeof mqtt === 'undefined') return;
    let pass;
    try { pass = (await (await fetch('/api/dashboard-settings/_mqtt_browser_pass')).json()).value; }
    catch (e) { status('broker pass fetch failed', '#c0392b'); return; }
    if (!pass) { status('MQTT_BROWSER_PASS not set', '#c0392b'); return; }
    _mqtt = mqtt.connect(BROKER_URL, {
      username: BROKER_USR, password: pass,
      clientId: 'bobo-cal-' + Math.random().toString(36).slice(2, 10),
      reconnectPeriod: 5000, connectTimeout: 8000,
    });
    _mqtt.on('connect',   () => { _mqttUp = true; _mqtt.subscribe(POS_TOPIC, { qos: 0 }); });
    _mqtt.on('reconnect', () => { _mqttUp = false; });
    _mqtt.on('close',     () => { _mqttUp = false; });
    _mqtt.on('error',     (e) => { console.error('BoBo MQTT error:', e); });
    _mqtt.on('message',   onMsg);
  }

  // ── calibration ─────────────────────────────────────────────────
  // Per-channel mean + stddev across a hold's samples.
  function stats(samples) {
    const n = samples.length, mean = new Array(9).fill(0), sd = new Array(9).fill(0);
    for (const s of samples) for (let i = 0; i < 9; i++) mean[i] += (s[i] || 0);
    for (let i = 0; i < 9; i++) mean[i] /= n;
    for (const s of samples) for (let i = 0; i < 9; i++) { const d = (s[i] || 0) - mean[i]; sd[i] += d * d; }
    for (let i = 0; i < 9; i++) sd[i] = Math.sqrt(sd[i] / n);
    return { mean, sd };
  }

  // Pick the channel that best (and stably) separates a HELD left vs right lean.
  // Score = |right−left| / hold-noise, but only for channels whose center sits BETWEEN
  // left and right (monotonic tilt response). This rejects gyro/motion channels — they
  // read ~0 when held (tiny separation) and their center isn't between the leans.
  function computeCal(cS, lS, rS) {
    const c = stats(cS), l = stats(lS), r = stats(rS);
    let ch = -1, best = -1, bestSep = 0;
    for (let i = 0; i < 9; i++) {
      const sep   = Math.abs(r.mean[i] - l.mean[i]);
      const noise = Math.max(c.sd[i], l.sd[i], r.sd[i], 1);
      const lo = Math.min(l.mean[i], r.mean[i]), hi = Math.max(l.mean[i], r.mean[i]);
      const mono  = c.mean[i] >= lo - noise && c.mean[i] <= hi + noise;
      const score = mono ? sep / noise : 0;
      if (score > best) { best = score; bestSep = sep; ch = i; }
    }
    if (ch < 0 || bestSep < 3) return null;   // no clear left/right signal found
    const center = clampI(c.mean[ch]);
    const sign   = (r.mean[ch] - c.mean[ch]) >= 0 ? 1 : -1;
    let scale    = Math.round((Math.abs(l.mean[ch] - center) + Math.abs(r.mean[ch] - center)) / 2);
    scale = Math.max(1, Math.min(32000, scale));
    return { ch_x: ch, sign_x: sign, center_x: center, scale_x: scale, ch_name: CH_NAMES[ch], quality: Math.round(best) };
  }

  async function pushCal(cx, cy) {
    try {
      const r = await fetch('/api/esp/boards/' + DEVICE_ID + '/parameters', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calibrated: 1,
          cal_ch_x: cx.ch_x, cal_sign_x: cx.sign_x, cal_center_x: cx.center_x, cal_scale_x: cx.scale_x,
          cal_ch_y: cy.ch_x, cal_sign_y: cy.sign_x, cal_center_y: cy.center_x, cal_scale_y: cy.scale_x,
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return true;
    } catch (e) { status('Push failed: ' + e.message, '#c0392b'); return false; }
  }

  async function saveCalMeta(cal) {
    try {
      await fetch('/api/dashboard-settings/medical.bobo_cal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: cal }),
      });
    } catch (e) { /* non-fatal — the board's EEPROM is the source of truth */ }
  }

  // ── board tuning: sensitivity (gain) + deadzone ─────────────────
  // Both live in the board's EEPROM. We also mirror them in dashboard_settings.medical.bobo_tune
  // so the sliders reload correctly (the esp_boards /parameters endpoint REPLACES its params
  // column on each push, so it can't be trusted to still hold both values).
  async function loadTuning() {
    let sv = 100, dz = 0;
    try {
      const j = await (await fetch('/api/dashboard-settings/medical.bobo_tune')).json();
      const t = j && j.value;
      if (t) { if (typeof t.sens === 'number') sv = t.sens; if (typeof t.deadzone === 'number') dz = t.deadzone; }
    } catch (e) { /* defaults */ }
    const sl = $('bobo-sens');     if (sl)  sl.value = sv;
    const slb = $('bobo-sens-val'); if (slb) slb.textContent = sv + '%';
    const dl = $('bobo-dz');       if (dl)  dl.value = dz;
    const dlb = $('bobo-dz-val');   if (dlb) dlb.textContent = dz;
  }

  // Push BOTH values together so the board (and the settings mirror) always have a consistent pair.
  async function pushTuning() {
    const sv = parseInt(($('bobo-sens') || {}).value || '100', 10);
    const dz = parseInt(($('bobo-dz')   || {}).value || '0',   10);
    try {
      const r = await fetch('/api/esp/boards/' + DEVICE_ID + '/parameters', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cal_sens: sv, cal_deadzone: dz }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      fetch('/api/dashboard-settings/medical.bobo_tune', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: { sens: sv, deadzone: dz } }),
      }).catch(() => {});
      status('Saved: sensitivity ' + sv + '%, deadzone ' + dz, '#2e7d32');
    } catch (e) { status('Tuning push failed: ' + e.message, '#c0392b'); }
  }

  async function loadCalMeta() {
    try {
      const j = await (await fetch('/api/dashboard-settings/medical.bobo_cal')).json();
      if (j && j.value && j.value.ts) _lastCal = j.value;
    } catch (e) { /* ignore */ }
  }

  const setStep  = (t, s) => { const a = $('bobo-wiz-step'); if (a) a.textContent = t; const b = $('bobo-wiz-sub'); if (b) b.textContent = s || ''; };
  const setCount = (v)    => { const c = $('bobo-wiz-count'); if (c) c.textContent = (v == null ? '' : String(v)); };
  const showWiz  = (on)   => { const w = $('bobo-wiz'); if (w) w.style.display = on ? 'block' : 'none'; };

  async function runCalibration() {
    if (_wizRunning) return;
    if (!_live) { status('Stand on BoBo first — no live data.', '#c0392b'); return; }
    _wizRunning = true; status('', '#888');
    const startBtn = $('bobo-start'); if (startBtn) startBtn.disabled = true;
    showWiz(true);
    // 2-axis capture. X = left/right lean (drives the ball); Y = forward/back lean (spare/2-D).
    // Directions: lean LEFT → x−100, RIGHT → x+100; FORWARD → y+100, BACK → y−100.
    const steps = [
      { key: 'center',  label: 'Stand NEUTRAL (balanced)', sub: 'board level — hold still' },
      { key: 'left',    label: 'Lean LEFT',                sub: 'the ball goes LEFT — hold still' },
      { key: 'right',   label: 'Lean RIGHT',               sub: 'the ball goes RIGHT — hold still' },
      { key: 'forward', label: 'Lean FORWARD',             sub: 'hold still' },
      { key: 'back',    label: 'Lean BACK / DOWN',         sub: 'hold still' },
    ];
    const caps = {};
    for (const s of steps) {
      setStep(s.label, s.sub);
      for (let n = 3; n >= 1; n--) { setCount(n); await sleep(900); }
      setCount('Hold…');
      await sleep(1000);           // settle: let the lean stabilize — capture NOTHING yet
      setCount('Capturing…');
      _cap = [];
      await sleep(1600);           // capture only the steady hold
      const samples = _cap; _cap = null;
      if (!samples || samples.length < 5) { showWiz(false); _wizRunning = false; status('Lost signal during capture — try again.', '#c0392b'); return; }
      caps[s.key] = samples;       // keep raw samples for noise-aware channel selection
    }
    setStep('Computing…', ''); setCount('');
    const calX = computeCal(caps.center, caps.left, caps.right);    // left→−, right→+
    const calY = computeCal(caps.center, caps.back, caps.forward);  // back→−, forward→+
    if (!calX || !calY) {
      showWiz(false); _wizRunning = false;
      status('No clear signal on ' + (!calX ? 'left/right' : 'forward/back') + ' — lean further that way and retry.', '#c0392b');
      return;
    }
    const ok = await pushCal(calX, calY);
    showWiz(false); _wizRunning = false;
    if (ok) {
      _lastCal = { ts: Date.now(), x: calX, y: calY };
      saveCalMeta(_lastCal);
      status(`✓ Calibrated — L/R axis ch${calX.ch_x}, F/B axis ch${calY.ch_x}. Lean to test the pad above.`, '#2e7d32');
    }
  }

  // ── entry point (called on Settings-tab open) ───────────────────
  window.medBoboSettingsInit = async function () {
    renderAxesInit();
    status('', '#888');
    _liveOn = true;   // stream stays connected while the tab is open; the checkbox is now an auto indicator
    const cb = $('bobo-live-toggle'); if (cb) cb.disabled = true;
    await loadCalMeta();
    loadTuning();
    if (!_wired) {
      const b = $('bobo-start'); if (b) b.addEventListener('click', runCalibration);
      const t = $('bobo-live-toggle'); if (t) t.addEventListener('change', () => setLive(t.checked));
      const sl = $('bobo-sens');
      if (sl) {
        sl.addEventListener('input',  () => { const lb = $('bobo-sens-val'); if (lb) lb.textContent = sl.value + '%'; });
        sl.addEventListener('change', pushTuning);
      }
      const dl = $('bobo-dz');
      if (dl) {
        dl.addEventListener('input',  () => { const lb = $('bobo-dz-val'); if (lb) lb.textContent = dl.value; });
        dl.addEventListener('change', pushTuning);
      }
      _wired = true;
    }
    connectMqtt();   // always monitor so the indicator can follow BoBo connect/disconnect
    if (_tick) clearInterval(_tick);
    tick(); _tick = setInterval(tick, 500);
    if (visible()) patchLive();
  };
})();
