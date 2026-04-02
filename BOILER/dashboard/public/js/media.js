let _tvMuted = false;
let _sbMuted = false;

function showTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}

function statusDot(power) {
  if (power === 'on')  return '<span style="color:#2ecc71; font-size:1.4rem;">⬤</span>';
  if (power === 'off') return '<span style="color:#e74c3c; font-size:1.4rem;">⬤</span>';
  return '<span style="color:#aaa; font-size:1.4rem;">⬤</span>';
}

async function refreshState() {
  try {
    const s = await fetch('/api/media/state').then(r => r.json());

    // TV
    const tv = s.tv;
    document.getElementById('tv-status').innerHTML = statusDot(tv.power);
    document.getElementById('tv-volume').textContent = tv.volume != null ? tv.volume + '%' : '—';
    _tvMuted = tv.muted;
    document.getElementById('tv-mute-btn').style.opacity = _tvMuted ? '1' : '0.4';


    // Soundbar
    const sb = s.soundbar;
    document.getElementById('sb-status').innerHTML = statusDot(sb.power);
    document.getElementById('sb-volume').textContent = sb.volume != null ? sb.volume + '%' : '—';
    _sbMuted = sb.muted;
    document.getElementById('sb-mute-btn').style.opacity = _sbMuted ? '1' : '0.4';

    const sbSrcSel = document.getElementById('sb-source-select');
    const sbInputs = sb.supportedInputs?.length ? sb.supportedInputs : (sb.input ? [sb.input] : []);
    sbSrcSel.innerHTML = sbInputs.map(i =>
      `<option value="${i}"${i === sb.input ? ' selected' : ''}>${i}</option>`
    ).join('') || `<option value="${sb.input||''}">${sb.input||'—'}</option>`;

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
    const r = await fetch('/api/media/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Command failed');
showFeedback(`✓ ${entity} — ${command}${value !== undefined ? ': ' + value : ''}`, true);
    setTimeout(refreshState, 4000);
  } catch (e) {
    showFeedback('✗ ' + e.message, false);
  }
}

function toggleMute(entity) {
  const muted = entity === 'tv' ? _tvMuted : _sbMuted;
  cmd(entity, 'mute', !muted);
}

function showFeedback(msg, ok) {
  const el = document.getElementById('cmd-feedback');
  el.textContent = msg;
  el.style.background = ok ? '#eafaf1' : '#fdecea';
  el.style.color      = ok ? '#1e8449'  : '#c0392b';
  el.style.border     = ok ? '1px solid #a9dfbf' : '1px solid #f5c6cb';
  el.style.display    = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// Init
refreshState();
