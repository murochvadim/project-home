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
  // start/stop alexa polling
  clearInterval(window._alexaPollTimer);
  if (name === 'alexa') {
    window._alexaPollTimer = setInterval(loadAlexa, 5000);
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

// ── Multi-select state for add-to-playlist (Phase 3) ──────────────
// _selectMode: when true, file cells are click-to-select instead of
//              click-to-play. Folder navigation still works regardless.
// _selectedPaths: Set of full '/mnt/media/...' paths currently checked.
// _selectedMeta:  Map<path, {title, type}> — kept alongside paths so
//              we can POST item objects without re-fetching browse info.
let _selectMode = false;
const _selectedPaths = new Set();
const _selectedMeta  = new Map();

function toggleSelectMode() {
  _selectMode = !_selectMode;
  if (!_selectMode) {
    _selectedPaths.clear();
    _selectedMeta.clear();
  }
  const bar = document.getElementById('media-select-bar');
  const btn = document.getElementById('media-select-btn');
  if (bar) bar.style.display = _selectMode ? 'flex' : 'none';
  if (btn) {
    btn.textContent      = _selectMode ? '✕ Exit Select' : '☑ Select';
    btn.style.background = _selectMode ? '#3a5a8a' : '';
    btn.style.color      = _selectMode ? '#fff' : '';
  }
  if (_selectMode) {
    refreshPlaylistDropdown();
  }
  selectionUpdated();
  // Re-render the grid to show / hide selection visuals
  loadMediaBrowser();
}

function clearSelection() {
  _selectedPaths.clear();
  _selectedMeta.clear();
  selectionUpdated();
  loadMediaBrowser();
}

function selectionUpdated() {
  const countEl = document.getElementById('media-select-count');
  const addBtn  = document.getElementById('media-add-btn');
  const target  = document.getElementById('media-add-target');
  const n = _selectedPaths.size;
  if (countEl) countEl.textContent = n + ' selected';
  if (addBtn) addBtn.disabled = (n === 0 || !target || !target.value);
}

async function refreshPlaylistDropdown() {
  const sel = document.getElementById('media-add-target');
  if (!sel) return;
  try {
    const r = await fetch(`${MEDIA_API}/api/playlists`);
    const data = await r.json();
    sel.innerHTML = '<option value="">— Add to playlist —</option>';
    for (const p of data) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.item_count})`;
      sel.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '+ New playlist…';
    sel.appendChild(newOpt);
    sel.onchange = selectionUpdated;
  } catch (_) { /* leave existing options */ }
}

async function addSelectedToPlaylist() {
  const target = document.getElementById('media-add-target');
  if (!target || !target.value || _selectedPaths.size === 0) return;
  const items = Array.from(_selectedPaths).map(p => {
    const meta = _selectedMeta.get(p) || {};
    return { path: p, title: meta.title || p.split('/').pop(), type: meta.type || 'file' };
  });
  try {
    let playlistId;
    if (target.value === '__new__') {
      const name = prompt('New playlist name:');
      if (!name || !name.trim()) return;
      const cr = await fetch(`${MEDIA_API}/api/playlists`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: name.trim(), items }),
      });
      const crd = await cr.json();
      if (!cr.ok || crd.error) {
        alert('Create failed: ' + (crd.error || `HTTP ${cr.status}`));
        return;
      }
      playlistId = crd.id;
    } else {
      playlistId = parseInt(target.value, 10);
      // Append: GET existing → merge unique paths → PATCH
      const gr   = await fetch(`${MEDIA_API}/api/playlists`);
      const all  = await gr.json();
      const pl   = all.find(p => p.id === playlistId);
      const existing = (pl && Array.isArray(pl.items)) ? pl.items : [];
      const existingPaths = new Set(existing.map(it => it.path));
      const merged = existing.concat(items.filter(it => !existingPaths.has(it.path)));
      const pr = await fetch(`${MEDIA_API}/api/playlists/${playlistId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ items: merged }),
      });
      const prd = await pr.json();
      if (!pr.ok || prd.error) {
        alert('Add failed: ' + (prd.error || `HTTP ${pr.status}`));
        return;
      }
    }
    // Success — clear selection, refresh playlists, exit select mode.
    _selectedPaths.clear();
    _selectedMeta.clear();
    selectionUpdated();
    await refreshPlaylistDropdown();
    loadPlaylists();
    toggleSelectMode();   // exit select mode
  } catch (e) {
    alert('Add failed: ' + (e.message || e));
  }
}

// ── Unassigned scan ────────────────────────────────────────────────
// Walk /mnt/media/Music server-side, diff against the union of paths
// already in any playlist, then present a navigable folder tree of
// the remainder. User drills folder-by-folder, ticking files at each
// level. Selections accumulate across the whole navigation so the
// final Add posts everything that was checked anywhere.
const _unassigned = {
  files:   [],            // flat list of every orphan with {name, path, folder, ext}
  checked: new Set(),     // accumulated selection (full paths)
  rootPath: 'Music',      // navigation root — relative to /mnt/media
  curPath:  'Music',      // current folder being shown
};

// ── MiniDLNA Rescan button (since 2026-05-27) ─────────────────────────
// Recovery path for "Not indexed by MiniDLNA" errors. Stops the daemon,
// wipes /var/cache/minidlna/files.db, restarts → forces a full rescan.
// Typical runtime: ~30 sec for a 1500-file library.

