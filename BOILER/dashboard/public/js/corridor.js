/* ── Corridor Agents — Pixoo64 tab ── */

function showTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}

// ── Pixoo state ──
let _pixooTimer = null;
let _pixooEditorItems = [];
let _pixooDefaultVars = {};   // baked-in defaults for {{var}} placeholders
let _pixooPixels = {};       // "x,y" → {r,g,b}
let _pixooPixelHistory = []; // stack of keys for undo
let _pixooCrosshair = null;
let _pixooBgImage = null;
let _pixooBgBase64 = null;
let _pixooMode = 'text';     // 'text' or 'pixel'
let _pixooLoadedPresetId = null; // currently loaded preset ID for update
let _pixooDrawing = false;   // mouse held down for pixel drawing

// Dashboard-side canvas-update pause. Stops loadPixoo() from repainting
// the canvas with live device state so the user can edit without their
// work being overwritten — covers the "starting from blank" gap that the
// existing editorActive guard doesn't (editorActive=false when editor is
// empty, so live updates would otherwise paint over a fresh blank canvas
// the moment the user clears or just-opened the page).
//
// SCOPE: pure frontend; only affects this dashboard. The Pixoo physical
// device may still be updated by rules — pause is about NOT showing those
// updates in the editor's canvas. Compare to the device-side `_pixoo_paused`
// flag (rule_engine_state DB), which is unrelated: that pauses the device's
// rotation cycle so a pushed preset stays pinned. Two different concepts
// that happen to share the word "pause".
//
// Persisted in sessionStorage (matches Corridor Simulator's Stop pattern):
// survives tab navigation, resets on browser close. Single-tab scope by
// design — different tabs can have different pause state.
const PIXOO_PAUSE_KEY = 'corridor.pixooPauseUpdates';
let _pixooPauseUpdates = (function(){
  try { return sessionStorage.getItem(PIXOO_PAUSE_KEY) === '1'; }
  catch (_) { return false; }
})();

function pixooApplyPauseVisual() {
  // Yellow canvas border while paused so the user has unambiguous
  // feedback that live updates are off. Reverts to the normal grey.
  const canvas = document.getElementById('pixoo-canvas');
  if (!canvas) return;
  canvas.style.borderColor = _pixooPauseUpdates ? '#e67e22' : '#d0cbc4';
}

window.pixooTogglePauseUpdates = function (el) {
  _pixooPauseUpdates = !!el.checked;
  try {
    if (_pixooPauseUpdates) sessionStorage.setItem(PIXOO_PAUSE_KEY, '1');
    else sessionStorage.removeItem(PIXOO_PAUSE_KEY);
  } catch (_) {}
  pixooApplyPauseVisual();
};

// Attach canvas handlers once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const c = document.getElementById('pixoo-canvas');
  if (!c) return;
  c.addEventListener('click', pixooCanvasClick);
  c.addEventListener('mousedown', (e) => { if (_pixooMode === 'pixel') { _pixooDrawing = true; pixooDrawPixelAt(e); } });
  c.addEventListener('mousemove', (e) => { if (_pixooDrawing) pixooDrawPixelAt(e); });
  c.addEventListener('mouseup', () => { _pixooDrawing = false; });
  c.addEventListener('mouseleave', () => { _pixooDrawing = false; });

  // Sync the pause-updates checkbox to the persisted state (sessionStorage)
  // and apply the orange-border visual if paused — runs before pixooPlay()
  // starts the 5s poll, so the very first poll already respects the flag.
  const pauseBox = document.getElementById('pixoo-pause-updates');
  if (pauseBox) pauseBox.checked = _pixooPauseUpdates;
  pixooApplyPauseVisual();

  // Auto-load on page open + start the 5s poll so live tokens
  // ({{time}}/{{countdown}}) visibly tick on the preview canvas.
  pixooPlay();
  loadPixooPresets();
  loadSimPresets();
});

function pixooSetMode(mode) {
  _pixooMode = mode;
  document.getElementById('pixoo-mode-text').style.background = mode === 'text' ? '#7a9ab8' : '';
  document.getElementById('pixoo-mode-text').style.color = mode === 'text' ? '#fff' : '';
  document.getElementById('pixoo-mode-pixel').style.background = mode === 'pixel' ? '#7a9ab8' : '';
  document.getElementById('pixoo-mode-pixel').style.color = mode === 'pixel' ? '#fff' : '';
  const textSection = document.getElementById('pixoo-text-section');
  if (textSection) textSection.style.display = mode === 'text' ? 'block' : 'none';
}

function pixooDrawPixelAt(event) {
  const canvas = event.target;
  const rect = canvas.getBoundingClientRect();
  const s = canvas.width / 64;
  const px = Math.floor((event.clientX - rect.left) * (canvas.width / rect.width));
  const py = Math.floor((event.clientY - rect.top) * (canvas.height / rect.height));
  const x = Math.floor(px / s);
  const y = Math.floor(py / s);
  if (x < 0 || x > 63 || y < 0 || y > 63) return;
  const hex = document.getElementById('pixoo-ed-color').value;
  const r = parseInt(hex.substring(1, 3), 16);
  const g = parseInt(hex.substring(3, 5), 16);
  const b = parseInt(hex.substring(5, 7), 16);
  const key = `${x},${y}`;
  _pixooPixels[key] = { r, g, b };
  _pixooPixelHistory.push(key);
  pixooRedrawEditor();
}

