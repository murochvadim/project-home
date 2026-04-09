const MEDIA_API  = 'http://192.168.1.138:8766';  // player service
const INGEST_API = 'http://192.168.1.138:8767';  // ingest service

let _tvMuted  = false;
let _tvgMuted = false;
let _sbMuted  = false;
let _tvbMuted = false;

function showTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  // load pixoo presets when tab opens
  if (name === 'pixoo') {
    loadPixooPresets();
  }
  // start/stop analyzer status polling
  clearInterval(window._azPollTimer);
  if (name === 'analyzer') {
    window._azPollTimer = setInterval(async () => {
      const prev = window._azLastCounts || {};
      await loadAnalyzerStatus();
      const cur = window._azLastCounts || {};
      // only reload face sections when counts change
      if (cur.unassigned !== prev.unassigned || cur.unlabeled !== prev.unlabeled || cur.named !== prev.named) {
        loadFaceClusters();
        loadUnmatchedFaces();
      }
    }, 3000);
  }
}

function statusDot(power) {
  if (power === 'on')  return '<span style="color:#2ecc71; font-size:1.4rem;">⬤</span>';
  if (power === 'off') return '<span style="color:#e74c3c; font-size:1.4rem;">⬤</span>';
  return '<span style="color:#aaa; font-size:1.4rem;">⬤</span>';
}

async function refreshState() {
  try {
    const resp = await fetch(`${MEDIA_API}/api/media/state`);
    const s = await resp.json();
    if (!resp.ok) throw new Error(s.error || 'Server error');

    // TV
    const tv = s.tv;
    document.getElementById('tv-status').innerHTML = statusDot(tv.power);
    document.getElementById('tv-volume').textContent = tv.volume != null ? tv.volume + '%' : '—';
    _tvMuted = tv.muted;
    document.getElementById('tv-mute-btn').style.opacity = _tvMuted ? '1' : '0.4';
    const tvSrcSel = document.getElementById('tv-source-select');
    const tvInputs = tv.supportedInputs?.length ? tv.supportedInputs : (tv.input ? [tv.input] : []);
    tvSrcSel.innerHTML = tvInputs.map(i =>
      `<option value="${i}"${i === tv.input ? ' selected' : ''}>${i}</option>`
    ).join('') || `<option value="${tv.input||''}">${tv.input||'—'}</option>`;

    // Guy Room TV
    const tvg = s.tvGuy;
    document.getElementById('tvg-status').innerHTML = statusDot(tvg.power);
    document.getElementById('tvg-volume').textContent = tvg.volume != null ? tvg.volume + '%' : '—';
    _tvgMuted = tvg.muted;
    document.getElementById('tvg-mute-btn').style.opacity = _tvgMuted ? '1' : '0.4';
    const tvgSrcSel = document.getElementById('tvg-source-select');
    const tvgInputs = tvg.supportedInputs?.length ? tvg.supportedInputs : (tvg.input ? [tvg.input] : []);
    tvgSrcSel.innerHTML = tvgInputs.map(i =>
      `<option value="${i}"${i === tvg.input ? ' selected' : ''}>${i}</option>`
    ).join('') || `<option value="${tvg.input||''}">${tvg.input||'—'}</option>`;

    // Soundbar
    const sb = s.soundbar;
    if (sb.power !== null) document.getElementById('sb-status').innerHTML = statusDot(sb.power);
    document.getElementById('sb-volume').textContent = sb.volume != null ? sb.volume + '%' : '—';
    _sbMuted = sb.muted;
    document.getElementById('sb-mute-btn').style.opacity = _sbMuted ? '1' : '0.4';
    const sbSrcSel = document.getElementById('sb-source-select');
    const sbInputs = sb.supportedInputs?.length ? sb.supportedInputs : (sb.input ? [sb.input] : []);
    sbSrcSel.innerHTML = sbInputs.map(i =>
      `<option value="${i}"${i === sb.input ? ' selected' : ''}>${i}</option>`
    ).join('') || `<option value="${sb.input||''}">${sb.input||'—'}</option>`;

    // Bedroom TV
    const tvb = s.tvBed;
    if (tvb.power !== null) document.getElementById('tvb-status').innerHTML = statusDot(tvb.power);
    document.getElementById('tvb-volume').textContent = tvb.volume != null ? tvb.volume + '%' : '—';
    _tvbMuted = tvb.muted;
    document.getElementById('tvb-mute-btn').style.opacity = _tvbMuted ? '1' : '0.4';
    const tvbSrcSel = document.getElementById('tvb-source-select');
    const tvbInputs = tvb.supportedInputs?.length ? tvb.supportedInputs : (tvb.input ? [tvb.input] : []);
    tvbSrcSel.innerHTML = tvbInputs.map(i =>
      `<option value="${i}"${i === tvb.input ? ' selected' : ''}>${i}</option>`
    ).join('') || `<option value="${tvb.input||''}">${tvb.input||'—'}</option>`;

    document.getElementById('last-refresh').textContent =
      'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
  } catch (e) {
    showFeedback('Failed to load state: ' + e.message, false);
  }
}

async function cmd(entity, command, value) {
  try {
    const body = { entity, command };
    if (value !== undefined) body.value = value;
    const r = await fetch(`${MEDIA_API}/api/media/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Command failed');
    showFeedback(`✓ ${entity} — ${command}${value !== undefined ? ': ' + value : ''}`, true);
    pollState(4);
  } catch (e) {
    showFeedback('✗ ' + e.message, false);
  }
}

function pollState(times, interval = 2000) {
  if (times <= 0) return;
  setTimeout(() => { refreshState(); pollState(times - 1, interval); }, interval);
}

function toggleMute(entity) {
  const muted = entity === 'tv' ? _tvMuted : entity === 'tv_guy' ? _tvgMuted : entity === 'tv_bed' ? _tvbMuted : _sbMuted;
  cmd(entity, 'mute', !muted);
}

function showFeedback(msg, ok) {
  const el = document.getElementById('cmd-feedback');
  el.textContent = msg;
  el.style.background  = ok ? '#eafaf1' : '#fdecea';
  el.style.color       = ok ? '#1e8449'  : '#c0392b';
  el.style.border      = ok ? '1px solid #a9dfbf' : '1px solid #f5c6cb';
  el.style.visibility  = 'visible';
  el.style.opacity     = '1';
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 3000);
}

// Init
refreshState();
setInterval(refreshState, 30000);

// Restore playback bar if something is already playing (page navigation / reload)
(async function restorePlayback() {
  try {
    const r = await fetch(`${MEDIA_API}/api/media/position`);
    if (!r.ok) return;
    const d = await r.json();
    if (d.duration > 0 && d.position < d.duration) {
      startProgressPoll(d.title || 'Now playing');
    }
  } catch (_) {}
})();

// ─── Media Browser ────────────────────────────────────────────

let _currentPath = '';

const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp']);
const VIDEO_EXTS = new Set(['.mp4','.mkv','.avi','.mov','.wmv','.m4v','.ts','.mpg','.mpeg']);

const AUDIO_EXTS = new Set(['.mp3','.flac','.aac','.wav','.ogg','.m4a','.wma']);

function fileIcon(entry) {
  if (entry.type === 'dir')           return '📁';
  if (IMAGE_EXTS.has(entry.ext))     return null;
  if (VIDEO_EXTS.has(entry.ext))     return '🎬';
  if (AUDIO_EXTS.has(entry.ext))     return '<svg viewBox="0 0 24 24" fill="#8e44ad" width="44" height="44"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg>';
  return '📄';
}

function formatSize(bytes) {
  if (bytes === 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(0) + ' KB';
  if (bytes < 1073741824) return (bytes/1048576).toFixed(1) + ' MB';
  return (bytes/1073741824).toFixed(2) + ' GB';
}

async function loadMediaBrowser(path) {
  if (path === undefined) path = _currentPath;
  _currentPath = path;
  renderBreadcrumb(path);
  const grid = document.getElementById('media-grid');
  grid.innerHTML = '<div style="color:#aaa;font-size:0.85rem;padding:20px;">Loading…</div>';
  try {
    const r = await fetch(`${MEDIA_API}/api/media/browse?path=` + encodeURIComponent(path));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Browse failed');
    renderGrid(d.entries, path);
  } catch (e) {
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'color:#c0392b;font-size:0.85rem;padding:20px;';
    errDiv.textContent = 'Error: ' + e.message;
    grid.innerHTML = '';
    grid.appendChild(errDiv);
  }
}

function renderBreadcrumb(path) {
  const el = document.getElementById('media-breadcrumb');
  el.innerHTML = '';

  const root = document.createElement('span');
  root.textContent = 'QNAP Media';
  root.style.cssText = 'cursor:pointer;color:#2980b9;';
  root.addEventListener('click', () => loadMediaBrowser(''));
  el.appendChild(root);

  const parts = path ? path.split('/').filter(Boolean) : [];
  let built = '';
  for (const p of parts) {
    built = built ? built + '/' + p : p;
    const sep = document.createElement('span');
    sep.textContent = ' › ';
    sep.style.color = '#aaa';
    el.appendChild(sep);

    const seg = document.createElement('span');
    seg.textContent = p;
    seg.style.cssText = 'cursor:pointer;color:#2980b9;';
    const snapPath = built;
    seg.addEventListener('click', () => loadMediaBrowser(snapPath));
    el.appendChild(seg);
  }
}

const HIDDEN_ENTRIES = new Set(['.faces', 'tmp']);

function renderGrid(entries, currentPath) {
  const grid = document.getElementById('media-grid');
  entries = entries.filter(e => !HIDDEN_ENTRIES.has(e.name));
  if (!entries.length) {
    grid.innerHTML = '<div style="color:#aaa;font-size:0.85rem;padding:20px;">Empty folder</div>';
    return;
  }
  grid.innerHTML = '';
  for (const e of entries) {
    const icon    = fileIcon(e);
    const label   = e.name.length > 16 ? e.name.substring(0, 14) + '…' : e.name;
    const relPath = currentPath ? currentPath + '/' + e.name : e.name;
    const isVideo = VIDEO_EXTS.has(e.ext);
    const isAudio = AUDIO_EXTS.has(e.ext);

    const cell = document.createElement('div');
    cell.style.cssText = `text-align:center;padding:10px;border-radius:6px;
      cursor:${e.type === 'dir' ? 'pointer' : 'default'};
      background:#faf8f5;border:1px solid #ece8e2;transition:background 0.15s;`;
    cell.title = e.name;
    if (e.type === 'file') cell.dataset.filePath = '/mnt/media/' + (relPath.startsWith('/') ? relPath.slice(1) : relPath);
    cell.addEventListener('mouseover', () => { cell.style.background = '#f0ede8'; });
    cell.addEventListener('mouseout',  () => { cell.style.background = '#faf8f5'; });
    if (e.type === 'dir') {
      cell.addEventListener('click', () => loadMediaBrowser(relPath));
    }

    // Thumbnail or icon
    const thumbWrap = document.createElement('div');
    thumbWrap.style.cssText = 'height:80px;display:flex;align-items:center;justify-content:center;';
    if (icon === null) {
      const img = document.createElement('img');
      img.src = `${MEDIA_API}/api/media/thumb?path=` + encodeURIComponent(relPath);
      img.style.cssText = 'width:80px;height:80px;object-fit:cover;border-radius:4px;';
      img.addEventListener('error', () => {
        const fallback = document.createElement('span');
        fallback.textContent = '🖼';
        fallback.style.fontSize = '2.5rem';
        img.replaceWith(fallback);
      });
      thumbWrap.appendChild(img);
    } else {
      const ico = document.createElement('span');
      if (icon.startsWith('<svg')) {
        ico.innerHTML = icon;
      } else {
        ico.textContent = icon;
        ico.style.cssText = 'font-size:2.5rem;line-height:1;';
      }
      thumbWrap.appendChild(ico);
    }
    cell.appendChild(thumbWrap);

    // Label
    const lbl = document.createElement('div');
    lbl.textContent = label;
    lbl.style.cssText = 'font-size:0.78rem;color:#333;margin-top:6px;word-break:break-word;';
    cell.appendChild(lbl);

    // Size
    if (e.type === 'file' && e.size) {
      const sz = document.createElement('div');
      sz.textContent = formatSize(e.size);
      sz.style.cssText = 'font-size:0.7rem;color:#aaa;margin-top:2px;';
      cell.appendChild(sz);
    }

    // Edit button (all files)
    if (e.type === 'file') {
      const editBtn = document.createElement('button');
      editBtn.textContent = '✏️';
      editBtn.title = 'Edit metadata';
      editBtn.style.cssText = 'position:absolute;top:6px;right:6px;background:rgba(255,255,255,0.85);border:1px solid #d0cbc4;border-radius:4px;padding:1px 5px;font-size:0.78rem;cursor:pointer;line-height:1.4;';
      editBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        openEditModal('/mnt/media/' + (relPath.startsWith('/') ? relPath.slice(1) : relPath), e.name);
      });
      cell.style.position = 'relative';
      cell.appendChild(editBtn);
    }

    // Play button
    if (isVideo || isAudio) {
      const btn = document.createElement('button');
      btn.textContent = '▶ TV';
      btn.className = 'btn btn-success btn-sm';
      btn.style.cssText = 'margin-top:6px;font-size:0.72rem;padding:2px 8px;';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        playOnTv(relPath);
      });
      cell.appendChild(btn);
    }

    grid.appendChild(cell);
  }
}