async function rescanMiniDLNA() {
  const btn = document.getElementById('media-rescan-btn');
  const original = btn ? btn.textContent : '🔄 Rescan';
  if (!confirm('Full MiniDLNA library rebuild?\n\nThis stops the daemon, wipes the index, restarts. Takes ~30 sec. Use when files don\'t appear in TV media library or you got a "Not indexed" error.')) return;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Rescanning…'; }
  try {
    const r = await fetch(MEDIA_API + '/api/media/minidlna/rescan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      alert('Rescan failed: ' + (data.error || `HTTP ${r.status}`));
      return;
    }
    const c = data.counts || {};
    const note = data.note || '';
    alert(
      `✓ MiniDLNA rescan complete in ${data.elapsed_sec}s\n\n` +
      `Indexed: ${c.total ?? '?'} total\n` +
      `  Videos:  ${c.videos ?? 0}\n` +
      `  Music:   ${c.music ?? 0}\n` +
      `  Photos:  ${c.photos ?? 0}\n\n` +
      (note ? note : '')
    );
  } catch (e) {
    alert('Rescan request failed: ' + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

// ── yt-dlp Download from YouTube card (Phase 1, since 2026-05-27) ────────
// Backend: 3 endpoints on player_service.py — probe (metadata only),
// start (spawn yt-dlp), status (poll job state). See youtube_playlist_integration.md.

const YT_API = MEDIA_API + '/api/media/yt-dlp';
let _ytPollTimer = null;
let _ytCurrentJob = null;
let _ytDetectInflight = false;

function ytSetMeta(text, color) {
  const el = document.getElementById('yt-meta');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = color || '#888';
}

async function ytUrlChanged() {
  // Lightweight side-effect: clear stale meta when user edits the URL field.
  ytSetMeta('', '#888');
}

async function ytDetect() {
  const url = document.getElementById('yt-url').value.trim();
  if (!url) { ytSetMeta('✗ paste a URL first', '#c0392b'); return; }
  if (_ytDetectInflight) return;
  _ytDetectInflight = true;
  const btn = document.getElementById('yt-detect-btn');
  if (btn) btn.disabled = true;
  ytSetMeta('🔄 probing…', '#888');
  try {
    const r = await fetch(YT_API + '/probe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      ytSetMeta('✗ ' + (data.error || `HTTP ${r.status}`), '#c0392b');
      return;
    }
    // Auto-fill the folder field with the suggested name.
    const folderEl = document.getElementById('yt-folder');
    if (folderEl && !folderEl.value.trim()) folderEl.value = data.suggested_folder;
    const noun = data.type === 'playlist'
      ? `playlist · ${data.track_count} tracks`
      : 'single video';
    ytSetMeta(`✓ ${noun} · ${data.title.slice(0, 60)}${data.title.length > 60 ? '…' : ''}`, '#27ae60');
  } catch (e) {
    ytSetMeta('✗ ' + (e.message || 'fetch error'), '#c0392b');
  } finally {
    _ytDetectInflight = false;
    if (btn) btn.disabled = false;
  }
}

async function ytStartDownload() {
  const url        = document.getElementById('yt-url').value.trim();
  const folder     = document.getElementById('yt-folder').value.trim();
  const create     = document.getElementById('yt-create-playlist').checked;
  const auto_split = document.getElementById('yt-auto-split').checked;
  if (!url) { ytSetMeta('✗ paste a URL first', '#c0392b'); return; }
  if (!folder) { ytSetMeta('✗ enter a folder name (or click Detect)', '#c0392b'); return; }
  if (_ytCurrentJob) {
    if (!confirm('A download is already in progress. Start a new one anyway?')) return;
    if (_ytPollTimer) { clearInterval(_ytPollTimer); _ytPollTimer = null; }
    _ytCurrentJob = null;
  }
  const btn = document.getElementById('yt-download-btn');
  if (btn) btn.disabled = true;
  ytSetMeta('🔄 starting…', '#888');
  try {
    const r = await fetch(YT_API + '/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url, folder, create_playlist: create, auto_split }),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      ytSetMeta('✗ ' + (data.error || `HTTP ${r.status}`), '#c0392b');
      if (btn) btn.disabled = false;
      return;
    }
    _ytCurrentJob = data.job_id;
    ytSetMeta(`▶ downloading to ${data.target_dir}`, '#888');
    // Reveal progress area + start polling
    const prog = document.getElementById('yt-progress');
    if (prog) prog.style.display = 'block';
    document.getElementById('yt-tracks').innerHTML =
      '<div style="color:#aaa; font-size:0.78rem;">Waiting for first track…</div>';
    document.getElementById('yt-state-pill').textContent = 'running';
    document.getElementById('yt-state-pill').style.background = '#3498db';
    document.getElementById('yt-state-pill').style.color = '#fff';
    document.getElementById('yt-summary').textContent = '';
    ytPollStatus();
    _ytPollTimer = setInterval(ytPollStatus, 1500);
  } catch (e) {
    ytSetMeta('✗ ' + (e.message || 'fetch error'), '#c0392b');
    if (btn) btn.disabled = false;
  }
}

async function ytPollStatus() {
  if (!_ytCurrentJob) return;
  try {
    const r = await fetch(YT_API + '/status/' + _ytCurrentJob);
    const data = await r.json();
    if (!r.ok || data.error) {
      // Job might have been cleared on server restart — stop polling.
      if (_ytPollTimer) { clearInterval(_ytPollTimer); _ytPollTimer = null; }
      _ytCurrentJob = null;
      ytSetMeta('✗ ' + (data.error || `HTTP ${r.status}`), '#c0392b');
      return;
    }
    // Render tracks
    const tracksEl = document.getElementById('yt-tracks');
    if (tracksEl) {
      if (!data.tracks || !data.tracks.length) {
        tracksEl.innerHTML = '<div style="color:#aaa; font-size:0.78rem;">Waiting for first track…</div>';
      } else {
        tracksEl.innerHTML = data.tracks.map(t => {
          const pillBg = t.status === 'done'        ? '#27ae60'
                       : t.status === 'downloading' ? '#3498db'
                       : '#888';
          return `<div style="display:flex; align-items:center; gap:8px; font-size:0.82rem;">
            <span style="background:${pillBg}; color:#fff; padding:1px 6px; border-radius:8px; font-size:0.72rem; font-weight:600; min-width:74px; text-align:center;">${t.status}</span>
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${(t.name || '').replace(/"/g,'&quot;')}">${t.name || '?'}</span>
          </div>`;
        }).join('');
      }
    }
    // Elapsed
    const elapsedEl = document.getElementById('yt-elapsed');
    if (elapsedEl) elapsedEl.textContent = `${data.elapsed_sec}s elapsed`;
    // Terminal state
    if (data.state === 'done' || data.state === 'error') {
      if (_ytPollTimer) { clearInterval(_ytPollTimer); _ytPollTimer = null; }
      _ytCurrentJob = null;
      const pill = document.getElementById('yt-state-pill');
      if (pill) {
        pill.textContent = data.state;
        pill.style.background = data.state === 'done' ? '#27ae60' : '#c0392b';
      }
      const sum = document.getElementById('yt-summary');
      if (sum) {
        if (data.state === 'done') {
          const n = (data.tracks || []).length;
          let txt = `✓ Downloaded ${n} track${n === 1 ? '' : 's'}`;
          if (data.split_summary && data.split_summary.length) {
            const totalParts = data.split_summary.reduce((s, r) => s + r.parts, 0);
            txt += ` (auto-split ${data.split_summary.length} compilation → ${totalParts} tracks)`;
          }
          if (data.playlist_id) txt += ` · created playlist "${data.folder}" (id=${data.playlist_id})`;
          else if (data.playlist_error) txt += ` · playlist creation failed: ${data.playlist_error}`;
          sum.textContent = txt;
          sum.style.color = '#27ae60';
          // Refresh playlists card so the new playlist appears
          if (typeof loadPlaylists === 'function') loadPlaylists();
        } else {
          sum.textContent = '✗ ' + (data.error || 'failed');
          sum.style.color = '#c0392b';
        }
      }
      const btn = document.getElementById('yt-download-btn');
      if (btn) btn.disabled = false;
      ytSetMeta('', '#888');
    }
  } catch (e) {
    console.warn('ytPollStatus error:', e);
  }
}

async function openUnassignedDialog() {
  const overlay = document.getElementById('unassigned-modal-overlay');
  const list    = document.getElementById('unassigned-list');
  const status  = document.getElementById('unassigned-status');
  const msg     = document.getElementById('unassigned-msg');
  const target  = document.getElementById('unassigned-target');
  if (!overlay) return;
  overlay.style.display = 'flex';
  msg.textContent = '';
  status.textContent = '';
  list.innerHTML = '<div style="color:#aaa; padding:14px; text-align:center;">Scanning Music folder…</div>';
  _unassigned.files = [];
  _unassigned.checked = new Set();
  _unassigned.curPath = _unassigned.rootPath;
  updateUnassignedCounts();

  // Populate playlist dropdown.
  target.innerHTML = '<option value="">— Add to playlist —</option>';
  try {
    const pr   = await fetch(`${MEDIA_API}/api/playlists`);
    const pls  = await pr.json();
    if (!pr.ok) throw new Error(pls.error || 'Playlists fetch failed');
    for (const p of pls) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.item_count})`;
      target.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '+ New playlist…';
    target.appendChild(newOpt);
    target.onchange = updateUnassignedAddState;

    // Walk Music/ (recursive flat list).
    const wr   = await fetch(`${MEDIA_API}/api/media/walk?path=${encodeURIComponent(_unassigned.rootPath)}`);
    const walk = await wr.json();
    if (!wr.ok) throw new Error(walk.error || 'Walk failed');

    // Build set of all paths in any playlist.
    const used = new Set();
    for (const p of pls) {
      if (!Array.isArray(p.items)) continue;
      for (const it of p.items) if (it && it.path) used.add(it.path);
    }

    const orphans = (walk.files || []).filter(f => !used.has(f.path));
    _unassigned.files = orphans;
    renderUnassignedList();
    status.textContent = `${orphans.length} orphans · ${walk.count} total · ${used.size} in playlists`;
  } catch (e) {
    list.innerHTML = `<div style="color:#c0392b; padding:14px;">Scan failed: ${e.message || e}</div>`;
  }
}

// Compute direct sub-folder names (and recursive orphan counts) for the
// current path from the flat walk result.
function _unassignedFolderView(curPath) {
  const prefix = curPath + '/';
  const filesHere = [];
  const subRecCount = new Map(); // first-segment name → count of orphans under it
  for (const f of _unassigned.files) {
    if (f.folder === curPath) {
      filesHere.push(f);
    } else if (f.folder.startsWith(prefix)) {
      const rest = f.folder.slice(prefix.length);
      const seg  = rest.split('/')[0];
      subRecCount.set(seg, (subRecCount.get(seg) || 0) + 1);
    }
  }
  const subFolders = Array.from(subRecCount.keys()).sort((a, b) => a.localeCompare(b));
  filesHere.sort((a, b) => a.name.localeCompare(b.name));
  return { filesHere, subFolders, subRecCount };
}

function _unassignedBreadcrumb(curPath, rootPath) {
  // Returns clickable breadcrumb segments. Root segment label uses the
  // folder name itself ("Music"). Anything deeper appends below it.
  // Navigation is wired in renderUnassignedList() via [data-uan-nav]
  // addEventListener AFTER innerHTML so paths with ' " \ & — common in
  // music libraries — don't need to survive a JS-in-onclick-attribute
  // round trip.
  const segs = curPath.split('/').filter(Boolean);
  const rootSegs = rootPath.split('/').filter(Boolean);
  const html = [];
  let acc = '';
  for (let i = 0; i < segs.length; i++) {
    acc = acc ? (acc + '/' + segs[i]) : segs[i];
    const isLast = i === segs.length - 1;
    const navigable = i >= rootSegs.length - 1;
    if (i > 0) html.push(`<span style="color:#aaa;">/</span>`);
    if (isLast || !navigable) {
      html.push(`<span style="color:#2e2e2e; font-weight:600;">${escHtmlSafe(segs[i])}</span>`);
    } else {
      html.push(`<a href="#" data-uan-nav="${escHtmlSafe(acc)}" style="color:#2980b9; text-decoration:none;">${escHtmlSafe(segs[i])}</a>`);
    }
  }
  return html.join(' ');
}

function renderUnassignedList() {
  const list = document.getElementById('unassigned-list');
  if (!list) return;
  if (_unassigned.files.length === 0) {
    list.innerHTML = '<div style="color:#27ae60; padding:14px; text-align:center;">✓ Nothing unassigned — every file in Music/ is already in a playlist.</div>';
    updateUnassignedCounts();
    return;
  }

  const { filesHere, subFolders, subRecCount } = _unassignedFolderView(_unassigned.curPath);
  const parts = [];

  // Breadcrumb + Up.
  const isRoot = _unassigned.curPath === _unassigned.rootPath;
  parts.push(`<div style="display:flex; align-items:center; gap:10px; padding:6px 4px 8px; border-bottom:1px solid #ece8e2; margin-bottom:6px; font-size:0.85rem;">`);
  if (!isRoot) {
    const parent = _unassigned.curPath.replace(/\/[^/]+$/, '') || _unassigned.rootPath;
    parts.push(`<a href="#" data-uan-nav="${escHtmlSafe(parent)}" style="color:#2980b9; text-decoration:none;">↑ Up</a>`);
  }
  parts.push(`<span>${_unassignedBreadcrumb(_unassigned.curPath, _unassigned.rootPath)}</span>`);
  parts.push(`</div>`);

  if (subFolders.length === 0 && filesHere.length === 0) {
    parts.push(`<div style="color:#27ae60; padding:14px; text-align:center;">✓ No unassigned files in this folder.</div>`);
  } else {
    // Sub-folders first.
    for (const sub of subFolders) {
      const child = _unassigned.curPath + '/' + sub;
      const cnt = subRecCount.get(sub) || 0;
      parts.push(`<a href="#" data-uan-nav="${escHtmlSafe(child)}" style="display:flex; align-items:center; gap:10px; padding:6px 8px; border-radius:3px; color:#2e2e2e; text-decoration:none;" onmouseover="this.style.background='#f0ede8'" onmouseout="this.style.background=''">
        <span style="font-size:1.05rem; flex-shrink:0;">📁</span>
        <span style="flex:1; font-weight:500;">${escHtmlSafe(sub)}</span>
        <span style="color:#888; font-size:0.78rem;">${cnt} unassigned</span>
      </a>`);
    }
    // Direct files at this level.
    if (filesHere.length > 0) {
      if (subFolders.length > 0) {
        parts.push(`<div style="font-size:0.7rem; color:#aaa; text-transform:uppercase; letter-spacing:0.04em; padding:10px 4px 4px;">Files</div>`);
      }
      for (const f of filesHere) {
        const isChecked = _unassigned.checked.has(f.path);
        parts.push(`<label style="display:flex; align-items:center; gap:8px; padding:3px 8px; cursor:pointer; border-radius:3px;" onmouseover="this.style.background='#f0ede8'" onmouseout="this.style.background=''">
          <input type="checkbox" data-path="${escHtmlSafe(f.path)}" ${isChecked ? 'checked' : ''} onchange="onUnassignedToggle(this)">
          <span style="font-family:monospace; font-size:0.82rem; color:#2e2e2e;">${escHtmlSafe(f.name)}</span>
        </label>`);
      }
    }
  }
  list.innerHTML = parts.join('');
  // Wire navigation handlers. Done here (post-innerHTML) instead of inline
  // onclick attributes so paths with ' " \ — common in music libraries —
  // don't have to round-trip through HTML-attribute-as-JS-source, which
  // would break the inline JS the moment a folder name contains an
  // apostrophe (HTML entities are decoded before the handler body parses).
  list.querySelectorAll('[data-uan-nav]').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      unassignedNavigate(el.getAttribute('data-uan-nav'));
    });
  });
  updateUnassignedCounts();
}

function unassignedNavigate(path) {
  _unassigned.curPath = path;
  renderUnassignedList();
}

function onUnassignedToggle(cb) {
  const p = cb.dataset.path;
  if (cb.checked) _unassigned.checked.add(p);
  else _unassigned.checked.delete(p);
  updateUnassignedCounts();
}

// Check/Uncheck All now applies ONLY to direct files in the current folder
// view — never the entire library, so a single click doesn't sweep up
// thousands of files across many sub-folders by accident.
function unassignedCheckAll(on) {
  const { filesHere } = _unassignedFolderView(_unassigned.curPath);
  for (const f of filesHere) {
    if (on) _unassigned.checked.add(f.path);
    else _unassigned.checked.delete(f.path);
  }
  // Update visible checkboxes in place without full re-render.
  const cbs = document.querySelectorAll('#unassigned-list input[type=checkbox]');
  cbs.forEach(cb => { cb.checked = on; });
  updateUnassignedCounts();
}

function updateUnassignedCounts() {
  const c = document.getElementById('unassigned-count');
  const t = document.getElementById('unassigned-total');
  if (c) c.textContent = _unassigned.checked.size;
  if (t) t.textContent = _unassigned.files.length;
  updateUnassignedAddState();
}

function updateUnassignedAddState() {
  const btn    = document.getElementById('unassigned-add-btn');
  const target = document.getElementById('unassigned-target');
  if (!btn || !target) return;
  btn.disabled = (_unassigned.checked.size === 0 || !target.value);
}

function closeUnassignedDialog() {
  const overlay = document.getElementById('unassigned-modal-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function addUnassignedToPlaylist() {
  const target = document.getElementById('unassigned-target');
  const msg    = document.getElementById('unassigned-msg');
  if (!target || !target.value || _unassigned.checked.size === 0) return;
  msg.textContent = '';

  // Build item list from the checked paths.
  const byPath = new Map(_unassigned.files.map(f => [f.path, f]));
  const items = Array.from(_unassigned.checked).map(p => {
    const f = byPath.get(p) || {};
    const ext = (f.ext || '').toLowerCase();
    const type = AUDIO_EXTS && AUDIO_EXTS.has(ext) ? 'audio'
               : VIDEO_EXTS && VIDEO_EXTS.has(ext) ? 'video' : 'file';
    return { path: p, title: f.name || p.split('/').pop(), type };
  });

  try {
    let playlistId;
    if (target.value === '__new__') {
      const name = prompt('New playlist name:');
      if (!name || !name.trim()) return;
      const cr = await fetch(`${MEDIA_API}/api/playlists`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: name.trim(), items }),
      });
      const crd = await cr.json();
      if (!cr.ok || crd.error) throw new Error(crd.error || `HTTP ${cr.status}`);
      playlistId = crd.id;
    } else {
      playlistId = parseInt(target.value, 10);
      const gr   = await fetch(`${MEDIA_API}/api/playlists`);
      const all  = await gr.json();
      const pl   = all.find(p => p.id === playlistId);
      const existing = (pl && Array.isArray(pl.items)) ? pl.items : [];
      const existingPaths = new Set(existing.map(it => it.path));
      const merged = existing.concat(items.filter(it => !existingPaths.has(it.path)));
      const pr = await fetch(`${MEDIA_API}/api/playlists/${playlistId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ items: merged }),
      });
      const prd = await pr.json();
      if (!pr.ok || prd.error) throw new Error(prd.error || `HTTP ${pr.status}`);
    }
    msg.style.color = '#27ae60';
    msg.textContent = `✓ Added ${items.length} items.`;
    loadPlaylists();
    setTimeout(closeUnassignedDialog, 900);
  } catch (e) {
    msg.style.color = '#c0392b';
    msg.textContent = 'Add failed: ' + (e.message || e);
  }
}

