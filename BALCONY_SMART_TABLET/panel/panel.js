/* Balcony Smart Tablet — the touch panel runtime.
 *
 * Renders tiles from /api/panel/config, reflects live on/off from the broker's
 * `mur/home/device/+/state` stream, and on a tap PUBLISHES only the tile id to
 * `mur/home/device/panel/event {dps:{tile,event:'short'}}`. It never issues raw
 * device commands — the Panel Commands rule (LXC 105) resolves the binding
 * server-side. Same MQTT-WS pattern as bobo-game.js / balcony.js.
 */
(function () {
  const BROKER = 'ws://192.168.1.189:9001';
  const USER = 'dashboard_browser';
  const EVENT_TOPIC = 'mur/home/device/panel/event';
  const ALERT_TOPIC = 'mur/home/device/panel/alert';

  let cfg = { pages: [] };
  let activePage = 0;
  let mq = null, mqUp = false;
  // deviceId -> [{tile element, channel}] for live-state updates
  const stateMap = new Map();

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Truthy device state (mirrors the rule's _resolve_toggle).
  function isOn(dps, channel) {
    if (!dps || typeof dps !== 'object') return false;
    let v;
    if (channel) v = dps[channel];
    else if ('1' in dps) v = dps['1'];
    else if ('state' in dps) v = dps['state'];
    else if ('power' in dps) v = dps['power'];
    else { const k = Object.keys(dps); v = k.length === 1 ? dps[k[0]] : undefined; }
    return v === true || v === 1 || v === 'on' || v === 'ON' || v === 'true' || v === 'True';
  }

  // A tile's "state source" = its first plain-device binding (has on/off).
  function stateBinding(tile) {
    for (const b of (tile.bindings || [])) {
      if (!b.type || b.type === 'device') return b;
    }
    return null;
  }
  // Built-in device icons (name -> inner SVG). Shared 1:1 with panel-editor.js.
  const ICONS = {
    heater: '<rect x="3.5" y="8.5" width="17" height="11" rx="1.5"/><path d="M7.5 8.5v11M12 8.5v11M16.5 8.5v11"/><path d="M7 6c.9-.8.9-1.6 0-2.4M12 6c.9-.8.9-1.6 0-2.4M17 6c.9-.8.9-1.6 0-2.4"/>',
    light: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M8.5 14.2a5 5 0 1 1 7 0c-.7.7-1.2 1.6-1.4 2.8H9.9c-.2-1.2-.7-2.1-1.4-2.8z"/>',
    lamp: '<path d="M8.5 3h7l2.2 6h-11.4z"/><path d="M12 9v10"/><path d="M8 21h8"/>',
    fan: '<circle cx="12" cy="12" r="1.6"/><path d="M12 10.4c0-4 1-6 3-5.5s.5 3.5-3 5.5"/><path d="M13.6 12c4 0 6 1 5.5 3s-3.5.5-5.5-3"/><path d="M12 13.6c0 4-1 6-3 5.5s-.5-3.5 3-5.5"/><path d="M10.4 12c-4 0-6-1-5.5-3s3.5-.5 5.5 3"/>',
    ac: '<rect x="3" y="4.5" width="18" height="9" rx="2"/><line x1="6" y1="9" x2="18" y2="9"/><path d="M6 17.5c1.6 0 1.6-1.5 3.2-1.5"/><path d="M12 17.5c1.6 0 1.6-1.5 3.2-1.5"/>',
    tv: '<rect x="2.5" y="7" width="19" height="12.5" rx="2"/><path d="M8 3.5l4 3.5 4-3.5"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
    curtain: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M7 3c.5 6-.5 9-3 12"/><path d="M12 3v18"/><path d="M17 3c-.5 6 .5 9 3 12"/>',
    water: '<path d="M12 3.2s6 6.4 6 10.3a6 6 0 0 1-12 0C6 9.6 12 3.2 12 3.2z"/>',
    boiler: '<rect x="6.5" y="3" width="11" height="18" rx="3"/><line x1="6.5" y1="9" x2="17.5" y2="9"/><circle cx="12" cy="15" r="2.5"/>',
    plug: '<path d="M9 2.5v5"/><path d="M15 2.5v5"/><path d="M6.5 7.5h11v2.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 21v-5.5"/>',
    speaker: '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="14.5" r="3"/><circle cx="12" cy="7" r="1"/>',
    thermostat: '<path d="M14 14.5V5a2 2 0 1 0-4 0v9.5a4 4 0 1 0 4 0z"/>',
    power: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0"/><line x1="12" y1="2.5" x2="12" y2="12"/>',
    scene: '<path d="M12 3l2.6 5.7 6.2.6-4.7 4.2 1.4 6.1L12 16.9 6.5 19.6l1.4-6.1L3.2 9.3l6.2-.6z"/>',
    gate: '<rect x="4" y="7" width="16" height="13" rx="1"/><path d="M4 11h16M4 15h16M8 7v13M12 7v13M16 7v13"/>',
    camera: '<rect x="3" y="7" width="18" height="12" rx="2"/><circle cx="12" cy="13" r="3.2"/><path d="M8 7l1.4-2h5L16 7"/>',
    music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    door: '<path d="M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17"/><path d="M3 21h18"/><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none"/>',
    human: '<circle cx="12" cy="7" r="3.2"/><path d="M5.5 21v-1a6.5 6.5 0 0 1 13 0v1"/>',
  };
  const ICON_COLORS = {
    heater: '#e8663a', light: '#f2b134', lamp: '#f2b134', fan: '#2fa9a1', ac: '#3a90d8',
    tv: '#5a6b86', lock: '#d64f4f', curtain: '#b07a4a', water: '#2f9fe0', boiler: '#e8663a',
    plug: '#6f8f4f', speaker: '#8a5ad6', thermostat: '#e05a5a', power: '#d64f4f', scene: '#d6a93a',
    gate: '#6f7f99', camera: '#5a6b86', music: '#8a5ad6', door: '#b07a4a', human: '#c9744e',
  };
  function svgIcon(inner, color) {
    const c = color ? ' style="color:' + color + '"' : '';
    return '<svg viewBox="0 0 24 24"' + c + ' fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  function autoIcon(tile) {
    const b = (tile.bindings || [])[0] || {};
    if (b.type === 'scene') return '🎬';
    if (b.type === 'curtain') return '🪟';
    if (b.type === 'pixoo_preset') return '🖼️';
    if (b.type === 'media') return '📺';
    return '💡';
  }
  function iconHtml(tile) {
    const ic = (tile.icon || '').trim();
    if (ic && ICONS[ic]) return svgIcon(ICONS[ic], ICON_COLORS[ic]);   // built-in SVG (own colour)
    if (ic) return esc(ic);                            // custom emoji/text
    return esc(autoIcon(tile));                        // auto by binding
  }

  function render() {
    stateMap.clear();
    const pages = cfg.pages || [];
    // page tabs (hidden when only one page)
    const pagesEl = $('pages');
    pagesEl.innerHTML = pages.length > 1 ? pages.map((p, i) =>
      `<div class="page-tab ${i === activePage ? 'active' : ''}" data-pi="${i}">${esc(p.name || ('Page ' + (i + 1)))}</div>`
    ).join('') : '';
    pagesEl.querySelectorAll('.page-tab').forEach(el =>
      el.addEventListener('click', () => { activePage = +el.dataset.pi; render(); }));

    const grid = $('grid');
    const page = pages[activePage];
    const tiles = (page && page.tiles) || [];
    if (!tiles.length) {
      grid.innerHTML = '<div id="empty">No tiles yet.<br>Add them on the dashboard:<br>Balcony agent → <b>Smart Tablet</b> tab.</div>';
      return;
    }
    grid.innerHTML = '';

    function makeTile(t) {
      const el = document.createElement('div');
      el.className = 'tile';
      const sb = stateBinding(t);
      el.innerHTML =
        `<div class="tile-icon">${iconHtml(t)}</div>` +
        `<div class="tile-body"><div class="tile-label">${esc(t.label || '?')}</div>` +
        (t.sub ? `<div class="tile-sub">${esc(t.sub)}</div>` : '') + `</div>` +
        (sb ? `<span class="tile-state"></span>` : '');
      el.addEventListener('click', () => tap(t, el));
      if (sb && sb.device_id) {
        if (!stateMap.has(sb.device_id)) stateMap.set(sb.device_id, []);
        stateMap.get(sb.device_id).push({ el, channel: sb.channel || null });
      }
      return el;
    }

    // Group tiles by their configured row; within a row, `pos` is the ABSOLUTE
    // slot (1,2,3…) — empty slots render as invisible spacers so a tile at pos 3
    // really sits 3rd. Every row is padded to the page's max column count so all
    // rows are the same width (positions line up) and the grid centers as a block.
    const rows = {};
    tiles.forEach((t, i) => { const r = t.row || 1; (rows[r] = rows[r] || []).push({ t, i }); });
    const maxCols = Math.max(1, ...tiles.map(t => t.pos || 1));
    grid.style.setProperty('--cols', maxCols);
    const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
    for (const rn of rowNums) {
      const rowEl = document.createElement('div');
      rowEl.className = 'tile-row';
      const items = rows[rn];
      const byPos = {};
      items.forEach((x, idx) => { const p = x.t.pos || (idx + 1); (byPos[p] = byPos[p] || []).push(x.t); });
      for (let p = 1; p <= maxCols; p++) {
        if (!byPos[p]) { const sp = document.createElement('div'); sp.className = 'tile-spacer'; rowEl.appendChild(sp); continue; }
        for (const t of byPos[p]) {
          // A tile marked hidden is a deliberate spacer — holds its slot, invisible + not tappable.
          if (t.hidden) { const sp = document.createElement('div'); sp.className = 'tile-spacer'; rowEl.appendChild(sp); }
          else rowEl.appendChild(makeTile(t));
        }
      }
      grid.appendChild(rowEl);
    }
  }

  function tap(tile, el) {
    if (tile.confirm) { askConfirm(tile, el); return; }
    doTap(tile, el);
  }
  function doTap(tile, el) {
    el.classList.remove('pressed'); void el.offsetWidth; el.classList.add('pressed');
    if (mq && mqUp) {
      mq.publish(EVENT_TOPIC, JSON.stringify({ dps: { tile: tile.id, event: 'short' } }), { qos: 0 });
    }
  }
  let confirmEl = null;
  function ensureConfirm() {
    if (confirmEl) return;
    confirmEl = document.createElement('div');
    confirmEl.id = 'confirm';
    confirmEl.innerHTML =
      '<div class="confirm-box"><div class="confirm-title" id="confirm-title"></div>' +
      '<div class="confirm-btns"><button class="confirm-no" id="confirm-no">Cancel</button>' +
      '<button class="confirm-yes" id="confirm-yes">Confirm</button></div></div>';
    confirmEl.addEventListener('click', (e) => { if (e.target === confirmEl) confirmEl.style.display = 'none'; });
    document.body.appendChild(confirmEl);
  }
  function askConfirm(tile, el) {
    ensureConfirm();
    $('confirm-title').textContent = (tile.label ? '“' + tile.label + '”' : 'This') + ' — run it?';
    const yes = $('confirm-yes'), no = $('confirm-no');
    const close = () => { yes.onclick = null; no.onclick = null; confirmEl.style.display = 'none'; };
    yes.onclick = () => { close(); doTap(tile, el); };
    no.onclick = close;
    confirmEl.style.display = 'flex';
  }

  // ── tablet alert (Notifications → panel_alert) ─────────────────────
  let audioCtx = null, beepTimer = null, alertTimer = null, alertEl = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* no audio */ }
  }
  // Unlock the synthesized beep on the first user gesture (kiosk gets tapped).
  document.addEventListener('touchstart', unlockAudio, { passive: true });
  document.addEventListener('click', unlockAudio);
  function beepOnce() {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
    o.type = 'square'; o.frequency.value = 880;
    o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.start(t); o.stop(t + 0.3);
  }
  function startBeep() { stopBeep(); beepOnce(); beepTimer = setInterval(beepOnce, 650); }
  function stopBeep() { if (beepTimer) { clearInterval(beepTimer); beepTimer = null; } }
  function ensureAlert() {
    if (alertEl) return;
    alertEl = document.createElement('div');
    alertEl.id = 'alert';
    alertEl.innerHTML =
      '<div class="alert-box"><div class="alert-icon" id="alert-icon"></div>' +
      '<div class="alert-msg" id="alert-msg"></div><div class="alert-hint">tap to dismiss</div></div>';
    alertEl.addEventListener('click', dismissAlert);
    document.body.appendChild(alertEl);
  }
  function dismissAlert() {
    stopBeep();
    if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
    if (alertEl) alertEl.style.display = 'none';
  }
  function showAlert(a) {
    a = a || {};
    ensureAlert();
    const color = a.color || '#e5352b';
    const name = a.icon || 'door';
    const ic = $('alert-icon');
    ic.innerHTML = ICONS[name] ? svgIcon(ICONS[name], color) : esc(name || '⚠️');
    ic.style.color = color;
    ic.className = 'alert-icon' + (a.blink === false ? '' : ' blink');
    const msg = $('alert-msg'); msg.textContent = a.message || ''; msg.style.color = color;
    alertEl.style.display = 'flex';
    unlockAudio();
    if (a.sound === false) stopBeep(); else startBeep();
    const dur = Math.max(2, parseInt(a.duration_sec, 10) || 12);
    if (alertTimer) clearTimeout(alertTimer);
    alertTimer = setTimeout(dismissAlert, dur * 1000);
  }

  function applyState(deviceId, dps) {
    const entries = stateMap.get(deviceId);
    if (!entries) return;
    for (const { el, channel } of entries) {
      el.classList.toggle('on', isOn(dps, channel));
    }
  }

  function connectMqtt(pass) {
    mq = mqtt.connect(BROKER, {
      username: USER, password: pass,
      keepalive: 30, reconnectPeriod: 3000, clean: true,
    });
    mq.on('connect', () => {
      mqUp = true; setDot('up');
      mq.subscribe('mur/home/device/+/state', { qos: 0 });
      mq.subscribe(ALERT_TOPIC, { qos: 0 });           // tablet alerts (Notifications)
    });
    mq.on('close',   () => { mqUp = false; setDot('down'); });
    mq.on('offline', () => { mqUp = false; setDot('down'); });
    mq.on('error',   () => { setDot('down'); });
    mq.on('message', (topic, payload) => {
      if (topic === ALERT_TOPIC) {
        let a; try { a = JSON.parse(payload.toString()); } catch (e) { return; }
        showAlert(a); return;
      }
      // mur/home/device/<id>/state
      const parts = topic.split('/');
      if (parts.length !== 5 || parts[4] !== 'state') return;
      const deviceId = parts[3];
      if (!stateMap.has(deviceId)) return;
      let msg; try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
      applyState(deviceId, msg && msg.dps ? msg.dps : msg);
    });
  }

  function setDot(cls) { const d = $('dot'); if (d) d.className = 'dot ' + cls; }
  function tick() {
    const c = $('clock');
    if (c) c.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  async function boot() {
    tick(); setInterval(tick, 15000);
    try {
      const [cRes, pRes] = await Promise.all([
        fetch('/api/panel/config').then(r => r.json()),
        fetch('/api/panel/pass').then(r => r.json()),
      ]);
      cfg = (cRes && cRes.value) || { pages: [] };
      render();
      connectMqtt(pRes && pRes.value);
    } catch (e) {
      $('grid').innerHTML = '<div id="empty">Could not load panel config.<br>' + esc(e.message) + '</div>';
    }
    // Re-pull config every 60 s so dashboard edits appear without a manual reload.
    setInterval(async () => {
      try {
        const r = await fetch('/api/panel/config'); const j = await r.json();
        const next = JSON.stringify(j.value || {});
        if (next !== JSON.stringify(cfg)) { cfg = j.value || { pages: [] };
          if (activePage >= (cfg.pages || []).length) activePage = 0; render(); }
      } catch (e) { /* keep last */ }
    }, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
