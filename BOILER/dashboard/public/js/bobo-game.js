/* bobo-game.js — BoBo Balance "Colour Tunnel" game (Medical → Settings → 🎮 BoBo Game card).
 *
 * Reads the calibrated lean position `x` (−100..100) from the ESP32 bridge over MQTT-WS
 * (same stream the calibration wizard uses) and plays a lightweight pseudo-3D tunnel dodger.
 * Lean LEFT/RIGHT to steer the ship into the gaps; survive as long as you can. On crash the
 * score is written to the player's medical record (`medical_test_results`, test_type='balance').
 * ▶ Play opens a full-viewport overlay; game-over/Exit returns to the card.
 *
 * All-local, no CDN (mqtt lib vendored at /vendor/mqtt/mqtt.min.js). Arrow keys work as a
 * fallback for desktop testing without BoBo. Difficulty is remembered per household user.
 * Entry point: window.boboGameInit() — called from the Medical Settings tab; renders the start
 * screen into #bobo-root (the game card). window.renderBalance(t) draws a saved score's detail.
 */
(function () {
  const BROKER_URL = 'ws://192.168.1.189:9001';
  const BROKER_USR = 'dashboard_browser';
  const POS_TOPIC  = 'mur/home/esp/balcony_bridge/pos';
  const LIVE_MS    = 3000;

  // Difficulty presets: base = tunnel-approach speed (depth/sec); ramp = speed gained per sec;
  // gap = gap width as a fraction of tunnel width; spawn = base seconds between obstacles.
  const LEVELS = {
    easy:   { label: 'Easy',   base: 0.30, ramp: 0.010, gap: 0.44, spawn: 2.2, tag: '#22c55e' },
    medium: { label: 'Medium', base: 0.42, ramp: 0.016, gap: 0.34, spawn: 1.7, tag: '#eab308' },
    hard:   { label: 'Hard',   base: 0.58, ramp: 0.024, gap: 0.26, spawn: 1.2, tag: '#ef4444' },
  };

  const $   = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let _mqtt = null, _mqttUp = false, _x = 0, _lastMsg = 0, _key = 0;
  let _players = [], _sel = null, _level = 'medium', _userLevels = {};
  let _wired = false, _inited = false, _statusTimer = null;

  // ── MQTT input (reuse the wizard's pattern; own clientId) ──────────
  async function connectMqtt() {
    if (_mqtt || typeof mqtt === 'undefined') return;
    let pass;
    try { pass = (await (await fetch('/api/dashboard-settings/_mqtt_browser_pass')).json()).value; }
    catch (e) { return; }
    if (!pass) return;
    _mqtt = mqtt.connect(BROKER_URL, {
      username: BROKER_USR, password: pass,
      clientId: 'bobo-game-' + Math.random().toString(36).slice(2, 10),
      reconnectPeriod: 5000, connectTimeout: 8000,
    });
    _mqtt.on('connect', () => { _mqttUp = true; _mqtt.subscribe(POS_TOPIC, { qos: 0 }); });
    _mqtt.on('reconnect', () => { _mqttUp = false; });
    _mqtt.on('close', () => { _mqttUp = false; });
    _mqtt.on('error', (e) => console.error('bobo-game mqtt:', e));
    _mqtt.on('message', (_t, p) => {
      try { const m = JSON.parse(p.toString()); if (typeof m.x === 'number') { _x = m.x; _lastMsg = Date.now(); } } catch (e) { /* ignore */ }
    });
  }
  const live  = () => (Date.now() - _lastMsg) < LIVE_MS;
  const input = () => (live() ? _x : _key);   // −100..100

  // ── data (all existing endpoints) ─────────────────────────────────
  async function loadPlayers() {
    try { const j = await (await fetch('/api/household-users')).json(); _players = Array.isArray(j) ? j : []; }
    catch (e) { _players = []; }
  }
  async function loadLevels() {
    try { const j = await (await fetch('/api/dashboard-settings/medical.bobo_game')).json(); const v = j && j.value; if (v && v.levels) _userLevels = v.levels; }
    catch (e) { /* defaults */ }
  }
  async function saveLevel() {
    if (!_sel) return;
    _userLevels[_sel.id] = _level;
    try { await fetch('/api/dashboard-settings/medical.bobo_game', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: { levels: _userLevels } }) }); }
    catch (e) { /* non-fatal */ }
  }
  async function loadRecent() {
    try { const rows = await (await fetch('/api/medical/test-results?type=balance')).json(); return Array.isArray(rows) ? rows.slice(0, 6) : []; }
    catch (e) { return []; }
  }
  async function saveScore(res) {
    try {
      const r = await fetch('/api/medical/test-results', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test_type: 'balance', user_id: _sel ? _sel.id : null, results: res, meta: { game: 'colour_tunnel' } }),
      });
      return r.ok;
    } catch (e) { return false; }
  }

  // ── start screen (rendered into #bobo-root in the Settings game card) ──
  async function renderMenu() {
    const panel = $('bobo-root'); if (!panel) return;   // container inside the Settings "🎮 BoBo Game" card
    const recent = await loadRecent();
    const nameById = {}; _players.forEach(p => { nameById[p.id] = p.name; });
    const playerTiles = _players.length ? _players.map(p => `
      <button class="bobo-tile ${_sel && _sel.id === p.id ? 'sel' : ''}" data-player="${p.id}">🧑 ${esc(p.name)}</button>`).join('')
      : '<span style="color:#999;font-size:0.82rem;">No household users yet — add them in Privacy → Settings → Users.</span>';
    const levelTiles = Object.keys(LEVELS).map(k => `
      <button class="bobo-tile lvl ${_level === k ? 'sel' : ''}" data-level="${k}" style="border-color:${LEVELS[k].tag};color:${_level === k ? '#fff' : LEVELS[k].tag};font-weight:700;">${LEVELS[k].label}</button>`).join('');
    const recentHtml = recent.length ? recent.slice(0, 4).map(r => {
      const nm = r.member_name || nameById[r.user_id] || '—';
      const sc = (r.results && r.results.score != null) ? r.results.score : '—';
      return `<span style="display:inline-block;font-size:0.78rem;color:#555;margin-right:12px;white-space:nowrap;">🧑 ${esc(nm)}: <b>${esc(sc)}</b></span>`;
    }).join('') : '<span style="color:#999;font-size:0.8rem;">No games yet.</span>';

    panel.innerHTML = `
      <style>
        #bobo-root .bobo-tile{cursor:pointer;background:#f7f4ef;border:2px solid #e5e0d8;border-radius:9px;padding:8px 13px;font-size:0.9rem;color:#333;}
        #bobo-root .bobo-tile.sel{background:#2563eb;color:#fff !important;border-color:#2563eb;}
        #bobo-root .bobo-tile.lvl.sel{background:#111;border-color:#111;color:#fff !important;}
      </style>
      <div id="bobo-game-status" style="font-size:0.82rem;margin-bottom:12px;color:#888;">connecting…</div>
      <div style="font-size:0.75rem;color:#777;margin-bottom:5px;">1 · Player</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">${playerTiles}</div>
      <div style="font-size:0.75rem;color:#777;margin-bottom:5px;">2 · Difficulty</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">${levelTiles}</div>
      <button id="bobo-play" style="background:#16a34a;color:#fff;font-size:1.1rem;padding:11px 26px;border-radius:11px;border:none;cursor:pointer;">▶ Play</button>
      <div style="color:#999;font-size:0.76rem;margin-top:9px;">Lean left / right to steer · arrow keys also work · plays full-screen</div>
      <div style="margin-top:16px;border-top:1px solid #f0ece6;padding-top:9px;">
        <span style="font-size:0.75rem;color:#777;">Recent:</span> ${recentHtml}
      </div>`;

    panel.querySelectorAll('[data-player]').forEach(el => el.addEventListener('click', () => {
      _sel = _players.find(p => String(p.id) === el.dataset.player) || null;
      if (_sel && _userLevels[_sel.id]) _level = _userLevels[_sel.id];
      renderMenu();
    }));
    panel.querySelectorAll('[data-level]').forEach(el => el.addEventListener('click', () => { _level = el.dataset.level; renderMenu(); }));
    const play = $('bobo-play');
    if (play) play.addEventListener('click', () => { if (!_sel) { alert('Pick a player first'); return; } saveLevel(); startGame(); });
    tickStatus();
  }
  function tickStatus() {
    const s = $('bobo-game-status'); if (!s) return;
    if (!_mqttUp)      { s.textContent = 'connecting to BoBo…'; s.style.color = '#888'; }
    else if (live())   { s.textContent = '● BoBo live — lean to steer'; s.style.color = '#16a34a'; }
    else               { s.textContent = 'waiting for BoBo (stand on the board) — or use arrow keys'; s.style.color = '#b8860b'; }
  }

  // ── game (full-viewport overlay canvas) ───────────────────────────
  let _raf = null, _ov = null, _ctx = null, _cv = null, _last = 0, G = null;

  function startGame() {
    _ov = document.createElement('div');
    _ov.id = 'bobo-overlay';
    _ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#05060a;overflow:hidden;';
    _cv = document.createElement('canvas'); _ov.appendChild(_cv);
    const ex = document.createElement('button'); ex.textContent = '✕'; ex.title = 'Exit';
    ex.style.cssText = 'position:absolute;top:12px;right:16px;z-index:2;background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:8px;font-size:1.3rem;width:46px;height:46px;cursor:pointer;';
    ex.addEventListener('click', () => { quitGame(); renderMenu(); }); _ov.appendChild(ex);
    document.body.appendChild(_ov);
    _ctx = _cv.getContext('2d'); resize();
    window.addEventListener('resize', resize);
    initState(); _last = performance.now(); _raf = requestAnimationFrame(loop);
  }
  function resize() { if (!_cv) return; _cv.width = window.innerWidth; _cv.height = window.innerHeight; }
  function quitGame() {
    if (_raf) cancelAnimationFrame(_raf); _raf = null;
    window.removeEventListener('resize', resize);
    if (_ov && _ov.parentNode) _ov.parentNode.removeChild(_ov);
    _ov = null; _ctx = null; _cv = null; G = null;
  }

  function initState() {
    G = { ship: 0.5, target: 0.5, obstacles: [], t: 0, spawnT: 0.5,
          speed: LEVELS[_level].base, top: LEVELS[_level].base,
          score: 0, passed: 0, alive: true, hue: 200 };
  }
  function spawnObstacle() {
    const gw = LEVELS[_level].gap;
    const g = gw / 2 + Math.random() * (1 - gw);   // gap center fully inside the wall
    G.obstacles.push({ p: 0, g: g, gw: gw, resolved: false, hue: (G.hue + 120) % 360 });
  }
  function loop(ts) {
    _raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (ts - _last) / 1000); _last = ts;
    if (G && G.alive) update(dt);
    draw();
  }
  function update(dt) {
    G.t += dt; G.hue = (G.hue + dt * 24) % 360;
    G.speed = Math.min(1.4, G.speed + LEVELS[_level].ramp * dt); G.top = Math.max(G.top, G.speed);
    G.target = Math.max(0, Math.min(1, (input() + 100) / 200));
    G.ship += (G.target - G.ship) * Math.min(1, dt * 12);
    G.spawnT -= dt;
    const every = LEVELS[_level].spawn / (0.6 + G.speed);
    if (G.spawnT <= 0) { spawnObstacle(); G.spawnT = every; }
    for (const o of G.obstacles) {
      o.p += G.speed * dt;
      if (!o.resolved && o.p >= 0.98) {
        o.resolved = true;
        if (Math.abs(G.ship - o.g) <= o.gw / 2) { G.score += 10; G.passed++; }
        else { G.alive = false; endGame(); return; }
      }
    }
    G.obstacles = G.obstacles.filter(o => o.p < 1.15);
  }
  function draw() {
    const ctx = _ctx; if (!ctx || !G) return;
    const W = _cv.width, H = _cv.height;
    const vpx = W / 2, vpy = H * 0.34, py = H * 0.82, tl = W * 0.10, tr = W * 0.90;
    ctx.fillStyle = '#05060a'; ctx.fillRect(0, 0, W, H);
    // tunnel edges
    ctx.lineWidth = 2; ctx.strokeStyle = `hsla(${G.hue},70%,55%,0.25)`;
    ctx.beginPath();
    ctx.moveTo(vpx, vpy); ctx.lineTo(tl, py); ctx.moveTo(vpx, vpy); ctx.lineTo(tr, py);
    ctx.moveTo(vpx, vpy); ctx.lineTo(tl, H);  ctx.moveTo(vpx, vpy); ctx.lineTo(tr, H); ctx.stroke();
    // depth rings (flying-forward effect)
    const rings = 9;
    for (let i = 0; i < rings; i++) {
      const rp = ((G.t * G.speed * 0.6 + i / rings) % 1);
      const y = vpy + (py - vpy) * rp, w = (tr - tl) * rp;
      ctx.strokeStyle = `hsla(${(G.hue + rp * 80) % 360},80%,55%,${0.08 + 0.22 * rp})`;
      ctx.lineWidth = 1 + 2 * rp;
      ctx.strokeRect(vpx - w / 2, y - H * 0.02 * rp, w, H * 0.04 * rp + 2);
    }
    // obstacles (walls with a gap)
    for (const o of G.obstacles) {
      const y = vpy + (py - vpy) * o.p, w = (tr - tl) * o.p;
      const left = vpx - w / 2, gapC = left + w * o.g, gapHalf = w * o.gw / 2;
      ctx.strokeStyle = `hsl(${o.hue},95%,60%)`; ctx.lineWidth = Math.max(3, 14 * o.p); ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(left, y); ctx.lineTo(gapC - gapHalf, y);
      ctx.moveTo(gapC + gapHalf, y); ctx.lineTo(left + w, y);
      ctx.stroke();
    }
    // ship
    const sx = tl + (tr - tl) * G.ship;
    ctx.fillStyle = '#e5f2ff'; ctx.strokeStyle = `hsl(${G.hue},90%,65%)`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(sx, py - 20); ctx.lineTo(sx - 15, py + 15); ctx.lineTo(sx + 15, py + 15); ctx.closePath(); ctx.fill(); ctx.stroke();
    // HUD
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
    ctx.font = '800 ' + Math.round(H * 0.07) + 'px system-ui,sans-serif';
    ctx.fillText(String(G.score), W / 2, H * 0.13);
    ctx.font = '600 ' + Math.round(H * 0.028) + 'px system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.fillText((_sel ? _sel.name : '') + ' · ' + LEVELS[_level].label, W / 2, H * 0.18);
    if (!live()) { ctx.fillStyle = 'rgba(255,210,0,.7)'; ctx.font = '600 ' + Math.round(H * 0.024) + 'px system-ui,sans-serif'; ctx.fillText('arrow keys (BoBo not detected)', W / 2, H * 0.96); }
  }
  async function endGame() {
    const dur = Math.round(G.t);
    const res = { score: G.score, obstacles: G.passed, duration_s: dur, level: _level, top_speed: Math.round(G.top * 100) / 100 };
    const ok = await saveScore(res);
    if (!_ov) return;
    const p = document.createElement('div');
    p.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(5,6,10,.85);color:#fff;z-index:3;text-align:center;';
    p.innerHTML = `
      <div style="font-size:2.4rem;font-weight:800;">Game Over</div>
      <div style="font-size:4.4rem;font-weight:900;color:#22c55e;margin:4px 0;">${G.score}</div>
      <div style="opacity:.75;">${G.passed} dodged · ${dur}s · ${LEVELS[_level].label}</div>
      <div style="opacity:.6;margin-top:6px;font-size:.9rem;">${ok ? ('✓ saved to ' + esc(_sel ? _sel.name : '—') + "'s medical") : '⚠ save failed'}</div>
      <div style="margin-top:28px;display:flex;gap:14px;">
        <button id="bobo-again" style="background:#16a34a;color:#fff;border:none;border-radius:12px;font-size:1.2rem;padding:12px 28px;cursor:pointer;">▶ Play again</button>
        <button id="bobo-quit" style="background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:12px;font-size:1.2rem;padding:12px 28px;cursor:pointer;">Exit</button>
      </div>`;
    _ov.appendChild(p);
    p.querySelector('#bobo-again').addEventListener('click', () => { p.remove(); initState(); _last = performance.now(); });
    p.querySelector('#bobo-quit').addEventListener('click', () => { quitGame(); renderMenu(); });
  }

  // ── keyboard fallback ─────────────────────────────────────────────
  function onKey(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (_ov) e.preventDefault();
    if (e.type === 'keydown') { _key = (e.key === 'ArrowLeft') ? -100 : 100; }
    else { if ((e.key === 'ArrowLeft' && _key < 0) || (e.key === 'ArrowRight' && _key > 0)) _key = 0; }
  }

  // ── entry point (called from the Medical Settings tab) ────────────
  window.boboGameInit = async function () {
    if (!_wired) {
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKey);
      _statusTimer = setInterval(tickStatus, 600);
      _wired = true;
    }
    if (!_inited) { await loadPlayers(); await loadLevels(); _inited = true; }
    connectMqtt();
    renderMenu();
  };

  // Detail view for a saved balance score (called by medTestView in the Tests → Test Results card).
  window.renderBalance = function (t) {
    const rr = t.results || {};
    let d = ''; try { d = new Date(t.tested_at).toLocaleString('en-GB', { hour12: false }); } catch (e) {}
    const m = document.createElement('div');
    m.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);';
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    m.innerHTML = `<div style="background:#fff;border-radius:14px;padding:22px 28px;max-width:340px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.3);">
      <div style="font-size:1.1rem;font-weight:700;color:#166534;">⚖ Balance — Colour Tunnel</div>
      <div style="font-size:3.4rem;font-weight:900;color:#16a34a;margin:6px 0;">${esc(rr.score != null ? rr.score : '—')}</div>
      <div style="color:#555;font-size:.9rem;line-height:1.9;text-align:left;display:inline-block;">
        Player: <b>${esc(t.member_name || '—')}</b><br>
        Difficulty: <b>${esc(rr.level || '—')}</b><br>
        Obstacles dodged: <b>${esc(rr.obstacles != null ? rr.obstacles : 0)}</b><br>
        Duration: <b>${esc(rr.duration_s != null ? rr.duration_s : 0)}s</b><br>
        Top speed: <b>${esc(rr.top_speed != null ? rr.top_speed : '—')}</b><br>
        <span style="color:#999;font-size:.82rem;">${esc(d)}</span>
      </div>
      <div><button style="margin-top:16px;background:#2563eb;color:#fff;border:none;border-radius:10px;padding:8px 24px;cursor:pointer;">Close</button></div>
    </div>`;
    m.querySelector('button').addEventListener('click', () => m.remove());
    document.body.appendChild(m);
  };
})();