// state: 'loading' | 'ok' | 'error'
function showMediaFeedback(msg, state) {
  if (state === true)  state = 'ok';
  if (state === false) state = 'error';

  const el   = document.getElementById('media-feedback');
  const icon = document.getElementById('mf-icon');
  const text = document.getElementById('mf-text');

  clearTimeout(el._t);

  const themes = {
    loading: { bg: '#eaf4ff', border: '#bdd9f5', color: '#1a5f96' },
    ok:      { bg: '#f5f0e8', border: '#d4c9b0', color: '#5a4a2f' },
    error:   { bg: '#fdecea', border: '#f5c6cb', color: '#a93226' },
  };
  const t = themes[state] || themes.ok;
  el.style.background = t.bg;
  el.style.border     = `1px solid ${t.border}`;
  el.style.color      = t.color;

  if (state === 'loading') {
    icon.innerHTML = '<div class="mf-spinner"></div>';
  } else if (state === 'ok') {
    icon.textContent = '✓';
    icon.style.fontWeight = '700';
  } else {
    icon.textContent = '✕';
    icon.style.fontWeight = '700';
  }
  text.textContent = msg;

  el.style.opacity   = '1';
  el.style.transform = 'translateY(0)';
  el.style.pointerEvents = 'none';

  if (state !== 'loading') {
    el._t = setTimeout(() => {
      el.style.opacity   = '0';
      el.style.transform = 'translateY(-4px)';
    }, state === 'error' ? 7000 : 4000);
  }
}

let _pollTimer   = null;
let _paused      = false;
let _lastPosSecs = 0;

async function togglePause() {
  const btn = document.getElementById('pb-pause-btn');
  try {
    if (_paused) {
      await fetch(`${MEDIA_API}/api/media/resume`, { method: 'POST' });
      _paused = false;
      btn.textContent = '⏸ Pause';
      btn.style.background = '#2980b9';
    } else {
      await fetch(`${MEDIA_API}/api/media/pause`, { method: 'POST' });
      _paused = true;
      btn.textContent = '▶ Resume';
      btn.style.background = '#27ae60';
    }
  } catch (_) {}
}

async function seekRel(deltaSecs) {
  const to = Math.max(0, Math.round(_lastPosSecs + deltaSecs));
  try {
    await fetch(`${MEDIA_API}/api/media/seek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to })
    });
  } catch (_) {}
}

function startProgressPoll(title) {
  document.getElementById('pb-title').textContent = title;
  document.getElementById('playback-bar').style.display = 'block';
  clearInterval(_pollTimer);
  // Delay first poll — play is async (TV needs ~3s to wake + start)
  _pollTimer = setInterval(async () => {
    try {
      const r = await fetch(`${MEDIA_API}/api/media/position`);
      if (!r.ok) return;
      const d = await r.json();
      if (d.duration === 0) return;
      _lastPosSecs = d.position;
      document.getElementById('pb-fill').style.width = d.percent + '%';
      document.getElementById('pb-time').textContent = d.posStr + ' / ' + d.durStr;
      if (d.position >= d.duration) stopProgressPoll();
    } catch (_) {}
  }, 4000); // 4s interval — matches TV wake time
}

function stopProgressPoll() {
  clearInterval(_pollTimer);
  _pollTimer = null;
  _paused = false;
  _lastPosSecs = 0;
  document.getElementById('playback-bar').style.display = 'none';
  document.getElementById('pb-fill').style.width = '0%';
  const btn = document.getElementById('pb-pause-btn');
  btn.textContent = '⏸ Pause';
  btn.style.background = '#2980b9';
}

async function playOnTv(relPath) {
  showMediaFeedback('Sending to TV…', 'loading');
  try {
    const r = await fetch(`${MEDIA_API}/api/media/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relPath })
    });
    const d = await r.json();
    if (r.status !== 202 && !r.ok) throw new Error(d.error);
    showMediaFeedback(`▶ Playing on TV: ${d.item}`, true);
    startProgressPoll(d.item);
  } catch (e) {
    showMediaFeedback('✗ ' + e.message, false);
  }
}

async function stopTv() {
  showMediaFeedback('Stopping…', 'loading');
  try {
    const r = await fetch(`${MEDIA_API}/api/media/stop`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    showMediaFeedback('⏹ Stopped', true);
    stopProgressPoll();
  } catch (e) {
    showMediaFeedback('✗ ' + e.message, false);
  }
}

// ─── Upload ───────────────────────────────────────────────────

function handleDrop(event) {
  event.preventDefault();
  document.getElementById('drop-zone').style.background = '';
  const items = event.dataTransfer.items;
  if (items) {
    const files = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) collectEntries(entry, '', files).then(() => uploadFiles(files));
      else if (item.kind === 'file') files.push({ file: item.getAsFile(), relPath: item.getAsFile().name });
    }
    if (!items[0]?.webkitGetAsEntry) uploadFiles(files);
  }
}

function collectEntries(entry, basePath, results) {
  return new Promise(resolve => {
    if (entry.isFile) {
      entry.file(f => { results.push({ file: f, relPath: basePath ? basePath+'/'+f.name : f.name }); resolve(); });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readAll = (acc) => reader.readEntries(entries => {
        if (!entries.length) {
          Promise.all(acc.map(e => collectEntries(e, basePath ? basePath+'/'+entry.name : entry.name, results))).then(resolve);
        } else readAll(acc.concat(Array.from(entries)));
      });
      readAll([]);
    } else resolve();
  });
}

function handleFileInput(fileList) {
  const files = Array.from(fileList).map(f => ({
    file: f,
    relPath: f.webkitRelativePath || f.name
  }));
  uploadFiles(files);
}

