/* bobo-game.js — BoBo balance-game SHELL + game registry.
 *
 * Host-agnostic: reads window.BOBO_CFG for all endpoint URLs + MQTT creds, so the SAME file runs
 *   (a) on the dashboard (Medical → Settings game card, default endpoints), and
 *   (b) on LXC 100's standalone TV page (/api/bobo/* endpoints) — laptop-independent.
 * The shell owns the shared parts: MQTT-WS board input (x), the menu (game → player → difficulty),
 * the full-viewport overlay + run loop, score→save. Each GAME is a pluggable module registered in
 * window.BOBO_GAMES with { id, name, levels, create(levelKey) -> { alive, update(dt,input),
 * draw(ctx,W,H,env), result(), reset() } }. Colour Tunnel is the first module.
 *
 * Board menu-nav (audit #4): on a TV (no mouse) the menu is steerable by the board — lean LEFT/RIGHT
 * to move the highlight, lean FORWARD/BACK to select. Arrow keys work as a desktop fallback.
 * Auto mode auto-starts with the configured default game/user/difficulty (no click needed).
 * Entry point: window.boboGameInit(); window.renderBalance(t) draws a saved score's detail.
 */
(function () {
  const CFG = window.BOBO_CFG || {};
  const EP = {
    mqttPass:     CFG.mqttPass     || '/api/dashboard-settings/_mqtt_browser_pass',
    players:      CFG.players      || '/api/household-users',
    settingsGet:  CFG.settingsGet  || '/api/dashboard-settings/medical.bobo_game',
    settingsPost: CFG.settingsPost || '/api/dashboard-settings/medical.bobo_game',
    recent:       CFG.recent       || '/api/personal-health/bobo',        // all-players recent
    saveScore:    CFG.saveScore    || '/api/personal-health/bobo',        // BoBo = a PH activity, not a test
  };
  const BROKER_URL = CFG.broker   || 'ws://192.168.1.189:9001';
  const BROKER_USR = CFG.mqttUser || 'dashboard_browser';
  const POS_TOPIC  = CFG.posTopic || 'mur/home/esp/balcony_bridge/pos';
  const LIVE_MS    = 3000;
  // A "TV" context = the standalone LXC page (CFG.autostart) or the #bobo deep-link. Enables auto-start
  // (per configured mode) + board menu-nav.
  const IS_TV = CFG.autostart === true || (location.hash || '').toLowerCase() === '#bobo';

  const $   = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  window.BOBO_GAMES = window.BOBO_GAMES || {};

  let _mqtt = null, _mqttUp = false, _x = 0, _y = 0, _lastMsg = 0, _key = 0;
  let _players = [], _sel = null, _game = null, _level = 'medium', _settings = { levels: {} };
  let _sets = 3, _hold = 30, _rest = 10;   // Balance Training options (per-user, persisted in _settings.bt)
  let _wired = false, _inited = false, _statusTimer = null;

  // ── MQTT input (reuse the wizard's pattern; own clientId) ──────────
  async function connectMqtt() {
    if (_mqtt || typeof mqtt === 'undefined') return;
    let pass;
    try { pass = (await (await fetch(EP.mqttPass)).json()).value; }
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
      try {
        const m = JSON.parse(p.toString());
        if (typeof m.x === 'number') { _x = m.x; _lastMsg = Date.now(); }
        if (typeof m.y === 'number') { _y = m.y; }
      } catch (e) { /* ignore */ }
    });
  }
  const live   = () => (Date.now() - _lastMsg) < LIVE_MS;   // frames flowing = someone ON the board
  const input  = () => (live() ? _x : _key);   // −100..100 (left/right)
  const inputY = () => (live() ? _y : 0);      // −100..100 (forward/back) — for 2-D balance games

  // ── data (host-agnostic via BOBO_CFG) ─────────────────────────────
  async function loadPlayers() {
    try { const j = await (await fetch(EP.players)).json(); _players = Array.isArray(j) ? j : []; }
    catch (e) { _players = []; }
  }
  async function loadSettings() {
    try { const j = await (await fetch(EP.settingsGet)).json(); _settings = (j && j.value) || {}; }
    catch (e) { _settings = {}; }
    if (!_settings.levels) _settings.levels = {};
    if (!_settings.bt) _settings.bt = {};
  }
  // read-merge-write (audit #3): never clobber levels / bt / mode / default_* against each other.
  async function saveSettings(patch) {
    let cur = {};
    try { const j = await (await fetch(EP.settingsGet)).json(); cur = (j && j.value) || {}; } catch (e) { cur = {}; }
    const merged = Object.assign({}, cur, patch);
    if (patch.levels) merged.levels = Object.assign({}, cur.levels || {}, patch.levels);
    // bt is a flat GLOBAL {sets,hold,rest} → the Object.assign above already replaces it wholesale.
    _settings = merged;
    try { await fetch(EP.settingsPost, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: merged }) }); }
    catch (e) { /* non-fatal */ }
  }
  function saveLevel() {
    if (!_sel) return;
    _settings.levels = _settings.levels || {}; _settings.levels[_sel.id] = _level;
    saveSettings({ levels: { [_sel.id]: _level } });
  }
  // Balance Training Sets/Hold/Rest — ONE GLOBAL setting saved forever (not per-player, not per-session).
  function applyBT() {
    const g = curGame();
    const d = (g && g.usesSets) ? { sets: g.defaultSets || 3, hold: g.defaultHold || 30, rest: g.defaultRest != null ? g.defaultRest : 10 }
                                : { sets: 3, hold: 30, rest: 10 };
    const s = (_settings.bt && typeof _settings.bt.sets !== 'undefined') ? _settings.bt : {};   // flat global {sets,hold,rest}
    _sets = s.sets || d.sets; _hold = s.hold || d.hold; _rest = (s.rest != null ? s.rest : d.rest);
  }
  function saveBT() {
    _settings.bt = { sets: _sets, hold: _hold, rest: _rest };   // global — no player required
    saveSettings({ bt: { sets: _sets, hold: _hold, rest: _rest } });
    const st = $('bobo-bt-status'); if (st) { st.textContent = '✓ saved'; setTimeout(() => { if (st) st.textContent = ''; }, 1500); }
  }
  async function loadRecent() {
    try { const rows = await (await fetch(EP.recent)).json(); return Array.isArray(rows) ? rows.slice(0, 6) : []; }
    catch (e) { return []; }
  }
  async function saveScore(res, gameId) {
    try {
      const r = await fetch(EP.saveScore, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test_type: 'balance', user_id: _sel ? _sel.id : null, results: res, meta: { game: gameId } }),
      });
      return r.ok;
    } catch (e) { return false; }
  }

  const gameIds   = () => Object.keys(window.BOBO_GAMES);
  const curGame   = () => window.BOBO_GAMES[_game] || window.BOBO_GAMES[gameIds()[0]];
  const curLevels = () => (curGame() ? curGame().levels : {});

  // ── start screen (rendered into #bobo-root) ───────────────────────
  async function renderMenu() {
    const panel = $('bobo-root'); if (!panel) return;
    if (!_game || !window.BOBO_GAMES[_game]) _game = gameIds()[0] || null;
    const games = gameIds();
    const LV = curLevels();
    if (!LV[_level]) _level = LV.medium ? 'medium' : Object.keys(LV)[0];
    applyBT();   // resolve Sets/Hold/Rest for the current player + game
    const recent = await loadRecent();
    const nameById = {}; _players.forEach(p => { nameById[p.id] = p.name; });

    const gameTiles = games.length > 1 ? games.map(g => `
      <button class="bobo-tile" data-nav data-game="${esc(g)}" ${_game === g ? 'data-sel' : ''}>🎮 ${esc(window.BOBO_GAMES[g].name || g)}</button>`).join('') : '';
    const playerTiles = _players.length ? _players.map(p => `
      <button class="bobo-tile" data-nav data-player="${p.id}" ${_sel && _sel.id === p.id ? 'data-sel' : ''}>🧑 ${esc(p.name)}</button>`).join('')
      : '<span style="color:#999;font-size:0.82rem;">No household users yet — add them in Privacy → Settings → Users.</span>';
    const levelTiles = Object.keys(LV).map(k => `
      <button class="bobo-tile lvl" data-nav data-level="${k}" ${_level === k ? 'data-sel' : ''} style="border-color:${LV[k].tag};color:${_level === k ? '#fff' : LV[k].tag};font-weight:700;">${esc(LV[k].label)}</button>`).join('');
    const recentHtml = recent.length ? recent.slice(0, 4).map(r => {
      const nm = r.member_name || nameById[r.user_id] || '—';
      const sc = (r.results && r.results.score != null) ? r.results.score : '—';
      return `<span style="display:inline-block;font-size:0.78rem;color:#555;margin-right:12px;white-space:nowrap;">🧑 ${esc(nm)}: <b>${esc(sc)}</b></span>`;
    }).join('') : '<span style="color:#999;font-size:0.8rem;">No games yet.</span>';

    panel.innerHTML = `
      <style>
        #bobo-root .bobo-tile{cursor:pointer;background:#f7f4ef;border:2px solid #e5e0d8;border-radius:9px;padding:8px 13px;font-size:0.9rem;color:#333;}
        #bobo-root .bobo-tile[data-sel]{background:#2563eb;color:#fff !important;border-color:#2563eb;}
        #bobo-root .bobo-tile.lvl[data-sel]{background:#111;border-color:#111;color:#fff !important;}
        #bobo-root .bobo-tile.navsel,#bobo-root #bobo-play.navsel{outline:4px solid #f59e0b;outline-offset:2px;}
        #bobo-root .bobo-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;}
        #bobo-root .bobo-lbl{font-size:0.75rem;color:#777;margin-bottom:5px;}
      </style>
      <div id="bobo-game-status" style="font-size:0.82rem;margin-bottom:12px;color:#888;">connecting…</div>
      ${games.length > 1 ? `<div class="bobo-lbl">Game</div><div class="bobo-row" style="align-items:center;">${gameTiles}${(curGame() && curGame().usesSets) ? `<div style="display:flex;align-items:center;gap:10px;font-size:0.8rem;color:#555;margin-left:8px;"><label>Sets <input id="bobo-bt-sets" type="number" min="1" max="10" value="${_sets}" style="width:48px;padding:4px;"></label><label>Hold s <input id="bobo-bt-hold" type="number" min="5" max="120" value="${_hold}" style="width:52px;padding:4px;"></label><label>Rest s <input id="bobo-bt-rest" type="number" min="0" max="60" value="${_rest}" style="width:52px;padding:4px;"></label><span id="bobo-bt-status" style="color:#3a7d44;font-size:0.78rem;font-weight:600;"></span></div>` : ''}</div>` : ''}
      <div class="bobo-lbl">Player</div>
      <div class="bobo-row">${playerTiles}</div>
      <div class="bobo-lbl">Difficulty</div>
      <div class="bobo-row">${levelTiles}</div>
      <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;">
        <button id="bobo-play" data-nav style="background:#16a34a;color:#fff;font-size:1.1rem;padding:11px 26px;border-radius:11px;border:none;cursor:pointer;">▶ Play</button>
        <div style="display:flex;align-items:center;flex-wrap:wrap;"><span style="font-size:0.75rem;color:#777;margin-right:6px;">Recent:</span> ${recentHtml}</div>
      </div>
      ${renderDefaultsUI()}`;

    panel.querySelectorAll('[data-game]').forEach(el => el.addEventListener('click', () => { _game = el.dataset.game; renderMenu(); }));
    panel.querySelectorAll('[data-player]').forEach(el => el.addEventListener('click', () => {
      _sel = _players.find(p => String(p.id) === el.dataset.player) || null;
      if (_sel && _settings.levels && _settings.levels[_sel.id]) _level = _settings.levels[_sel.id];
      renderMenu();
    }));
    panel.querySelectorAll('[data-level]').forEach(el => el.addEventListener('click', () => { _level = el.dataset.level; renderMenu(); }));
    const bs = $('bobo-bt-sets'), bh = $('bobo-bt-hold'), br = $('bobo-bt-rest');
    if (bs) bs.addEventListener('change', () => { _sets = Math.max(1, Math.min(10, parseInt(bs.value) || 3)); bs.value = _sets; saveBT(); });
    if (bh) bh.addEventListener('change', () => { _hold = Math.max(5, Math.min(120, parseInt(bh.value) || 30)); bh.value = _hold; saveBT(); });
    if (br) br.addEventListener('change', () => { const v = parseInt(br.value); _rest = isNaN(v) ? 10 : Math.max(0, Math.min(60, v)); br.value = _rest; saveBT(); });
    const play = $('bobo-play');
    if (play) play.addEventListener('click', () => { if (!_sel) { alert('Pick a player first'); return; } saveLevel(); saveBT(); startGame(_game, _level, { sets: _sets, hold: _hold, rest: _rest }); });
    wireDefaultsUI(panel);
    tickStatus();
  }

  // Dashboard-only: TV defaults editor (mode + default game/player/difficulty) → medical.bobo_game.
  function renderDefaultsUI() {
    const mode = _settings.mode === 'auto' ? 'auto' : 'manual';
    const games = gameIds();
    return `
      <div style="margin-top:16px;border-top:1px solid #f0ece6;padding-top:10px;">
        <div class="bobo-lbl">TV defaults (used when the game opens on the balcony TV)</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:0.82rem;color:#444;">
          <label>Mode
            <select id="bobo-def-mode" style="margin-left:5px;">
              <option value="manual" ${mode === 'manual' ? 'selected' : ''}>Manual (pick on TV)</option>
              <option value="auto" ${mode === 'auto' ? 'selected' : ''}>Auto (start on connect)</option>
            </select>
          </label>
          ${games.length > 1 ? `<label>Game
            <select id="bobo-def-game" style="margin-left:5px;">
              ${games.map(g => `<option value="${esc(g)}" ${_settings.default_game === g ? 'selected' : ''}>${esc(window.BOBO_GAMES[g].name || g)}</option>`).join('')}
            </select></label>` : ''}
          <label>Player
            <select id="bobo-def-user" style="margin-left:5px;">
              <option value="">— first —</option>
              ${_players.map(p => `<option value="${p.id}" ${String(_settings.default_user) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          </label>
          <label>Difficulty
            <select id="bobo-def-level" style="margin-left:5px;">
              ${['easy', 'medium', 'hard'].map(k => `<option value="${k}" ${(_settings.default_level || 'medium') === k ? 'selected' : ''}>${k}</option>`).join('')}
            </select>
          </label>
        </div>
      </div>`;
  }
  function wireDefaultsUI(panel) {
    const m = panel.querySelector('#bobo-def-mode'); if (m) m.addEventListener('change', () => saveSettings({ mode: m.value }));
    const g = panel.querySelector('#bobo-def-game'); if (g) g.addEventListener('change', () => saveSettings({ default_game: g.value }));
    const u = panel.querySelector('#bobo-def-user'); if (u) u.addEventListener('change', () => saveSettings({ default_user: u.value || null }));
    const l = panel.querySelector('#bobo-def-level'); if (l) l.addEventListener('change', () => saveSettings({ default_level: l.value }));
  }

  function tickStatus() {
    const s = $('bobo-game-status'); if (!s) return;
    if (!_mqttUp)      { s.textContent = 'connecting to BoBo…'; s.style.color = '#888'; }
    else if (live())   { s.textContent = '● BoBo live — lean to steer'; s.style.color = '#16a34a'; }
    else               { s.textContent = 'waiting for BoBo (stand on the board) — or use arrow keys'; s.style.color = '#b8860b'; }
  }

  // ── board menu-nav (TV, no mouse) ─────────────────────────────────
  let _navTimer = null, _navFocus = 0, _navCool = 0;
  function navItems() { const p = $('bobo-root'); return p ? [].slice.call(p.querySelectorAll('[data-nav]')) : []; }
  function paintFocus() {
    const items = navItems();
    items.forEach((el, i) => el.classList.toggle('navsel', i === _navFocus));
  }
  function enableBoardNav() {
    if (_navTimer) return;
    _navFocus = 0;
    _navTimer = setInterval(() => {
      if (_ov) { return; }                 // in-game → no menu nav
      const items = navItems(); if (!items.length) return;
      if (_navFocus >= items.length) _navFocus = items.length - 1;
      const now = Date.now();
      if (live() && now > _navCool) {
        if (_x > 55)  { _navFocus = Math.min(items.length - 1, _navFocus + 1); _navCool = now + 450; }
        else if (_x < -55) { _navFocus = Math.max(0, _navFocus - 1); _navCool = now + 450; }
        else if (Math.abs(_y) > 60) { _navCool = now + 800; items[_navFocus].click(); return; }
      }
      paintFocus();
    }, 120);
  }

  // ── game host (full-viewport overlay canvas) ──────────────────────
  let _raf = null, _ov = null, _ctx = null, _cv = null, _last = 0, _inst = null, _curGame = null, _gameOver = false;

  function startGame(gameId, level, opts) {
    const game = window.BOBO_GAMES[gameId]; if (!game) return;
    _curGame = gameId; _inst = game.create(level, opts || { sets: _sets, hold: _hold, rest: _rest }); _gameOver = false;
    _ov = document.createElement('div');
    _ov.id = 'bobo-overlay';
    _ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#05060a;overflow:hidden;';
    _cv = document.createElement('canvas'); _ov.appendChild(_cv);
    const ex = document.createElement('button'); ex.textContent = '✕ Exit'; ex.title = 'Stop and back to settings (or press Esc)';
    ex.style.cssText = 'position:absolute;top:16px;right:18px;z-index:3;background:#ef4444;color:#fff;border:none;border-radius:11px;font-size:1.05rem;font-weight:700;padding:11px 20px;cursor:pointer;box-shadow:0 3px 14px rgba(0,0,0,.45);';
    ex.addEventListener('click', () => { quitGame(); renderMenu(); }); _ov.appendChild(ex);
    document.body.appendChild(_ov);
    _ctx = _cv.getContext('2d'); resize();
    window.addEventListener('resize', resize);
    _last = performance.now(); _raf = requestAnimationFrame(loop);
  }
  function resize() { if (!_cv) return; _cv.width = window.innerWidth; _cv.height = window.innerHeight; }
  function quitGame() {
    if (_raf) cancelAnimationFrame(_raf); _raf = null;
    window.removeEventListener('resize', resize);
    if (_ov && _ov.parentNode) _ov.parentNode.removeChild(_ov);
    _ov = null; _ctx = null; _cv = null; _inst = null; _gameOver = false;
  }
  function loop(ts) {
    _raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (ts - _last) / 1000); _last = ts;
    if (_inst && _inst.alive) _inst.update(dt, input(), inputY(), live() || !IS_TV);   // desktop/dashboard = always "on board" (arrow-key testing); real off-board pause only on the TV
    if (_inst) _inst.draw(_ctx, _cv.width, _cv.height, { playerName: _sel ? _sel.name : '', live: live() });
    if (_inst && !_inst.alive && !_gameOver) { _gameOver = true; endGame(); }
  }
  async function endGame() {
    const res = _inst.result();
    const ok = await saveScore(res, _curGame);
    if (!_ov) return;
    const lbl = (curLevels()[res.level] && curLevels()[res.level].label) || res.level;
    const summ = (res.obstacles != null)   // game-aware Game-Over sub-line (Colour Tunnel vs Balance Training)
      ? `${res.obstacles} dodged · ${res.duration_s}s · ${esc(lbl)}`
      : `${res.sets}×${res.hold_s}s hold · ${res.duration_s}s · ${esc(lbl)}`;
    const p = document.createElement('div');
    p.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(5,6,10,.85);color:#fff;z-index:3;text-align:center;';
    p.innerHTML = `
      <div style="font-size:2.4rem;font-weight:800;">Game Over</div>
      <div style="font-size:4.4rem;font-weight:900;color:#22c55e;margin:4px 0;">${res.score}</div>
      <div style="opacity:.75;">${summ}</div>
      <div style="opacity:.6;margin-top:6px;font-size:.9rem;">${ok ? ('✓ saved to ' + esc(_sel ? _sel.name : '—') + "'s medical") : '⚠ save failed'}</div>
      <div style="margin-top:28px;display:flex;gap:14px;">
        <button id="bobo-again" style="background:#16a34a;color:#fff;border:none;border-radius:12px;font-size:1.2rem;padding:12px 28px;cursor:pointer;">▶ Play again</button>
        <button id="bobo-quit" style="background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:12px;font-size:1.2rem;padding:12px 28px;cursor:pointer;">Exit</button>
      </div>`;
    _ov.appendChild(p);
    p.querySelector('#bobo-again').addEventListener('click', () => { p.remove(); _inst.reset(); _gameOver = false; _last = performance.now(); });
    p.querySelector('#bobo-quit').addEventListener('click', () => { quitGame(); renderMenu(); });
  }

  // ── keyboard fallback ─────────────────────────────────────────────
  function onKey(e) {
    if (e.type === 'keydown' && e.key === 'Escape' && _ov) { quitGame(); renderMenu(); return; }   // Esc = stop → settings
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (_ov) e.preventDefault();
    if (e.type === 'keydown') { _key = (e.key === 'ArrowLeft') ? -100 : 100; }
    else { if ((e.key === 'ArrowLeft' && _key < 0) || (e.key === 'ArrowRight' && _key > 0)) _key = 0; }
  }

  // ── auto-start (TV) ───────────────────────────────────────────────
  function resolveDefaults() {
    const ids = gameIds();
    const gid = (_settings.default_game && window.BOBO_GAMES[_settings.default_game]) ? _settings.default_game : ids[0];
    let player = null;
    if (_settings.default_user) player = _players.find(p => String(p.id) === String(_settings.default_user));
    if (!player) player = _players[0] || null;
    let lvl = _settings.default_level || (player && _settings.levels && _settings.levels[player.id]) || 'medium';
    if (!gid || !window.BOBO_GAMES[gid].levels[lvl]) lvl = 'medium';
    return { gid, player, lvl };
  }

  // ── entry point ───────────────────────────────────────────────────
  window.boboGameInit = async function () {
    if (!_wired) {
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKey);
      _statusTimer = setInterval(tickStatus, 600);
      _wired = true;
    }
    if (!_inited) { await loadPlayers(); await loadSettings(); _inited = true; }
    connectMqtt();
    _game = gameIds()[0] || null;
    if (IS_TV && _settings.mode === 'auto') {
      const d = resolveDefaults();
      if (d.player && d.gid) { _game = d.gid; _sel = d.player; _level = d.lvl; applyBT(); startGame(_game, _level); return; }
    }
    renderMenu();
    if (IS_TV) enableBoardNav();
  };

  // Detail view for a saved balance score (called by medTestView in the Tests → Test Results card).
  window.renderBalance = function (t) {
    const rr = t.results || {};
    let d = ''; try { d = new Date(t.tested_at).toLocaleString('en-GB', { hour12: false }); } catch (e) {}
    const gid = (t.meta && t.meta.game) || rr.game;   // game id lives in meta.game
    const gname = (gid && window.BOBO_GAMES[gid] && window.BOBO_GAMES[gid].name) || 'Colour Tunnel';
    const isBalance = gid === 'balance_training' || rr.hold_s != null;   // game-aware detail rows
    const midRows = isBalance
      ? `Balanced: <b>${esc(rr.score != null ? rr.score : 0)}s</b><br>
        Sets × Hold: <b>${esc(rr.sets != null ? rr.sets : '—')} × ${esc(rr.hold_s != null ? rr.hold_s : '—')}s</b><br>
        Rest: <b>${esc(rr.rest_s != null ? rr.rest_s : '—')}s</b><br>`
      : `Obstacles dodged: <b>${esc(rr.obstacles != null ? rr.obstacles : 0)}</b><br>
        Top speed: <b>${esc(rr.top_speed != null ? rr.top_speed : '—')}</b><br>`;
    const m = document.createElement('div');
    m.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);';
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    m.innerHTML = `<div style="background:#fff;border-radius:14px;padding:22px 28px;max-width:340px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.3);">
      <div style="font-size:1.1rem;font-weight:700;color:#166534;">⚖ Balance — ${esc(gname)}</div>
      <div style="font-size:3.4rem;font-weight:900;color:#16a34a;margin:6px 0;">${esc(rr.score != null ? rr.score : '—')}</div>
      <div style="color:#555;font-size:.9rem;line-height:1.9;text-align:left;display:inline-block;">
        Player: <b>${esc(t.member_name || '—')}</b><br>
        Difficulty: <b>${esc(rr.level || '—')}</b><br>
        ${midRows}
        Duration: <b>${esc(rr.duration_s != null ? rr.duration_s : 0)}s</b><br>
        <span style="color:#999;font-size:.82rem;">${esc(d)}</span>
      </div>
      <div><button style="margin-top:16px;background:#2563eb;color:#fff;border:none;border-radius:10px;padding:8px 24px;cursor:pointer;">Close</button></div>
    </div>`;
    m.querySelector('button').addEventListener('click', () => m.remove());
    document.body.appendChild(m);
  };

  // ══ GAME MODULE: Colour Tunnel ════════════════════════════════════
  window.BOBO_GAMES['colour_tunnel'] = {
    id: 'colour_tunnel',
    name: 'Colour Tunnel',
    levels: {
      easy:   { label: 'Easy',   base: 0.30, ramp: 0.010, gap: 0.44, spawn: 2.2, tag: '#22c55e' },
      medium: { label: 'Medium', base: 0.42, ramp: 0.016, gap: 0.34, spawn: 1.7, tag: '#eab308' },
      hard:   { label: 'Hard',   base: 0.58, ramp: 0.024, gap: 0.26, spawn: 1.2, tag: '#ef4444' },
    },
    create(levelKey) {
      const L = this.levels[levelKey] || this.levels.medium;
      let G;
      const init = () => { G = { ship: 0.5, target: 0.5, obstacles: [], t: 0, spawnT: 0.5, speed: L.base, top: L.base, score: 0, passed: 0, alive: true, hue: 200 }; };
      const spawn = () => { const gw = L.gap; const g = gw / 2 + Math.random() * (1 - gw); G.obstacles.push({ p: 0, g: g, gw: gw, resolved: false, hue: (G.hue + 120) % 360 }); };
      init();
      return {
        get alive() { return G.alive; },
        reset: init,
        update(dt, input) {
          G.t += dt; G.hue = (G.hue + dt * 24) % 360;
          G.speed = Math.min(1.4, G.speed + L.ramp * dt); G.top = Math.max(G.top, G.speed);
          G.target = Math.max(0, Math.min(1, (input + 100) / 200));
          G.ship += (G.target - G.ship) * Math.min(1, dt * 12);
          G.spawnT -= dt;
          const every = L.spawn / (0.6 + G.speed);
          if (G.spawnT <= 0) { spawn(); G.spawnT = every; }
          for (const o of G.obstacles) {
            o.p += G.speed * dt;
            if (!o.resolved && o.p >= 0.98) {
              o.resolved = true;
              if (Math.abs(G.ship - o.g) <= o.gw / 2) { G.score += 10; G.passed++; }
              else { G.alive = false; }
            }
          }
          G.obstacles = G.obstacles.filter(o => o.p < 1.15);
        },
        draw(ctx, W, H, env) {
          const vpx = W / 2, vpy = H * 0.34, py = H * 0.82, tl = W * 0.10, tr = W * 0.90;
          ctx.fillStyle = '#05060a'; ctx.fillRect(0, 0, W, H);
          ctx.lineWidth = 2; ctx.strokeStyle = `hsla(${G.hue},70%,55%,0.25)`;
          ctx.beginPath();
          ctx.moveTo(vpx, vpy); ctx.lineTo(tl, py); ctx.moveTo(vpx, vpy); ctx.lineTo(tr, py);
          ctx.moveTo(vpx, vpy); ctx.lineTo(tl, H); ctx.moveTo(vpx, vpy); ctx.lineTo(tr, H); ctx.stroke();
          const rings = 9;
          for (let i = 0; i < rings; i++) {
            const rp = ((G.t * G.speed * 0.6 + i / rings) % 1);
            const y = vpy + (py - vpy) * rp, w = (tr - tl) * rp;
            ctx.strokeStyle = `hsla(${(G.hue + rp * 80) % 360},80%,55%,${0.08 + 0.22 * rp})`;
            ctx.lineWidth = 1 + 2 * rp;
            ctx.strokeRect(vpx - w / 2, y - H * 0.02 * rp, w, H * 0.04 * rp + 2);
          }
          for (const o of G.obstacles) {
            const y = vpy + (py - vpy) * o.p, w = (tr - tl) * o.p;
            const left = vpx - w / 2, gapC = left + w * o.g, gapHalf = w * o.gw / 2;
            ctx.strokeStyle = `hsl(${o.hue},95%,60%)`; ctx.lineWidth = Math.max(3, 14 * o.p); ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(left, y); ctx.lineTo(gapC - gapHalf, y);
            ctx.moveTo(gapC + gapHalf, y); ctx.lineTo(left + w, y);
            ctx.stroke();
          }
          const sx = tl + (tr - tl) * G.ship;
          ctx.fillStyle = '#e5f2ff'; ctx.strokeStyle = `hsl(${G.hue},90%,65%)`; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(sx, py - 20); ctx.lineTo(sx - 15, py + 15); ctx.lineTo(sx + 15, py + 15); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
          ctx.font = '800 ' + Math.round(H * 0.07) + 'px system-ui,sans-serif';
          ctx.fillText(String(G.score), W / 2, H * 0.13);
          ctx.font = '600 ' + Math.round(H * 0.028) + 'px system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.6)';
          ctx.fillText((env.playerName || '') + ' · ' + L.label, W / 2, H * 0.18);
          if (!env.live) { ctx.fillStyle = 'rgba(255,210,0,.7)'; ctx.font = '600 ' + Math.round(H * 0.024) + 'px system-ui,sans-serif'; ctx.fillText('arrow keys / lean (BoBo not detected)', W / 2, H * 0.96); }
        },
        result() {
          return { score: G.score, obstacles: G.passed, duration_s: Math.round(G.t), level: levelKey, top_speed: Math.round(G.top * 100) / 100 };
        },
      };
    },
  };

  // ══ GAME MODULE: Balance Training (timed single-leg / both-legs HOLD, à la BoBo) ══
  window.BOBO_GAMES['balance_training'] = {
    id: 'balance_training',
    name: 'Balance Training',
    usesSets: true, defaultSets: 3, defaultHold: 30, defaultRest: 10,
    // Difficulty drives the STANCE + how steady you must be (zone). Hold/Rest/Sets come from opts.
    levels: {
      easy:   { label: 'Easy',   tag: '#22c55e', zone: 38, pattern: ['both'],         warmup: null   },
      medium: { label: 'Medium', tag: '#eab308', zone: 28, pattern: ['left', 'right'], warmup: null   },
      hard:   { label: 'Hard',   tag: '#ef4444', zone: 20, pattern: ['left', 'right'], warmup: 'both' },
    },
    create(levelKey, opts) {
      const L = this.levels[levelKey] || this.levels.medium;
      const o = opts || {};
      const sets = Math.max(1, o.sets || this.defaultSets);
      const hold = Math.max(3, o.hold || this.defaultHold);
      const rest = (o.rest != null ? Math.max(0, o.rest) : this.defaultRest);
      const patLen = L.pattern.length, warmN = L.warmup ? 1 : 0;
      const seq = L.warmup ? [L.warmup] : [];
      for (let s = 0; s < sets; s++) for (const st of L.pattern) seq.push(st);
      const stanceLabel = (st) => st === 'both' ? 'Balance on BOTH legs'
        : (st === 'left' ? 'Stand on your LEFT leg' : 'Stand on your RIGHT leg');
      let G;
      const init = () => { G = { idx: 0, phase: 'rest', clock: Math.max(3, rest), prep: true, balancedT: 0, alive: true, t: 0, sx: 0, sy: 0, steady: false, flash: 0, paused: false }; };
      init();
      return {
        get alive() { return G.alive; },
        reset: init,
        update(dt, x, y, onBoard) {
          // On/off-board PAUSE: the board streams only while someone's standing on it.
          G.paused = !onBoard;
          if (!onBoard) { G.t += dt; return; }
          G.t += dt; if (G.flash > 0) G.flash -= dt;
          G.sx += (x - G.sx) * Math.min(1, dt * 12);   // smoothed marker position
          G.sy += (y - G.sy) * Math.min(1, dt * 12);
          const dev = Math.hypot(G.sx, G.sy);
          G.steady = dev <= L.zone;
          G.clock -= dt;
          if (G.phase === 'hold') {
            if (G.steady) G.balancedT += dt;             // score only while steady
            if (G.clock <= 0) {
              if (G.idx === seq.length - 1) { G.alive = false; }
              else if (rest > 0) { G.phase = 'rest'; G.clock = rest; }
              else { G.idx++; G.clock = hold; G.flash = 0.4; }
            }
          } else {                                       // rest (incl. the initial "step on board" prep)
            if (G.clock <= 0) {
              if (G.prep) { G.prep = false; } else { G.idx++; }   // prep → 1st hold (no bump); rest → next hold
              G.phase = 'hold'; G.clock = hold; G.flash = 0.4;
            }
          }
        },
        draw(ctx, W, H, env) {
          ctx.fillStyle = '#0a0e14'; ctx.fillRect(0, 0, W, H);
          // fixed marker scale; ring radius = the steady zone → smaller (harder) on medium/hard, and clears the text
          const cx = W / 2, cy = H * 0.56, scale = Math.min(W, H) * 0.0055, R = L.zone * scale;
          const stance = seq[G.idx], isHold = G.phase === 'hold';
          // balance target ring (= the steady zone) + crosshair
          ctx.lineWidth = 4; ctx.strokeStyle = G.steady ? 'rgba(34,197,94,0.8)' : 'rgba(239,68,68,0.7)';
          ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(cx - R * 1.5, cy); ctx.lineTo(cx + R * 1.5, cy);
          ctx.moveTo(cx, cy - R * 1.5); ctx.lineTo(cx, cy + R * 1.5); ctx.stroke();
          // marker dot (green steady / red wobbling)
          const mx = Math.max(cx - W * 0.45, Math.min(cx + W * 0.45, cx + G.sx * scale));
          const my = Math.max(cy - H * 0.38, Math.min(cy + H * 0.38, cy - G.sy * scale));
          ctx.fillStyle = G.steady ? '#22c55e' : '#ef4444';
          ctx.beginPath(); ctx.arc(mx, my, H * 0.022, 0, Math.PI * 2); ctx.fill();
          // big countdown — GREEN in hold, BLUE in rest
          ctx.textAlign = 'center';
          ctx.fillStyle = isHold ? '#22c55e' : '#3b82f6';
          ctx.font = '900 ' + Math.round(H * 0.14) + 'px system-ui,sans-serif';
          ctx.fillText(String(Math.ceil(Math.max(0, G.clock))), cx, H * 0.19);
          ctx.fillStyle = '#fff'; ctx.font = '700 ' + Math.round(H * 0.036) + 'px system-ui,sans-serif';
          ctx.fillText(isHold ? stanceLabel(stance) : (G.prep ? 'Step on the board' : 'Rest — get ready'), cx, H * 0.27);
          // score + set progress
          const isWarm = warmN && G.idx === 0;
          const setNo = Math.min(sets, Math.floor((G.idx - warmN) / patLen) + 1);
          const prog = isWarm ? 'Warm-up' : ('Set ' + setNo + '/' + sets + ' · ' + (stance === 'both' ? 'both' : stance));
          ctx.font = '700 ' + Math.round(H * 0.03) + 'px system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.75)';
          ctx.fillText('🔥 ' + Math.round(G.balancedT) + 's balanced · ' + prog, cx, H * 0.9);
          ctx.font = '600 ' + Math.round(H * 0.026) + 'px system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.45)';
          ctx.fillText((env.playerName || '') + ' · ' + L.label, cx, H * 0.965);
          // off-board pause overlay (matches the update pause exactly)
          if (G.paused) {
            ctx.fillStyle = 'rgba(5,8,14,0.72)'; ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#facc15'; ctx.font = '800 ' + Math.round(H * 0.05) + 'px system-ui,sans-serif';
            ctx.fillText('⚠ Step onto the board — paused', cx, cy);
          }
        },
        result() {
          return { score: Math.round(G.balancedT), sets, hold_s: hold, rest_s: rest, duration_s: Math.round(G.t), level: levelKey };
        },
      };
    },
  };
})();