// Escapes &, <, >, " — covers both text and double-quoted-attribute contexts
// in one helper, so callers don't have to pick the right escape per call site.
function escHtmlSafe(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
    const fullPath = e.type === 'file'
      ? '/mnt/media/' + (relPath.startsWith('/') ? relPath.slice(1) : relPath)
      : '';
    const isSelected = e.type === 'file' && _selectedPaths.has(fullPath);
    const clickable  = e.type === 'dir' || (_selectMode && e.type === 'file');
    cell.style.cssText = `text-align:center;padding:10px;border-radius:6px;
      cursor:${clickable ? 'pointer' : 'default'};
      background:${isSelected ? '#dceefb' : '#faf8f5'};
      border:${isSelected ? '2px solid #3a5a8a' : '1px solid #ece8e2'};
      transition:background 0.15s, border 0.15s;`;
    cell.title = e.name;
    if (e.type === 'file') cell.dataset.filePath = fullPath;
    cell.addEventListener('mouseover', () => { if (!isSelected) cell.style.background = '#f0ede8'; });
    cell.addEventListener('mouseout',  () => { if (!isSelected) cell.style.background = '#faf8f5'; });
    if (e.type === 'dir') {
      cell.addEventListener('click', () => loadMediaBrowser(relPath));
    } else if (_selectMode) {
      // In select mode, the WHOLE cell toggles selection for files.
      cell.addEventListener('click', (ev) => {
        // Don't toggle if the click was on a button inside the cell.
        if (ev.target.closest('button')) return;
        if (_selectedPaths.has(fullPath)) {
          _selectedPaths.delete(fullPath);
          _selectedMeta.delete(fullPath);
        } else {
          _selectedPaths.add(fullPath);
          _selectedMeta.set(fullPath, {
            title: e.name,
            type:  isVideo ? 'video' : isAudio ? 'audio' : (e.type === 'file' ? 'file' : 'other'),
          });
        }
        selectionUpdated();
        // Re-render to flip the visual on the clicked cell.
        loadMediaBrowser();
      });
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
      // targetPath intentionally omitted — server auto-routes by extension
      // (Music / Videos / Photos). Sending _currentPath here forced every
      // file into whichever folder the Player browser was last viewing.
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
  loadPlaylists();
  // Queue status drives the Now Playing strip. Audio plays through the
  // soundbar via Cast (Chromecast) — auto-advance is native, no watcher.
  loadQueueStatus();
  if (!window._queuePollTimer) {
    window._queuePollTimer = setInterval(loadQueueStatus, 5000);
  }
}

// Per-playlist Shuffle/Repeat preferences are remembered locally so they
// survive page navigation. Key shape: { "<pid>": { shuffle: 0|1, repeat: 0|1 } }.
const PLAYLIST_MODES_KEY = 'media.playlistModes';

function _loadPlaylistModes() {
  try {
    return JSON.parse(localStorage.getItem(PLAYLIST_MODES_KEY) || '{}') || {};
  } catch (_) { return {}; }
}
function _savePlaylistMode(pid, mode, on) {
  const all = _loadPlaylistModes();
  const cur = all[pid] || { shuffle: 0, repeat: 0 };
  cur[mode] = on ? 1 : 0;
  all[pid] = cur;
  try { localStorage.setItem(PLAYLIST_MODES_KEY, JSON.stringify(all)); } catch (_) {}
}

// Drag-and-drop reordering for playlist cards.
let _plDragId = null;            // playlist id being dragged (string)
let _plDragInProgress = false;   // suppresses the synthetic click after drop

function wirePlaylistDragReorder(grid) {
  const cards = Array.from(grid.querySelectorAll('.playlist-card'));
  cards.forEach(card => {
    const handle = card.querySelector('[data-pl-drag-handle]');
    if (handle) {
      handle.addEventListener('mousedown', (e) => e.stopPropagation());
      handle.addEventListener('dragstart', (e) => {
        _plDragId = card.dataset.pid;
        _plDragInProgress = true;
        card.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', _plDragId); } catch (_) {}
      });
      handle.addEventListener('dragend', () => {
        card.style.opacity = '';
        _plDragId = null;
        // Clear right after the event loop so the click handler still sees true.
        setTimeout(() => { _plDragInProgress = false; }, 50);
      });
    }
    card.addEventListener('dragover', (e) => {
      if (!_plDragId) return;
      e.preventDefault();
      if (card.dataset.pid === _plDragId) return;
      card.style.outline = '3px solid #6c4f9f';
      card.style.outlineOffset = '-3px';
    });
    card.addEventListener('dragleave', () => {
      card.style.outline = '';
      card.style.outlineOffset = '';
    });
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.style.outline = '';
      card.style.outlineOffset = '';
      if (!_plDragId || card.dataset.pid === _plDragId) return;
      const targetPid = card.dataset.pid;
      // Compute the new order by walking the current DOM order and
      // moving _plDragId to immediately before targetPid.
      const current = Array.from(grid.querySelectorAll('.playlist-card'))
                           .map(c => c.dataset.pid);
      const moved   = _plDragId;
      const fromIdx = current.indexOf(moved);
      if (fromIdx >= 0) current.splice(fromIdx, 1);
      const toIdx = current.indexOf(targetPid);
      current.splice(toIdx, 0, moved);
      const numericOrder = current.map(s => parseInt(s, 10)).filter(n => !Number.isNaN(n));
      try {
        const r = await fetch(`${MEDIA_API}/api/playlists/reorder`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ order: numericOrder }),
        });
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
        loadPlaylists();   // re-render in the new server-confirmed order
      } catch (err) {
        alert('Reorder failed: ' + (err.message || err));
      }
    });
  });
}

function applyStoredPlaylistModes() {
  const all = _loadPlaylistModes();
  document.querySelectorAll('.playlist-card').forEach(card => {
    const pid = parseInt(card.dataset.pid, 10);
    const pref = all[pid] || { shuffle: 0, repeat: 0 };
    for (const mode of ['shuffle', 'repeat']) {
      const v = pref[mode] ? '1' : '0';
      card.setAttribute('data-' + mode, v);
      const label = card.querySelector(`[data-state-for="${mode}"]`);
      if (label) {
        label.textContent = v === '1' ? 'ON' : 'OFF';
        label.style.color = v === '1' ? '#27ae60' : '#999';
      }
    }
  });
}

function togglePlaylistMode(btn, mode) {
  const card = btn.closest('.playlist-card');
  if (!card) return;
  const attr = 'data-' + mode;
  const on = card.getAttribute(attr) === '1';
  const next = on ? '0' : '1';
  card.setAttribute(attr, next);
  const label = card.querySelector(`[data-state-for="${mode}"]`);
  if (label) {
    if (next === '1') {
      label.textContent = 'ON';
      label.style.color = '#27ae60';
    } else {
      label.textContent = 'OFF';
      label.style.color = '#999';
    }
  }
  const pid = parseInt(card.dataset.pid, 10);
  const isOn = (next === '1');
  // Persist the new value so it survives page navigation.
  _savePlaylistMode(pid, mode, isOn);
  // Also patch the currently-playing queue if it's THIS playlist, so the
  // toggle takes effect immediately (not only on the next Play click).
  fetch(`${MEDIA_API}/api/queue/mode`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ playlist_id: pid, [mode]: isOn }),
  }).catch(() => { /* silent — no active queue means no patch needed */ });
}