function drawPixooCanvas(items) {
  const canvas = document.getElementById('pixoo-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const s = canvas.width / 64;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = 'top';
  for (const item of (items || [])) {
    ctx.fillStyle = `rgb(${item.r},${item.g},${item.b})`;
    ctx.font = `${5 * s}px monospace`;
    ctx.fillText(item.t, item.x * s, item.y * s);
  }
}

async function loadPixoo() {
  try {
    const r = await fetch('/api/pixoo/status').then(r => r.json());
    const hb = r.heartbeat || {};
    const dev = r.device || {};
    const screen = r.screen || {};

    // Status — authoritative signal is whether the device responds to HTTP.
    // Service heartbeat keeps firing even when the hardware is unplugged, so
    // relying on it alone leaves the dot green after a power loss.
    const deviceReachable = r.device != null && typeof r.device === 'object' && Object.keys(r.device).length > 0;
    const hbAge = hb.ts ? (Date.now() - new Date(hb.ts).getTime()) / 1000 : Infinity;
    const serviceAlive = hbAge < 120;
    const online = deviceReachable && serviceAlive;
    const label = !deviceReachable ? 'Offline — no HTTP response'
                 : !serviceAlive   ? 'Offline — service heartbeat stale'
                 : 'Online';
    document.getElementById('pixoo-status').innerHTML =
      `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:${online ? '#27ae60' : '#e74c3c'}"></span>${label}`;

    // Screen name
    const screenName = screen.screen || hb.decision || '—';
    document.getElementById('pixoo-screen').textContent = screenName;
    document.getElementById('pixoo-screen-label').textContent = screenName;

    // Skip canvas redraw while the user is editing — live device state
    // would otherwise overwrite the in-progress preset every 5 s. Resumes
    // automatically once the editor is empty (Clear/New). The
    // `_pixooPauseUpdates` flag is an ADDITIONAL manual override for the
    // "starting from blank" gap — editor empty but user wants the canvas
    // to stay clean (e.g. to draw fresh after Clear).
    const editorActive =
      _pixooLoadedPresetId !== null ||
      (_pixooEditorItems && _pixooEditorItems.length > 0) ||
      (_pixooPixels && Object.keys(_pixooPixels).length > 0) ||
      !!_pixooBgBase64;

    if (!editorActive && !_pixooPauseUpdates) {
      // Draw canvas
      const preview = r.preview;
      const screenId = screen.screen || '';
      const isAnimation = screenId === 'animation';
      if (screenId === 'wiped' || (!preview && (!screen.items || screen.items.length === 0))) {
        const canvas = document.getElementById('pixoo-canvas');
        if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
      } else if (screen.items && screen.items.length > 0 && !isAnimation) {
        // Text/pixel/preset screens — draw with browser font (clean)
        drawPixooCanvas(screen.items);
      } else if (preview) {
        // Animation or rotation — use preview image
        const img = new Image();
        img.onload = function() {
          const canvas = document.getElementById('pixoo-canvas');
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          // For animations, draw text items on top with browser font
          if (isAnimation && screen.items && screen.items.length > 0) {
            const s = canvas.width / 64;
            ctx.textBaseline = 'top';
            for (const item of screen.items) {
              ctx.fillStyle = `rgb(${item.r},${item.g},${item.b})`;
              ctx.font = `${5 * s}px monospace`;
              ctx.fillText(item.t, item.x * s, item.y * s);
            }
          }
        };
        img.src = preview;
      } else if (screen.items) {
        drawPixooCanvas(screen.items);
      }
    }

    // Heartbeat time
    if (hb.ts) {
      const d = new Date(hb.ts);
      document.getElementById('pixoo-heartbeat').textContent = d.toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }

    // Brightness
    if (dev && dev.Brightness !== undefined) {
      document.getElementById('pixoo-brightness').value = dev.Brightness;
      document.getElementById('pixoo-brightness-val').textContent = dev.Brightness;
    }

    // Update refresh timestamp
    document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch (e) {
    document.getElementById('pixoo-status').textContent = 'Error: ' + e.message;
  }
}

function pixooPlay() {
  if (_pixooTimer) return;
  _pixooTimer = setInterval(loadPixoo, 5000);
  loadPixoo();
}

function pixooStop() {
  if (_pixooTimer) { clearInterval(_pixooTimer); _pixooTimer = null; }
}

async function pixooPower(on) {
  try {
    await fetch('/api/pixoo/power', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    if (!on) {
      const canvas = document.getElementById('pixoo-canvas');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        const s = canvas.width / 64;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#888';
        ctx.font = `${10 * s}px monospace`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText('OFF', canvas.width / 2, canvas.height / 2);
        ctx.textAlign = 'left';
      }
      document.getElementById('pixoo-screen-label').textContent = 'OFF';
      document.getElementById('pixoo-screen-label').style.color = '#888';
    } else {
      document.getElementById('pixoo-screen-label').textContent = 'ON';
      document.getElementById('pixoo-screen-label').style.color = '#27ae60';
      pixooRedrawEditor();
    }
  } catch (e) { console.error('Pixoo power error:', e); }
}

async function pixooResume() {
  try {
    await fetch('/api/pixoo/resume', { method: 'POST' });
  } catch (e) { console.error('Pixoo resume error:', e); }
}

async function pixooCustom(page) {
  try {
    await fetch('/api/pixoo/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page }),
    });
  } catch (e) { console.error('Pixoo custom error:', e); }
}

async function pixooChannel(index) {
  try {
    await fetch('/api/pixoo/channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    });
    setTimeout(loadPixoo, 1000);
  } catch (e) { console.error('Pixoo channel error:', e); }
}

async function pixooRestart() {
  const label = document.getElementById('pixoo-screen-label');
  let sec = 90;
  label.style.color = '#c0392b';
  label.textContent = `Rebooting... ${sec}s`;
  const timer = setInterval(() => {
    sec--;
    if (sec > 0) {
      label.textContent = `Rebooting... ${sec}s`;
    } else {
      clearInterval(timer);
      label.textContent = 'Reboot complete';
      label.style.color = '#27ae60';
      setTimeout(() => { label.textContent = 'Ready'; label.style.color = '#888'; }, 3000);
    }
  }, 1000);
  fetch('/api/pixoo/restart', { method: 'POST' }).catch(() => {});
}

async function pixooNoise() {
  try {
    await fetch('/api/pixoo/noise', { method: 'POST' });
  } catch (e) { console.error('Pixoo noise error:', e); }
}

async function pixooBrightness(val) {
  document.getElementById('pixoo-brightness-val').textContent = val;
  try {
    await fetch('/api/pixoo/brightness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: parseInt(val) }),
    });
  } catch (e) { console.error('Pixoo brightness error:', e); }
}

// ── Pixoo64 Editor ──────────────────────────────────────────────

function pixooCanvasClick(event) {
  if (_pixooMode === 'pixel') return;
  const canvas = event.target;
  const rect = canvas.getBoundingClientRect();
  const s = canvas.width / 64;
  const px = Math.floor((event.clientX - rect.left) * (canvas.width / rect.width));
  const py = Math.floor((event.clientY - rect.top) * (canvas.height / rect.height));
  const x64 = Math.floor(px / s);
  const y64 = Math.floor(py / s);
  document.getElementById('pixoo-ed-x').value = x64;
  document.getElementById('pixoo-ed-y').value = y64;
  _pixooCrosshair = { px: x64 * s, py: y64 * s };
  pixooRedrawEditor();
}

function pixooRedrawEditor() {
  const canvas = document.getElementById('pixoo-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const s = canvas.width / 64;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (_pixooBgImage) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(_pixooBgImage, 0, 0, canvas.width, canvas.height);
  }
  for (const [key, c] of Object.entries(_pixooPixels)) {
    const [px, py] = key.split(',').map(Number);
    ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
    ctx.fillRect(px * s, py * s, s, s);
  }
  ctx.textBaseline = 'top';
  for (const item of _pixooEditorItems) {
    ctx.fillStyle = `rgb(${item.r},${item.g},${item.b})`;
    ctx.font = `${5 * s}px monospace`;
    ctx.fillText(item.t, item.x * s, item.y * s);
  }
  if (_pixooCrosshair) {
    ctx.strokeStyle = 'rgba(255,255,0,0.8)';
    ctx.lineWidth = 1;
    const cx = _pixooCrosshair.px + 2;
    const cy = _pixooCrosshair.py + 2;
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy);
    ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8);
    ctx.stroke();
  }
}