async function uploadFiles(files) {
  if (!files.length) return;
  const prog = document.getElementById('upload-progress');
  const bar  = document.getElementById('upload-bar');
  const stat = document.getElementById('upload-status');
  const cnt  = document.getElementById('upload-count');
  const errs = document.getElementById('upload-errors');
  prog.style.display = 'block';
  errs.textContent = '';
  const errors = [];

  for (let i = 0; i < files.length; i++) {
    const { file, relPath } = files[i];
    stat.textContent = relPath;
    cnt.textContent  = `${i+1} / ${files.length}`;
    bar.style.width  = Math.round((i / files.length) * 100) + '%';
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('relativePath', relPath);
      fd.append('targetPath', _currentPath);
      const r = await fetch(`${INGEST_API}/api/media/upload`, { method: 'POST', body: fd });
      if (!r.ok) { const d = await r.json(); errors.push(`${relPath}: ${d.error}`); }
    } catch (e) { errors.push(`${relPath}: ${e.message}`); }
  }

  bar.style.width = '100%';
  stat.textContent = errors.length ? `Done — ${errors.length} error(s)` : `Done — ${files.length} file(s) uploaded`;
  errs.textContent = errors.join('\n');
  setTimeout(() => { prog.style.display = 'none'; }, 5000);
  loadMediaBrowser(_currentPath);

  // reset file inputs so same file can be re-selected
  document.getElementById('upload-files').value   = '';
  document.getElementById('upload-folder').value  = '';
}

// ── Tab loaders ───────────────────────────────────────────────────
async function loadAnalyzer(force) {
  if (!force && window._analyzerLoaded) return;
  window._analyzerLoaded = true;
  loadAnalyzerStatus();
  await loadFacePeople();   // populate _knownPeopleNames first
  loadFaceClusters();       // cluster cards now render with "Same as…" dropdown
  loadUnmatchedFaces();
}

function loadIngest() {
  // Ingest tab has its own static UI — nothing to fetch on open
}