function playPlaylistFromCard(btn) {
  const card = btn.closest('.playlist-card');
  if (!card) return;
  const pid = parseInt(card.dataset.pid, 10);
  const shuffle = card.getAttribute('data-shuffle') === '1';
  const repeat = card.getAttribute('data-repeat') === '1';
  playPlaylist(pid, shuffle, repeat);
}

async function playPlaylist(id, shuffle, repeat) {
  try {
    const r = await fetch(`${MEDIA_API}/api/playlists/${id}/play`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ shuffle: !!shuffle, repeat: !!repeat }),
    });
    const data = await r.json();
    if (!r.ok || data.error) alert('Play failed: ' + (data.error || `HTTP ${r.status}`));
    loadQueueStatus();
  } catch (e) { alert('Play failed: ' + (e.message || e)); }
}

async function loadQueueStatus() {
  try {
    const r = await fetch(`${MEDIA_API}/api/queue/status`);
    const q = await r.json();
    renderQueueStrip(q);
    paintPlayingPlaylistCard((q && q.active) ? q.playlist_id : null);
  } catch (_) { /* ignore */ }
}

// Highlight the playlist card matching the currently-playing playlist_id.
// Called from the 5-s queue poll and re-applied after loadPlaylists() so
// the marker survives card re-renders.
function paintPlayingPlaylistCard(playingId) {
  const cards = document.querySelectorAll('.playlist-card');
  cards.forEach(card => {
    const pid = parseInt(card.dataset.pid, 10);
    if (playingId != null && pid === playingId) {
      card.style.background = '#fff8b3';                  // yellow highlight
      card.style.borderColor = '#e6c200';
      card.style.boxShadow = '0 0 0 2px rgba(230,194,0,0.45)';
    } else {
      card.style.background = '#faf8f5';                  // default card bg
      card.style.borderColor = '';
      card.style.boxShadow = '';
    }
  });
}

function renderQueueStrip(q) {
  let strip = document.getElementById('now-playing-strip');
  if (!q || !q.active) {
    if (strip) strip.remove();
    return;
  }
  if (!strip) {
    strip = document.createElement('div');
    strip.id = 'now-playing-strip';
    strip.className = 'card';
    strip.style.cssText = 'background:linear-gradient(135deg, #2c3e50, #34495e); color:#fff; padding:16px 20px; margin-bottom:12px; border:none;';
    const browser = document.querySelector('#tab-player .card');
    if (browser) browser.parentNode.insertBefore(strip, browser);
  }
  const cur = q.current_item || {};
  const title = cur.title || (cur.path || '').split('/').pop() || '?';
  const btnStyle = 'color:#fff; border:1px solid rgba(255,255,255,0.3); padding:10px 18px; font-size:0.95rem; font-weight:600; display:inline-flex; align-items:center; gap:6px; border-radius:6px; cursor:pointer;';
  // Don't clobber the slider while the user is dragging — the 5-s poll
  // would otherwise snap it back to whatever the server last reported.
  const vol = q.cast_volume == null ? 0.3 : q.cast_volume;
  const volPct = Math.round(vol * 100);
  const dragging = strip && strip.dataset.volDragging === '1';
  // Stash position + duration on the strip so the interpolation timer can
  // read them and advance the bar between server polls. Only adopt the
  // server's position if it's MEANINGFULLY ahead of where the client is
  // already showing — otherwise stale 0 readings would reset the bar.
  const srvPos = q.cast_position == null ? 0 : q.cast_position;
  const dur = q.cast_duration == null ? 0 : q.cast_duration;
  const prevPos = parseFloat(strip.dataset.castPos || '0');
  const prevStamp = parseInt(strip.dataset.castStamp || '0', 10);
  const prevState = strip.dataset.castState || '';
  const prevDur = parseFloat(strip.dataset.castDur || '0');
  const clientInterpPos = prevState === 'PLAYING' && prevStamp
    ? Math.min(prevDur || 0, prevPos + (Date.now() - prevStamp) / 1000)
    : prevPos;
  const trackChanged = (q.current_item && q.current_item.path !== strip.dataset.castPath);
  let basePos = srvPos;
  if (!trackChanged && srvPos < clientInterpPos - 1 && srvPos > clientInterpPos - 30) {
    // Server reading is a few seconds behind client — stale GET_STATUS
    // cache, keep the client's interpolated value so the bar doesn't snap
    // backwards. A drop > 30 s is treated as a real restart (e.g. repeat
    // looped back to the same track) and the server value is adopted.
    basePos = clientInterpPos;
  }
  strip.dataset.castPos = String(basePos);
  strip.dataset.castDur = String(dur);
  strip.dataset.castState = q.cast_state || '';
  strip.dataset.castStamp = String(Date.now());
  strip.dataset.castPath = (q.current_item && q.current_item.path) || '';
  // Use basePos (not srvPos) for the initial render so the bar doesn't flash.
  const pos = basePos;
  strip.innerHTML = `
    <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
      <span style="font-size:1.6rem;">🔊</span>
      <div style="flex:1; min-width:0;">
        <div style="font-size:0.82rem; opacity:0.75; margin-bottom:4px;">${escapeHtml(q.playlist_name || 'Playlist')} · ${q.current_idx + 1}/${q.total} · via Soundbar</div>
        <div style="font-weight:700; font-size:1.1rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(cur.path || '')}">${escapeHtml(title)}</div>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <button onclick="tvCommand('turn_on')" title="TV on" style="${btnStyle} background:rgba(255,255,255,0.15);"><span style="font-size:1.1rem;">📺</span> TV On</button>
        <button onclick="tvCommand('turn_off')" title="TV off" style="${btnStyle} background:rgba(255,255,255,0.15);"><span style="font-size:1.1rem;">📺</span> TV Off</button>
        <span style="width:1px; height:30px; background:rgba(255,255,255,0.25); margin:0 6px;"></span>
        <button onclick="queuePrev()" title="Previous track" style="${btnStyle} background:rgba(255,255,255,0.15);"><span style="font-size:1.2rem;">⏮</span> Prev</button>
        <button onclick="queueNext()" title="Next track" style="${btnStyle} background:rgba(255,255,255,0.15);"><span style="font-size:1.2rem;">⏭</span> Next</button>
        <button onclick="queuePauseToggle()" title="${q.cast_state === 'PAUSED' ? 'Resume' : 'Pause'}" style="${btnStyle} background:rgba(255,255,255,0.15);"><span style="font-size:1.2rem;">${q.cast_state === 'PAUSED' ? '▶' : '⏸'}</span> ${q.cast_state === 'PAUSED' ? 'Resume' : 'Pause'}</button>
        <button onclick="queueStop()" title="Stop playlist" style="${btnStyle} background:#c0392b; border-color:#c0392b;"><span style="font-size:1.2rem;">⏹</span> Stop</button>
      </div>
    </div>
    <div style="display:flex; align-items:center; gap:10px; margin-top:14px;">
      <span id="cast-pos-label" style="font-size:0.78rem; opacity:0.85; min-width:42px; font-variant-numeric:tabular-nums;">${_fmtMMSS(pos)}</span>
      <div style="flex:1; height:6px; background:rgba(255,255,255,0.18); border-radius:3px; overflow:hidden;">
        <div id="cast-pos-fill" style="height:100%; background:#27ae60; width:${dur > 0 ? Math.min(100, pos/dur*100) : 0}%; transition:width 0.4s linear;"></div>
      </div>
      <span id="cast-dur-label" style="font-size:0.78rem; opacity:0.85; min-width:42px; text-align:right; font-variant-numeric:tabular-nums;">${_fmtMMSS(dur)}</span>
    </div>
    <div style="display:flex; align-items:center; gap:12px; margin-top:12px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.12);">
      <span style="font-size:1.1rem; flex-shrink:0;" title="Volume">🔉</span>
      <input id="cast-vol-slider" type="range" min="0" max="100" step="1" value="${volPct}" style="flex:1; cursor:pointer; height:6px;" title="Cast volume on soundbar">
      <span id="cast-vol-label" style="font-size:0.9rem; opacity:0.9; min-width:44px; text-align:right; font-weight:600;">${volPct}%</span>
      <button onclick="saveCastVolumePreset()" title="Save current volume as preset (used at start of next playlist)" style="background:rgba(255,255,255,0.15); color:#fff; border:1px solid rgba(255,255,255,0.3); padding:6px 12px; font-size:0.82rem; border-radius:6px; cursor:pointer; flex-shrink:0;">💾 Save preset</button>
    </div>
  `;
  // 1-s interpolation tick so the progress bar advances smoothly between
  // 5-s server polls. Re-uses position+duration we just stashed on the strip.
  if (!window._castProgTimer) {
    window._castProgTimer = setInterval(_tickCastProgress, 1000);
  }
  // Wire the slider — POST cast volume on every change. Mark dragging so
  // the 5-s status poll doesn't snap the slider back mid-drag.
  const sl = document.getElementById('cast-vol-slider');
  const lbl = document.getElementById('cast-vol-label');
  if (sl) {
    sl.addEventListener('input', () => {
      strip.dataset.volDragging = '1';
      lbl.textContent = sl.value + '%';
    });
    sl.addEventListener('change', async () => {
      const level = parseInt(sl.value, 10) / 100;
      try {
        await fetch(`${MEDIA_API}/api/cast/volume`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ level }),
        });
      } catch (_) {}
      // Release the drag-lock after a moment so the next poll can update.
      setTimeout(() => { delete strip.dataset.volDragging; }, 1500);
    });
  }
  if (dragging && sl) {
    // Restore the dragging flag we just consumed in innerHTML replacement.
    strip.dataset.volDragging = '1';
  }
}

function _fmtMMSS(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function _tickCastProgress() {
  const strip = document.getElementById('now-playing-strip');
  if (!strip) {
    if (window._castProgTimer) { clearInterval(window._castProgTimer); window._castProgTimer = null; }
    return;
  }
  const dur = parseFloat(strip.dataset.castDur || '0');
  if (!dur) return;
  const state = strip.dataset.castState || '';
  // Only advance when Cast says PLAYING — otherwise hold the last position.
  if (state !== 'PLAYING') return;
  const basePos = parseFloat(strip.dataset.castPos || '0');
  const stampMs = parseInt(strip.dataset.castStamp || '0', 10);
  const elapsed = (Date.now() - stampMs) / 1000;
  const pos = Math.min(dur, basePos + elapsed);
  const fill = document.getElementById('cast-pos-fill');
  const lbl = document.getElementById('cast-pos-label');
  if (fill) fill.style.width = (pos / dur * 100) + '%';
  if (lbl) lbl.textContent = _fmtMMSS(pos);
}

async function saveCastVolumePreset() {
  const sl = document.getElementById('cast-vol-slider');
  if (!sl) return;
  const level = parseInt(sl.value, 10) / 100;
  try {
    const r = await fetch(`${MEDIA_API}/api/cast/volume`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ level, save: true }),
    });
    const d = await r.json();
    if (r.ok && !d.error) {
      // Tiny inline confirmation — temporarily flash the button.
      const btn = document.querySelector('#now-playing-strip button[onclick^="saveCastVolumePreset"]');
      if (btn) { const t = btn.textContent; btn.textContent = '✓'; setTimeout(() => { btn.textContent = t; }, 1200); }
    } else {
      alert('Save preset failed: ' + (d.error || `HTTP ${r.status}`));
    }
  } catch (e) { alert('Save preset failed: ' + (e.message || e)); }
}

