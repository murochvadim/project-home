// WhatsApp tab (Communication page) — groups + owner + participants view.
// UI-only: calls the Baileys agent (LXC 114) directly. Everything here is READ-ONLY
// (groups/participants) = zero ban risk. Writes (send/leave) come in a later phase.
(function () {
  const WA_API = 'http://192.168.1.228:8790';
  let _groups = [];
  let _activeJid = null;
  let _shown = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const q = (id) => document.getElementById(id);

  async function loadStatus() {
    const el = q('wa-status'); if (!el) return;
    try {
      const s = await (await fetch(WA_API + '/status')).json();
      if (s.connection === 'open') { el.textContent = 'WhatsApp: ✅ connected' + (s.me && s.me.name ? ' (' + s.me.name + ')' : ''); el.style.color = '#166534'; }
      else if (s.connection === 'qr' || s.connection === 'connecting') { el.textContent = 'WhatsApp: linking… open ' + WA_API + '/link to scan the QR'; el.style.color = '#b45309'; }
      else { el.textContent = 'WhatsApp: ' + (s.connection || '?'); el.style.color = '#c0392b'; }
    } catch (e) { el.textContent = 'WhatsApp: agent unreachable (' + WA_API + ')'; el.style.color = '#c0392b'; }
  }

  async function loadGroups() {
    const host = q('wa-groups'); if (host) host.innerHTML = '<div class="wa-hint">Loading…</div>';
    try {
      const r = await (await fetch(WA_API + '/groups')).json();
      _groups = (r.groups || []).slice();
      renderGroups();
    } catch (e) { if (host) host.innerHTML = '<div class="wa-hint">Failed to load groups.</div>'; }
  }

  function renderGroups() {
    const host = q('wa-groups'); if (!host) return;
    const term = ((q('wa-group-search') && q('wa-group-search').value) || '').toLowerCase();
    const list = _groups.filter(g => !term || (g.name || '').toLowerCase().includes(term));
    const cnt = q('wa-groups-count'); if (cnt) cnt.textContent = '(' + list.length + (term ? ' of ' + _groups.length : '') + ')';
    if (!list.length) { host.innerHTML = '<div class="wa-hint">No groups.</div>'; return; }
    host.innerHTML = list.map(g => {
      const owner = g.owner_name || g.owner_notify || (g.owner_jid ? '(hidden id)' : '—');
      return '<div class="wa-grow' + (g.jid === _activeJid ? ' active' : '') + '" onclick="waOpenGroup(\'' + esc(g.jid) + '\')">' +
        '<div style="min-width:0;flex:1;"><div class="wa-gname">' + esc(g.name || '(no name)') + '</div>' +
        '<div class="wa-gsub">owner: ' + esc(owner) + '</div></div>' +
        '<span class="wa-gcount">' + (g.participant_count != null ? g.participant_count : '?') + '</span>' +
        '<button class="wa-del" title="Leave / delete this group" onclick="event.stopPropagation(); waLeaveGroup(\'' + esc(g.jid) + '\')">🗑</button></div>';
    }).join('');
  }

  function showModal(on) { const m = q('wa-group-modal'); if (m) m.style.display = on ? 'flex' : 'none'; }
  function closeGroup() { showModal(false); _activeJid = null; renderGroups(); }
  // Groups ALWAYS start collapsed on every tab entry (only Chats open). The toggle
  // opens it for the current view only; re-entering the tab collapses it again.
  let _groupsHidden = true;
  function applyGroupsVis() {
    const list = q('wa-groups'), btn = q('wa-groups-toggle'); if (!list) return;
    list.style.display = _groupsHidden ? 'none' : '';
    if (btn) btn.textContent = _groupsHidden ? '▸' : '▾';
  }
  function toggleGroups() { _groupsHidden = !_groupsHidden; applyGroupsVis(); }

  async function openGroup(jid) {
    _activeJid = jid; renderGroups();
    showModal(true);
    const d = q('wa-detail'); if (d) d.innerHTML = '<div class="wa-hint">Loading participants…</div>';
    try {
      const g = await (await fetch(WA_API + '/group/' + encodeURIComponent(jid))).json();
      if (!g.ok) { d.innerHTML = '<div class="wa-hint">Failed: ' + esc(g.reason || '') + '</div>'; return; }
      const ownerLbl = g.owner_name || (g.owner_number ? '+' + g.owner_number : (g.owner ? '(hidden id)' : '?'));
      const parts = (g.participants || []).slice().sort((a, b) => {
        const ar = a.admin ? 0 : 1, br = b.admin ? 0 : 1; if (ar !== br) return ar - br;
        return (a.name || a.number || '').localeCompare(b.name || b.number || '');
      });
      d.innerHTML =
        '<h3 style="margin:0 0 4px;">' + esc(g.subject || '(no name)') + '</h3>' +
        '<div style="font-size:0.82rem;color:#64748b;margin-bottom:4px;">👑 owner: <b>' + esc(ownerLbl) + '</b></div>' +
        '<div style="font-size:0.82rem;color:#64748b;margin-bottom:10px;">👥 ' + (g.size || parts.length) + ' participants · ' + (g.resolved_count || 0) + ' resolved' +
          (g.desc ? ' · <i>' + esc(String(g.desc).slice(0, 90)) + '</i>' : '') + '</div>' +
        parts.map(p => {
          const nm = p.name || (p.number ? '+' + p.number : '(hidden id)');
          const badge = p.admin === 'superadmin' ? '<span class="wa-badge super">owner/admin</span>' : (p.admin ? '<span class="wa-badge">admin</span>' : '');
          const num = (p.number && p.name) ? ' <span class="wa-pnum">+' + esc(p.number) + '</span>' : '';
          return '<div class="wa-part"><span class="wa-pname">' + esc(nm) + num + '</span>' + badge + '</div>';
        }).join('');
    } catch (e) { d.innerHTML = '<div class="wa-hint">Error loading participants.</div>'; }
  }

  // Leave (delete) a group — WRITE + outward + irreversible → strong confirm.
  // Low ban risk (a normal user action). Uses the agent's guarded /leave.
  async function leaveGroup(jid) {
    const g = _groups.find(x => x.jid === jid);
    const name = (g && g.name) || 'this group';
    if (!confirm('Leave / delete "' + name + '"?\n\nThis removes YOU from the group. The other members will see "You left", and to return you would need someone to RE-INVITE you.\n\nThis cannot be undone. Continue?')) return;
    try {
      const r = await (await fetch(WA_API + '/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jid }) })).json();
      if (!r.ok) { alert('Could not leave the group: ' + (r.reason || 'error')); return; }
      _groups = _groups.filter(x => x.jid !== jid);
      if (_activeJid === jid) { _activeJid = null; showModal(false); }
      renderGroups();
    } catch (e) { alert('Error leaving group: ' + e.message); }
  }

  async function refresh() {
    const el = q('wa-status'); if (el) el.textContent = 'WhatsApp: refreshing groups…';
    try { await fetch(WA_API + '/groups/refresh', { method: 'POST' }); } catch (e) {}
    await loadStatus(); await loadGroups(); await loadChats(true); await loadRecent();
  }

  function onShow() {
    loadStatus();
    if (!_shown) { _shown = true; loadChats(true); loadGroups(); startMonitorPoll(); }
    _groupsHidden = true;   // always collapse Groups on tab entry
    applyGroupsVis();
    if (monitorVisible()) loadRecent();   // refresh the feed immediately on tab entry
  }

  // ── Live monitor: latest INCOMING messages, auto-refresh while tab visible ──
  let _monTimer = null, _monHidden = false;
  async function loadRecent() {
    const host = q('wa-monitor-feed'); if (!host) return;
    try {
      const r = await (await fetch(WA_API + '/recent?limit=15')).json();
      renderRecent(r.messages || []);
    } catch (e) { /* leave last render; transient */ }
  }
  function renderRecent(msgs) {
    const host = q('wa-monitor-feed'); if (!host) return;
    if (!msgs.length) { host.innerHTML = '<div class="wa-hint">No recent incoming messages.</div>'; return; }
    const now = Date.now();
    host.innerHTML = msgs.map(m => {
      const fresh = m.ts && (now - new Date(m.ts).getTime() < 30000) ? ' fresh' : '';
      const nm = m.chat_name || '(unknown)';
      const sender = (m.is_group && m.sender_name) ? '<span class="wa-msender">' + esc(m.sender_name) + ':</span> ' : '';
      const jarg = "'" + esc(m.chat_jid) + "'," + JSON.stringify(nm) + "," + (m.is_group ? 'true' : 'false');
      return '<div class="wa-mrow' + fresh + '" onclick="waOpenChatJid(' + jarg + ')">' +
        '<span class="wa-mtime">' + fmtTime(m.ts) + '</span>' +
        '<span class="wa-mtext">' + sender + msgBody(m) + '</span>' +
        '<span class="wa-mchat">' + esc(nm) + '</span></div>';
    }).join('');
    const dot = q('wa-monitor-dot'); if (dot) dot.textContent = '● live';
  }
  function monitorVisible() {
    const p = q('comm-whatsapp');
    return p && p.style.display !== 'none' && document.visibilityState === 'visible' && !_monHidden;
  }
  function startMonitorPoll() {
    if (_monTimer) return;
    _monTimer = setInterval(() => { if (monitorVisible()) loadRecent(); }, 5000);
  }
  function toggleMonitor() {
    const feed = q('wa-monitor-feed'), btn = q('wa-monitor-toggle'); if (!feed) return;
    _monHidden = feed.style.display !== 'none';   // about to hide?
    feed.style.display = _monHidden ? 'none' : '';
    if (btn) btn.textContent = _monHidden ? '▸' : '▾';
    if (!_monHidden) loadRecent();
  }

  // ── Chats: name-resolved, searchable, recent-first, paged (manage every chat) ──
  let _chats = [], _chatTotal = 0, _chatOffset = 0, _chatTerm = '', _chatFilter = 'all', _searchTimer = null;
  let _activeChat = null; // {jid, name, is_group}
  const PAGE = 40;

  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
  };

  async function loadChats(reset) {
    if (reset) { _chatOffset = 0; _chats = []; }
    const host = q('wa-chats');
    if (reset && host) host.innerHTML = '<div class="wa-hint">Loading…</div>';
    try {
      const url = WA_API + '/chats?limit=' + PAGE + '&offset=' + _chatOffset +
        (_chatTerm ? '&q=' + encodeURIComponent(_chatTerm) : '') +
        (_chatFilter !== 'all' ? '&filter=' + _chatFilter : '');
      const r = await (await fetch(url)).json();
      _chatTotal = r.total || 0;
      _chats = _chats.concat(r.chats || []);
      _chatOffset += (r.chats || []).length;
      renderChats();
    } catch (e) { if (host) host.innerHTML = '<div class="wa-hint">Failed to load chats.</div>'; }
  }

  function renderChats() {
    const host = q('wa-chats'); if (!host) return;
    const cnt = q('wa-chats-count'); if (cnt) cnt.textContent = '(' + _chats.length + ' of ' + _chatTotal + ')';
    if (!_chats.length) { host.innerHTML = '<div class="wa-hint">' + (_chatTerm ? 'No matches.' : 'No chats.') + '</div>'; }
    else host.innerHTML = _chats.map((c, i) => {
      const nm = c.name || '(unknown)';
      const cls = c.resolved ? 'wa-cname' : 'wa-cname unknown';
      const tag = c.is_group ? '<span class="wa-ctag grp">👥 group</span>' : '<span class="wa-ctag dm">👤 person</span>';
      const un = c.unread ? '<span class="wa-unread">' + c.unread + '</span>' : '';
      return '<div class="wa-crow" onclick="waOpenChat(' + i + ')">' +
        '<span class="' + cls + '">' + esc(nm) + '</span>' + tag + un +
        '<span class="wa-ctime">' + fmtTime(c.last_ts) + '</span></div>';
    }).join('');
    const more = q('wa-chats-more');
    if (more) more.innerHTML = (_chats.length < _chatTotal)
      ? '<button class="btn btn-secondary btn-sm" onclick="waMoreChats()">Load more (' + (_chatTotal - _chats.length) + ' left)</button>' : '';
  }

  function chatSearch() {
    const el = q('wa-chat-search'); if (!el) return;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => { _chatTerm = el.value.trim(); loadChats(true); }, 300);
  }
  function chatFilter() {
    const el = q('wa-chat-filter'); if (!el) return;
    _chatFilter = el.value; loadChats(true);
  }
  function toggleChats() {
    const list = q('wa-chats'), more = q('wa-chats-more'), btn = q('wa-chats-toggle'); if (!list) return;
    const hidden = list.style.display === 'none';
    list.style.display = hidden ? '' : 'none';
    if (more) more.style.display = hidden ? '' : 'none';
    if (btn) btn.textContent = hidden ? '▾' : '▸';
  }
  function showChatModal(on) { const m = q('wa-chat-modal'); if (m) m.style.display = on ? 'flex' : 'none'; }
  function closeChat() { showChatModal(false); _activeChat = null; }

  function openChat(idx) { openChatObj(_chats[idx]); }
  function openChatJid(jid, name, isGroup) {
    openChatObj({ jid, name: name || null, is_group: !!isGroup, resolved: !!name });
  }

  async function openChatObj(c) {
    if (!c) return;
    _activeChat = c;
    showChatModal(true);
    const title = q('wa-chat-title'); if (title) title.textContent = c.name || '(unknown)';
    const del = q('wa-chat-del'); if (del) del.textContent = c.is_group ? 'Leave' : 'Delete';
    const inp = q('wa-chat-input'); if (inp) { inp.value = ''; }
    const sm = q('wa-chat-sendmsg'); if (sm) sm.textContent = '';
    const body = q('wa-chat-body'); if (body) body.innerHTML = '<div class="wa-hint">Loading…</div>';
    // mark read (fire-and-forget)
    fetch(WA_API + '/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jid: c.jid }) }).catch(() => {});
    try {
      const r = await (await fetch(WA_API + '/messages?jid=' + encodeURIComponent(c.jid) + '&limit=200')).json();
      renderMessages(r.messages || [], c);
    } catch (e) { if (body) body.innerHTML = '<div class="wa-hint">Error loading messages.</div>'; }
  }

  function msgBody(m) {
    if (m.body) return esc(m.body);
    const t = m.type || '';
    if (/image/i.test(t)) return '📷 photo'; if (/video/i.test(t)) return '🎞 video';
    if (/audio|ptt/i.test(t)) return '🎙 audio'; if (/sticker/i.test(t)) return '🩹 sticker';
    if (/document/i.test(t)) return '📄 document'; if (/location/i.test(t)) return '📍 location';
    return '<i style="opacity:.6;">(' + esc(t || 'no text') + ')</i>';
  }

  function renderMessages(msgs, c) {
    const body = q('wa-chat-body'); if (!body) return;
    if (!msgs.length) {
      body.innerHTML = '<div class="wa-hint">No messages cached yet — you can still send below.</div>'; return;
    }
    body.innerHTML = '<div class="wa-brow">' + msgs.map(m => {
      const out = !!m.from_me;
      const sender = (!out && c.is_group && m.sender_name) ? '<div class="wa-bsender">' + esc(m.sender_name) + '</div>' : '';
      const del = out ? '<span class="wa-bdel" title="Delete for everyone" onclick=\'waDelMsg(' +
        JSON.stringify({ id: m.wa_id, jid: c.jid, fromMe: true, part: m.sender_jid || null }).replace(/'/g, '&#39;') + ')\'>🗑</span>' : '';
      return '<div class="wa-bubble ' + (out ? 'out' : 'in') + '">' + sender + msgBody(m) + del +
        '<div class="wa-btime">' + fmtTime(m.ts) + '</div></div>';
    }).join('') + '</div>';
    body.scrollTop = body.scrollHeight;
  }

  async function sendChat() {
    const c = _activeChat; if (!c) return;
    const inp = q('wa-chat-input'), sm = q('wa-chat-sendmsg'); if (!inp) return;
    const text = inp.value.trim(); if (!text) return;
    if (sm) { sm.style.color = '#64748b'; sm.textContent = 'Sending…'; }
    try {
      const r = await (await fetch(WA_API + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jid: c.jid, text }) })).json();
      if (!r.ok) {
        const why = { rate: 'Too fast — wait a few seconds (safety limit).', cap: 'Hourly/daily send limit reached.', not_contact: 'Not in your contacts (blocked by contact-only).', not_connected: 'WhatsApp not connected.' }[r.reason] || ('Failed: ' + (r.reason || 'error'));
        if (sm) { sm.style.color = '#c0392b'; sm.textContent = why; }
        return;
      }
      inp.value = '';
      if (sm) sm.textContent = '';
      // reload the thread to show the sent message
      const mr = await (await fetch(WA_API + '/messages?jid=' + encodeURIComponent(c.jid) + '&limit=200')).json();
      renderMessages(mr.messages || [], c);
    } catch (e) { if (sm) { sm.style.color = '#c0392b'; sm.textContent = 'Error: ' + e.message; } }
  }

  const guardWhy = (reason) => ({
    rate: 'Too fast — wait a few seconds (delete/leave safety limit).',
    cap: 'Hourly delete/leave limit reached — try later.',
    not_connected: 'WhatsApp not connected.'
  }[reason] || (reason || 'error'));

  async function delMsg(info) {
    if (!info || !info.id) return;
    if (!confirm('Delete this message for everyone?')) return;
    const key = { id: info.id, remoteJid: info.jid, fromMe: !!info.fromMe };
    if (info.part) key.participant = info.part;
    try {
      const r = await (await fetch(WA_API + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jid: info.jid, key }) })).json();
      if (!r.ok) { alert('Could not delete: ' + guardWhy(r.reason)); return; }
      if (_activeChat) { const mr = await (await fetch(WA_API + '/messages?jid=' + encodeURIComponent(_activeChat.jid) + '&limit=200')).json(); renderMessages(mr.messages || [], _activeChat); }
    } catch (e) { alert('Error deleting: ' + e.message); }
  }

  async function renameChat() {
    const c = _activeChat; if (!c) return;
    const cur = (c.name && c.resolved) ? c.name : '';
    const nm = prompt('Custom name for this chat (dashboard only — not sent to WhatsApp).\nLeave blank to clear it.', cur);
    if (nm === null) return; // cancelled
    try {
      const r = await (await fetch(WA_API + '/chat/name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jid: c.jid, name: nm }) })).json();
      if (!r.ok) { alert('Could not rename: ' + (r.reason || 'error')); return; }
      c.name = r.name || null; c.resolved = !!r.resolved;
      const row = _chats.find(x => x.jid === c.jid);
      if (row) { row.name = c.name; row.resolved = c.resolved; }
      const title = q('wa-chat-title'); if (title) title.textContent = c.name || '(unknown)';
      renderChats();
    } catch (e) { alert('Error: ' + e.message); }
  }

  async function deleteChat() {
    const c = _activeChat; if (!c) return;
    if (c.is_group) {
      if (!confirm('Leave the group "' + (c.name || '') + '"?\n\nThis removes YOU from it (needs a re-invite to return). Cannot be undone.')) return;
      try {
        const r = await (await fetch(WA_API + '/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jid: c.jid }) })).json();
        if (!r.ok) { alert('Could not leave: ' + guardWhy(r.reason)); return; }
      } catch (e) { alert('Error: ' + e.message); return; }
    } else {
      if (!confirm('Delete the chat with "' + (c.name || '') + '"?\n\nRemoves the conversation from this dashboard (and from your phone where supported).')) return;
      try {
        const r = await (await fetch(WA_API + '/chat/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jid: c.jid }) })).json();
        if (!r.ok) { alert('Could not delete: ' + guardWhy(r.reason)); return; }
      } catch (e) { alert('Error: ' + e.message); return; }
    }
    _chats = _chats.filter(x => x.jid !== c.jid); _chatTotal = Math.max(0, _chatTotal - 1);
    renderChats(); closeChat();
  }

  // ── Settings (shared Settings tab): the send-guard limits (ban-risk firewall) ──
  async function settingsLoad() {
    const st = q('wa-set-status'); if (st) st.textContent = '';
    try {
      const r = await (await fetch(WA_API + '/settings')).json();
      const s = (r && r.settings) || {};
      if (q('wa-set-gap')) q('wa-set-gap').value = s.min_gap_sec != null ? s.min_gap_sec : 4;
      if (q('wa-set-hour')) q('wa-set-hour').value = s.hourly_cap != null ? s.hourly_cap : 20;
      if (q('wa-set-day')) q('wa-set-day').value = s.daily_cap != null ? s.daily_cap : 100;
      if (q('wa-set-contact')) q('wa-set-contact').checked = s.contact_only !== false;
      if (q('wa-set-delgap')) q('wa-set-delgap').value = s.del_min_gap_sec != null ? s.del_min_gap_sec : 4;
      if (q('wa-set-delhour')) q('wa-set-delhour').value = s.del_hourly_cap != null ? s.del_hourly_cap : 30;
    } catch (e) {
      if (st) { st.textContent = 'agent unreachable'; st.style.color = '#c0392b'; }
    }
  }

  async function settingsSave() {
    const st = q('wa-set-status');
    const body = {
      min_gap_sec: parseInt(q('wa-set-gap').value, 10),
      hourly_cap: parseInt(q('wa-set-hour').value, 10),
      daily_cap: parseInt(q('wa-set-day').value, 10),
      contact_only: !!q('wa-set-contact').checked,
      del_min_gap_sec: parseInt(q('wa-set-delgap').value, 10),
      del_hourly_cap: parseInt(q('wa-set-delhour').value, 10)
    };
    if (st) { st.textContent = 'Saving…'; st.style.color = '#64748b'; }
    try {
      const r = await (await fetch(WA_API + '/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (!r.ok) { if (st) { st.textContent = 'Save failed: ' + (r.reason || 'error'); st.style.color = '#c0392b'; } return; }
      const s = r.settings || {};
      // Reflect the agent's clamped values back into the inputs.
      if (q('wa-set-gap')) q('wa-set-gap').value = s.min_gap_sec;
      if (q('wa-set-hour')) q('wa-set-hour').value = s.hourly_cap;
      if (q('wa-set-day')) q('wa-set-day').value = s.daily_cap;
      if (q('wa-set-contact')) q('wa-set-contact').checked = s.contact_only !== false;
      if (q('wa-set-delgap')) q('wa-set-delgap').value = s.del_min_gap_sec;
      if (q('wa-set-delhour')) q('wa-set-delhour').value = s.del_hourly_cap;
      if (st) { st.textContent = '✓ Saved'; st.style.color = '#166534'; }
    } catch (e) {
      if (st) { st.textContent = 'Error: ' + e.message; st.style.color = '#c0392b'; }
    }
  }

  window.waOnShow = onShow;
  window.waRefresh = refresh;
  window.waOpenGroup = openGroup;
  window.waCloseGroup = closeGroup;
  window.waToggleGroups = toggleGroups;
  window.waLeaveGroup = leaveGroup;
  window.waFilter = renderGroups;
  window.waSettingsLoad = settingsLoad;
  window.waSettingsSave = settingsSave;
  // chats + conversation
  window.waChatSearch = chatSearch;
  window.waChatFilter = chatFilter;
  window.waToggleChats = toggleChats;
  window.waMoreChats = () => loadChats(false);
  window.waOpenChat = openChat;
  window.waOpenChatJid = openChatJid;
  window.waToggleMonitor = toggleMonitor;
  window.waCloseChat = closeChat;
  window.waSendChat = sendChat;
  window.waDelMsg = delMsg;
  window.waRenameChat = renameChat;
  window.waDeleteChat = deleteChat;
})();