function pixooInsertToken(token) {
  const el = document.getElementById('pixoo-ed-text');
  if (!el) return;
  el.value = (el.value ? el.value + ' ' : '') + token;
  el.focus();
}
window.pixooInsertToken = pixooInsertToken;

function pixooAddText() {
  const text = document.getElementById('pixoo-ed-text').value.trim();
  if (!text) return;
  const x = parseInt(document.getElementById('pixoo-ed-x').value) || 0;
  const y = parseInt(document.getElementById('pixoo-ed-y').value) || 0;
  const hex = document.getElementById('pixoo-ed-color').value;
  const r = parseInt(hex.substring(1, 3), 16);
  const g = parseInt(hex.substring(3, 5), 16);
  const b = parseInt(hex.substring(5, 7), 16);
  const item = { t: text, x, y, r, g, b };
  if (document.getElementById('pixoo-ed-scroll') && document.getElementById('pixoo-ed-scroll').checked) {
    item.scroll = true;
    item.dir = parseInt(document.getElementById('pixoo-ed-scroll-dir').value) || 0;   // 0=left, 1=right
    const _sp = parseInt(document.getElementById('pixoo-ed-scroll-speed').value);
    item.speed = isNaN(_sp) ? 6 : Math.max(0, Math.min(20, _sp));                     // 0=slow .. 20=fast
    item.font = parseInt(document.getElementById('pixoo-ed-scroll-font').value) || 0;  // firmware font 0-7
  }
  _pixooEditorItems.push(item);
  document.getElementById('pixoo-ed-text').value = '';
  pixooRedrawEditor();
  pixooRenderItemsList();
}
// Show/hide the scroll dir/speed/font controls with the ↔ Scroll checkbox.
function pixooToggleScrollControls() {
  const on = document.getElementById('pixoo-ed-scroll').checked;
  document.getElementById('pixoo-scroll-controls').style.display = on ? 'inline-flex' : 'none';
}
// Click an item in the list → load it (incl. scroll settings) back into the
// controls and remove it; editing + Add re-inserts the updated version.
function pixooEditItem(i) {
  const it = _pixooEditorItems[i];
  if (!it) return;
  document.getElementById('pixoo-ed-text').value = it.t || '';
  document.getElementById('pixoo-ed-x').value = it.x || 0;
  document.getElementById('pixoo-ed-y').value = it.y || 0;
  document.getElementById('pixoo-ed-color').value =
    '#' + [it.r, it.g, it.b].map(v => ((v | 0) & 255).toString(16).padStart(2, '0')).join('');
  const sc = document.getElementById('pixoo-ed-scroll');
  if (sc) {
    sc.checked = !!it.scroll;
    pixooToggleScrollControls();
    if (it.scroll) {
      document.getElementById('pixoo-ed-scroll-dir').value = it.dir || 0;
      document.getElementById('pixoo-ed-scroll-speed').value = (it.speed == null ? 6 : it.speed);
      document.getElementById('pixoo-ed-scroll-font').value = it.font || 0;
    }
  }
  _pixooEditorItems.splice(i, 1);
  pixooRedrawEditor();
  pixooRenderItemsList();
}