async function queueNext() {
  try {
    const r = await fetch(`${MEDIA_API}/api/queue/next`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok || d.error) alert('Next failed: ' + (d.error || `HTTP ${r.status}`));
    loadQueueStatus();
  } catch (e) { alert('Next failed: ' + (e.message || e)); }
}

async function queuePrev() {
  try {
    const r = await fetch(`${MEDIA_API}/api/queue/prev`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok || d.error) alert('Prev failed: ' + (d.error || `HTTP ${r.status}`));
    loadQueueStatus();
  } catch (e) { alert('Prev failed: ' + (e.message || e)); }
}

async function queueStop() {
  try {
    await fetch(`${MEDIA_API}/api/queue/stop`, { method: 'POST' });
    loadQueueStatus();
  } catch (e) { alert('Stop failed: ' + (e.message || e)); }
}

async function queuePauseToggle() {
  try {
    const r = await fetch(`${MEDIA_API}/api/queue/pause`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok || d.error) alert('Pause failed: ' + (d.error || `HTTP ${r.status}`));
    loadQueueStatus();
  } catch (e) { alert('Pause failed: ' + (e.message || e)); }
}

// TV power — proxies through player_service to tv_control.py (WoL magic
// packet for turn_on, KEY_POWER over WebSocket for turn_off).
async function tvCommand(cmd) {
  try {
    const r = await fetch(`${MEDIA_API}/api/media/command`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ entity: 'tv', command: cmd }),
    });
    const d = await r.json();
    if (!r.ok || d.error) alert('TV ' + cmd + ' failed: ' + (d.error || `HTTP ${r.status}`));
  } catch (e) { alert('TV ' + cmd + ' failed: ' + (e.message || e)); }
}


// ── Playlists CRUD (Phase 1) ──────────────────────────────────────
// All calls go to player_service.py on LXC 100:8766 directly. Phase 1 covers
// list/create/delete; Phase 2 will add play/queue endpoints; Phase 3 will
// hook into the QNAP Media browser for add-to-playlist from selected items.
async function loadPlaylists() {
  const grid = document.getElementById('playlists-grid');
  if (!grid) return;
  try {
    const r = await fetch(`${MEDIA_API}/api/playlists`);
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) {
      grid.innerHTML = '<div style="color:#aaa; font-size:0.85rem; padding:14px;">No playlists yet — click "+ New Playlist" to create one.</div>';
      return;
    }
    const btnStyle = 'color:#fff; border:none; padding:10px 8px; font-size:0.85rem; font-weight:600; display:inline-flex; align-items:center; justify-content:center; gap:4px; border-radius:6px; cursor:pointer; white-space:nowrap;';
    const statusLabel = 'font-size:0.7rem; font-weight:600; text-align:center; padding-bottom:2px; color:#999;';
    grid.innerHTML = data.map(p => {
      const empty = p.item_count === 0;
      const playColor = empty ? '#aaa' : '#27ae60';
      const shufColor = empty ? '#aaa' : '#1565c0';
      const repColor  = empty ? '#aaa' : '#8e44ad';
      return `
      <div class="card playlist-card" data-pid="${p.id}" data-shuffle="0" data-repeat="0" style="margin:0; padding:14px; background:#faf8f5; cursor:pointer; position:relative;" title="Click to view items">
        <span data-pl-drag-handle="1" draggable="true" title="Drag to reorder" style="position:absolute; top:6px; right:8px; cursor:grab; color:#aaa; font-size:0.95rem; user-select:none; line-height:1; padding:2px 4px;">⋮⋮</span>
        <div style="font-weight:700; font-size:1.05rem; margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:18px;">${escapeHtml(p.name)}</div>
        <div style="font-size:0.82rem; color:#888; margin-bottom:10px;">${p.item_count} item${p.item_count === 1 ? '' : 's'}</div>
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px;" onclick="event.stopPropagation()">
          <div></div>
          <div data-state-for="shuffle" style="${statusLabel}">OFF</div>
          <div data-state-for="repeat" style="${statusLabel}">OFF</div>
          <button onclick="playPlaylistFromCard(this)" ${empty ? 'disabled' : ''} title="Play with current Shuffle/Repeat settings" style="${btnStyle} background:${playColor};"><span style="font-size:1.05rem;">▶</span> Play</button>
          <button data-toggle="shuffle" onclick="togglePlaylistMode(this, 'shuffle')" ${empty ? 'disabled' : ''} title="Toggle shuffle" style="${btnStyle} background:${shufColor};"><span style="font-size:1.05rem;">🔀</span> Shuffle</button>
          <button data-toggle="repeat" onclick="togglePlaylistMode(this, 'repeat')" ${empty ? 'disabled' : ''} title="Toggle repeat (loop playlist)" style="${btnStyle} background:${repColor};"><span style="font-size:1.05rem;">🔁</span> Repeat</button>
        </div>
      </div>
    `;}).join('');
    // Whole-card click also opens the detail modal (Items button shortcut).
    // Stop a click from firing right after a drag (Chrome dispatches a stray
    // synthetic click on dragend for the drop target).
    grid.querySelectorAll('.playlist-card').forEach(card => {
      card.addEventListener('click', (ev) => {
        if (_plDragInProgress) return;
        if (ev.target.closest('[data-pl-drag-handle]')) return;
        const pid = parseInt(card.dataset.pid, 10);
        if (!Number.isNaN(pid)) openPlaylistDetail(pid);
      });
    });
    // Drag-to-reorder. Handle = the ⋮⋮ chip; drop target = whole card.
    // Mirrors the rule-card pattern in main-agent.js. Server persists the
    // new order via POST /api/playlists/reorder.
    wirePlaylistDragReorder(grid);
    // Restore per-card Shuffle / Repeat preferences from localStorage so
    // the toggles survive page navigation.
    applyStoredPlaylistModes();
    // Re-paint the currently-playing highlight on top of the fresh render.
    try {
      const qr = await fetch(`${MEDIA_API}/api/queue/status`);
      const q  = await qr.json();
      paintPlayingPlaylistCard((q && q.active) ? q.playlist_id : null);
    } catch (_) { /* highlight is best-effort */ }
  } catch (e) {
    grid.innerHTML = `<div style="color:#c0392b; font-size:0.85rem; padding:14px;">Failed to load playlists: ${escapeHtml(String(e.message || e))}</div>`;
  }
}