// ── Media Settings ────────────────────────────────────────────────
async function loadMediaSettings() {
  try {
    const r = await fetch(`${MEDIA_API}/api/analyzer/settings`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');

    // Auto mode fields
    const autoEnabled = document.getElementById('ms-auto_enabled');
    if (autoEnabled && d.auto_enabled != null) autoEnabled.value = String(d.auto_enabled);

    for (const k of ['auto_frame_interval', 'auto_cluster_every']) {
      const el = document.getElementById(`ms-${k}`);
      if (el && d[k] != null) el.value = d[k];
    }
    for (const k of ['auto_face_score_min']) {
      const el = document.getElementById(`ms-${k}`);
      if (el && d[k] != null) el.value = Math.round(d[k] * 100);
    }

    // Manual mode fields
    for (const k of ['manual_batch_size', 'manual_frame_interval']) {
      const el = document.getElementById(`ms-${k}`);
      if (el && d[k] != null) el.value = d[k];
    }
    for (const k of ['manual_face_score_min', 'manual_cluster_eps']) {
      const el = document.getElementById(`ms-${k}`);
      if (el && d[k] != null) el.value = Math.round(d[k] * 100);
    }

  } catch (e) {
    const msg = document.getElementById('ms-auto-msg') || document.getElementById('ms-manual-msg');
    if (msg) { msg.style.color = '#c0392b'; msg.textContent = e.message; }
  }
}

async function saveMediaSettings(event, mode) {
  if (event) event.preventDefault();
  const formId = mode === 'auto' ? 'ms-auto-form' : 'ms-manual-form';
  const msgId  = mode === 'auto' ? 'ms-auto-msg'  : 'ms-manual-msg';
  const btn = document.querySelector(`#${formId} button[type="submit"]`);
  const msg = document.getElementById(msgId);
  const body = {};

  if (mode === 'auto') {
    const en = document.getElementById('ms-auto_enabled');
    if (en) body.auto_enabled = parseInt(en.value);
    const fi = document.getElementById('ms-auto_frame_interval');
    if (fi) body.auto_frame_interval = parseInt(fi.value);
    const fs = document.getElementById('ms-auto_face_score_min');
    if (fs) body.auto_face_score_min = parseFloat(fs.value) / 100;
    const ce = document.getElementById('ms-auto_cluster_every');
    if (ce) body.auto_cluster_every = parseInt(ce.value);
  } else if (mode === 'manual') {
    const bs = document.getElementById('ms-manual_batch_size');
    if (bs) body.manual_batch_size = parseInt(bs.value);
    const fi = document.getElementById('ms-manual_frame_interval');
    if (fi) body.manual_frame_interval = parseInt(fi.value);
    const fs = document.getElementById('ms-manual_face_score_min');
    if (fs) body.manual_face_score_min = parseFloat(fs.value) / 100;
    const ce = document.getElementById('ms-manual_cluster_eps');
    if (ce) body.manual_cluster_eps = parseFloat(ce.value) / 100;
  }

  btn.disabled = true; msg.style.color = '#888'; msg.textContent = 'Saving…';
  try {
    const r = await fetch(`${MEDIA_API}/api/analyzer/settings`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    msg.style.color = '#2ecc71'; msg.textContent = '✓ Saved';
    setTimeout(() => { msg.textContent = ''; }, 3000);
  } catch (e) {
    msg.style.color = '#c0392b'; msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}


function loadPlayer() {
  if (window._playerLoaded) return;
  window._playerLoaded = true;
  loadMediaBrowser('');
}


// ── Analyzer Status ───────────────────────────────────────────────
async function loadAnalyzerStatus() {
  const grid     = document.getElementById('az-status-grid');
  const facesRow = document.getElementById('az-faces-row');
  const lastRun  = document.getElementById('az-last-run');
  try {
    const r = await fetch(`${MEDIA_API}/api/analyzer/status`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');

    const currentDone = (d.searchable || 0) + (d.ready || 0) + (d.error || 0);
    const processing  = d.processing || 0;

    // ── Auto Run bar — only active when NO manual Re-run is in progress ──
    const manualRunning = !!sessionStorage.getItem('az_manual_snap');
    const autoBar   = document.getElementById('az-run-bar');
    const autoPctEl = document.getElementById('az-run-pct');
    const autoLbl   = document.getElementById('az-run-label');
    if (manualRunning) {
      if (autoBar)   autoBar.style.width   = '0%';
      if (autoPctEl) autoPctEl.textContent = '0%';
      if (autoLbl)   autoLbl.textContent   = 'No active run';
    } else {
      const autoTotal  = (d.pending || 0) + processing + currentDone;
      const autoActive = (d.pending || 0) > 0 || processing > 0;
      const autoPct    = (autoTotal > 0 && autoActive) ? Math.round((currentDone + processing * 0.5) / autoTotal * 100) : 0;
      if (autoBar)   autoBar.style.width   = autoPct + '%';
      if (autoPctEl) autoPctEl.textContent = autoPct + '%';
      if (autoLbl) {
        if (!autoActive)       autoLbl.textContent = 'No active run';
        else if (processing>0) autoLbl.textContent = `${currentDone} done, 1 processing…`;
        else                   autoLbl.textContent = `${currentDone} of ${autoTotal} files`;
      }
    }

    // ── Overall counts ──
    const counts = [
      { label: 'Pending',    val: d.pending,    color: '#e67e22' },
      { label: 'Processing', val: d.processing, color: '#2980b9' },
      { label: 'Searchable', val: d.searchable, color: '#8e44ad' },
      { label: 'Ready',      val: d.ready,      color: '#27ae60' },
      { label: 'Error',      val: d.error,      color: '#c0392b' },
      { label: 'Total',      val: d.total,      color: '#555', bold: true },
    ];
    const gridSep = '<div style="width:1px;background:#e8e4de;align-self:stretch;"></div>';
    grid.innerHTML = counts.map(c =>
      `<div style="text-align:center;flex:1;padding:4px 4px;">
         <div style="font-size:1.3rem;font-weight:${c.bold?700:600};color:${c.color};">${c.val}</div>
         <div style="font-size:0.68rem;color:#888;margin-top:1px;">${c.label}</div>
       </div>`
    ).join(gridSep);

    // ── Run Status card: faces + last run ──
    const f = d.faces || {};
    window._azLastCounts = { unassigned: f.unassigned||0, unlabeled: f.unlabeled||0, named: f.named||0 };
    const unassigned = f.unassigned || 0;
    const unlabeled  = f.unlabeled  || 0;
    const named      = f.named      || 0;
    const sep = '<div style="width:1px;background:#e8e4de;align-self:stretch;"></div>';
    facesRow.innerHTML = [
      { label: 'Unassigned', val: unassigned, color: '#e67e22' },
      { label: 'In Clusters', val: unlabeled,  color: '#2980b9' },
      { label: 'Named',       val: named,      color: '#27ae60' },
    ].map(c =>
      `<div style="text-align:center;flex:1;padding:4px 4px;">
         <div style="font-size:1.3rem;font-weight:600;color:${c.color};">${c.val}</div>
         <div style="font-size:0.68rem;color:#888;margin-top:1px;">${c.label}</div>
       </div>`
    ).join(sep);

    if (d.last_run) {
      const lr = d.last_run;
      const ts = new Date(lr.ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
      const errHtml = (lr.error && lr.error !== 'NO ERROR')
        ? ` <span style="color:#c0392b;">${escHtml(lr.error)}</span>` : '';
      lastRun.innerHTML = `${ts} — ${escHtml(lr.decision || '—')}${errHtml}`;
    } else {
      lastRun.textContent = '';
    }

    // ── Manual Run bar — snap set by Re-run click, cleared when batch completes ──
    let msnap = JSON.parse(sessionStorage.getItem('az_manual_snap') || 'null');
    if (msnap && d.pending === 0 && processing === 0) {
      sessionStorage.removeItem('az_manual_snap');
      msnap = null;
    }
    const mBar   = document.getElementById('az-manual-bar');
    const mPctEl = document.getElementById('az-manual-pct');
    const mLbl   = document.getElementById('az-manual-label');
    if (!msnap) {
      if (mBar)   mBar.style.width   = '0%';
      if (mPctEl) mPctEl.textContent = '0%';
      if (mLbl)   mLbl.textContent   = 'No active batch';
    } else {
      const mDone = Math.max(0, currentDone - msnap.doneAtStart);
      const mTotal = msnap.pendingAtStart;
      const mPct  = mTotal > 0 ? Math.round((mDone + processing * 0.5) / mTotal * 100) : 0;
      if ((mDone >= mTotal && processing === 0) || (d.pending === 0 && processing === 0 && mTotal === 0)) {
        // batch complete — reset to 0
        sessionStorage.removeItem('az_manual_snap');
        if (mBar)   mBar.style.width   = '0%';
        if (mPctEl) mPctEl.textContent = '0%';
        if (mLbl)   mLbl.textContent   = `Done — ${mTotal} file${mTotal !== 1 ? 's' : ''} processed`;
      } else {
        if (mBar)   mBar.style.width   = Math.min(99, mPct) + '%';
        if (mPctEl) mPctEl.textContent = Math.min(99, mPct) + '%';
        if (mLbl) {
          if (processing > 0) mLbl.textContent = `${mDone} done, 1 processing…`;
          else                mLbl.textContent = `${mDone} of ${mTotal} files`;
        }
      }
    }
  } catch (e) {
    if (grid)     grid.innerHTML     = `<div style="color:#c0392b;font-size:0.82rem;">${escHtml(e.message)}</div>`;
    if (facesRow) facesRow.innerHTML = '';
  }
}


async function rerunAnalyzer(btn) {
  const confirmed = await new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;padding:24px 28px;max-width:380px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
        <h3 style="margin:0 0 12px;font-size:1.05rem;">Re-run Analysis?</h3>
        <p style="margin:0 0 10px;font-size:0.88rem;color:#555;">All files will be reset to pending and re-analyzed.</p>
        <p style="margin:0 0 20px;font-size:0.88rem;color:#b86e00;font-weight:600;">⚠ Known People are preserved — faces will be re-detected and auto-matched.</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="_rerun-cancel" class="btn btn-secondary btn-sm">Cancel</button>
          <button id="_rerun-confirm" class="btn btn-sm" style="background:#c0392b;color:#fff;border-color:#c0392b;">Re-run</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#_rerun-cancel').onclick  = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('#_rerun-confirm').onclick = () => { overlay.remove(); resolve(true); };
  });
  if (!confirmed) return;
  btn.disabled = true; btn.textContent = 'Resetting…';
  const msg = document.getElementById('az-rerun-msg');
  try {
    const r = await fetch(`${MEDIA_API}/api/analyzer/rerun`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    // set manual snap for this batch; auto bar is live so needs no reset
    // doneAtStart = current done count from status (rerun doesn't reset ready files that weren't re-queued)
    const statusR = await fetch(`${MEDIA_API}/api/analyzer/status`);
    const statusD = statusR.ok ? await statusR.json() : {};
    const doneNow = (statusD.searchable||0) + (statusD.ready||0) + (statusD.error||0);
    sessionStorage.setItem('az_manual_snap', JSON.stringify({ pendingAtStart: d.count, doneAtStart: doneNow }));
    const mBar = document.getElementById('az-manual-bar');
    const mPct = document.getElementById('az-manual-pct');
    const mLbl = document.getElementById('az-manual-label');
    if (mBar)  mBar.style.width   = '0%';
    if (mPct)  mPct.textContent   = '0%';
    if (mLbl)  mLbl.textContent   = `0 of ${d.count} files`;
    if (msg) { msg.style.color = '#2ecc71'; msg.textContent = `✓ ${d.count} file${d.count !== 1 ? 's' : ''} reset`; }
    btn.textContent = '↺ Re-run';
    setTimeout(() => { btn.disabled = false; if (msg) msg.textContent = ''; loadAnalyzerStatus(); }, 2000);
  } catch (e) {
    btn.disabled = false; btn.textContent = '↺ Re-run';
    if (msg) { msg.style.color = '#c0392b'; msg.textContent = e.message; }
  }
}

async function runClustering(btn) {
  btn.disabled = true; btn.textContent = 'Requested…';
  try {
    const r = await fetch(`${MEDIA_API}/api/analyzer/trigger-clustering`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    btn.textContent = '✓ Will run in ≤5s';
    setTimeout(() => { btn.disabled = false; btn.textContent = '↺ Run'; loadAnalyzer(true); }, 6000);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Run Clustering';
    alert('Error: ' + e.message);
  }
}


// ── Face Clusters ─────────────────────────────────────────────────
const _skippedClusters = new Set();
let   _knownPeopleNames = [];

async function loadFaceClusters(clearSkipped) {
  if (clearSkipped) _skippedClusters.clear();
  const container = document.getElementById('az-clusters');
  const countEl   = document.getElementById('az-cluster-count');
  container.innerHTML = '<div style="color:#aaa;font-size:0.85rem;padding:8px;">Loading…</div>';
  try {
    const r = await fetch(`${MEDIA_API}/api/faces/clusters`);
    const clusters = await r.json();
    if (!r.ok) throw new Error(clusters.error || 'Failed');

    const visible = clusters.filter(c => !_skippedClusters.has(c.cluster_id));
    countEl.textContent = visible.length ? `(${visible.length} unlabeled)` : '';
    if (!visible.length) {
      container.innerHTML = '<div style="color:#aaa;font-size:0.85rem;padding:8px;">No unlabeled face clusters yet.</div>';
      return;
    }
    container.innerHTML = '';
    for (const c of visible) container.appendChild(buildClusterCard(c));
  } catch (e) {
    container.innerHTML = `<div style="color:#c0392b;font-size:0.85rem;">${escHtml(e.message)}</div>`;
  }
}

function buildClusterCard(c) {
  const card = document.createElement('div');
  card.style.cssText = 'background:#faf8f5;border:1px solid #ece8e2;border-radius:8px;padding:14px;text-align:center;';
  card.dataset.clusterId = c.cluster_id;

  const imgSrc = c.crop_file ? `${MEDIA_API}/api/faces/crop/${c.crop_file}` : '';
  const imgHtml = imgSrc
    ? `<img src="${imgSrc}" style="width:112px;height:112px;object-fit:cover;"
            onerror="this.parentElement.innerHTML='<span style=font-size:2.5rem;line-height:112px>👤</span>'">`
    : '<span style="font-size:2.5rem;line-height:112px;">👤</span>';

  const sameAsOpts = _knownPeopleNames.length
    ? `<option value="">Same as…</option>` +
      _knownPeopleNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('')
    : '';

  card.innerHTML = `
    <div style="width:112px;height:112px;margin:0 auto 10px;border-radius:6px;overflow:hidden;background:#e8e4de;">${imgHtml}</div>
    <div style="font-size:0.78rem;color:#888;margin-bottom:4px;">
      ${c.face_count} face${c.face_count !== 1 ? 's' : ''} · ${c.file_count} file${c.file_count !== 1 ? 's' : ''}
    </div>
    ${c.confidence != null ? `<div style="font-size:0.78rem;margin-bottom:10px;font-weight:600;${c.confidence >= 0.8 ? 'color:#3a7d44;' : c.confidence >= 0.6 ? 'color:#b86e00;' : 'color:#c0392b;'}">Similarity: ${Math.round(c.confidence * 100)}%</div>` : ''}
    <div style="display:flex;gap:6px;align-items:center;justify-content:center;flex-wrap:wrap;">
      <input type="text" placeholder="Name…" id="cluster-name-${c.cluster_id}"
             style="width:88px;padding:5px 8px;border:1px solid #d0cbc4;border-radius:4px;font-size:0.82rem;"
             onkeydown="if(event.key==='Enter')saveFaceLabel(${c.cluster_id})">
      ${sameAsOpts ? `<select class="cluster-same-as"
             style="padding:5px 4px;border:1px solid #d0cbc4;border-radius:4px;font-size:0.78rem;max-width:100px;"
             onchange="if(this.value){document.getElementById('cluster-name-${c.cluster_id}').value=this.value;this.value=''}">${sameAsOpts}</select>` : ''}
    </div>
    <div style="display:flex;gap:6px;justify-content:center;margin-top:6px;">
      <button class="btn btn-success btn-sm" onclick="saveFaceLabel(${c.cluster_id})">Save</button>
      <button class="btn btn-secondary btn-sm" onclick="skipCluster(${c.cluster_id})">Skip</button>
    </div>
    <div id="cluster-msg-${c.cluster_id}" style="font-size:0.75rem;min-height:1.2em;margin-top:4px;"></div>
  `;
  return card;
}

async function saveFaceLabel(clusterId) {
  const input = document.getElementById(`cluster-name-${clusterId}`);
  const msg   = document.getElementById(`cluster-msg-${clusterId}`);
  const name  = (input?.value || '').trim();
  if (!name) { msg.style.color = '#c0392b'; msg.textContent = 'Enter a name'; return; }

  msg.style.color = '#888'; msg.textContent = 'Saving…';
  try {
    const r = await fetch(`${MEDIA_API}/api/faces/label`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cluster_id: clusterId, name })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');

    msg.style.color = '#27ae60';
    msg.textContent = `✓ Saved as "${d.name}" (${d.files_updated} file${d.files_updated !== 1 ? 's' : ''})`;
    setTimeout(() => {
      const card = document.querySelector(`[data-cluster-id="${clusterId}"]`);
      if (card) card.remove();
      _refreshClusterCount();
      loadFacePeople();
    }, 1500);
  } catch (e) {
    msg.style.color = '#c0392b';
    msg.textContent = e.message;
  }
}

function skipCluster(clusterId) {
  _skippedClusters.add(clusterId);
  const card = document.querySelector(`[data-cluster-id="${clusterId}"]`);
  if (card) card.remove();
  _refreshClusterCount();
}

function _refreshClusterCount() {
  const remaining = document.querySelectorAll('#az-clusters [data-cluster-id]').length;
  const countEl   = document.getElementById('az-cluster-count');
  if (!remaining) {
    const cont = document.getElementById('az-clusters');
    if (!cont.querySelector('[data-cluster-id]')) {
      cont.innerHTML = '<div style="color:#aaa;font-size:0.85rem;padding:8px;">No unlabeled face clusters yet.</div>';
    }
    countEl.textContent = '';
  } else {
    countEl.textContent = `(${remaining} unlabeled)`;
  }
}


// ── Unmatched Faces ───────────────────────────────────────────────
const _skippedFaces = new Set();

async function loadUnmatchedFaces() {
  const container = document.getElementById('az-unmatched');
  const countEl   = document.getElementById('az-unmatched-count');
  if (!container) return;
  container.innerHTML = '<div style="color:#aaa;font-size:0.85rem;padding:8px;">Loading…</div>';
  try {
    const r = await fetch(`${MEDIA_API}/api/faces/unmatched`);
    const faces = await r.json();
    if (!r.ok) throw new Error(faces.error || 'Failed');

    const visible = faces.filter(f => !_skippedFaces.has(f.id));
    countEl.textContent = visible.length ? `(${visible.length})` : '';

    if (!visible.length) {
      container.innerHTML = '<div style="color:#aaa;font-size:0.85rem;padding:8px;">No unmatched faces.</div>';
      return;
    }

    container.innerHTML = '';
    for (const f of visible) {
      const card = document.createElement('div');
      card.dataset.faceId = f.id;
      card.style.cssText = 'background:#faf8f5;border:1px solid #ece8e2;border-radius:8px;padding:10px;text-align:center;width:160px;flex-shrink:0;';

      const imgSrc = `${MEDIA_API}/api/faces/crop/${escAttr(f.crop_file)}`;
      const opts = ['<option value="">Assign to…</option>']
        .concat(_knownPeopleNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`))
        .join('');

      card.innerHTML = `
        <div style="width:112px;height:112px;margin:0 auto 8px;overflow:hidden;border-radius:6px;background:#eee;">
          <img src="${imgSrc}" width="112" height="112" style="object-fit:cover;"
               onerror="this.parentElement.innerHTML='<span style=font-size:2rem;line-height:112px>👤</span>'">
        </div>
        <div style="font-size:0.72rem;color:#888;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escAttr(f.file_name)}">${escHtml(f.file_name)}</div>
        <div style="font-size:0.70rem;color:#aaa;margin-bottom:4px;display:flex;align-items:center;justify-content:center;gap:6px;">
          <span>${f.frame_sec != null ? '⏱ ' + new Date(f.frame_sec*1000).toISOString().slice(11,19) : 'image'}</span>
          <button onclick="showFaceFrame(${f.id})"
                  style="padding:2px 6px;background:none;border:1px solid #b0aaa4;border-radius:4px;font-size:0.70rem;color:#666;cursor:pointer;">🎬</button>
        </div>
        ${f.det_score != null ? `<div style="font-size:0.70rem;margin-bottom:4px;color:${f.det_score>=0.85?'#27ae60':f.det_score>=0.70?'#e67e22':'#e74c3c'};">Det: ${(f.det_score*100).toFixed(0)}%</div>` : ''}
        <div style="display:flex;flex-direction:column;gap:5px;">
          <div style="display:flex;gap:4px;">
            <input type="text" placeholder="New name…" id="unmatched-name-${f.id}"
                   style="width:80px;padding:4px 6px;border:1px solid #d0cbc4;border-radius:4px;font-size:0.78rem;"
                   onkeydown="if(event.key==='Enter')assignFace(${f.id})">
            <button onclick="assignFace(${f.id})"
                    style="padding:4px 7px;background:#2980b9;color:#fff;border:none;border-radius:4px;font-size:0.78rem;cursor:pointer;">✓</button>
          </div>
          <select onchange="if(this.value){document.getElementById('unmatched-name-${f.id}').value=this.value;this.value=''}"
                  style="padding:4px;border:1px solid #d0cbc4;border-radius:4px;font-size:0.75rem;width:100%;">${opts}</select>
          <button onclick="skipFace(${f.id}, this)"
                  style="padding:3px;background:none;border:1px solid #ccc;border-radius:4px;font-size:0.75rem;color:#888;cursor:pointer;">Skip</button>
        </div>`;
      container.appendChild(card);
    }
  } catch (e) {
    container.innerHTML = `<div style="color:#c0392b;font-size:0.85rem;">${escHtml(e.message)}</div>`;
  }
}

function showFaceFrame(faceId, overrides) {
  const existing = document.getElementById('face-frame-lightbox');
  if (existing) existing.remove();

  const peopleOpts = ['<option value="">Existing person…</option>']
    .concat(_knownPeopleNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`))
    .join('');

  const box = document.createElement('div');
  box.id = 'face-frame-lightbox';
  box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:9999;display:flex;align-items:center;justify-content:center;';
  box.onclick = () => box.remove();

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:96vw;display:flex;flex-direction:column;align-items:center;';
  wrap.onclick = e => e.stopPropagation();

  const hint = document.createElement('div');
  hint.style.cssText = 'color:#aaa;font-size:0.8rem;margin-bottom:6px;';
  hint.textContent = 'Draw a box around the face you want to save';

  // scrollable canvas container
  const canvasWrap = document.createElement('div');
  canvasWrap.style.cssText = 'overflow:auto;max-width:92vw;max-height:62vh;border-radius:8px 8px 0 0;background:#000;';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;cursor:crosshair;';
  canvasWrap.appendChild(canvas);

  // nav + zoom bar
  const navBar = document.createElement('div');
  navBar.style.cssText = 'background:#111;padding:7px 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;box-sizing:border-box;border-top:1px solid #333;';
  navBar.innerHTML = `
    <button onclick="lbSeek(${faceId},-5)"  title="-5s"  style="${_lbBtnStyle()}">⏮ 5s</button>
    <button onclick="lbSeek(${faceId},-1)"  title="-1s"  style="${_lbBtnStyle()}">◀ 1s</button>
    <span id="lb-time-${faceId}" style="color:#ccc;font-size:0.82rem;min-width:56px;text-align:center;">--:--</span>
    <button onclick="lbSeek(${faceId},1)"   title="+1s"  style="${_lbBtnStyle()}">1s ▶</button>
    <button onclick="lbSeek(${faceId},5)"   title="+5s"  style="${_lbBtnStyle()}">5s ⏭</button>
    <span style="flex:1"></span>
    <button onclick="lbZoom(${faceId},-1)"  style="${_lbBtnStyle()}">－</button>
    <span id="lb-zoom-${faceId}" style="color:#ccc;font-size:0.8rem;min-width:36px;text-align:center;">100%</span>
    <button onclick="lbZoom(${faceId},1)"   style="${_lbBtnStyle()}">＋</button>`;

  // name + save bar
  const bar = document.createElement('div');
  bar.style.cssText = 'background:#1a1a1a;border-radius:0 0 8px 8px;padding:10px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;box-sizing:border-box;';
  bar.innerHTML = `
    <input type="text" id="lb-name-${faceId}" placeholder="Name this person…"
           style="flex:1;min-width:110px;padding:6px 10px;border:1px solid #555;border-radius:5px;background:#2a2a2a;color:#fff;font-size:0.85rem;"
           onkeydown="if(event.key==='Enter')saveManualCrop(${faceId})">
    <select onchange="if(this.value){document.getElementById('lb-name-${faceId}').value=this.value;this.value=''}"
            style="padding:6px 7px;border:1px solid #555;border-radius:5px;background:#2a2a2a;color:#fff;font-size:0.8rem;">${peopleOpts}</select>
    <button id="lb-save-${faceId}" onclick="saveManualCrop(${faceId})"
            style="padding:6px 16px;background:#27ae60;color:#fff;border:none;border-radius:5px;font-size:0.85rem;cursor:pointer;font-weight:600;" disabled>Save selection</button>
    <button onclick="document.getElementById('face-frame-lightbox').remove()"
            style="padding:6px 12px;background:none;border:1px solid #666;color:#aaa;border-radius:5px;font-size:0.85rem;cursor:pointer;">Close</button>`;

  wrap.append(hint, canvasWrap, navBar, bar);
  box.appendChild(wrap);
  document.body.appendChild(box);

  // state attached to box element
  box._lb = { faceId, filePath: null, frameSec: 0, zoom: 1, baseW: 0, baseH: 0, context: overrides?.context || 'unmatched' };

  // pre-fill name if provided
  if (overrides?.defaultName) {
    const nameEl = document.getElementById(`lb-name-${faceId}`);
    if (nameEl) nameEl.value = overrides.defaultName;
  }

  if (overrides?.filePath != null) {
    // called from Known People — use provided info directly
    box._lb.filePath = overrides.filePath;
    box._lb.frameSec = overrides.frameSec ?? 0;
    lbLoadFrame(faceId, canvas, canvasWrap, hint);
  } else {
    // called from Unmatched — fetch face info
    fetch(`${MEDIA_API}/api/faces/unmatched`)
      .then(r => r.json())
      .then(faces => {
        const face = faces.find(f => f.id === faceId);
        if (!face) return;
        box._lb.filePath = `/mnt/media/${face.file_name}`;
        box._lb.frameSec = face.frame_sec ?? 0;
        lbLoadFrame(faceId, canvas, canvasWrap, hint);
      })
      .catch(() => { hint.textContent = 'Could not load face info'; });
  }

  setTimeout(() => document.getElementById(`lb-name-${faceId}`)?.focus(), 100);
}

function _lbBtnStyle() {
  return 'padding:4px 9px;background:#2a2a2a;border:1px solid #555;color:#ccc;border-radius:4px;font-size:0.8rem;cursor:pointer;';
}

function lbLoadFrame(faceId, canvas, _canvasWrap, hint) {
  const box = document.getElementById('face-frame-lightbox');
  if (!box) return;
  const lb = box._lb;
  const timeEl = document.getElementById(`lb-time-${faceId}`);
  const sec = lb.frameSec;
  if (timeEl) timeEl.textContent = new Date(sec * 1000).toISOString().slice(11, 19);

  const url = `${MEDIA_API}/api/faces/video-frame?path=${encodeURIComponent(lb.filePath)}&sec=${sec}`;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (!document.getElementById('face-frame-lightbox')) return;
    const maxW = Math.min(window.innerWidth * 0.9, 1280);
    const maxH = window.innerHeight * 0.60;
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    lb.baseW = Math.round(img.naturalWidth  * scale);
    lb.baseH = Math.round(img.naturalHeight * scale);
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    lbApplyZoom(faceId, canvas, lb.zoom);
    canvas.getContext('2d').drawImage(img, 0, 0);
    canvas._selRect = null;
    document.getElementById(`lb-save-${faceId}`)?.setAttribute('disabled', '');
    setupCanvasDraw(canvas, faceId, img);
    if (hint) hint.textContent = 'Draw a box around the face you want to save';
  };
  img.onerror = () => { if (hint) hint.textContent = 'Frame not available'; };
  img.src = url;
}

function lbApplyZoom(faceId, canvas, zoom) {
  const box = document.getElementById('face-frame-lightbox');
  if (!box) return;
  const lb = box._lb;
  lb.zoom = zoom;
  const w = Math.round(lb.baseW * zoom);
  const h = Math.round(lb.baseH * zoom);
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  const zEl = document.getElementById(`lb-zoom-${faceId}`);
  if (zEl) zEl.textContent = Math.round(zoom * 100) + '%';
}

function lbZoom(faceId, dir) {
  const box = document.getElementById('face-frame-lightbox');
  if (!box) return;
  const canvas = box.querySelector('canvas');
  const lb = box._lb;
  const steps = [0.5, 0.75, 1, 1.5, 2, 3, 4];
  let idx = steps.findIndex(s => s >= lb.zoom);
  if (idx < 0) idx = 2;
  idx = Math.max(0, Math.min(steps.length - 1, idx + dir));
  lbApplyZoom(faceId, canvas, steps[idx]);
}

function lbSeek(faceId, delta) {
  const box = document.getElementById('face-frame-lightbox');
  if (!box || !box._lb.filePath) return;
  box._lb.frameSec = Math.max(0, box._lb.frameSec + delta);
  const canvas   = box.querySelector('canvas');
  const canvasWrap = box.querySelector('div[style*="overflow"]');
  lbLoadFrame(faceId, canvas, canvasWrap, null);
}

function setupCanvasDraw(canvas, faceId, srcImg) {
  const natW = srcImg.naturalWidth;
  const natH = srcImg.naturalHeight;
  const ctx  = canvas.getContext('2d');
  let drawing = false, startX = 0, startY = 0;

  function evXY(e) {
    const r  = canvas.getBoundingClientRect();
    const cl = e.touches ? e.touches[0] : e;
    return [
      (cl.clientX - r.left) * (natW / r.width),
      (cl.clientY - r.top)  * (natH / r.height)
    ];
  }

  function redraw(x1, y1, x2, y2) {
    ctx.drawImage(srcImg, 0, 0);
    if (x2 !== undefined) {
      const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
      const rw = Math.abs(x2 - x1),  rh = Math.abs(y2 - y1);
      ctx.fillStyle   = 'rgba(243,156,18,0.15)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = '#f39c12';
      ctx.lineWidth   = Math.max(2, natW / 400);
      ctx.setLineDash([8, 4]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
    }
  }

  canvas.addEventListener('mousedown', e => {
    e.preventDefault();
    [startX, startY] = evXY(e);
    drawing = true;
    canvas._selRect = null;
    document.getElementById(`lb-save-${faceId}`).disabled = true;
  });
  canvas.addEventListener('mousemove', e => {
    if (!drawing) return;
    e.preventDefault();
    const [cx, cy] = evXY(e);
    redraw(startX, startY, cx, cy);
  });
  canvas.addEventListener('mouseup', e => {
    if (!drawing) return;
    drawing = false;
    const [cx, cy] = evXY(e);
    const x1 = Math.min(startX, cx), y1 = Math.min(startY, cy);
    const x2 = Math.max(startX, cx), y2 = Math.max(startY, cy);
    redraw(x1, y1, x2, y2);
    if (x2 - x1 > 10 && y2 - y1 > 10) {
      canvas._selRect = { x1: x1/natW, y1: y1/natH, x2: x2/natW, y2: y2/natH };
      document.getElementById(`lb-save-${faceId}`).disabled = false;
    }
  });
}

async function saveManualCrop(faceId) {
  const canvas = document.querySelector('#face-frame-lightbox canvas');
  const sel    = canvas?._selRect;
  const nameEl = document.getElementById(`lb-name-${faceId}`);
  const name   = (nameEl ? nameEl.value : '').trim();
  if (!sel)  { alert('Draw a box around the face first'); return; }
  if (!name) { nameEl?.focus(); return; }

  const btn = document.getElementById(`lb-save-${faceId}`);
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const lb = document.getElementById('face-frame-lightbox')?._lb;
    if (!lb) throw new Error('Lightbox state lost');

    const r = await fetch(`${MEDIA_API}/api/faces/manual-crop`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        file_path: lb.filePath,
        frame_sec: lb.frameSec,
        x1_frac: sel.x1, y1_frac: sel.y1,
        x2_frac: sel.x2, y2_frac: sel.y2,
        name
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');

    const lbContext = lb.context;
    const lbName    = name;
    document.getElementById('face-frame-lightbox')?.remove();

    if (lbContext === 'known') {
      // refresh only the open faces panel for this person
      const panel = document.querySelector(`[data-person-panel="${CSS.escape(lbName)}"]`);
      if (panel && panel.style.display !== 'none') loadPersonFaces(lbName, panel);
    } else {
      // unmatched context: mark face as assigned + update unmatched list
      await assignFace(faceId, lbName);
    }
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Save selection';
    alert(e.message);
  }
}

async function assignFace(faceId, forceName) {
  const input = document.getElementById(`unmatched-name-${faceId}`);
  const name  = forceName || (input ? input.value : '').trim();
  if (!name) { if (input) input.focus(); return; }
  try {
    const r = await fetch(`${MEDIA_API}/api/faces/assign`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({face_id: faceId, name})
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    _skippedFaces.add(faceId);
    document.querySelector(`[data-face-id="${faceId}"]`)?.remove();
    const countEl = document.getElementById('az-unmatched-count');
    const remaining = document.querySelectorAll('#az-unmatched [data-face-id]').length;
    if (countEl) countEl.textContent = remaining ? `(${remaining})` : '';
    if (!remaining) document.getElementById('az-unmatched').innerHTML =
      '<div style="color:#aaa;font-size:0.85rem;padding:8px;">No unmatched faces.</div>';
    // refresh known people in case new name was added
    loadFacePeople();
  } catch (e) {
    alert(e.message);
  }
}

async function skipFace(faceId, btn) {
  btn.disabled = true;
  try {
    await fetch(`${MEDIA_API}/api/faces/skip`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({face_id: faceId})
    });
  } catch (_) {}  // fire-and-forget — hide immediately regardless
  document.querySelector(`[data-face-id="${faceId}"]`)?.remove();
  const remaining = document.querySelectorAll('#az-unmatched [data-face-id]').length;
  const countEl = document.getElementById('az-unmatched-count');
  if (countEl) countEl.textContent = remaining ? `(${remaining})` : '';
  if (!remaining) document.getElementById('az-unmatched').innerHTML =
    '<div style="color:#aaa;font-size:0.85rem;padding:8px;">No unmatched faces.</div>';
}


// ── Known People ──────────────────────────────────────────────────
async function loadFacePeople() {
  const container = document.getElementById('az-people');
  const countEl   = document.getElementById('az-people-count');
  try {
    const r = await fetch(`${MEDIA_API}/api/faces/people?_=${Date.now()}`);
    const people = await r.json();
    if (!r.ok) throw new Error(people.error || 'Failed');

    countEl.textContent = people.length ? `(${people.length})` : '';
    _knownPeopleNames = people.map(p => p.name);
    _updateClusterDropdowns();

    if (!people.length) {
      container.innerHTML = '<div style="color:#aaa;font-size:0.85rem;padding:8px;">No named people yet — label a cluster above.</div>';
      return;
    }
    container.innerHTML = '';
    for (const p of people) container.appendChild(buildPersonRow(p));
  } catch (e) {
    container.innerHTML = `<div style="color:#c0392b;font-size:0.85rem;">${escHtml(e.message)}</div>`;
  }
}

function buildPersonRow(p) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 12px;background:#faf8f5;border:1px solid #ece8e2;border-radius:6px;';

  // Avatar
  const imgSrc = p.crop_file ? `${MEDIA_API}/api/faces/crop/${p.crop_file}` : '';
  const avatar = document.createElement('div');
  avatar.style.cssText = 'width:48px;height:48px;border-radius:50%;overflow:hidden;background:#e8e4de;flex-shrink:0;';
  avatar.innerHTML = imgSrc
    ? `<img src="${imgSrc}" style="width:48px;height:48px;object-fit:cover;border-radius:50%;"
            onerror="this.parentElement.innerHTML='<span style=font-size:1.5rem;line-height:48px;display:block;text-align:center>👤</span>'">`
    : '<span style="font-size:1.5rem;line-height:48px;display:block;text-align:center;">👤</span>';

  // Info block
  const info = document.createElement('div');
  info.style.cssText = 'flex:1;min-width:0;';

  const nameDisplay = document.createElement('div');
  nameDisplay.style.cssText = 'font-weight:600;font-size:0.95rem;min-width:100px;';
  nameDisplay.textContent = p.name;

  const subText = document.createElement('div');
  subText.style.cssText = 'font-size:0.76rem;color:#888;';
  subText.textContent = `${p.face_count} face${p.face_count !== 1 ? 's' : ''} · ${p.file_count} file${p.file_count !== 1 ? 's' : ''}`;

  const confText = document.createElement('div');
  const confPct = p.confidence != null ? Math.round(p.confidence * 100) : null;
  confText.style.cssText = `font-size:0.76rem;font-weight:600;${confPct != null ? (confPct >= 80 ? 'color:#3a7d44;' : confPct >= 60 ? 'color:#b86e00;' : 'color:#c0392b;') : 'color:#c0392b;'}`;
  confText.textContent = confPct != null ? `Similarity: ${confPct}%` : 'No similarity';

  const detText = document.createElement('div');
  const detPct = p.det_score != null ? Math.round(p.det_score * 100) : null;
  if (detPct != null) {
    detText.style.cssText = `font-size:0.76rem;font-weight:600;${detPct >= 85 ? 'color:#27ae60;' : detPct >= 70 ? 'color:#e67e22;' : 'color:#e74c3c;'}`;
    detText.textContent = `Det: ${detPct}%`;
  }

  // Inline rename form (hidden by default)
  const renameForm = document.createElement('div');
  renameForm.style.cssText = 'display:none;align-items:center;gap:4px;margin-top:4px;';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = p.name;
  nameInput.style.cssText = 'padding:4px 8px;border:1px solid #d0cbc4;border-radius:4px;font-size:0.85rem;width:110px;';

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = '✓';
  confirmBtn.className = 'btn btn-success btn-sm';
  confirmBtn.style.padding = '3px 8px';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕';
  cancelBtn.className = 'btn btn-secondary btn-sm';
  cancelBtn.style.padding = '3px 8px';

  const renameMsg = document.createElement('div');
  renameMsg.style.cssText = 'font-size:0.75rem;color:#888;min-height:1em;';

  renameForm.appendChild(nameInput);
  renameForm.appendChild(confirmBtn);
  renameForm.appendChild(cancelBtn);

  // Name row: name + scores inline
  const nameRow = document.createElement('div');
  nameRow.style.cssText = 'display:flex;align-items:center;gap:24px;';
  nameRow.appendChild(nameDisplay);
  nameRow.appendChild(confText);
  if (detPct != null) nameRow.appendChild(detText);

  info.appendChild(nameRow);
  info.appendChild(subText);
  info.appendChild(renameForm);
  info.appendChild(renameMsg);

  // Edit button
  const editBtn = document.createElement('button');
  editBtn.textContent = '✏️';
  editBtn.title = 'Rename';
  editBtn.className = 'btn btn-secondary btn-sm';
  editBtn.style.cssText = 'padding:3px 7px;font-size:0.8rem;';
  editBtn.addEventListener('click', () => {
    nameDisplay.style.display = 'none';
    renameForm.style.display  = 'flex';
    nameInput.focus();
    nameInput.select();
  });

  cancelBtn.addEventListener('click', () => {
    renameForm.style.display  = 'none';
    nameDisplay.style.display = '';
    nameInput.value = p.name;
    renameMsg.textContent = '';
  });

  confirmBtn.addEventListener('click', () => renamePerson(p.name, nameInput.value.trim(), confirmBtn, renameMsg));
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') renamePerson(p.name, nameInput.value.trim(), confirmBtn, renameMsg);
    if (e.key === 'Escape') cancelBtn.click();
  });

  // Forget button
  const forgetBtn = document.createElement('button');
  forgetBtn.textContent = 'Forget';
  forgetBtn.className = 'btn btn-secondary btn-sm';
  forgetBtn.style.cssText = 'color:#c0392b;border-color:#e0b0ad;';
  forgetBtn.addEventListener('click', () => forgetPerson(p.name, forgetBtn));

  // Faces toggle button
  const facesBtn = document.createElement('button');
  facesBtn.textContent = '🖼 Faces';
  facesBtn.className = 'btn btn-secondary btn-sm';
  facesBtn.style.cssText = 'padding:3px 7px;font-size:0.8rem;';

  // Faces panel (hidden by default, placed below the row)
  const wrap = document.createElement('div');

  const facesPanel = document.createElement('div');
  facesPanel.dataset.personPanel = p.name;
  facesPanel.style.cssText = 'display:none;padding:10px 8px 4px;flex-wrap:wrap;gap:8px;background:#f4f1ed;border:1px solid #e0dbd4;border-top:none;border-radius:0 0 6px 6px;';

  facesBtn.addEventListener('click', () => {
    const open = facesPanel.style.display !== 'none';
    if (open) {
      facesPanel.style.display = 'none';
      facesBtn.textContent = '🖼 Faces';
    } else {
      facesPanel.style.display = 'flex';
      facesBtn.textContent = '▲ Faces';
      loadPersonFaces(p.name, facesPanel);
    }
  });

  row.appendChild(avatar);
  row.appendChild(info);
  row.appendChild(facesBtn);
  row.appendChild(editBtn);
  row.appendChild(forgetBtn);

  wrap.appendChild(row);
  wrap.appendChild(facesPanel);
  return wrap;
}

async function loadPersonFaces(name, panel) {
  panel.innerHTML = '<div style="color:#aaa;font-size:0.82rem;padding:4px;">Loading…</div>';
  try {
    const r = await fetch(`${MEDIA_API}/api/faces/people/${encodeURIComponent(name)}/crops`);
    const crops = await r.json();
    if (!r.ok) throw new Error(crops.error || 'Failed');
    if (!crops.length) { panel.innerHTML = '<div style="color:#aaa;font-size:0.82rem;padding:4px;">No faces saved.</div>'; return; }
    panel.innerHTML = '';
    for (const c of crops) {
      const card = document.createElement('div');
      card.dataset.cropId = c.id;
      card.style.cssText = 'text-align:center;width:96px;';
      const imgSrc = c.crop_file ? `${MEDIA_API}/api/faces/crop/${escAttr(c.crop_file)}` : '';
      const ts   = c.frame_sec != null ? new Date(c.frame_sec*1000).toISOString().slice(11,19) : 'img';
      const conf = c.confidence != null ? c.confidence : null;
      const confBadge = conf != null
        ? `<div style="font-size:0.68rem;font-weight:600;color:${conf>=0.8?'#27ae60':conf>=0.6?'#e67e22':'#c0392b'};">
             ${Math.round(conf*100)}%
           </div>`
        : '';
      card.innerHTML = `
        <div style="width:80px;height:80px;border-radius:6px;overflow:hidden;background:#ddd;margin:0 auto 4px;cursor:pointer;"
             onclick="showCropFrame(${c.id},'${escAttr(c.file_path)}',${c.frame_sec ?? 'null'},'${escAttr(name)}')">
          <img src="${imgSrc}" width="80" height="80" style="object-fit:cover;"
               onerror="this.parentElement.innerHTML='<span style=font-size:1.8rem;line-height:80px>👤</span>'">
        </div>
        ${confBadge}
        <div style="font-size:0.68rem;color:#888;margin-bottom:3px;">⏱ ${escHtml(ts)}</div>
        <div style="display:flex;gap:4px;justify-content:center;">
          <button onclick="showCropFrame(${c.id},'${escAttr(c.file_path)}',${c.frame_sec ?? 'null'},'${escAttr(name)}')"
                  style="padding:2px 7px;background:none;border:1px solid #bbb;border-radius:4px;font-size:0.72rem;cursor:pointer;">🎬</button>
          <button onclick="deleteCrop(${c.id},this)"
                  style="padding:2px 7px;background:none;border:1px solid #e0b0ad;border-radius:4px;font-size:0.72rem;color:#c0392b;cursor:pointer;">✕</button>
        </div>`;
      panel.appendChild(card);
    }
  } catch (e) {
    panel.innerHTML = `<div style="color:#c0392b;font-size:0.82rem;">${escHtml(e.message)}</div>`;
  }
}

async function deleteCrop(cropId, btn) {
  btn.disabled = true;
  try {
    const r = await fetch(`${MEDIA_API}/api/faces/crop/${cropId}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    btn.closest('[data-crop-id]')?.remove();
  } catch (e) {
    btn.disabled = false;
    alert(e.message);
  }
}

function showCropFrame(cropId, filePath, frameSec, defaultName, facesPanel) {
  const existing = document.getElementById('face-frame-lightbox');
  if (existing) existing.remove();
  showFaceFrame(cropId, { filePath, frameSec, defaultName, facesPanel, context: 'known' });
}

async function renamePerson(oldName, newName, btn, msgEl) {
  if (!newName) { msgEl.style.color = '#c0392b'; msgEl.textContent = 'Enter a name'; return; }
  if (newName === oldName) { btn.closest('div[style*="display:flex"]').style.display = 'none'; return; }
  btn.disabled = true;
  msgEl.style.color = '#888'; msgEl.textContent = 'Saving…';
  try {
    const r = await fetch(`${MEDIA_API}/api/faces/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_name: oldName, new_name: newName })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    loadFacePeople();  // reload — row will be rebuilt with new name
  } catch (e) {
    btn.disabled = false;
    msgEl.style.color = '#c0392b'; msgEl.textContent = e.message;
  }
}

function _updateClusterDropdowns() {
  const opts = '<option value="">Same as…</option>' +
    _knownPeopleNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
  document.querySelectorAll('.cluster-same-as').forEach(sel => {
    const prev = sel.value;
    sel.innerHTML = opts;
    sel.value = prev;
  });
}

async function forgetPerson(name, btn) {
  const confirmed = await new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;padding:24px 28px;max-width:380px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
        <h3 style="margin:0 0 12px;font-size:1.05rem;">Forget "${escHtml(name)}"?</h3>
        <p style="margin:0 0 20px;font-size:0.88rem;color:#c0392b;font-weight:600;">⚠ All faces and file assignments for "${escHtml(name)}" will be permanently deleted. This cannot be undone.</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="_forget-cancel" class="btn btn-secondary btn-sm">Cancel</button>
          <button id="_forget-confirm" class="btn btn-sm" style="background:#c0392b;color:#fff;border-color:#c0392b;">Forget</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#_forget-cancel').onclick  = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('#_forget-confirm').onclick = () => { overlay.remove(); resolve(true); };
  });
  if (!confirmed) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await fetch(`${MEDIA_API}/api/faces/people/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    loadFacePeople();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Forget';
    alert('Error: ' + e.message);
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return String(s).replace(/'/g,'&#39;').replace(/"/g,'&quot;');
}


// ── Edit Metadata Modal ───────────────────────────────────────────
let _editModalPath = null;

async function openEditModal(fullPath, name) {
  _editModalPath = fullPath;
  document.getElementById('edit-modal-title').textContent = name;
  document.getElementById('edit-modal-status').textContent = '';
  document.getElementById('edit-modal-msg').textContent = '';
  document.getElementById('edit-event').value    = '';
  document.getElementById('edit-year').value     = '';
  document.getElementById('edit-location').value = '';
  document.getElementById('edit-person').value   = '';

  const overlay = document.getElementById('edit-modal-overlay');
  overlay.style.display = 'flex';

  // fetch current values
  try {
    const r = await fetch(`${MEDIA_API}/api/media/library/${encodeURIComponent(fullPath)}`);
    if (r.ok) {
      const d = await r.json();
      document.getElementById('edit-event').value    = d.event    || '';
      document.getElementById('edit-year').value     = d.year     || '';
      document.getElementById('edit-location').value = d.location || '';
      const persons = (d.person || []).filter(p => p !== 'not_recognized');
      document.getElementById('edit-person').value   = persons.join(', ');
      const status = d.status ? `status: ${d.status}` : '';
      const added  = d.added_at ? ' · added ' + new Date(d.added_at).toLocaleDateString('he-IL') : '';
      document.getElementById('edit-modal-status').textContent = status + added;
    } else {
      document.getElementById('edit-modal-status').textContent = 'Not yet in library';
    }
  } catch (_) {
    document.getElementById('edit-modal-status').textContent = 'Could not load current data';
  }
}

function closeEditModal() {
  document.getElementById('edit-modal-overlay').style.display = 'none';
  _editModalPath = null;
}

async function saveMetadata() {
  if (!_editModalPath) return;
  const msg = document.getElementById('edit-modal-msg');
  msg.style.color = '#888'; msg.textContent = 'Saving…';

  const event    = document.getElementById('edit-event').value.trim()    || null;
  const yearRaw  = document.getElementById('edit-year').value.trim();
  const year     = yearRaw ? parseInt(yearRaw, 10) : null;
  const location = document.getElementById('edit-location').value.trim() || null;
  const personRaw= document.getElementById('edit-person').value.trim();
  const person   = personRaw ? personRaw.split(',').map(s => s.trim()).filter(Boolean) : null;

  try {
    const r = await fetch(`${INGEST_API}/api/media/library?path=${encodeURIComponent(_editModalPath)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, year, location, person })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    msg.style.color = '#27ae60'; msg.textContent = '✓ Saved';
    setTimeout(closeEditModal, 1000);
  } catch (e) {
    msg.style.color = '#c0392b'; msg.textContent = e.message;
  }
}

