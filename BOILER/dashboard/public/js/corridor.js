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
let _pixooPixels = {};       // "x,y" → {r,g,b}
let _pixooPixelHistory = []; // stack of keys for undo
let _pixooCrosshair = null;
let _pixooBgImage = null;
let _pixooBgBase64 = null;
let _pixooMode = 'text';     // 'text' or 'pixel'
let _pixooLoadedPresetId = null; // currently loaded preset ID for update
let _pixooDrawing = false;   // mouse held down for pixel drawing

// Attach canvas handlers once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const c = document.getElementById('pixoo-canvas');
  if (!c) return;
  c.addEventListener('click', pixooCanvasClick);
  c.addEventListener('mousedown', (e) => { if (_pixooMode === 'pixel') { _pixooDrawing = true; pixooDrawPixelAt(e); } });
  c.addEventListener('mousemove', (e) => { if (_pixooDrawing) pixooDrawPixelAt(e); });
  c.addEventListener('mouseup', () => { _pixooDrawing = false; });
  c.addEventListener('mouseleave', () => { _pixooDrawing = false; });
  // Auto-load on page open
  loadPixoo();
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

async function pixooSendText() {
  const text = document.getElementById('pixoo-text').value.trim();
  if (!text) return;
  try {
    await fetch('/api/pixoo/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, color: [255, 255, 255] }),
    });
  } catch (e) { console.error('Pixoo text error:', e); }
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

function pixooAddText() {
  const text = document.getElementById('pixoo-ed-text').value.trim();
  if (!text) return;
  const x = parseInt(document.getElementById('pixoo-ed-x').value) || 0;
  const y = parseInt(document.getElementById('pixoo-ed-y').value) || 0;
  const hex = document.getElementById('pixoo-ed-color').value;
  const r = parseInt(hex.substring(1, 3), 16);
  const g = parseInt(hex.substring(3, 5), 16);
  const b = parseInt(hex.substring(5, 7), 16);
  _pixooEditorItems.push({ t: text, x, y, r, g, b });
  document.getElementById('pixoo-ed-text').value = '';
  pixooRedrawEditor();
  pixooRenderItemsList();
}

function pixooRenderItemsList() {
  const el = document.getElementById('pixoo-ed-items');
  if (!el) return;
  if (_pixooEditorItems.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = _pixooEditorItems.map((it, i) =>
    `<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">` +
    `<span style="color:rgb(${it.r},${it.g},${it.b});">"${it.t}"</span>` +
    `<span>@ ${it.x},${it.y}</span>` +
    `<button onclick="pixooRemoveItem(${i})" style="background:none;border:none;color:#c0392b;cursor:pointer;font-size:0.75rem;padding:0;">&#10005;</button>` +
    `</div>`
  ).join('');
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
    const payload = { name, type, content: { items: _pixooEditorItems, pixels: _pixooPixels }, image_data: _pixooBgBase64 };
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
    const content = typeof preset.content === 'string' ? JSON.parse(preset.content) : (preset.content || {});
    const items = Array.isArray(content) ? content : (content.items || []);
    const pixels = content.pixels || {};
    const r = await fetch('/api/pixoo/push-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, pixels, image: preset.image_data }),
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
    html += `<div style="font-size:0.68rem;color:#888;">{{${v}}}</div>`;
    html += `<input type="text" id="sim-var-${v}" placeholder="${v}..." style="width:100%;padding:3px 6px;border:1px solid #d0cbc4;border-radius:4px;font-size:0.78rem;box-sizing:border-box;margin-bottom:6px;">`;
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
      if (input && input.value) vars[key] = input.value;
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

async function simResume() {
  if (window._simSeqRefresh) { clearInterval(window._simSeqRefresh); window._simSeqRefresh = null; }
  const status = document.getElementById('sim-status');
  try {
    if (status) { status.textContent = 'Resuming...'; status.style.color = '#888'; }
    await fetch('/api/pixoo/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    });
    if (status) { status.textContent = 'Rotation resumed'; status.style.color = '#27ae60'; }
    setTimeout(loadPixoo, 2000);
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