async function createPlaylist() {
  const name = prompt('Playlist name:');
  if (!name || !name.trim()) return;
  try {
    const r = await fetch(`${MEDIA_API}/api/playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), items: [] }),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      alert('Create failed: ' + (data.error || `HTTP ${r.status}`));
      return;
    }
    loadPlaylists();
  } catch (e) {
    alert('Create failed: ' + (e.message || e));
  }
}

// ── Playlist detail modal ─────────────────────────────────────────
// Shows current items, allows rename, remove items, reorder via HTML5
// drag, and Delete Playlist (also accessible from the card's ✕ button).
// Adding new items remains in the QNAP Media browser's Select mode.
let _modalPlaylist = null;   // {id, name, items: [...]} — local working copy

async function openPlaylistDetail(id) {
  try {
    const r = await fetch(`${MEDIA_API}/api/playlists`);
    const all = await r.json();
    const pl = all.find(p => p.id === id);
    if (!pl) { alert('Playlist not found'); return; }
    _modalPlaylist = {
      id:    pl.id,
      name:  pl.name,
      items: Array.isArray(pl.items) ? pl.items.slice() : [],
    };
    document.getElementById('playlist-modal-name').value = pl.name;
    document.getElementById('playlist-modal-status').textContent = `id #${pl.id}`;
    document.getElementById('playlist-modal-msg').textContent = '';
    renderModalItems();
    document.getElementById('playlist-modal-overlay').style.display = 'flex';
  } catch (e) {
    alert('Load failed: ' + (e.message || e));
  }
}

function renderModalItems() {
  const wrap = document.getElementById('playlist-modal-items');
  const count = document.getElementById('playlist-modal-count');
  if (!wrap || !count) return;
  count.textContent = String(_modalPlaylist.items.length);
  if (_modalPlaylist.items.length === 0) {
    wrap.innerHTML = '<div style="color:#aaa; font-size:0.85rem; padding:14px; text-align:center;">No items yet — close this dialog, click ☑ Select in QNAP Media, pick files, choose this playlist from the dropdown.</div>';
    return;
  }
  wrap.innerHTML = _modalPlaylist.items.map((it, i) => `
    <div class="pl-item" draggable="true" data-idx="${i}" style="display:flex; align-items:center; gap:8px; padding:6px 8px; background:#fff; border:1px solid #ece8e2; border-radius:4px; margin-bottom:3px; cursor:grab;">
      <span style="color:#aaa; font-size:0.9rem; cursor:grab;" title="drag to reorder">⋮⋮</span>
      <span style="color:#888; font-size:0.78rem; min-width:24px;">${i + 1}.</span>
      <span style="font-size:0.86rem; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(it.path || '')}">${escapeHtml(it.title || (it.path || '').split('/').pop() || '(no title)')}</span>
      <span style="font-size:0.7rem; color:#aaa; text-transform:uppercase;">${escapeHtml(it.type || '')}</span>
      <button class="btn btn-secondary btn-sm" onclick="removeModalItem(${i})" style="background:#c0392b; color:#fff; padding:1px 7px; font-size:0.76rem;" title="Remove from playlist">✕</button>
    </div>
  `).join('');
  // HTML5 drag-and-drop reorder
  wrap.querySelectorAll('.pl-item').forEach(row => {
    row.addEventListener('dragstart', ev => {
      ev.dataTransfer.setData('text/plain', row.dataset.idx);
      row.style.opacity = '0.4';
    });
    row.addEventListener('dragend', () => { row.style.opacity = '1'; });
    row.addEventListener('dragover', ev => { ev.preventDefault(); });
    row.addEventListener('drop', ev => {
      ev.preventDefault();
      const fromIdx = parseInt(ev.dataTransfer.getData('text/plain'), 10);
      const toIdx   = parseInt(row.dataset.idx, 10);
      if (Number.isNaN(fromIdx) || Number.isNaN(toIdx) || fromIdx === toIdx) return;
      const arr = _modalPlaylist.items;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      renderModalItems();
    });
  });
}

function removeModalItem(idx) {
  if (!_modalPlaylist) return;
  _modalPlaylist.items.splice(idx, 1);
  renderModalItems();
}

async function savePlaylistDetail() {
  if (!_modalPlaylist) return;
  const newName = document.getElementById('playlist-modal-name').value.trim();
  if (!newName) { alert('Name cannot be empty'); return; }
  const msg = document.getElementById('playlist-modal-msg');
  msg.textContent = 'Saving…'; msg.style.color = '#888';
  try {
    const r = await fetch(`${MEDIA_API}/api/playlists/${_modalPlaylist.id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: newName, items: _modalPlaylist.items }),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      msg.textContent = 'Save failed: ' + (data.error || `HTTP ${r.status}`);
      msg.style.color = '#c0392b';
      return;
    }
    msg.textContent = '✓ Saved'; msg.style.color = '#27ae60';
    loadPlaylists();
    setTimeout(closePlaylistDetail, 600);
  } catch (e) {
    msg.textContent = 'Save failed: ' + (e.message || e);
    msg.style.color = '#c0392b';
  }
}

function closePlaylistDetail() {
  document.getElementById('playlist-modal-overlay').style.display = 'none';
  _modalPlaylist = null;
}

async function deletePlaylistFromModal() {
  if (!_modalPlaylist) return;
  if (!confirm(`Delete playlist "${_modalPlaylist.name}"? This cannot be undone.`)) return;
  await deletePlaylist(_modalPlaylist.id, _modalPlaylist.name);
  closePlaylistDetail();
}

async function renamePlaylist(id, currentName) {
  const newName = prompt('New playlist name:', currentName);
  if (!newName || !newName.trim() || newName === currentName) return;
  try {
    const r = await fetch(`${MEDIA_API}/api/playlists/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      alert('Rename failed: ' + (data.error || `HTTP ${r.status}`));
      return;
    }
    loadPlaylists();
  } catch (e) {
    alert('Rename failed: ' + (e.message || e));
  }
}

async function deletePlaylist(id, name) {
  if (!confirm(`Delete playlist "${name}"? This cannot be undone.`)) return;
  try {
    const r = await fetch(`${MEDIA_API}/api/playlists/${id}`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok || data.error) {
      alert('Delete failed: ' + (data.error || `HTTP ${r.status}`));
      return;
    }
    loadPlaylists();
  } catch (e) {
    alert('Delete failed: ' + (e.message || e));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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

// ─── Alexa Devices tab ───────────────────────────────────────────────────────
// Backed by /api/alexa/* on dashboard server. Each call HA via callHA().

const ALEXA_TPL_KEY = 'media-agents.alexa_announcements';

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Per user 2026-05-08:
//   green dot = online (any reachable state)
//   grey dot  = unavailable / off / unknown
// The dot doesn't change colour when playing — that's the NAME's job
// (handled in _alexaUpdateCard, which paints the name red while the
// device is `state==='playing'` OR while a dashboard-initiated TTS is
// still in flight).
function _alexaStatusDot(haState) {
  if (!haState) return '<span style="color:#aaa;font-size:1.1rem;">●</span>';
  const s = haState.state;
  const offline = (s === 'unavailable' || s === 'off');
  const c = offline ? '#999' : '#2ecc71';
  return `<span style="color:${c};font-size:1.1rem;" title="${_esc(s)}">●</span>`;
}

// Track last "user touched this control" timestamp per (entity, field).
// While < 3 s old, the poll-driven refresh skips that field so optimistic
// values aren't snapped back by stale HA state.
const _alexaTouched = {};
function _alexaMarkTouched(entity, field) { _alexaTouched[entity + '|' + field] = Date.now(); }
function _alexaWasTouched(entity, field, ms = 3000) {
  return Date.now() - (_alexaTouched[entity + '|' + field] || 0) < ms;
}

function _alexaCardHtml(d) {
  const eid = d.id;
  // Mode = announce (TTS, mixes with current audio — default) or sound
  // (play_media, captures source). Persisted per-device in localStorage.
  // Default 'announce' so a fresh user never accidentally starts music
  // playback (which captures the soundbar source until manual restore).
  const mode = localStorage.getItem(`alexa_mode_${eid}`) || 'announce';
  return `
    <div class="card" data-alexa-id="${_esc(eid)}" data-alexa-mode="${mode}" style="flex:1; min-width:280px; max-width:380px;">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
        <span data-alexa-field="dot">${_alexaStatusDot(null)}</span>
        <div style="flex:1;">
          <div data-alexa-field="name" style="font-weight:600; font-size:0.95rem;">${_esc(d.name)}</div>
          <div style="font-size:0.72rem; color:#888;"><span>${_esc(d.room || '—')}</span> · <span data-alexa-field="state">—</span></div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="alexaCmd('${_esc(eid)}','turn_on')" title="Wake">On</button>
        <button class="btn btn-secondary btn-sm" onclick="alexaCmd('${_esc(eid)}','turn_off')" title="Sleep">Off</button>
      </div>
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
        <span style="font-size:0.72rem; color:#666; min-width:40px;">Vol</span>
        <input type="range" min="0" max="100" value="0"
               data-alexa-field="vol-slider"
               oninput="_alexaMarkTouched('${_esc(eid)}','vol'); document.querySelector('[data-alexa-id=\\'${_esc(eid)}\\'] [data-alexa-field=vol-text]').textContent = this.value + '%'"
               onchange="_alexaMarkTouched('${_esc(eid)}','vol'); alexaCmd('${_esc(eid)}','volume', this.value/100)"
               style="flex:1;">
        <span data-alexa-field="vol-text" style="font-size:0.78rem; min-width:34px; text-align:right;">0%</span>
        <button class="btn btn-secondary btn-sm" data-alexa-field="mute-btn"
                onclick="alexaCmd('${_esc(eid)}','mute', !this.dataset.muted || this.dataset.muted === 'false')"
                title="Mute">🔇</button>
      </div>
      <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
        <button class="btn btn-secondary btn-sm" onclick="alexaCmd('${_esc(eid)}','prev')" title="Previous">⏮</button>
        <button class="btn btn-secondary btn-sm" onclick="alexaCmd('${_esc(eid)}','play')" title="Play (resume)">▶</button>
        <button class="btn btn-secondary btn-sm" onclick="alexaCmd('${_esc(eid)}','pause')" title="Pause">⏸</button>
        <button class="btn btn-secondary btn-sm" onclick="alexaCmd('${_esc(eid)}','stop')" title="Stop">⏹</button>
        <button class="btn btn-secondary btn-sm" onclick="alexaCmd('${_esc(eid)}','next')" title="Next">⏭</button>
        <span data-alexa-field="title" style="flex:1; font-size:0.72rem; color:#888; padding-left:8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
      </div>
      <div data-alexa-field="stations" style="display:${mode === 'sound' ? 'flex' : 'none'}; flex-wrap:wrap; gap:0; padding:4px 0; border-top:1px dashed #e8e2da;">
        <span style="color:#888; font-size:0.72rem;">loading stations…</span>
      </div>
      <div style="display:flex; gap:6px; align-items:center; margin-top:6px; font-size:0.72rem;">
        <span style="color:#666; min-width:38px;">Mode</span>
        <label style="display:inline-flex; align-items:center; gap:3px; cursor:pointer;">
          <input type="radio" name="alexa-mode-${_esc(eid)}" value="announce"
                 ${mode === 'announce' ? 'checked' : ''}
                 onchange="alexaSetMode('${_esc(eid)}','announce')"
                 style="margin:0;"> Announcement
        </label>
        <label style="display:inline-flex; align-items:center; gap:3px; cursor:pointer;">
          <input type="radio" name="alexa-mode-${_esc(eid)}" value="sound"
                 ${mode === 'sound' ? 'checked' : ''}
                 onchange="alexaSetMode('${_esc(eid)}','sound')"
                 style="margin:0;"> Sound
        </label>
      </div>
      <div style="display:flex; gap:6px; align-items:center; margin-top:4px;">
        <input type="text"
               data-alexa-field="play-input"
               placeholder="${mode === 'sound' ? 'play radio / song / phrase…' : 'say something…'}"
               onkeydown="if(event.key==='Enter') document.querySelector('[data-alexa-id=\\'${_esc(eid)}\\'] [data-alexa-field=play-btn]').click()"
               style="flex:1; min-width:0; padding:3px 6px; border:1px solid #d0cbc4; border-radius:3px; font-size:0.78rem;">
        <button class="btn btn-secondary btn-sm" data-alexa-field="play-btn"
                onclick="alexaPlayOrSay('${_esc(eid)}')"
                style="background:#3a7d44; color:#fff; flex-shrink:0;"
                title="${mode === 'sound' ? 'Start playback (captures source)' : 'Speak announcement (overlays current audio)'}">${mode === 'sound' ? '▶ Play' : '▶ Speak'}</button>
        <button class="btn btn-secondary btn-sm" data-alexa-field="save-btn"
                onclick="alexaSaveStation('${_esc(eid)}')"
                style="display:${mode === 'sound' ? 'inline-block' : 'none'}; flex-shrink:0;"
                title="Save the typed phrase as a station you can reuse">💾 Save</button>
      </div>
    </div>`;
}

function _alexaUpdateCard(card, d) {
  const eid = d.id;
  const ha = d.ha || {};
  const a = ha.attributes || {};
  const vol = a.volume_level != null ? Math.round(a.volume_level * 100) : 0;
  const muted = !!a.is_volume_muted;
  const title = a.media_title ? _esc(a.media_title) : '';
  const artist = a.media_artist ? ` — ${_esc(a.media_artist)}` : '';
  const stateLabel = ha.state ? _esc(ha.state) : 'unknown';
  const set = (sel, html) => { const el = card.querySelector(sel); if (el) el.innerHTML = html; };
  const text = (sel, t) => { const el = card.querySelector(sel); if (el) el.textContent = t; };
  set('[data-alexa-field=dot]', _alexaStatusDot(ha));
  text('[data-alexa-field=state]', stateLabel);
  set('[data-alexa-field=title]', title + artist);
  // Name turns red while the device is actively playing OR while a
  // dashboard-initiated TTS announcement is still in flight. Alexa's
  // notify path doesn't transition state to 'playing' for TTS, so the
  // server marks `d.speaking=true` for an estimated TTS duration on
  // every /say or /announce call (see speakAlexa() in server.js).
  const nameEl = card.querySelector('[data-alexa-field=name]');
  const isActive = (ha.state === 'playing') || !!d.speaking;
  if (nameEl) nameEl.style.color = isActive ? '#e74c3c' : '';
  // Don't snap-back the volume slider/text if user just touched it.
  if (!_alexaWasTouched(eid, 'vol')) {
    const sl = card.querySelector('[data-alexa-field=vol-slider]');
    if (sl && document.activeElement !== sl) sl.value = vol;
    text('[data-alexa-field=vol-text]', vol + '%');
  }
  const mb = card.querySelector('[data-alexa-field=mute-btn]');
  if (mb) {
    mb.dataset.muted = muted ? 'true' : 'false';
    mb.style.opacity = muted ? '1' : '0.4';
  }
}

async function loadAlexa() {
  const cards = document.getElementById('alexa-cards');
  const tgtSel = document.getElementById('alexa-ann-target');
  if (!cards) return;
  try {
    const r = await fetch('/api/alexa/devices');
    const list = await r.json();
    if (!r.ok) throw new Error(list.error || 'load failed');

    // Build the static structure once. Patch dynamic fields on every refresh.
    const presentIds = new Set(Array.from(cards.querySelectorAll('[data-alexa-id]'))
                                    .map(el => el.getAttribute('data-alexa-id')));
    const wantIds    = new Set(list.map(d => d.id));
    if (presentIds.size !== wantIds.size || ![...wantIds].every(id => presentIds.has(id))) {
      cards.innerHTML = list.map(_alexaCardHtml).join('') ||
        '<div style="color:#888;">No Alexa devices registered.</div>';
    }
    // Always patch dynamic fields
    for (const d of list) {
      const card = cards.querySelector(`[data-alexa-id="${d.id}"]`);
      if (card) _alexaUpdateCard(card, d);
    }

    // Sync target dropdown (only if the option set changed)
    if (tgtSel) {
      const want = ['__all__', ...list.map(d => d.id)];
      const have = Array.from(tgtSel.options).map(o => o.value);
      if (want.length !== have.length || !want.every((v, i) => v === have[i])) {
        const cur = tgtSel.value;
        tgtSel.innerHTML = '<option value="__all__">All devices</option>' +
          list.map(d => `<option value="${_esc(d.id)}">${_esc(d.name)}</option>`).join('');
        if (cur && [...tgtSel.options].some(o => o.value === cur)) tgtSel.value = cur;
      }
    }

    // Templates + saved stations + speech settings — only on first load
    if (!cards.dataset.tplLoaded) {
      cards.dataset.tplLoaded = '1';
      loadAlexaTemplates();
      await _alexaStationsGet(true);  // populate cache
      _refreshAllStationRows();
      _alexaSpeechInit();
    }
    // Test-target dropdown reflects current device list each refresh
    _alexaSpeechSyncTestTarget(list);
  } catch (e) {
    if (!cards.querySelector('[data-alexa-id]')) {
      cards.innerHTML = `<div style="color:#c0392b; font-size:0.85rem;">Load failed: ${_esc(e.message)}</div>`;
    }
  }
}

async function alexaCmd(entity, action, value) {
  let path, body;
  if (action === 'volume') { path = 'volume'; body = { level: value }; }
  else if (action === 'mute') { path = 'mute'; body = { mute: value }; }
  else { path = action; body = {}; }
  try {
    const r = await fetch(`/api/alexa/${encodeURIComponent(entity)}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'cmd failed');
    showFeedback(`✓ ${entity.replace('media_player.','')} — ${action}`, true);
    // refresh cards after short delay so HA state catches up
    setTimeout(loadAlexa, 1500);
  } catch (e) {
    showFeedback('✗ ' + e.message, false);
  }
}

async function alexaSpeak() {
  const target = document.getElementById('alexa-ann-target').value;
  const msg = (document.getElementById('alexa-ann-msg').value || '').trim();
  const status = document.getElementById('alexa-ann-status');
  if (!msg) { status.textContent = 'Type a message first.'; status.style.color = '#c0392b'; return; }
  status.textContent = 'Sending…'; status.style.color = '#888';
  try {
    let r;
    if (target === '__all__') {
      const devs = await fetch('/api/alexa/devices').then(r => r.json());
      const targets = devs.map(d => d.id);
      r = await fetch('/api/alexa/announce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, targets }),
      });
    } else {
      r = await fetch(`/api/alexa/${encodeURIComponent(target)}/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
    }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'speak failed');
    status.textContent = '✓ Sent'; status.style.color = '#1e8449';
  } catch (e) {
    status.textContent = '✗ ' + e.message; status.style.color = '#c0392b';
  }
}

async function loadAlexaTemplates() {
  const list = document.getElementById('alexa-tpl-list');
  if (!list) return;
  try {
    const r = await fetch(`/api/dashboard-settings/${ALEXA_TPL_KEY}`);
    const data = await r.json();
    const arr = Array.isArray(data.value) ? data.value : [];
    if (!arr.length) {
      list.innerHTML = '<div style="color:#888;">No saved announcements yet.</div>';
      return;
    }
    list.innerHTML = arr.map(t => `
      <div style="display:flex; gap:8px; align-items:center; padding:6px 0; border-bottom:1px dashed #e8e2da;">
        <span style="font-weight:600; min-width:140px;">${_esc(t.name || '—')}</span>
        <span style="flex:1; color:#555;">${_esc(t.message || '')}</span>
        <button class="btn btn-secondary btn-sm" onclick="alexaTplPlay('${_esc(t.id)}')">▶ Speak</button>
        <button class="btn btn-secondary btn-sm" onclick="alexaTplEdit('${_esc(t.id)}')">Edit</button>
        <button class="btn btn-secondary btn-sm" onclick="alexaTplDelete('${_esc(t.id)}')" style="color:#c0392b;">Del</button>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = `<div style="color:#c0392b;">${_esc(e.message)}</div>`;
  }
}

async function _alexaTplGet() {
  const r = await fetch(`/api/dashboard-settings/${ALEXA_TPL_KEY}`);
  const d = await r.json();
  return Array.isArray(d.value) ? d.value : [];
}
async function _alexaTplSave(arr) {
  const r = await fetch(`/api/dashboard-settings/${ALEXA_TPL_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: arr }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `save failed (HTTP ${r.status})`);
  }
}

// Inline form replaces prompt() — browser prompts are flaky across tabs,
// especially after the page has been idle, and silently fail without
// surfacing an error. The form is a single shared element used both for
// new + edit; `_editingId` carries which row is being edited (null = new).
let _alexaTplEditingId = null;

function alexaTplFormShow(id) {
  _alexaTplEditingId = id || null;
  const form = document.getElementById('alexa-tpl-form');
  const nameEl = document.getElementById('alexa-tpl-name');
  const msgEl  = document.getElementById('alexa-tpl-msg');
  const status = document.getElementById('alexa-tpl-form-status');
  if (status) status.textContent = '';
  if (id) {
    _alexaTplGet().then(arr => {
      const t = arr.find(x => x.id === id);
      if (t) { nameEl.value = t.name || ''; msgEl.value = t.message || ''; }
    });
  } else {
    nameEl.value = '';
    msgEl.value  = '';
  }
  if (form) form.style.display = 'block';
  if (nameEl) nameEl.focus();
}

function alexaTplFormCancel() {
  const form = document.getElementById('alexa-tpl-form');
  if (form) form.style.display = 'none';
  _alexaTplEditingId = null;
}

async function alexaTplFormSave() {
  const name = (document.getElementById('alexa-tpl-name').value || '').trim();
  const msg  = (document.getElementById('alexa-tpl-msg').value || '').trim();
  const status = document.getElementById('alexa-tpl-form-status');
  if (!name) { status.textContent = 'Name required'; status.style.color = '#c0392b'; return; }
  if (!msg)  { status.textContent = 'Message required'; status.style.color = '#c0392b'; return; }
  status.textContent = 'Saving…'; status.style.color = '#888';
  try {
    const arr = await _alexaTplGet();
    if (_alexaTplEditingId) {
      const t = arr.find(x => x.id === _alexaTplEditingId);
      if (t) { t.name = name; t.message = msg; }
    } else {
      arr.push({ id: 'tpl_' + Date.now().toString(36), name, message: msg });
    }
    await _alexaTplSave(arr);
    alexaTplFormCancel();
    loadAlexaTemplates();
  } catch (e) {
    status.textContent = '✗ ' + e.message; status.style.color = '#c0392b';
  }
}

// Backwards-compat shims used by the inline list buttons.
function alexaTplEdit(id) { alexaTplFormShow(id); }
function alexaTplNew()    { alexaTplFormShow(); }

async function alexaTplDelete(id) {
  if (!confirm('Delete this template?')) return;
  const arr = (await _alexaTplGet()).filter(x => x.id !== id);
  await _alexaTplSave(arr);
  loadAlexaTemplates();
}

async function alexaTplPlay(id) {
  const arr = await _alexaTplGet();
  const t = arr.find(x => x.id === id);
  if (!t) return;
  document.getElementById('alexa-ann-msg').value = t.message;
  alexaSpeak();
}

// ── Saved stations (per-card) ────────────────────────────────────────────────
// Storage key kept as alexa_quick_music for backwards compat with already-
// seeded data. Each entry: {id, name, content_id, content_type}.
const ALEXA_STATIONS_KEY = 'media-agents.alexa_quick_music';
let _alexaStations = null;  // cached list

async function alexaPlayMedia(entity, content_id, content_type) {
  const phrase = (content_id || '').trim();
  if (!phrase) { showFeedback('Type a phrase first', false); return; }
  try {
    const r = await fetch(`/api/alexa/${encodeURIComponent(entity)}/play_media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_id: phrase, content_type: content_type || 'DEFAULT' }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'play_media failed');
    showFeedback(`▶ ${entity.replace('media_player.','')} — ${phrase}`, true);
    setTimeout(loadAlexa, 1500);
  } catch (e) {
    showFeedback('✗ ' + e.message, false);
  }
}

// Per-card mode selector (Announcement | Sound). Persists in localStorage.
// Re-renders the affected card to swap input placeholder + button label +
// stations row visibility — done by patching DOM rather than full reload
// so the user's typed-but-unsent phrase is preserved across mode flips.
function alexaSetMode(entity, mode) {
  if (mode !== 'announce' && mode !== 'sound') return;
  localStorage.setItem(`alexa_mode_${entity}`, mode);
  const card = document.querySelector(`#alexa-cards [data-alexa-id="${entity}"]`);
  if (!card) return;
  card.setAttribute('data-alexa-mode', mode);
  const stations = card.querySelector('[data-alexa-field=stations]');
  const input    = card.querySelector('[data-alexa-field=play-input]');
  const btn      = card.querySelector('[data-alexa-field=play-btn]');
  const save     = card.querySelector('[data-alexa-field=save-btn]');
  if (stations) stations.style.display = mode === 'sound' ? 'flex' : 'none';
  if (save)     save.style.display     = mode === 'sound' ? 'inline-block' : 'none';
  if (input) {
    input.setAttribute('placeholder',
      mode === 'sound' ? 'play radio / song / phrase…' : 'say something…');
  }
  if (btn) {
    btn.textContent = mode === 'sound' ? '▶ Play' : '▶ Speak';
    btn.setAttribute('title', mode === 'sound'
      ? 'Start playback (captures source)'
      : 'Speak announcement (overlays current audio)');
  }
  if (mode === 'sound') _renderAlexaStations(card, entity);
}

// Single click handler for the input-row button — branches on the card's
// current mode. Keeps the HTML simple (one button, one onclick).
function alexaPlayOrSay(entity) {
  const card  = document.querySelector(`#alexa-cards [data-alexa-id="${entity}"]`);
  if (!card) return;
  const mode  = card.getAttribute('data-alexa-mode') || 'announce';
  const input = card.querySelector('[data-alexa-field=play-input]');
  const text  = (input && input.value || '').trim();
  if (!text) { showFeedback(mode === 'sound' ? 'Type a phrase first' : 'Type a message first', false); return; }
  if (mode === 'sound') {
    alexaPlayMedia(entity, text, 'DEFAULT');
  } else {
    alexaSayOneShot(entity, text);
  }
}

async function alexaSayOneShot(entity, message) {
  try {
    const r = await fetch(`/api/alexa/${encodeURIComponent(entity)}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'say failed');
    showFeedback(`🔊 ${entity.replace('media_player.','')} — ${message}`, true);
  } catch (e) {
    showFeedback('✗ ' + e.message, false);
  }
}

async function _alexaStationsGet(forceRefresh) {
  if (_alexaStations && !forceRefresh) return _alexaStations;
  const r = await fetch(`/api/dashboard-settings/${ALEXA_STATIONS_KEY}`);
  const d = await r.json();
  _alexaStations = Array.isArray(d.value) ? d.value : [];
  // Clean up legacy default_target field that's no longer used
  return _alexaStations;
}
async function _alexaStationsSave(arr) {
  _alexaStations = arr;
  await fetch(`/api/dashboard-settings/${ALEXA_STATIONS_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: arr }),
  });
}

// Render the saved-stations row inside an Echo card.
function _renderAlexaStations(card, eid) {
  const row = card.querySelector('[data-alexa-field=stations]');
  if (!row) return;
  const stations = _alexaStations || [];
  if (!stations.length) {
    row.innerHTML = '<span style="color:#888; font-size:0.72rem;">No saved stations yet — type one below + click 💾 to save.</span>';
    return;
  }
  row.innerHTML = stations.map(s => `
    <span style="display:inline-flex; align-items:center; gap:0; margin:2px 4px 2px 0;">
      <button class="btn btn-secondary btn-sm" title="Play on this Echo"
              onclick="alexaPlayStation('${_esc(eid)}','${_esc(s.id)}')"
              style="padding:3px 10px; font-size:0.78rem; border-radius:3px 0 0 3px;">${_esc(s.name)}</button>
      <button class="btn btn-secondary btn-sm" title="Delete this station"
              onclick="alexaDeleteStation('${_esc(s.id)}')"
              style="padding:3px 6px; font-size:0.78rem; color:#c0392b; border-radius:0 3px 3px 0; border-left:none;">×</button>
    </span>
  `).join('');
}

// Re-render the stations row in every card after the list changes.
function _refreshAllStationRows() {
  document.querySelectorAll('#alexa-cards [data-alexa-id]').forEach(card => {
    _renderAlexaStations(card, card.getAttribute('data-alexa-id'));
  });
}

async function alexaPlayStation(eid, stationId) {
  const arr = await _alexaStationsGet();
  const s = arr.find(x => x.id === stationId);
  if (!s) return;
  alexaPlayMedia(eid, s.content_id, s.content_type || 'DEFAULT');
}

async function alexaSaveStation(eid) {
  const card = document.querySelector(`#alexa-cards [data-alexa-id="${eid}"]`);
  if (!card) return;
  const input = card.querySelector('[data-alexa-field=play-input]');
  const phrase = (input.value || '').trim();
  if (!phrase) { showFeedback('Type a phrase first to save it', false); return; }
  const name = prompt('Save as (short label):', phrase);
  if (!name) return;
  // Default to TUNEIN if user typed something that looks like a TuneIn id (s + digits),
  // else DEFAULT (Alexa interprets as voice command).
  const content_type = /^s\d+$/i.test(phrase) ? 'TUNEIN' : 'DEFAULT';
  const arr = await _alexaStationsGet(true);
  arr.push({ id: 'st_' + Date.now().toString(36), name, content_id: phrase, content_type });
  await _alexaStationsSave(arr);
  _refreshAllStationRows();
  input.value = '';
  showFeedback(`💾 Saved "${name}"`, true);
}

async function alexaDeleteStation(stationId) {
  const arr = await _alexaStationsGet();
  const s = arr.find(x => x.id === stationId);
  if (!s) return;
  if (!confirm(`Delete "${s.name}"?`)) return;
  await _alexaStationsSave(arr.filter(x => x.id !== stationId));
  _refreshAllStationRows();
}

// ── Global Speech Settings (rate, voice, announcement volume) ────────────
const ALEXA_SPEECH_KEY = 'media-agents.alexa_speech';

function _alexaFormatDb(db) {
  if (db === 0) return '0 dB (full)';
  return db + ' dB';
}

function _alexaFormatRate(pct) {
  if (pct >= 100) return '100% (normal)';
  return pct + '%';
}

async function _alexaSpeechInit() {
  // Hydrate the form from dashboard_settings
  try {
    const r = await fetch(`/api/dashboard-settings/${ALEXA_SPEECH_KEY}`);
    const d = await r.json();
    const v = (d && typeof d.value === 'object' && d.value) ? d.value : {};
    const pct   = (v.rate_pct == null) ? 100
                : Math.max(50, Math.min(100, Math.round(Number(v.rate_pct))));
    const voice = v.voice || '';
    const ldb   = (v.loudness_db == null) ? null
                : Math.max(-20, Math.min(0, Math.round(Number(v.loudness_db))));
    const rateSlider = document.getElementById('alexa-speech-rate');
    const rateText   = document.getElementById('alexa-speech-rate-text');
    if (rateSlider) rateSlider.value = pct;
    if (rateText)   rateText.textContent = _alexaFormatRate(pct);
    const voiceSel = document.getElementById('alexa-speech-voice');
    if (voiceSel) voiceSel.value = voice;
    const loudSlider = document.getElementById('alexa-speech-loud');
    const loudText   = document.getElementById('alexa-speech-loud-text');
    if (loudSlider && loudText) {
      if (ldb == null) {
        loudSlider.value = 0;
        loudSlider.dataset.cleared = '1';
        loudText.textContent = 'off';
      } else {
        loudSlider.value = ldb;
        delete loudSlider.dataset.cleared;
        loudText.textContent = _alexaFormatDb(ldb);
      }
    }
  } catch (_) { /* leave defaults */ }
  // Wire up event handlers
  const rateSlider = document.getElementById('alexa-speech-rate');
  const rateText   = document.getElementById('alexa-speech-rate-text');
  if (rateSlider) rateSlider.addEventListener('input', () => {
    if (rateText) rateText.textContent = _alexaFormatRate(Number(rateSlider.value));
  });
  const loudSlider = document.getElementById('alexa-speech-loud');
  const loudText   = document.getElementById('alexa-speech-loud-text');
  if (loudSlider) loudSlider.addEventListener('input', () => {
    delete loudSlider.dataset.cleared;
    if (loudText) loudText.textContent = _alexaFormatDb(Number(loudSlider.value));
  });
  const clr = document.getElementById('alexa-speech-loud-clear');
  if (clr) clr.addEventListener('click', () => {
    if (loudSlider) { loudSlider.value = 0; loudSlider.dataset.cleared = '1'; }
    if (loudText)   loudText.textContent = 'off';
  });
  const saveBtn = document.getElementById('alexa-speech-save');
  if (saveBtn) saveBtn.addEventListener('click', _alexaSpeechSave);
  const testBtn = document.getElementById('alexa-speech-test-btn');
  if (testBtn) testBtn.addEventListener('click', _alexaSpeechTest);
}

function _alexaSpeechReadForm() {
  const rateSlider = document.getElementById('alexa-speech-rate');
  const rate_pct   = rateSlider ? Math.max(50, Math.min(100, Math.round(Number(rateSlider.value)))) : 100;
  const voice      = (document.getElementById('alexa-speech-voice') || {}).value || null;
  const loudSlider = document.getElementById('alexa-speech-loud');
  const cleared    = loudSlider && loudSlider.dataset.cleared === '1';
  const loudness_db = (cleared || !loudSlider) ? null
                    : Math.max(-20, Math.min(0, Math.round(Number(loudSlider.value))));
  return { rate_pct, voice: voice || null, loudness_db };
}

async function _alexaSpeechSave() {
  const status = document.getElementById('alexa-speech-status');
  const v = _alexaSpeechReadForm();
  try {
    const r = await fetch(`/api/dashboard-settings/${ALEXA_SPEECH_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: v }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'save failed');
    if (status) { status.textContent = '✓ saved'; status.style.color = '#2e7d32'; setTimeout(() => { status.textContent = ''; }, 2500); }
  } catch (e) {
    if (status) { status.textContent = '✗ ' + e.message; status.style.color = '#c0392b'; }
  }
}

async function _alexaSpeechTest() {
  const tgt = (document.getElementById('alexa-speech-test-target') || {}).value || '';
  const msg = ((document.getElementById('alexa-speech-test-input') || {}).value || '').trim();
  if (!tgt) { showFeedback('Pick a target Alexa device', false); return; }
  if (!msg) { showFeedback('Type a test phrase', false); return; }
  const v = _alexaSpeechReadForm();
  // Save first so the active settings are what server reads
  await _alexaSpeechSave();
  try {
    const body = { message: msg };
    if (v.loudness_db != null) body.loudness_db = v.loudness_db;
    const r = await fetch(`/api/alexa/${encodeURIComponent(tgt)}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'say failed');
    showFeedback(`🔊 ${tgt.replace('media_player.','')} — ${msg}`, true);
  } catch (e) {
    showFeedback('✗ ' + e.message, false);
  }
}

function _alexaSpeechSyncTestTarget(list) {
  const sel = document.getElementById('alexa-speech-test-target');
  if (!sel) return;
  const want = list.map(d => d.id);
  const have = Array.from(sel.options).map(o => o.value);
  if (want.length !== have.length || !want.every((v, i) => v === have[i])) {
    const cur = sel.value;
    sel.innerHTML = list.map(d => `<option value="${_esc(d.id)}">${_esc(d.name)}</option>`).join('');
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  }
}

