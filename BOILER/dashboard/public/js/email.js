// Email — Gmail two-way client. Talks DIRECTLY to the Email Agent on LXC 110
// (dashboard is UI-only). Full bodies are fetched + sanitized server-side.
(function () {
  const API = 'http://192.168.1.162:8780';
  let _msgs = [];
  let _openId = null;
  let _mode = 'new';        // 'new' | 'reply'
  let _replyThread = null;

  function esc(s) {
    return (s || '').replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
    return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Jerusalem' });
  }

  function shortFrom(f) {
    if (!f) return '(unknown)';
    const m = f.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
    return m ? m[1].trim() : f.replace(/[<>]/g, '').trim();
  }

  async function jget(path) {
    const r = await fetch(API + path);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function jpost(path, body) {
    const r = await fetch(API + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function loadHealth() {
    const banner = document.getElementById('email-auth-banner');
    try {
      const h = await jget('/api/email/health');
      banner.style.display = h.authorized ? 'none' : 'block';
    } catch (e) {
      banner.style.display = 'block';
      banner.textContent = '⚠ Email Agent unreachable (' + API + '). Is the service running on LXC 110?';
    }
  }

  function renderList() {
    const el = document.getElementById('email-list');
    if (!_msgs.length) { el.innerHTML = '<div class="em-hint">No messages.</div>'; return; }
    el.innerHTML = _msgs.map(m => {
      const unread = (m.labels || []).includes('UNREAD') ? ' unread' : '';
      const active = m.gmail_id === _openId ? ' active' : '';
      return `<div class="em-row${unread}${active}" onclick="emOpen('${m.gmail_id}')">
        <div class="em-top"><span class="em-from">${esc(shortFrom(m.from_addr))}</span>
          <span class="em-time">${fmtTime(m.msg_ts)}</span></div>
        <div class="em-subj">${esc(m.subject || '(no subject)')}</div>
        <div class="em-snip">${esc(m.snippet || '')}</div></div>`;
    }).join('');
  }

  async function loadMessages() {
    const label = document.getElementById('email-label-filter').value;
    const el = document.getElementById('email-list');
    try {
      const d = await jget('/api/email/messages?limit=60&label=' + encodeURIComponent(label));
      _msgs = d.messages || [];
      renderList();
    } catch (e) {
      el.innerHTML = '<div class="em-hint">Could not load messages.</div>';
    }
  }

  async function emOpen(id) {
    _openId = id;
    renderList();
    const pane = document.getElementById('email-read');
    pane.innerHTML = '<div class="em-hint">Loading…</div>';
    try {
      const m = await jget('/api/email/message/' + encodeURIComponent(id));
      const bodyHtml = m.is_html
        ? m.body
        : '<div style="white-space:pre-wrap">' + esc(m.body) + '</div>';
      pane.innerHTML = `
        <div id="em-read-head">
          <div style="font-size:1.05rem; font-weight:700;">${esc(m.subject || '(no subject)')}</div>
          <div style="font-size:0.82rem; color:#64748b; margin-top:4px;">
            <strong>${esc(shortFrom(m.from_addr))}</strong> &lt;${esc((m.from_addr || '').replace(/^.*<|>.*$/g, ''))}&gt;
          </div>
          <div style="font-size:0.76rem; color:#94a3b8;">${esc(m.date || '')}</div>
          <div class="em-actions">
            <button class="btn btn-primary btn-sm" onclick="emReply()">↩ Reply</button>
            <button class="btn btn-secondary btn-sm" onclick="emArchive('${id}')">🗄 Archive</button>
            <button class="btn btn-secondary btn-sm" onclick="emMarkRead('${id}')">✓ Mark read</button>
          </div>
        </div>
        <div id="em-read-body">${bodyHtml}</div>`;
      window._emOpenMsg = m;
      // opening marks it read (best-effort)
      if ((_msgs.find(x => x.gmail_id === id)?.labels || []).includes('UNREAD')) emMarkRead(id, true);
    } catch (e) {
      pane.innerHTML = '<div class="em-hint">Could not open message.</div>';
    }
  }

  async function emArchive(id) {
    try { await jpost('/api/email/' + encodeURIComponent(id) + '/archive'); } catch (e) {}
    document.getElementById('email-read').innerHTML = '<div class="em-hint">Archived. Select a message to read.</div>';
    _openId = null;
    loadMessages();
  }

  async function emMarkRead(id, silent) {
    try { await jpost('/api/email/' + encodeURIComponent(id) + '/read'); } catch (e) {}
    const m = _msgs.find(x => x.gmail_id === id);
    if (m) m.labels = (m.labels || []).filter(l => l !== 'UNREAD');
    renderList();
  }

  // ---- compose / reply ----
  function emCompose() {
    _mode = 'new'; _replyThread = null;
    document.getElementById('em-compose-title').textContent = 'New message';
    document.getElementById('em-compose-to').value = '';
    document.getElementById('em-compose-subject').value = '';
    document.getElementById('em-compose-body').value = '';
    document.getElementById('em-compose-status').textContent = '';
    document.getElementById('em-compose-back').style.display = 'flex';
  }
  function emReply() {
    const m = window._emOpenMsg;
    if (!m) return;
    _mode = 'reply'; _replyThread = m.thread_id;
    let subj = m.subject || '';
    if (!/^re:/i.test(subj)) subj = 'Re: ' + subj;
    document.getElementById('em-compose-title').textContent = 'Reply';
    document.getElementById('em-compose-to').value = m.from_addr || '';
    document.getElementById('em-compose-subject').value = subj;
    document.getElementById('em-compose-body').value = '';
    document.getElementById('em-compose-status').textContent = '';
    document.getElementById('em-compose-back').style.display = 'flex';
  }
  function emCloseCompose() { document.getElementById('em-compose-back').style.display = 'none'; }

  async function emSend() {
    const to = document.getElementById('em-compose-to').value.trim();
    const subject = document.getElementById('em-compose-subject').value.trim();
    const body = document.getElementById('em-compose-body').value;
    const status = document.getElementById('em-compose-status');
    const btn = document.getElementById('em-compose-send');
    if (!to && _mode === 'new') { status.style.color = '#c0392b'; status.textContent = 'Recipient required.'; return; }
    btn.disabled = true; status.style.color = '#64748b'; status.textContent = 'Sending…';
    try {
      if (_mode === 'reply') await jpost('/api/email/reply', { thread_id: _replyThread, to, body });
      else await jpost('/api/email/send', { to, subject, body });
      status.style.color = '#1e7e34'; status.textContent = '✓ Sent.';
      setTimeout(() => { emCloseCompose(); loadMessages(); }, 700);
    } catch (e) {
      status.style.color = '#c0392b'; status.textContent = 'Send failed (' + e.message + ').';
    } finally { btn.disabled = false; }
  }

  function emReload() { loadHealth(); loadMessages(); }

  window.emOpen = emOpen; window.emArchive = emArchive; window.emMarkRead = emMarkRead;
  window.emCompose = emCompose; window.emReply = emReply; window.emCloseCompose = emCloseCompose;
  window.emSend = emSend; window.emReload = emReload;

  window.addEventListener('DOMContentLoaded', () => {
    emReload();
    setInterval(loadMessages, 30000);   // light auto-refresh
  });
})();