async function deleteLibraryItem() {
  if (!_editModalPath) return;
  const name = document.getElementById('edit-modal-title').textContent;
  if (!confirm(`Delete "${name}"?\n\nThis will remove it from the library AND delete the file from the NAS.`)) return;

  const msg = document.getElementById('edit-modal-msg');
  msg.style.color = '#888'; msg.textContent = 'Deleting…';
  try {
    const r = await fetch(`${INGEST_API}/api/media/library?path=${encodeURIComponent(_editModalPath)}`, {
      method: 'DELETE'
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    msg.style.color = '#27ae60'; msg.textContent = '✓ Removed from library';
    setTimeout(() => {
      document.querySelector(`[data-file-path="${CSS.escape(_editModalPath)}"]`)?.remove();
      closeEditModal();
    }, 800);
  } catch (e) {
    msg.style.color = '#c0392b'; msg.textContent = e.message;
  }
}

// Close modal on overlay click
document.getElementById('edit-modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeEditModal();
});

// ── Pixoo64 ─────────────────────────────────────────────────────

let _pixooTimer = null;
let _pixooEditorItems = [];
let _pixooCrosshair = null;
let _pixooBgImage = null;
let _pixooBgBase64 = null;

// Attach canvas click handler once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const c = document.getElementById('pixoo-canvas');
  if (c) c.addEventListener('click', pixooCanvasClick);
});

