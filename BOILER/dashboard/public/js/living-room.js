// Living Room Agent — page logic
(function () {
  const WM1_ID = 'e410cc7b-a734-4177-b941-2394dd7a5f7f';
  const WM2_ID = '62f40d30-5c63-4d97-bf55-c602d1e2ee93';

  const CONTROLLABLE_TYPES = new Set(['switch', 'light', 'circuit_breaker', 'water_heater', 'curtain', 'valve']);
  const ACTIONS = [
    { v: 'turn_on',  label: 'Turn On',  tag: 'on'     },
    { v: 'turn_off', label: 'Turn Off', tag: 'off'    },
    { v: 'toggle',   label: 'Toggle',   tag: 'toggle' },
  ];
  const STORAGE_KEY = 'living-room.wallmote_bindings';

  // In-memory bindings state
  // Shape: { 'wm1:button1:pushed': [{device_id, channel, name, label, action}, ...] }
  let bindings = {};

  // Cached device list (built once on load)
  let controllableDevices = [];

  // Active picker context
  let activePicker = null;

  function key(wm, btn, ev) { return `${wm}:${btn}:${ev}`; }
  function defaultActionFor(event) { return event === 'held' ? 'toggle' : 'turn_on'; }
  function actionLabel(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.label : v; }
  function actionTag(v) { const a = ACTIONS.find(x => x.v === v); return a ? a.tag : 'on'; }

  function showTab(name, btn) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    btn.classList.add('active');
  }
  window.showTab = showTab;

  function refreshPage() {
    const el = document.getElementById('last-refresh');
    if (el) el.textContent = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
    loadData();
  }
  window.refreshPage = refreshPage;

  async function loadData() {
    try {
      const [devs, saved] = await Promise.all([
        fetch('/api/devices').then(r => r.json()),
        fetch(`/api/dashboard-settings/${encodeURIComponent(STORAGE_KEY)}`).then(r => r.json()).catch(() => ({ value: null })),
      ]);

      // Wallmote status (both)
      const fmtWm = (devId, prefix) => {
        const d = devs.find(x => x.id === devId);
        if (!d) return;
        const batt = d.last_state?.battery;
        const bEl = document.getElementById(prefix + '-battery');
        if (bEl) bEl.textContent = batt != null ? batt + '%' : '—';
        const lsEl = document.getElementById(prefix + '-last-seen');
        if (lsEl && d.last_seen) {
          lsEl.textContent = new Date(d.last_seen).toLocaleTimeString('he-IL',
            { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
        }
      };
      fmtWm(WM1_ID, 'wm1');
      fmtWm(WM2_ID, 'wm2');

      // Build controllable device list — expand multi-gang switches by channel
      controllableDevices = [];
      for (const d of devs) {
        if (d.enabled === false) continue;
        if (!CONTROLLABLE_TYPES.has(d.device_type)) continue;

        const chanCfg = d.channel_config || {};
        const dpsLabels = d.dps_labels || {};

        // Channel-expansion priority:
        // 1) channel_config with numeric keys (Tuya local/gateway multi-gang)
        // 2) dps_labels with state_l<N> keys (Zigbee multi-gang)
        const tuyaChans = Object.keys(chanCfg).filter(k => k && !isNaN(parseInt(k))).sort();
        const zigbeeChans = Object.keys(dpsLabels).filter(k => /^state_l\d+$/i.test(k))
          .sort((a, b) => parseInt(a.replace(/\D/g,'')) - parseInt(b.replace(/\D/g,'')));

        if (tuyaChans.length > 1) {
          for (const ch of tuyaChans) {
            const chInfo = chanCfg[ch] || {};
            controllableDevices.push({
              device_id: d.id, channel: ch,
              name: d.name, label: chInfo.name || `Ch.${ch}`,
              room: chInfo.room || d.room || '', protocol: d.protocol,
            });
          }
        } else if (zigbeeChans.length > 1) {
          for (const ch of zigbeeChans) {
            controllableDevices.push({
              device_id: d.id, channel: ch,
              name: d.name, label: dpsLabels[ch] || ch,
              room: d.room || '', protocol: d.protocol,
            });
          }
        } else {
          controllableDevices.push({
            device_id: d.id, channel: null,
            name: d.name, label: '',
            room: d.room || '', protocol: d.protocol,
          });
        }
      }
      controllableDevices.sort((a, b) => {
        const rc = (a.room || 'zzz').localeCompare(b.room || 'zzz');
        return rc !== 0 ? rc : a.name.localeCompare(b.name);
      });

      // Load saved bindings
      if (saved && saved.value && typeof saved.value === 'object') {
        bindings = saved.value;
      } else {
        bindings = {};
      }

      // Populate all picker displays from saved state
      document.querySelectorAll('.device-picker').forEach(p => {
        updatePickerDisplay(p, p.dataset.wallmote, p.dataset.button, p.dataset.event);
      });
    } catch (e) {
      console.error('Living Room load error:', e);
    }
  }

  // ─── Picker ──────────────────────────────────────────────────────

  window.openPicker = function (wallmote, button, event, pickerEl) {
    const slotKey = key(wallmote, button, event);
    const currentSelection = bindings[slotKey] || [];
    activePicker = {
      wallmote, button, event, pickerEl,
      selectedBefore: JSON.parse(JSON.stringify(currentSelection)),
    };
    document.getElementById('picker-title').textContent =
      `Wallmote ${wallmote.replace('wm','')} · Button ${button.replace('button','')} · ${event}`;
    document.getElementById('picker-search-input').value = '';
    renderPickerList('');
    document.getElementById('picker-overlay').classList.add('show');
  };

  window.closePicker = function (save) {
    const overlay = document.getElementById('picker-overlay');
    overlay.classList.remove('show');
    if (!save && activePicker) {
      bindings[key(activePicker.wallmote, activePicker.button, activePicker.event)] = activePicker.selectedBefore;
    }
    if (activePicker) updatePickerDisplay(activePicker.pickerEl, activePicker.wallmote, activePicker.button, activePicker.event);
    activePicker = null;
  };

  function renderPickerList(filter) {
    if (!activePicker) return;
    const slotKey = key(activePicker.wallmote, activePicker.button, activePicker.event);
    const selected = bindings[slotKey] || [];
    const selectedByKey = new Map(selected.map(s => [s.device_id + ':' + (s.channel || ''), s]));

    const f = (filter || '').toLowerCase();
    const list = document.getElementById('picker-list');
    list.innerHTML = '';

    let currentRoom = null;
    let visibleCount = 0;
    const defaultAct = defaultActionFor(activePicker.event);

    for (const d of controllableDevices) {
      const rowKey = d.device_id + ':' + (d.channel || '');
      const displayName = d.label ? `${d.name} — ${d.label}` : d.name;
      const searchBlob = `${d.name} ${d.label} ${d.room} ${d.protocol}`.toLowerCase();
      if (f && !searchBlob.includes(f)) continue;

      if (d.room !== currentRoom) {
        currentRoom = d.room;
        const rl = document.createElement('div');
        rl.className = 'picker-room-label';
        rl.textContent = d.room || '(no room)';
        list.appendChild(rl);
      }

      const existing = selectedByKey.get(rowKey);
      const checked = !!existing;
      const act = existing ? existing.action : defaultAct;

      const item = document.createElement('div');
      item.className = 'picker-item';
      item.innerHTML = `
        <input type="checkbox" ${checked ? 'checked' : ''}>
        <div class="picker-item-name">${escHtml(displayName)}</div>
        <select class="picker-action-select">
          ${ACTIONS.map(a => `<option value="${a.v}" ${a.v === act ? 'selected' : ''}>${a.label}</option>`).join('')}
        </select>
        <div class="picker-item-meta">${escHtml(d.protocol)}${d.channel ? ' · Ch.'+d.channel : ''}</div>
      `;
      const cb = item.querySelector('input');
      const sel = item.querySelector('select');

      item.addEventListener('click', (e) => {
        if (e.target === sel || sel.contains(e.target)) return;  // let the select handle its own clicks
        if (e.target !== cb) cb.checked = !cb.checked;
        toggleSelection(d, cb.checked, sel.value);
      });
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        // Changing action implicitly selects the device (if not already)
        if (!cb.checked) cb.checked = true;
        toggleSelection(d, cb.checked, sel.value);
      });
      sel.addEventListener('click', (e) => e.stopPropagation());

      list.appendChild(item);
      visibleCount++;
    }

    if (visibleCount === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:20px;color:#aaa;text-align:center;font-size:0.82rem;';
      empty.textContent = 'No devices match your filter';
      list.appendChild(empty);
    }
    updatePickerCount();
  }

  function toggleSelection(dev, checked, action) {
    if (!activePicker) return;
    const slotKey = key(activePicker.wallmote, activePicker.button, activePicker.event);
    if (!bindings[slotKey]) bindings[slotKey] = [];
    const existingIdx = bindings[slotKey].findIndex(s =>
      s.device_id === dev.device_id && (s.channel || null) === (dev.channel || null));
    if (checked) {
      if (existingIdx >= 0) {
        bindings[slotKey][existingIdx].action = action;
      } else {
        bindings[slotKey].push({
          device_id: dev.device_id, channel: dev.channel,
          name: dev.name, label: dev.label,
          action: action,
        });
      }
    } else if (existingIdx >= 0) {
      bindings[slotKey].splice(existingIdx, 1);
    }
    updatePickerCount();
  }

  function updatePickerCount() {
    if (!activePicker) return;
    const slotKey = key(activePicker.wallmote, activePicker.button, activePicker.event);
    const count = (bindings[slotKey] || []).length;
    document.getElementById('picker-count').textContent = `${count} selected`;
  }

  function updatePickerDisplay(pickerEl, wallmote, button, event) {
    const slotKey = key(wallmote, button, event);
    const sel = bindings[slotKey] || [];
    if (sel.length === 0) {
      pickerEl.classList.add('empty');
      pickerEl.innerHTML = '— select devices —';
      pickerEl.title = '';
    } else {
      pickerEl.classList.remove('empty');
      const makeTag = (s) =>
        `${escHtml(s.label ? s.name + ':' + s.label : s.name)}<span class="action-tag ${actionTag(s.action)}">${actionTag(s.action)}</span>`;
      pickerEl.innerHTML = sel.map(makeTag).join(' · ');
      pickerEl.title = sel.map(s => `${s.name}${s.label?':'+s.label:''} → ${actionLabel(s.action)}`).join('\n');
    }
  }

  window.filterPicker = function () {
    const v = document.getElementById('picker-search-input').value;
    renderPickerList(v);
  };

  // ─── Test — dispatches per-device actions ────────────────────────

  async function fetchDeviceState(device_id, channel) {
    try {
      const devs = await fetch('/api/devices').then(r => r.json());
      const d = devs.find(x => x.id === device_id);
      if (!d || !d.last_state) return null;
      const k = channel || '1';
      const v = d.last_state[k];
      if (v === true || v === 1 || v === 'on' || v === 'ON' || v === 'true') return true;
      if (v === false || v === 0 || v === 'off' || v === 'OFF' || v === 'false') return false;
      return null;
    } catch (e) { return null; }
  }

  async function dispatchOne(device_id, channel, state) {
    const body = channel ? { state, channel } : { state };
    const r = await fetch(`/api/devices/${encodeURIComponent(device_id)}/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  window.testBinding = async function (wallmote, button, event, btn) {
    const slotKey = key(wallmote, button, event);
    const sel = bindings[slotKey] || [];
    if (sel.length === 0) {
      alert(`No devices bound to ${wallmote} ${button} ${event}. Select devices first.`);
      return;
    }
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    let ok = 0, fail = 0;
    const errors = [];
    for (const s of sel) {
      try {
        let target;
        if (s.action === 'turn_on') target = true;
        else if (s.action === 'turn_off') target = false;
        else if (s.action === 'toggle') {
          const cur = await fetchDeviceState(s.device_id, s.channel);
          target = (cur === true) ? false : true;
        }
        await dispatchOne(s.device_id, s.channel, target);
        ok++;
      } catch (e) {
        fail++;
        errors.push(`${s.name}${s.label?':'+s.label:''} ${s.action}: ${e.message}`);
      }
    }
    btn.textContent = fail === 0 ? `✓ ${ok}` : `✗ ${fail}/${ok+fail}`;
    btn.style.cssText = `background:${fail===0?'#3a7d44':'#c0392b'};color:#fff;border-color:transparent;`;
    if (fail > 0) {
      console.error('[wallmote test]', errors);
      alert(`Test: ${ok} ok, ${fail} failed:\n\n` + errors.join('\n'));
    }
    setTimeout(() => {
      btn.textContent = original; btn.disabled = false; btn.style.cssText = '';
    }, 2000);
  };

  // ─── Save — POST to dashboard_settings ──────────────────────────

  window.saveBindings = async function () {
    const saveBtn = document.querySelector('.btn-save');
    const originalText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const r = await fetch(`/api/dashboard-settings/${encodeURIComponent(STORAGE_KEY)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: bindings }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      saveBtn.textContent = '✓ Saved';
      saveBtn.style.background = '#3a7d44';
      setTimeout(() => {
        saveBtn.textContent = originalText;
        saveBtn.style.background = '';
        saveBtn.disabled = false;
      }, 1500);
    } catch (e) {
      saveBtn.textContent = '✗ Error';
      saveBtn.style.background = '#c0392b';
      alert(`Save failed: ${e.message}`);
      setTimeout(() => {
        saveBtn.textContent = originalText;
        saveBtn.style.background = '';
        saveBtn.disabled = false;
      }, 2000);
    }
  };

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activePicker) closePicker(false);
  });
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'picker-overlay' && activePicker) closePicker(false);
  });

  window.addEventListener('DOMContentLoaded', refreshPage);
})();
