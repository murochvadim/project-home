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
  function tileIcon(tile) {
    if (tile.icon) return tile.icon;
    const b = (tile.bindings || [])[0] || {};
    if (b.type === 'scene') return '🎬';
    if (b.type === 'curtain') return '🪟';
    if (b.type === 'pixoo_preset') return '🖼️';
    if (b.type === 'media') return '📺';
    return '💡';
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
        `<div class="tile-icon">${esc(tileIcon(t))}</div>` +
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
        for (const t of byPos[p]) rowEl.appendChild(makeTile(t));
      }
      grid.appendChild(rowEl);
    }
  }

  function tap(tile, el) {
    el.classList.remove('pressed'); void el.offsetWidth; el.classList.add('pressed');
    if (mq && mqUp) {
      mq.publish(EVENT_TOPIC, JSON.stringify({ dps: { tile: tile.id, event: 'short' } }), { qos: 0 });
    }
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
    });
    mq.on('close',   () => { mqUp = false; setDot('down'); });
    mq.on('offline', () => { mqUp = false; setDot('down'); });
    mq.on('error',   () => { setDot('down'); });
    mq.on('message', (topic, payload) => {
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