function drawPixooCanvas(items) {
  const canvas = document.getElementById('pixoo-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const s = PIXOO_SCALE;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 320, 320);
  ctx.textBaseline = 'top';
  for (const item of (items || [])) {
    ctx.fillStyle = `rgb(${item.r},${item.g},${item.b})`;
    const fontSize = (item.sz || 1) * 5 * s;
    ctx.font = `${fontSize}px monospace`;
    ctx.fillText(item.t, item.x * s, item.y * s);
  }
}

async function loadPixoo() {
  try {
    const r = await fetch('/api/pixoo/status').then(r => r.json());
    const hb = r.heartbeat || {};
    const dev = r.device || {};
    const screen = r.screen || {};

    // Status
    const hbAge = hb.ts ? (Date.now() - new Date(hb.ts).getTime()) / 1000 : Infinity;
    const online = hbAge < 120;
    document.getElementById('pixoo-status').innerHTML =
      `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:${online ? '#27ae60' : '#e74c3c'}"></span>${online ? 'Online' : 'Offline'}`;

    // Screen name
    const screenName = screen.screen || hb.decision || '—';
    document.getElementById('pixoo-screen').textContent = screenName;
    document.getElementById('pixoo-screen-label').textContent = screenName;

    // Draw canvas mirror
    if (screen.items) {
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
    setTimeout(loadPixoo, 1000);
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
  const canvas = event.target;
  const rect = canvas.getBoundingClientRect();
  const scaleX = 320 / rect.width;
  const scaleY = 320 / rect.height;
  const px = Math.floor((event.clientX - rect.left) * scaleX);
  const py = Math.floor((event.clientY - rect.top) * scaleY);
  const x64 = Math.floor(px / PIXOO_SCALE);
  const y64 = Math.floor(py / PIXOO_SCALE);
  document.getElementById('pixoo-ed-x').value = x64;
  document.getElementById('pixoo-ed-y').value = y64;
  _pixooCrosshair = { px: x64 * PIXOO_SCALE, py: y64 * PIXOO_SCALE };
  pixooRedrawEditor();
}

const PIXOO_SCALE = 5; // 320 / 64

function pixooRedrawEditor() {
  const canvas = document.getElementById('pixoo-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const s = PIXOO_SCALE;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 320, 320);
  // Draw background image if loaded
  if (_pixooBgImage) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(_pixooBgImage, 0, 0, 320, 320);
  }
  ctx.textBaseline = 'top';
  for (const item of _pixooEditorItems) {
    ctx.fillStyle = `rgb(${item.r},${item.g},${item.b})`;
    const fontSize = (item.sz || 1) * 5 * s;
    ctx.font = `${fontSize}px monospace`;
    ctx.fillText(item.t, item.x * s, item.y * s);
  }
  // Draw crosshair
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
  const sz = parseInt(document.getElementById('pixoo-ed-size').value) || 1;
  _pixooEditorItems.push({ t: text, x, y, r, g, b, sz });
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
  _pixooCrosshair = null;
  _pixooBgImage = null;
  _pixooBgBase64 = null;
  document.getElementById('pixoo-image-upload').value = '';
  document.getElementById('pixoo-image-info').textContent = '';
  pixooRedrawEditor();
  pixooRenderItemsList();
}

async function pixooPushCanvas() {
  if (_pixooEditorItems.length === 0 && !_pixooBgBase64) return;
  try {
    await fetch('/api/pixoo/push-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: _pixooEditorItems, image: _pixooBgBase64 }),
    });
  } catch (e) { console.error('Pixoo push error:', e); }
}

async function pixooSavePreset() {
  const name = document.getElementById('pixoo-preset-name').value.trim();
  if (!name) return alert('Enter a preset name');
  if (_pixooEditorItems.length === 0 && !_pixooBgBase64) return alert('Add content first');
  try {
    const type = _pixooBgBase64 ? 'image' : 'text';
    await fetch('/api/pixoo/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, content: _pixooEditorItems, image_data: _pixooBgBase64 }),
    });
    document.getElementById('pixoo-preset-name').value = '';
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
      const items = typeof p.content === 'string' ? JSON.parse(p.content) : (p.content || []);
      const summary = items.map(i => i.t).join(', ');
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
    const items = typeof preset.content === 'string' ? JSON.parse(preset.content) : (preset.content || []);
    _pixooEditorItems = items;
    _pixooCrosshair = null;
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
  try {
    await fetch(`/api/pixoo/presets/${id}/push`, { method: 'POST' });
  } catch (e) { console.error('Pixoo push preset error:', e); }
}