function pixooRenderItemsList() {
  const el = document.getElementById('pixoo-ed-items');
  if (!el) return;
  if (_pixooEditorItems.length === 0) { el.innerHTML = ''; pixooRenderDefaults(); return; }
  el.innerHTML = _pixooEditorItems.map((it, i) =>
    `<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">` +
    `<span onclick="pixooEditItem(${i})" title="click to edit" style="cursor:pointer;color:rgb(${it.r},${it.g},${it.b});">"${it.t}"</span>` +
    (it.scroll ? `<span title="scrolling ${it.dir ? 'right' : 'left'}, spd ${it.speed}, font ${it.font}" style="color:#2980b9;">↔</span>` : '') +
    `<span>@ ${it.x},${it.y}</span>` +
    `<button onclick="pixooRemoveItem(${i})" style="background:none;border:none;color:#c0392b;cursor:pointer;font-size:0.75rem;padding:0;">&#10005;</button>` +
    `</div>`
  ).join('');
  pixooRenderDefaults();
}

// Scan all editor items for {{var}} placeholders. For each unique var,
// render an input field in the DEFAULT VALUES panel, prefilled with the
// currently loaded preset's default (if any). Hides the panel when no
// placeholders are present.
function pixooRenderDefaults() {
  const section = document.getElementById('pixoo-defaults-section');
  const list    = document.getElementById('pixoo-defaults-list');
  if (!section || !list) return;
  const vars = new Set();
  for (const item of _pixooEditorItems) {
    const matches = (item.t || '').match(/\{\{(\w+)\}\}/g);
    if (matches) matches.forEach(m => vars.add(m.slice(2, -2)));
  }
  // Exclude built-in live tokens that the service handles automatically.
  vars.delete('time');
  vars.delete('date');
  if (vars.size === 0) { section.style.display = 'none'; list.innerHTML = ''; return; }
  section.style.display = '';
  let html = '';
  for (const v of Array.from(vars)) {
    const isCountdown = v.toLowerCase().includes('countdown');
    const hint        = isCountdown ? ' (seconds)' : '';
    const placeholder = isCountdown ? 'e.g. 60' : `${v}...`;
    const current     = _pixooDefaultVars[v] != null ? String(_pixooDefaultVars[v]) : '';
    html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">`;
    html += `<span style="font-size:0.68rem;color:#888;min-width:90px;">{{${v}}}${hint}</span>`;
    html += `<input type="text" id="pixoo-default-${v}" value="${current.replace(/"/g, '&quot;')}" placeholder="${placeholder}" style="flex:1;padding:3px 6px;border:1px solid #d0cbc4;border-radius:4px;font-size:0.78rem;">`;
    html += `</div>`;
  }
  list.innerHTML = html;
}

