/* medical-bobo.js — "BoBo Balance Board" classification card (Medical → Settings).
 *
 * Names + show/hide for the BoBo board's live parameters: the 9 IMU channels
 * (ch0..ch8) + the BLE link. Config persists in dashboard_settings.medical.bobo.
 *
 * Live values come from GET /api/esp/boards -> the balcony_bridge board's
 * last_status (which holds ch[9] + ble_connected). NOTE: ch[] is only in the
 * board's ~60 s status heartbeat (plus an immediate publish on BLE connect/
 * disconnect), so channel values refresh on connect + ~every 60 s — BLE flips
 * near-instantly. (The continuous 5 Hz stream is the future game telemetry.)
 *
 * The `show` flags are stored for a future Personal-Health results card to consume.
 */
(function () {
  const DEVICE_ID = 'balcony_bridge';
  const FRESH_MS  = 180000;   // board considered online if seen within 3 min
  const POLL_MS   = 2000;   // matches the board's ~2 s fast heartbeat while BoBo is connected

  // Default classification of the 9 channels (editable). Orient X-Y-Z are the
  // ch6-8 axes that hold the gravity/tilt reference at rest.
  const DEFAULTS = [
    { key: 'ch0', name: 'Accel X',  show: true },
    { key: 'ch1', name: 'Accel Y',  show: true },
    { key: 'ch2', name: 'Accel Z',  show: true },
    { key: 'ch3', name: 'Gyro X',   show: true },
    { key: 'ch4', name: 'Gyro Y',   show: true },
    { key: 'ch5', name: 'Gyro Z',   show: true },
    { key: 'ch6', name: 'Orient X', show: true },
    { key: 'ch7', name: 'Orient Y', show: true },
    { key: 'ch8', name: 'Orient Z', show: true },
    { key: 'ble_connected', name: 'BLE Connected', show: true },
  ];

  let _cfg = null;                       // { params: [...] }
  let _live = { _online: false };        // { ch:[...], ble_connected, _online }
  let _pollTimer = null;

  const $   = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Overlay saved name/show onto the fixed DEFAULTS order (keys never change).
  function mergedParams(saved) {
    const byKey = {};
    ((saved && saved.params) || []).forEach(p => { if (p && p.key) byKey[p.key] = p; });
    return DEFAULTS.map(d => {
      const s = byKey[d.key];
      return {
        key:  d.key,
        name: (s && typeof s.name === 'string' && s.name.trim()) ? s.name : d.name,
        show: s ? s.show !== false : d.show,
      };
    });
  }

  function liveValue(key) {
    if (!_live._online) return { txt: '—', color: '#999' };
    if (key === 'ble_connected') {
      return _live.ble_connected
        ? { txt: 'connected', color: '#1a7f37' }
        : { txt: 'disconnected', color: '#c0392b' };
    }
    const idx = parseInt(key.slice(2), 10);   // ch3 -> 3
    if (!Array.isArray(_live.ch) || _live.ch[idx] == null) return { txt: '—', color: '#999' };
    return { txt: String(_live.ch[idx]), color: '#333' };
  }

  function renderPreview() {
    const prev = $('bobo-preview');
    if (!prev || !_cfg) return;
    const vis = _cfg.params.filter(p => p.show);
    if (!vis.length) {
      prev.innerHTML = '<span style="color:#999;font-style:italic;font-size:0.82rem;">Nothing shown — tick parameters below.</span>';
      return;
    }
    prev.innerHTML = vis.map(p => {
      const lv = liveValue(p.key);
      return `<span style="display:inline-flex;flex-direction:column;align-items:center;min-width:76px;padding:5px 9px;background:#f7f4ef;border-radius:6px;">
        <span style="font-size:0.68rem;color:#777;">${esc(p.name)}</span>
        <span data-bobo-pval="${esc(p.key)}" style="font-weight:700;font-variant-numeric:tabular-nums;color:${lv.color};">${esc(lv.txt)}</span>
      </span>`;
    }).join('');
  }

  function render() {
    const list = $('bobo-param-list');
    if (!list || !_cfg) return;
    list.innerHTML = _cfg.params.map((p, i) => {
      const lv = liveValue(p.key);
      return `<div style="display:grid;grid-template-columns:34px 1fr 130px;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid #f0ece6;">
        <input type="checkbox" data-bobo-show="${i}" ${p.show ? 'checked' : ''} title="Show this parameter" style="transform:scale(1.2);justify-self:center;">
        <input type="text" data-bobo-name="${i}" value="${esc(p.name)}" spellcheck="false" style="padding:5px 8px;border:1px solid #d0cbc4;border-radius:4px;width:100%;box-sizing:border-box;">
        <span data-bobo-val="${esc(p.key)}" style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600;color:${lv.color};">${esc(lv.txt)}</span>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-bobo-name]').forEach(el => el.addEventListener('input', e => {
      _cfg.params[+e.target.dataset.boboName].name = e.target.value;
      renderPreview();
    }));
    list.querySelectorAll('[data-bobo-show]').forEach(el => el.addEventListener('change', e => {
      _cfg.params[+e.target.dataset.boboShow].show = e.target.checked;
      renderPreview();
    }));
    renderPreview();
  }

  // Patch just the value cells (no full re-render) on each poll.
  function patchValues() {
    document.querySelectorAll('[data-bobo-val]').forEach(el => {
      const lv = liveValue(el.dataset.boboVal); el.textContent = lv.txt; el.style.color = lv.color;
    });
    document.querySelectorAll('[data-bobo-pval]').forEach(el => {
      const lv = liveValue(el.dataset.boboPval); el.textContent = lv.txt; el.style.color = lv.color;
    });
  }

  async function pollLive() {
    const panel = $('tab-settings');
    if (!panel || panel.offsetParent === null) return;   // only poll while Settings tab is visible
    try {
      const raw = await (await fetch('/api/esp/boards')).json();
      const arr = Array.isArray(raw) ? raw : (raw.boards || []);
      const b = arr.find(x => x && x.id === DEVICE_ID);
      const fresh = b && b.last_seen && (Date.now() - new Date(b.last_seen).getTime() < FRESH_MS);
      if (b && b.last_status && fresh) {
        _live = { ch: b.last_status.ch, ble_connected: !!b.last_status.ble_connected, _online: true };
      } else {
        _live = { _online: false };
      }
    } catch (e) { /* keep last snapshot on transient error */ }
    patchValues();
  }

  window.medBoboSettingsInit = async function () {
    try {
      const j = await (await fetch('/api/dashboard-settings/medical.bobo')).json();
      _cfg = { params: mergedParams(j && j.value) };
    } catch (e) {
      _cfg = { params: mergedParams(null) };
    }
    render();
    if ($('bobo-status')) $('bobo-status').textContent = '';
    if (_pollTimer) clearInterval(_pollTimer);
    pollLive();
    _pollTimer = setInterval(pollLive, POLL_MS);
  };

  window.medBoboSave = async function () {
    if (!_cfg) return;
    const value = {
      device_id: DEVICE_ID,
      params: _cfg.params.map(p => ({ key: p.key, name: (p.name || '').trim() || p.key, show: p.show !== false })),
    };
    const st = $('bobo-status');
    try {
      const r = await fetch('/api/dashboard-settings/medical.bobo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (st) { st.style.color = '#2e7d32'; st.textContent = '✓ Saved'; }
    } catch (e) {
      if (st) { st.style.color = '#c0392b'; st.textContent = 'Failed: ' + e.message; }
    }
  };

  window.medBoboResetNames = function () {
    if (!_cfg) return;
    _cfg.params = DEFAULTS.map(d => {
      const cur = _cfg.params.find(p => p.key === d.key);
      return { key: d.key, name: d.name, show: cur ? cur.show !== false : d.show };
    });
    render();
    const st = $('bobo-status'); if (st) { st.style.color = '#888'; st.textContent = 'Names reset — click Save All to keep.'; }
  };
})();
