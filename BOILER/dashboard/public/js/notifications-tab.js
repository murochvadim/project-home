// Notifications tab (Main Agent) — author + manage notifications. UI only; the
// LXC rule engine (RULES/rules/notifications.py) does the firing. CRUD against
// /api/notifications/defs; the popup itself is notify-toast.js.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const TRIG_LABEL = {
    main_door_closed: 'Main door closes',
    home_mode_changed: 'Home mode changes',
    people_count_changed: 'People count changes',
    device_presence: 'Presence detected',
    scheduled_time: 'At a scheduled time',
  };
  const DELIV_LABEL = { immediate: 'Immediately', at_time: 'At a set time', daily: 'Daily summary' };

  // Presence/motion/door sensors — for the device_presence trigger selector.
  let _presenceDevs = null;
  async function loadPresenceDevices() {
    if (_presenceDevs) return _presenceDevs;
    try {
      const list = await fetch('/api/devices').then(r => r.json());
      _presenceDevs = (Array.isArray(list) ? list : []).filter(
        d => ['presence', 'motion', 'door_sensor'].includes(d.device_type))
        .map(d => ({ id: d.id, name: d.name })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) { _presenceDevs = []; }
    const sel = $('notif-f-trigparam-deviceval');
    if (sel) sel.innerHTML = _presenceDevs.length
      ? _presenceDevs.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')
      : '<option value="">(no presence sensors found)</option>';
    return _presenceDevs;
  }
  function _devName(id) { const d = (_presenceDevs || []).find(x => x.id === id); return d ? d.name : null; }

  // ── list ──
  window.notifLoad = async function () {
    try {
      await loadPresenceDevices();     // device names ready for the summary line
      const defs = await fetch('/api/notifications/defs').then(r => r.json());
      const box = document.getElementById('notif-list');
      if (!box) return;
      if (!defs.length) { box.innerHTML = '<div style="color:#888;font-size:0.85rem;">No notifications yet — click “+ Add notification”.</div>'; }
      else box.innerHTML = defs.map(renderRow).join('');
    } catch (e) { /* ignore */ }
    loadRecent();
  };

  function summarize(d) {
    let t = TRIG_LABEL[d.trigger] || d.trigger;
    if (d.trigger === 'home_mode_changed' && d.trigger_param) t += ' → ' + d.trigger_param;
    if (d.trigger === 'device_presence' && d.trigger_param) t += ' → ' + (_devName(d.trigger_param) || 'sensor');
    if (d.trigger === 'scheduled_time' && d.trigger_param) t += ' at ' + d.trigger_param;
    const tab = d.surfaces && d.surfaces.tablet;
    if (tab && tab.enabled) t += ' 📟';
    const conds = (d.conditions || []).map(c => {
      if (c.field === 'home_mode') return 'home mode is ' + c.value;
      if (c.field === 'people_home') return 'people ' + c.op + ' ' + c.value;
      if (c.field === 'time_window') return 'between ' + c.value;
      if (c.field === 'day') return 'on ' + c.value;
      if (c.field === 'main_door') return 'main door is ' + c.value;
      return c.field;
    });
    let when = DELIV_LABEL[d.delivery] || d.delivery;
    if ((d.delivery === 'at_time' || d.delivery === 'daily') && d.delivery_time) when += ' ' + d.delivery_time;
    return { t, conds, when };
  }

  function renderRow(d) {
    const s = summarize(d);
    const accent = { info: '#2b4c7e', warn: '#e67e22', alert: '#c0392b' }[d.level] || '#2b4c7e';
    return `<div style="border:1px solid #e2e6eb;border-left:4px solid ${accent};border-radius:6px;padding:9px 12px;margin-bottom:8px;${d.enabled ? '' : 'opacity:0.55;'}">
      <div style="display:flex;align-items:center;gap:10px;">
        <label style="font-size:0.78rem;white-space:nowrap;"><input type="checkbox" ${d.enabled ? 'checked' : ''} onchange="notifToggle(${d.id},this.checked)"> on</label>
        <b style="flex:1;">${esc(d.name)}</b>
        <button onclick="notifTest(${d.id})" title="Fire a test now — popup + tablet flash (if configured)" style="background:#27ae60;color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:0.76rem;cursor:pointer;">▶ Test</button>
        <button onclick="notifEdit(${d.id})" style="background:#eef2f7;color:#2b4c7e;border:1px solid #cdd8e6;border-radius:4px;padding:3px 10px;font-size:0.76rem;cursor:pointer;">Edit</button>
        <button onclick="notifDelete(${d.id},'${esc(d.name).replace(/'/g, '')}')" style="background:#fff;color:#c0392b;border:1px solid #e0b4b4;border-radius:4px;padding:3px 9px;font-size:0.76rem;cursor:pointer;">✕</button>
      </div>
      <div style="font-size:0.78rem;color:#555;margin-top:5px;">
        <b>When:</b> ${esc(s.t)}${s.conds.length ? ' · <b>if</b> ' + esc(s.conds.join(', ')) : ''} · <b>tell me:</b> ${esc(s.when)}
      </div>
      <div style="font-size:0.82rem;color:#333;margin-top:3px;">💬 ${esc(d.message || '(no message)')}</div>
    </div>`;
  }

  async function loadRecent() {
    try {
      // reuse the feed (since=0 returns recent events + we just list them read-only)
      const data = await fetch('/api/notifications/feed?since=0').then(r => r.json());
      const box = document.getElementById('notif-recent');
      if (!box) return;
      const evs = (data.events || []).slice(-12).reverse();
      if (!evs.length) { box.textContent = 'Nothing fired yet.'; return; }
      box.innerHTML = evs.map(e => {
        const t = new Date((e.ts_epoch || 0) * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', hour12: false });
        return `<div style="padding:3px 0;border-top:1px solid #eee;"><span style="color:#999;">${esc(t)}</span> — ${esc(e.body)}</div>`;
      }).join('');
    } catch (e) { /* ignore */ }
  }

  // ── modal ──
  const $ = id => document.getElementById(id);
  window.notifCloseModal = function () { $('notif-modal').style.display = 'none'; };

  window.notifTriggerChanged = function () {
    const t = $('notif-f-trigger').value;
    $('notif-f-trigparam-mode').style.display = (t === 'home_mode_changed') ? 'block' : 'none';
    $('notif-f-trigparam-time').style.display = (t === 'scheduled_time') ? 'block' : 'none';
    $('notif-f-trigparam-device').style.display = (t === 'device_presence') ? 'block' : 'none';
    if (t === 'device_presence') loadPresenceDevices();
  };
  window.notifTabletToggled = function () {
    $('notif-f-tablet-cfg').style.display = $('notif-f-tablet').checked ? 'flex' : 'none';
  };
  window.notifDeliveryChanged = function () {
    const d = $('notif-f-delivery').value;
    $('notif-f-delivtime-wrap').style.display = (d === 'at_time' || d === 'daily') ? 'block' : 'none';
  };

  // condition rows
  function condRow(c) {
    c = c || { field: 'home_mode', op: 'is', value: 'home' };
    const wrap = document.createElement('div');
    wrap.className = 'notif-cond-row';
    const fieldSel = `<select data-k="field" onchange="notifCondFieldChanged(this)">
      <option value="home_mode">home mode</option>
      <option value="people_home">people home</option>
      <option value="time_window">time window</option>
      <option value="day">day</option>
      <option value="main_door">main door</option></select>`;
    wrap.innerHTML = fieldSel + '<span data-slot="rest" style="display:flex;gap:6px;flex:1;"></span>' +
      '<button onclick="this.parentNode.remove()" style="background:none;border:none;color:#c0392b;cursor:pointer;font-size:0.9rem;">✕</button>';
    $('notif-f-conds').appendChild(wrap);
    wrap.querySelector('[data-k="field"]').value = c.field;
    renderCondRest(wrap, c);
    return wrap;
  }
  function renderCondRest(wrap, c) {
    const field = wrap.querySelector('[data-k="field"]').value;
    const slot = wrap.querySelector('[data-slot="rest"]');
    if (field === 'home_mode') {
      slot.innerHTML = `<span style="align-self:center;font-size:0.8rem;">is</span>
        <select data-k="op" style="display:none;"><option value="is">is</option></select>
        <select data-k="value"><option>home</option><option>away</option><option>abroad</option></select>`;
      slot.querySelector('[data-k="value"]').value = c.value || 'home';
    } else if (field === 'people_home') {
      slot.innerHTML = `<select data-k="op"><option value=">=">≥</option><option value="<=">≤</option><option value="==">=</option><option value=">">&gt;</option><option value="<">&lt;</option></select>
        <input data-k="value" type="number" min="0" style="width:60px;" value="${esc(c.value != null ? c.value : 1)}">`;
      slot.querySelector('[data-k="op"]').value = c.op || '>=';
    } else if (field === 'time_window') {
      slot.innerHTML = `<span style="align-self:center;font-size:0.8rem;">between</span>
        <input data-k="op" type="hidden" value="between">
        <input data-k="value" placeholder="18:00-23:00" style="width:120px;" value="${esc(c.value || '')}">`;
    } else if (field === 'day') {
      slot.innerHTML = `<span style="align-self:center;font-size:0.8rem;">is</span>
        <input data-k="op" type="hidden" value="is">
        <select data-k="value"><option value="weekday">weekday</option><option value="weekend">weekend</option></select>`;
      slot.querySelector('[data-k="value"]').value = c.value || 'weekday';
    } else if (field === 'main_door') {
      slot.innerHTML = `<span style="align-self:center;font-size:0.8rem;">is</span>
        <select data-k="op" style="display:none;"><option value="is">is</option></select>
        <select data-k="value"><option value="open">open</option><option value="closed">closed</option></select>`;
      slot.querySelector('[data-k="value"]').value = c.value || 'open';
    }
  }
  window.notifCondFieldChanged = function (sel) { renderCondRest(sel.parentNode, {}); };
  window.notifAddCond = function () { condRow(); };

  async function fillForm(d) {
    d = d || {};
    await loadPresenceDevices();   // populate the sensor dropdown before setting its value
    $('notif-f-id').value = d.id || '';
    $('notif-f-name').value = d.name || '';
    $('notif-f-trigger').value = d.trigger || 'main_door_closed';
    $('notif-f-trigparam-modeval').value = (d.trigger === 'home_mode_changed' ? (d.trigger_param || '') : '');
    $('notif-f-trigparam-timeval').value = (d.trigger === 'scheduled_time' ? (d.trigger_param || '') : '');
    $('notif-f-trigparam-deviceval').value = (d.trigger === 'device_presence' ? (d.trigger_param || '') : '');
    $('notif-f-message').value = d.message || '';
    $('notif-f-delivery').value = d.delivery || 'immediate';
    $('notif-f-delivtime').value = d.delivery_time || '';
    $('notif-f-level').value = d.level || 'info';
    $('notif-f-throttle').value = d.throttle_min || 0;
    const surf = d.surfaces || { popup: true };
    $('notif-f-popup').checked = surf.popup !== false;
    $('notif-f-setpeople').checked = (d.action === 'set_people');
    const tab = (surf && surf.tablet) || {};
    $('notif-f-tablet').checked = !!tab.enabled;
    $('notif-f-tablet-icon').value = tab.icon || 'door';
    $('notif-f-tablet-color').value = tab.color || '#e5352b';
    $('notif-f-tablet-blink').checked = tab.blink !== false;
    $('notif-f-tablet-sound').checked = tab.sound !== false;
    $('notif-f-tablet-dur').value = tab.duration_sec || 12;
    $('notif-f-conds').innerHTML = '';
    (d.conditions || []).forEach(condRow);
    notifTriggerChanged();
    notifDeliveryChanged();
    notifTabletToggled();
    $('notif-modal').style.display = 'flex';
    $('notif-modal-title').textContent = d.id ? 'Edit notification' : 'New notification';
  }

  window.notifNew = function () { fillForm(null); };
  window.notifEdit = async function (id) {
    const defs = await fetch('/api/notifications/defs').then(r => r.json());
    const d = defs.find(x => x.id === id);
    if (d) fillForm(d);
  };

  window.notifSave = async function () {
    const trig = $('notif-f-trigger').value;
    let trigParam = null;
    if (trig === 'home_mode_changed') trigParam = $('notif-f-trigparam-modeval').value || null;
    if (trig === 'scheduled_time') trigParam = $('notif-f-trigparam-timeval').value || null;
    if (trig === 'device_presence') trigParam = $('notif-f-trigparam-deviceval').value || null;
    const conds = [];
    document.querySelectorAll('#notif-f-conds .notif-cond-row').forEach(row => {
      const g = k => { const el = row.querySelector(`[data-k="${k}"]`); return el ? el.value : null; };
      conds.push({ field: g('field'), op: g('op') || 'is', value: g('value') });
    });
    const body = {
      name: $('notif-f-name').value.trim(),
      trigger: trig,
      trigger_param: trigParam,
      conditions: conds,
      message: $('notif-f-message').value,
      delivery: $('notif-f-delivery').value,
      delivery_time: (($('notif-f-delivery').value === 'at_time' || $('notif-f-delivery').value === 'daily') ? ($('notif-f-delivtime').value || null) : null),
      throttle_min: parseInt($('notif-f-throttle').value) || 0,
      level: $('notif-f-level').value,
      surfaces: (() => {
        const s = { popup: $('notif-f-popup').checked, pages: 'all', phone: false };
        if ($('notif-f-tablet').checked) {
          s.tablet = {
            enabled: true,
            icon: $('notif-f-tablet-icon').value || 'door',
            color: $('notif-f-tablet-color').value || '#e5352b',
            blink: $('notif-f-tablet-blink').checked,
            sound: $('notif-f-tablet-sound').checked,
            duration_sec: parseInt($('notif-f-tablet-dur').value) || 12,
          };
        }
        return s;
      })(),
      action: $('notif-f-setpeople').checked ? 'set_people' : null,
    };
    if (!body.name) { $('notif-f-name').focus(); return; }
    const id = $('notif-f-id').value;
    const url = id ? '/api/notifications/defs/' + id : '/api/notifications/defs';
    const method = id ? 'PATCH' : 'POST';
    await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    notifCloseModal();
    notifLoad();
  };

  window.notifToggle = async function (id, enabled) {
    await fetch('/api/notifications/defs/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    notifLoad();
  };
  window.notifDelete = async function (id, name) {
    if (!confirm('Delete notification “' + name + '”?')) return;
    await fetch('/api/notifications/defs/' + id, { method: 'DELETE' });
    notifLoad();
  };
  window.notifClearRecent = async function () {
    if (!confirm('Clear the recent notifications log?')) return;
    try { await fetch('/api/notifications/events', { method: 'DELETE' }); } catch (e) { /* ignore */ }
    loadRecent();
  };
  window.notifTest = async function (id) {
    await fetch('/api/notifications/test/' + id, { method: 'POST' });
    // Ask the popup component to check immediately instead of waiting for its poll.
    window.dispatchEvent(new CustomEvent('notify-toast-poll'));
    setTimeout(loadRecent, 800);
  };

  // Load when the Notifications tab is opened.
  const _prev = window.showTab;
  window.showTab = function (name, btn) {
    if (typeof _prev === 'function') _prev(name, btn);
    if (name === 'notifications') notifLoad();
  };
})();