// Read the DEFAULT VALUES inputs into a plain JSON object — called at
// save time. Returns null when no defaults are set (so the preset stays
// backward-compatible: an absent `default_vars` field is identical to
// not having defaults). Numeric values are parsed; non-numeric kept as
// string. Empty inputs are omitted.
function pixooCollectDefaults() {
  const out = {};
  const vars = new Set();
  for (const item of _pixooEditorItems) {
    const matches = (item.t || '').match(/\{\{(\w+)\}\}/g);
    if (matches) matches.forEach(m => vars.add(m.slice(2, -2)));
  }
  vars.delete('time');
  vars.delete('date');
  for (const v of Array.from(vars)) {
    const inp = document.getElementById('pixoo-default-' + v);
    if (!inp) continue;
    const raw = inp.value.trim();
    if (raw === '') continue;
    out[v] = /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function pixooRemoveItem(index) {
  _pixooEditorItems.splice(index, 1);
  pixooRedrawEditor();
  pixooRenderItemsList();
}

function pixooLoadImage(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      _pixooBgImage = img;
      _pixooBgBase64 = e.target.result;
      document.getElementById('pixoo-image-info').textContent = `${img.width}x${img.height} — ${file.name}`;
      pixooRedrawEditor();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function pixooClearImage() {
  _pixooBgImage = null;
  _pixooBgBase64 = null;
  document.getElementById('pixoo-image-upload').value = '';
  document.getElementById('pixoo-image-info').textContent = '';
  pixooRedrawEditor();
}

function pixooClearCanvas() {
  _pixooEditorItems = [];
  _pixooPixels = {};
  _pixooPixelHistory = [];
  _pixooDefaultVars = {};
  _pixooCrosshair = null;
  _pixooLoadedPresetId = null;
  _pixooBgImage = null;
  _pixooBgBase64 = null;
  document.getElementById('pixoo-image-upload').value = '';
  document.getElementById('pixoo-image-info').textContent = '';
  pixooRedrawEditor();
  pixooRenderItemsList();
}

function pixooUndoPixel() {
  if (_pixooPixelHistory.length === 0) return;
  const key = _pixooPixelHistory.pop();
  delete _pixooPixels[key];
  pixooRedrawEditor();
}

async function pixooWipeDisplay() {
  const label = document.getElementById('pixoo-screen-label');
  try {
    label.textContent = 'Wiping...'; label.style.color = '#888';
    const r = await fetch('/api/pixoo/push-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [], pixels: {}, image: null, wipe: true }),
    });
    if (r.ok) { label.textContent = 'Wiped'; label.style.color = '#27ae60'; }
    else { label.textContent = 'Wipe failed'; label.style.color = '#c0392b'; }
  } catch (e) { label.textContent = 'Connection error'; label.style.color = '#c0392b'; }
}

function pixooZoom(size) {
  const canvas = document.getElementById('pixoo-canvas');
  if (!canvas) return;
  canvas.width = size;
  canvas.height = size;
  pixooRedrawEditor();
}

async function pixooPushCanvas() {
  const label = document.getElementById('pixoo-screen-label');
  if (_pixooEditorItems.length === 0 && !_pixooBgBase64 && Object.keys(_pixooPixels).length === 0) return;
  try {
    label.textContent = 'Pushing...'; label.style.color = '#888';
    const r = await fetch('/api/pixoo/push-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: _pixooEditorItems, image: _pixooBgBase64, pixels: _pixooPixels }),
    });
    if (r.ok) { label.textContent = 'Pushed'; label.style.color = '#27ae60'; }
    else { label.textContent = 'Push failed'; label.style.color = '#c0392b'; }
  } catch (e) { label.textContent = 'Connection error'; label.style.color = '#c0392b'; }
}

async function pixooSavePreset() {
  const name = document.getElementById('pixoo-preset-name').value.trim();
  if (!name) return alert('Enter a preset name');
  const hasPixels = Object.keys(_pixooPixels).length > 0;
  if (_pixooEditorItems.length === 0 && !_pixooBgBase64 && !hasPixels) return alert('Add content first');
  try {
    const type = _pixooBgBase64 ? 'image' : hasPixels ? 'pixel' : 'text';
    const defaults = pixooCollectDefaults();
    const content  = { items: _pixooEditorItems, pixels: _pixooPixels };
    if (defaults) content.default_vars = defaults;
    const payload = { name, type, content, image_data: _pixooBgBase64 };
    if (_pixooLoadedPresetId) {
      await fetch('/api/pixoo/presets/' + _pixooLoadedPresetId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      await fetch('/api/pixoo/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    loadPixooPresets();
  } catch (e) { console.error('Pixoo save preset error:', e); }
}

// Save As New — always creates a new preset entry, regardless of whether
// a preset is currently loaded. Lets the user clone-and-modify: load A,
// edit, change the name, click Save As New → B exists with the changes,
// A is untouched. If the user didn't change the name, auto-append
// " (copy)" so we never silently duplicate names. After saving, the new
// preset becomes the "loaded" one so subsequent Save clicks update it,
// not the original.
async function pixooSaveAsNew() {
  const nameInput = document.getElementById('pixoo-preset-name');
  let name = nameInput.value.trim();
  if (!name) return alert('Enter a preset name');
  const hasPixels = Object.keys(_pixooPixels).length > 0;
  if (_pixooEditorItems.length === 0 && !_pixooBgBase64 && !hasPixels) return alert('Add content first');

  // Fetch the current preset list ONCE so the auto-append-(copy) check
  // and the collision check share the same data. Fail-silent: if the
  // fetch breaks we skip the niceties and let the POST proceed with the
  // user's exact name (worst case: a duplicate-name entry the user can
  // rename or delete afterwards).
  let presets = [];
  try { presets = await fetch('/api/pixoo/presets').then(r => r.json()); } catch (_) {}

  // Auto-append " (copy)" if the name still matches what's loaded — keeps
  // the preset list unambiguous (no two presets with identical names).
  if (_pixooLoadedPresetId) {
    const loadedPreset = presets.find(p => p.id === _pixooLoadedPresetId);
    if (loadedPreset && loadedPreset.name === name) {
      name = name + ' (copy)';
      nameInput.value = name;
    }
  }

  // Collision check applies to BOTH cases (loaded preset and new). Save As
  // New's whole purpose is to clone with a different name — if the user
  // typed a name that matches some OTHER preset, confirm intent before
  // creating a duplicate-name entry. Skip the loaded preset's own row
  // (it would match itself, which is fine).
  const collision = presets.find(p => p.name === name && p.id !== _pixooLoadedPresetId);
  if (collision) {
    if (!confirm(`Preset "${name}" already exists. Save as a new copy anyway?\n\nClick OK to create a duplicate-name preset, Cancel to abort.`)) {
      return;
    }
  }

  try {
    const type     = _pixooBgBase64 ? 'image' : hasPixels ? 'pixel' : 'text';
    const defaults = pixooCollectDefaults();
    const content  = { items: _pixooEditorItems, pixels: _pixooPixels };
    if (defaults) content.default_vars = defaults;
    const payload  = { name, type, content, image_data: _pixooBgBase64 };
    const r = await fetch('/api/pixoo/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const created = await r.json();
    // Adopt the new id so future Save clicks update the clone, not the
    // original. If the API doesn't return the new id, leave the loaded id
    // alone — user can re-Load the new preset from the list manually.
    if (created && typeof created.id === 'number') {
      _pixooLoadedPresetId = created.id;
    }
    loadPixooPresets();
  } catch (e) {
    console.error('Pixoo save-as-new error:', e);
    alert('Save As New failed: ' + e.message);
  }
}
window.pixooSaveAsNew = pixooSaveAsNew;

async function loadPixooPresets() {
  try {
    const presets = await fetch('/api/pixoo/presets').then(r => r.json());
    const el = document.getElementById('pixoo-presets-list');
    if (!el) return;
    if (!Array.isArray(presets) || presets.length === 0) {
      el.innerHTML = '<div style="color:#aaa;font-size:0.78rem;">No presets saved</div>';
      return;
    }
    el.innerHTML = presets.map(p => {
      const content = typeof p.content === 'string' ? JSON.parse(p.content) : (p.content || {});
      const items = Array.isArray(content) ? content : (content.items || []);
      const pixelCount = content.pixels ? Object.keys(content.pixels).length : 0;
      const textSummary = items.map(i => i.t).join(', ');
      const summary = textSummary || (pixelCount > 0 ? `${pixelCount} pixels` : '—');
      return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #eee;">` +
        `<span style="flex:1;font-weight:500;">${p.name}</span>` +
        `<span style="color:#aaa;font-size:0.72rem;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${summary}</span>` +
        `<button class="btn btn-secondary btn-sm" style="padding:2px 8px;font-size:0.72rem;" onclick="pixooLoadPreset(${p.id})">Load</button>` +
        `<button class="btn btn-secondary btn-sm" style="padding:2px 8px;font-size:0.72rem;background:#27ae60;color:#fff;" onclick="pixooPushPreset(${p.id})">Push</button>` +
        `<button class="btn btn-secondary btn-sm" style="padding:2px 8px;font-size:0.72rem;color:#c0392b;border-color:#e0b0ad;" onclick="pixooDeletePreset(${p.id})">Del</button>` +
        `</div>`;
    }).join('');
  } catch (e) { console.error('Pixoo load presets error:', e); }
}

async function pixooLoadPreset(id) {
  try {
    const presets = await fetch('/api/pixoo/presets').then(r => r.json());
    const preset = presets.find(p => p.id === id);
    if (!preset) return;
    const content = typeof preset.content === 'string' ? JSON.parse(preset.content) : (preset.content || {});
    _pixooEditorItems = Array.isArray(content) ? content : (content.items || []);
    _pixooPixels = content.pixels || {};
    _pixooDefaultVars = content.default_vars || {};
    _pixooPixelHistory = Object.keys(_pixooPixels);
    _pixooCrosshair = null;
    if (preset.image_data) {
      const img = new Image();
      img.onload = () => { _pixooBgImage = img; _pixooBgBase64 = preset.image_data; pixooRedrawEditor(); };
      img.src = preset.image_data;
    } else {
      _pixooBgImage = null;
      _pixooBgBase64 = null;
    }
    _pixooLoadedPresetId = id;
    document.getElementById('pixoo-preset-name').value = preset.name;
    pixooRedrawEditor();
    pixooRenderItemsList();
  } catch (e) { console.error('Pixoo load preset error:', e); }
}

async function pixooDeletePreset(id) {
  if (!confirm('Delete this preset?')) return;
  try {
    await fetch(`/api/pixoo/presets/${id}`, { method: 'DELETE' });
    loadPixooPresets();
  } catch (e) { console.error('Pixoo delete preset error:', e); }
}

async function pixooPushPreset(id) {
  const label = document.getElementById('pixoo-screen-label');
  try {
    label.textContent = 'Pushing...'; label.style.color = '#888';
    await pixooLoadPreset(id);
    const presets = await fetch('/api/pixoo/presets').then(r => r.json());
    const preset = presets.find(p => p.id === id);
    if (!preset) return;
    // Route via /command (named preset push) instead of /push-items
    // (raw item push). Difference matters: /command goes through
    // pixoo_service._render_preset which publishes 'preset:<name>' to
    // _pixoo_screen — keeps any "currently playing" dashboard cards in
    // sync. /push-items publishes just 'animation' for GIF presets and
    // the name is lost downstream.
    const r = await fetch('/api/pixoo/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'push_preset', preset_name: preset.name, vars: {} }),
    });
    if (r.ok) { label.textContent = 'Pushed: ' + preset.name; label.style.color = '#27ae60'; }
    else { label.textContent = 'Push failed'; label.style.color = '#c0392b'; }
  } catch (e) { label.textContent = 'Connection error'; label.style.color = '#c0392b'; }
}

// ── Simulator ──────────────────────────────────────────────────

let _simPresets = [];

async function loadSimPresets() {
  try {
    _simPresets = await fetch('/api/pixoo/presets').then(r => r.json());
    const opts = _simPresets.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    const sel = document.getElementById('sim-preset');
    if (sel) sel.innerHTML = '<option value="">— select preset —</option>' + opts;
    const seqSel = document.getElementById('sim-seq-preset');
    if (seqSel) seqSel.innerHTML = '<option value="">add preset...</option>' + opts;
  } catch (e) { console.error('Failed to load sim presets:', e); }
}

function simPresetChanged() {
  const id = parseInt(document.getElementById('sim-preset').value);
  const el = document.getElementById('sim-vars');
  if (!el) return;
  if (!id) { el.innerHTML = ''; return; }
  const preset = _simPresets.find(p => p.id === id);
  if (!preset) { el.innerHTML = ''; return; }
  const content = typeof preset.content === 'string' ? JSON.parse(preset.content) : (preset.content || {});
  const items = Array.isArray(content) ? content : (content.items || []);
  // Find all {{var}} placeholders
  const vars = new Set();
  for (const item of items) {
    const matches = (item.t || '').match(/\{\{(\w+)\}\}/g);
    if (matches) matches.forEach(m => vars.add(m.slice(2, -2)));
  }
  if (vars.size === 0) {
    el.innerHTML = '<span style="color:#aaa;">No variables in this preset</span>';
    return;
  }
  let html = '';
  for (const v of Array.from(vars)) {
    const isCountdown = v.toLowerCase().includes('countdown');
    const labelHint   = isCountdown ? ' (seconds from now)' : '';
    const placeholder = isCountdown ? '60 = 60 sec from now' : `${v}...`;
    html += `<div style="font-size:0.68rem;color:#888;">{{${v}}}${labelHint}</div>`;
    html += `<input type="text" id="sim-var-${v}" placeholder="${placeholder}" style="width:100%;padding:3px 6px;border:1px solid #d0cbc4;border-radius:4px;font-size:0.78rem;box-sizing:border-box;margin-bottom:6px;">`;
  }
  el.innerHTML = html;
}

async function simPushPreset() {
  const id = parseInt(document.getElementById('sim-preset').value);
  const preset = _simPresets.find(p => p.id === id);
  const status = document.getElementById('sim-status');
  if (!preset) { if (status) status.textContent = 'Select a preset first'; return; }
  // Collect vars
  const content = typeof preset.content === 'string' ? JSON.parse(preset.content) : (preset.content || {});
  const items = Array.isArray(content) ? content : (content.items || []);
  const vars = {};
  for (const item of items) {
    const matches = (item.t || '').match(/\{\{(\w+)\}\}/g);
    if (matches) matches.forEach(m => {
      const key = m.slice(2, -2);
      const input = document.getElementById('sim-var-' + key);
      if (!input || !input.value) return;
      // pixoo_service handles the seconds→epoch conversion for any
      // "*countdown*" var (since 2026-05-16) — see _maybe_epoch in
      // pixoo_service.py. Send the raw value here.
      vars[key] = input.value.trim();
    });
  }
  try {
    if (status) { status.textContent = 'Pushing...'; status.style.color = '#888'; }
    const r = await fetch('/api/pixoo/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'push_preset', preset_name: preset.name, vars }),
    });
    if (r.ok) {
      if (status) { status.textContent = 'Pushed: ' + preset.name; status.style.color = '#27ae60'; }
      setTimeout(loadPixoo, 2000);
    } else {
      if (status) { status.textContent = 'Push failed'; status.style.color = '#c0392b'; }
    }
  } catch (e) {
    if (status) { status.textContent = 'Connection error'; status.style.color = '#c0392b'; }
  }
}

async function simWipe() {
  if (window._simSeqRefresh) { clearInterval(window._simSeqRefresh); window._simSeqRefresh = null; }
  const status = document.getElementById('sim-status');
  try {
    if (status) { status.textContent = 'Wiping...'; status.style.color = '#888'; }
    await fetch('/api/pixoo/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'wipe' }),
    });
    // Reset the simulator card: drop the preset selection + any var inputs
    // so the card returns to its idle "— preset —" state. Wipe is conceptually
    // "clear everything related to the current push," not just the LED.
    const sel = document.getElementById('sim-preset');
    if (sel) sel.value = '';
    const varsEl = document.getElementById('sim-vars');
    if (varsEl) varsEl.innerHTML = '';
    if (status) { status.textContent = 'Wiped'; status.style.color = '#27ae60'; }
    setTimeout(loadPixoo, 1000);
  } catch (e) {
    if (status) { status.textContent = 'Connection error'; status.style.color = '#c0392b'; }
  }
}

// ── Sequence builder ───────────────────────────────────────────

let _simSequence = []; // [{id, name, duration, vars}]

function _getPresetVarNames(presetId) {
  const preset = _simPresets.find(p => p.id === presetId);
  if (!preset) return [];
  const content = typeof preset.content === 'string' ? JSON.parse(preset.content) : (preset.content || {});
  const items = Array.isArray(content) ? content : (content.items || []);
  const vars = new Set();
  for (const item of items) {
    const matches = (item.t || '').match(/\{\{(\w+)\}\}/g);
    if (matches) matches.forEach(m => vars.add(m.slice(2, -2)));
  }
  return Array.from(vars);
}

function simSeqAdd() {
  const id = parseInt(document.getElementById('sim-seq-preset').value);
  const preset = _simPresets.find(p => p.id === id);
  if (!preset) return;
  const dur = parseInt(document.getElementById('sim-seq-dur').value) || 10;
  const varNames = _getPresetVarNames(id);
  const vars = {};
  varNames.forEach(v => { vars[v] = ''; });
  _simSequence.push({ id, name: preset.name, duration: dur, vars, varNames });
  simSeqRender();
}

function simSeqRender() {
  const el = document.getElementById('sim-seq-list');
  if (!el) return;
  if (_simSequence.length === 0) { el.innerHTML = '<span style="color:#aaa;">No presets in sequence</span>'; return; }
  el.innerHTML = _simSequence.map((s, i) => {
    let varsHtml = '';
    if (s.varNames && s.varNames.length > 0) {
      varsHtml = `<div style="margin-left:18px;margin-bottom:4px;">` +
        s.varNames.map(v =>
          `<div style="margin-bottom:3px;">` +
          `<div style="font-size:0.68rem;color:#888;">{{${v}}}</div>` +
          `<input type="text" id="seq-var-${i}-${v}" value="${s.vars[v] || ''}" placeholder="${v}..." ` +
          `oninput="_simSequence[${i}].vars['${v}']=this.value" ` +
          `style="width:100%;padding:2px 4px;border:1px solid #d0cbc4;border-radius:3px;font-size:0.75rem;box-sizing:border-box;">` +
          `</div>`
        ).join('') + `</div>`;
    }
    return `<div style="margin-bottom:2px;">` +
    `<div style="display:flex;align-items:center;gap:6px;">` +
    `<span style="font-weight:500;">${i + 1}. ${s.name}</span>` +
    `<span style="color:#888;">${s.duration}s</span>` +
    `<button onclick="simSeqRemove(${i})" style="background:none;border:none;color:#c0392b;cursor:pointer;font-size:0.72rem;padding:0;">&#10005;</button>` +
    `</div>${varsHtml}</div>`;
  }).join('');
}

function simSeqRemove(index) {
  _simSequence.splice(index, 1);
  simSeqRender();
}

async function simSeqPlay() {
  if (_simSequence.length === 0) return;
  const status = document.getElementById('sim-status');
  // Collect current var values from inline inputs
  _simSequence.forEach((s, i) => {
    (s.varNames || []).forEach(v => {
      const input = document.getElementById(`seq-var-${i}-${v}`);
      if (input) s.vars[v] = input.value;
    });
  });
  const presets = _simSequence.map(s => ({ name: s.name, duration: s.duration, vars: s.vars }));
  try {
    if (status) { status.textContent = 'Playing sequence...'; status.style.color = '#888'; }
    const r = await fetch('/api/pixoo/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'play_sequence', presets }),
    });
    if (r.ok) {
      if (status) { status.textContent = 'Sequence playing: ' + presets.map(p => p.name).join(' → '); status.style.color = '#27ae60'; }
      // Auto-refresh canvas while sequence plays
      if (window._simSeqRefresh) clearInterval(window._simSeqRefresh);
      window._simSeqRefresh = setInterval(loadPixoo, 3000);
    } else {
      if (status) { status.textContent = 'Sequence failed'; status.style.color = '#c0392b'; }
    }
  } catch (e) {
    if (status) { status.textContent = 'Connection error'; status.style.color = '#c0392b'; }
  }
}

function simSeqClear() {
  _simSequence = [];
  simSeqRender();
}
