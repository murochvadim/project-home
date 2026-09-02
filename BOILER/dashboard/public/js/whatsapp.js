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
    _chatsHidden = true;    // always collapse Chats on tab entry (same as Groups)
    applyGroupsVis();
    applyChatsVis();
    if (monitorVisible()) loadRecent();   // refresh the feed immediately on tab entry
  }

  // ── Live monitor: latest INCOMING messages, auto-refresh while tab visible ──
  let _monTimer = null, _monHidden = false, _recent = [];   // rows currently shown; clicked by index
  let _msgs = [], _replyTo = null;   // open thread + the message the next send REPLIES to
  let _reactions = {};               // wa_id of the ANSWERED message -> [{emoji, from_me}]
  async function loadRecent() {
    const host = q('wa-monitor-feed'); if (!host) return;
    try {
      const r = await (await fetch(WA_API + '/recent?limit=30')).json();
      renderRecent(r.messages || []);
    } catch (e) { /* leave last render; transient */ }
  }
  function renderRecent(msgs) {
    const host = q('wa-monitor-feed'); if (!host) return;
    if (!msgs.length) { _recent = []; host.innerHTML = '<div class="wa-hint">No recent incoming messages.</div>'; return; }
    const now = Date.now();
    _recent = msgs;                     // click opens _recent[i] — see openRecent()
    host.innerHTML = msgs.map((m, i) => {
      const fresh = m.ts && (now - new Date(m.ts).getTime() < 30000) ? ' fresh' : '';
      const nm = m.chat_name || '(unknown)';
      const sender = (m.is_group && m.sender_name) ? '<span class="wa-msender">' + esc(m.sender_name) + ':</span> ' : '';
      // The row carries only its INDEX. Putting the jid/name in the attribute is how this
      // was broken: JSON.stringify(name) emits raw double quotes, which closed the
      // double-quoted onclick attribute, so every named row silently did nothing.
      // A photo/video shows its preview here too — the thumbnail came WITH the message,
      // so this costs no WhatsApp traffic. Falls back to the "📷 photo" text if absent.
      const thumb = (m.has_media && m.has_thumb)
        ? '<img src="' + mediaUrl(m.wa_id, 'thumb') + '" style="height:30px;width:30px;object-fit:cover;border-radius:5px;vertical-align:middle;margin-right:6px;">'
        : '';
      // A reaction is "<emoji> → the message it answers"; a bare 👍 tells you nothing.
      const text = m.is_reaction
        ? '<span style="font-size:1.05rem;">' + esc(m.reaction || '👍') + '</span>' +
          (m.reaction_to ? '<span style="opacity:.6;"> → ' + esc(String(m.reaction_to).slice(0, 40)) + '</span>' : '')
        : (m.has_media && m.has_thumb)
        ? (m.body ? esc(m.body) : (m.media_kind === 'video' ? '🎞 video' : '📷 photo'))
        : msgBody(m);
      return '<div class="wa-mrow' + fresh + '" onclick="waOpenRecent(' + i + ')">' +
        '<span class="wa-mtime">' + fmtTime(m.ts) + '</span>' +
        '<span class="wa-mtext">' + sender + thumb + text + '</span>' +
        '<span class="wa-mchat">' + esc(nm) + '</span></div>';
    }).join('');
    const dot = q('wa-monitor-dot'); if (dot) dot.textContent = '● live';
  }
  function monitorVisible() {
    const p = q('comm-whatsapp'), sub = q('wa-sub-chats');
    return p && p.style.display !== 'none' && document.visibilityState === 'visible' && !_monHidden
      && (!sub || sub.style.display !== 'none');   // paused on the Automation sub-tab
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
  // Chats card behaves like Groups: collapsed by default on every tab entry, staying
  // closed across page/tab moves (not persisted → can't reopen itself).
  let _chatsHidden = true;
  function applyChatsVis() {
    const list = q('wa-chats'), more = q('wa-chats-more'), btn = q('wa-chats-toggle'); if (!list) return;
    list.style.display = _chatsHidden ? 'none' : '';
    if (more) more.style.display = _chatsHidden ? 'none' : '';
    if (btn) btn.textContent = _chatsHidden ? '▸' : '▾';
  }
  function toggleChats() { _chatsHidden = !_chatsHidden; applyChatsVis(); }
  function showChatModal(on) { const m = q('wa-chat-modal'); if (m) m.style.display = on ? 'flex' : 'none'; }
  function closeChat() { showChatModal(false); _activeChat = null; }

  function openChat(idx) { openChatObj(_chats[idx]); }
  // Clicking a monitor row opens the chat AND arms a reply to THAT message, so the
  // answer is attached to what you clicked (WhatsApp shows it quoted above your text).
  function openRecent(i) {
    const m = _recent[i]; if (!m) return;
    openChatObj({ jid: m.chat_jid, name: m.chat_name || null,
                  is_group: !!m.is_group, resolved: !!m.chat_name },
                { wa_id: m.wa_id, body: m.body, type: m.type, who: m.sender_name || m.chat_name });
  }
  // ── Reply-to (quoted) ──────────────────────────────────────────────────────
  function replyBarRender() {
    const bar = q('wa-reply-bar'); if (!bar) return;
    if (!_replyTo) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    const prev = (_replyTo.body || '').slice(0, 70) || '(media)';
    bar.style.display = 'flex';
    bar.innerHTML = '<span style="color:#25D366;font-weight:700;">↩</span>' +
      '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
        (_replyTo.who ? '<b>' + esc(_replyTo.who) + ':</b> ' : '') + esc(prev) + '</span>' +
      '<span onclick="waCancelReply()" title="Cancel reply" style="cursor:pointer;color:#64748b;padding:0 4px;">✕</span>';
  }
  // Mark which bubble the next send answers. Class toggle on the live node — a
  // re-render would jump the thread back to the bottom and lose your place.
  function armHighlight(i) {
    const body = q('wa-chat-body'); if (!body) return;
    body.querySelectorAll('.wa-bubble.armed').forEach(b => b.classList.remove('armed'));
    if (i != null) {
      const el = body.querySelector('[data-bi="' + i + '"]');
      if (el) el.classList.add('armed');
    }
  }
  function replyTo(i) {
    const m = _msgs[i]; if (!m) return;
    _replyTo = { wa_id: m.wa_id, body: m.body, type: m.type, idx: i,
                 who: m.from_me ? 'You' : (m.sender_name || (_activeChat && _activeChat.name) || '') };
    replyBarRender();
    armHighlight(i);
    const inp = q('wa-chat-input'); if (inp) inp.focus();
  }
  function cancelReply() { _replyTo = null; replyBarRender(); armHighlight(null); }

  async function openChatObj(c, replyTo) {
    if (!c) return;
    _activeChat = c;
    _replyTo = replyTo && replyTo.wa_id ? replyTo : null;   // armed when opened from a monitor row
    replyBarRender();
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
      renderMessages(r.messages || [], c, r.reactions);
    } catch (e) { if (body) body.innerHTML = '<div class="wa-hint">Error loading messages.</div>'; }
  }

  // Plain one-line rendering (monitor feed): no media fetching here.
  function msgBody(m) {
    if (m.body) return esc(m.body);
    const t = m.type || '';
    if (/image/i.test(t)) return '📷 photo'; if (/video/i.test(t)) return '🎞 video';
    if (/audio|ptt/i.test(t)) return '🎙 audio'; if (/sticker/i.test(t)) return '🩹 sticker';
    if (/document/i.test(t)) return '📄 document'; if (/location/i.test(t)) return '📍 location';
    return '<i style="opacity:.6;">(' + esc(t || 'no text') + ')</i>';
  }
  // In a thread: show the preview that CAME WITH the message (free — no download) and
  // the caption. The full file is fetched only when the tile is clicked (openMedia).
  const mediaUrl = (id, what) => WA_API + '/media/' + encodeURIComponent(id) + '/' + what;
  function msgBubbleBody(m, i) {
    if (!m.has_media) return msgBody(m);
    const cap = m.body ? '<div style="margin-top:4px;">' + esc(m.body) + '</div>' : '';
    const kind = m.media_kind || 'document';
    if ((kind === 'image' || kind === 'video') && m.has_thumb) {
      const play = kind === 'video'
        ? '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:1.6rem;color:#fff;text-shadow:0 1px 4px #000;">▶</span>' : '';
      return '<div style="position:relative;display:inline-block;cursor:pointer;" onclick="waOpenMedia(' + i + ')" title="Click to open">' +
        '<img src="' + mediaUrl(m.wa_id, 'thumb') + '" style="max-width:190px;max-height:190px;border-radius:8px;display:block;">' + play + '</div>' + cap;
    }
    const label = kind === 'audio' ? '🎙 voice message' : (kind === 'video' ? '🎞 video' : (kind === 'image' ? '📷 photo' : '📄 ' + (m.file_name || 'document')));
    return '<span style="cursor:pointer;text-decoration:underline;" onclick="waOpenMedia(' + i + ')">' + esc(label) + '</span>' + cap;
  }
  // Lightbox — the ONLY place that downloads the real file.
  // ── Save a chat photo/video into the Daily Journal ─────────────────────────
  // Files it on the day the MESSAGE was sent (not today), in the journal slot nearest
  // the message time, using the journal's own upload + "Add details" prompt so both
  // pages behave identically (js/journal-media.js).
  const _J_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const _EXT_OF = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
                    'image/gif': '.gif', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/3gpp': '.mp4' };
  // The message time as {day:'YYYY-MM-DD', hm:minutes, year} in the journal's timezone.
  function _msgWhen(ts) {
    const tz = (window.activeTzFor ? window.activeTzFor('daily_journal') : 'Asia/Jerusalem');
    const d = new Date(ts);
    const day = d.toLocaleDateString('en-CA', { timeZone: tz });               // YYYY-MM-DD
    const t = d.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
    const [h, m] = t.split(':').map(Number);
    return { day, hm: h * 60 + m, hhmm: t.replace(':', ''), year: day.slice(0, 4) };
  }
  async function _journalSlotFor(hm) {
    let slots = [];
    try {
      const j = await (await fetch('/api/dashboard-settings/journal')).json();
      slots = (j && j.value && j.value.slots) || [];
    } catch (e) { /* fall through */ }
    if (!slots.length) return null;
    const mins = (s) => { const [h, m] = String(s.time_hm || '00:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    return slots.slice().sort((a, b) => Math.abs(mins(a) - hm) - Math.abs(mins(b) - hm))[0];
  }
  async function saveToJournal(i, btn) {
    const m = _msgs[i]; if (!m || !m.has_media) return;
    const say = (t, ok) => { if (btn) { btn.textContent = t; btn.style.background = ok === false ? '#c0392b' : (ok ? '#166534' : '#2b7a4b'); btn.disabled = !!ok; } };
    try {
      say('saving…');
      if (window.loadTravelSettings) { try { await window.loadTravelSettings(); } catch (e) {} }   // activeTzFor reads a preloaded cache
      const when = _msgWhen(m.ts);
      const slot = await _journalSlotFor(when.hm);
      if (!slot) { say('no journal slots configured', false); return; }
      const kind = m.media_kind === 'video' ? 'video' : 'image';
      if (m.media_kind !== 'image' && m.media_kind !== 'video') { say('only photos/videos', false); return; }
      // Already filed? (the link row is keyed by the file name, which is derived from wa_id)
      const ext = _EXT_OF[(m.mime || '').toLowerCase()] || (kind === 'video' ? '.mp4' : '.jpg');
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(when.day);
      const fname = dm[1] + '-' + _J_MONTHS[+dm[2] - 1] + '-' + dm[3] + '_' + when.hhmm + '_wa_' + m.wa_id + ext;
      let existing = [];
      try { existing = await (await fetch('/api/journal/media?user_id=1&from=' + when.day + '&to=' + when.day)).json(); } catch (e) {}
      const already = (existing || []).find(x => String(x.media_path || '').endsWith('/' + fname));
      if (already) { say('already in the journal · ' + when.day, true); return; }
      // bytes -> journal folder -> link row
      const blob = await (await fetch(mediaUrl(m.wa_id, 'full'))).blob();
      const file = new File([blob], fname, { type: m.mime || blob.type || 'application/octet-stream' });
      const path = await window.journalUploadMedia(file, when.day, fname);
      await fetch('/api/journal/media', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 1, entry_date: when.day, slot_id: slot.id, media_path: path,
                               media_type: kind, orig_name: fname }),
      });
      say('saved · ' + when.day + ' · ' + (slot.name || slot.id), true);
      // …then the journal's own Event / Year / Location / People prompt.
      try { await window.journalMediaScan(); } catch (e) {}
      const meta = await window.journalMediaMetaPrompt(fname, when.day);
      if (meta) await window.journalApplyMediaMeta(path, meta);
    } catch (e) { say('failed: ' + (e.message || 'error'), false); }
  }

  function openMedia(i) {
    const m = _msgs[i]; if (!m || !m.has_media) return;
    const url = mediaUrl(m.wa_id, 'full'), kind = m.media_kind || 'document';
    const inner = kind === 'image'
      ? '<img src="' + url + '" style="max-width:92vw;max-height:88vh;border-radius:8px;display:block;">'
      : kind === 'video'
      ? '<video src="' + url + '" controls autoplay style="max-width:92vw;max-height:88vh;border-radius:8px;display:block;background:#000;"></video>'
      : kind === 'audio'
      ? '<audio src="' + url + '" controls autoplay style="width:min(80vw,420px);"></audio>'
      : '<a href="' + url + '" target="_blank" rel="noopener" style="color:#25D366;font-weight:600;">⬇ ' + esc(m.file_name || 'download file') + '</a>';
    const ov = q('wa-media-modal'); if (!ov) return;
    const saveable = (kind === 'image' || kind === 'video');
    ov.querySelector('#wa-media-body').innerHTML =
      '<div style="color:#fff;font-size:0.8rem;margin-bottom:6px;">' + esc(m.body || m.file_name || '') + '</div>' + inner +
      '<div style="margin-top:10px;display:flex;gap:12px;align-items:center;justify-content:center;">' +
        (saveable ? '<button id="wa-media-save" onclick="waSaveToJournal(' + i + ',this)" style="padding:6px 16px;border:none;background:#2b7a4b;color:#fff;border-radius:5px;cursor:pointer;font-weight:600;">💾 Save to Journal</button>' : '') +
        '<a href="' + url + '" target="_blank" rel="noopener" style="color:#9be7b4;font-size:0.8rem;">open in a new tab</a>' +
      '</div>';
    ov.style.display = 'flex';
  }
  function closeMedia() {
    const ov = q('wa-media-modal'); if (!ov) return;
    ov.style.display = 'none';
    ov.querySelector('#wa-media-body').innerHTML = '';   // stops video/audio playback
  }

  // -- Reactions -----------------------------------------------------------
  // A reaction is not a message: it belongs UNDER the message it answers. The same emoji
  // from several people collapses into one chip with a count; yours is tinted green.
  const REACT_SET = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  function reactChips(m) {
    const list = (m.wa_id && _reactions[m.wa_id]) || [];
    if (!list.length) return '';
    const seen = {}, order = [];
    list.forEach(r => {
      if (!r.emoji) return;
      if (!seen[r.emoji]) { seen[r.emoji] = { n: 0, mine: false }; order.push(r.emoji); }
      seen[r.emoji].n++; if (r.from_me) seen[r.emoji].mine = true;
    });
    if (!order.length) return '';
    return '<div class="wa-breact">' + order.map(e =>
      '<span class="wa-rchip' + (seen[e].mine ? ' mine' : '') + '">' + esc(e) +
      (seen[e].n > 1 ? ' ' + seen[e].n : '') + '</span>').join('') + '</div>';
  }
  // Repaint ONE bubble's chips in place -- a full re-render would scroll the thread back
  // to the bottom and lose where you were reading.
  function reactRedraw(i) {
    const body = q('wa-chat-body'); if (!body) return;
    const el = body.querySelector('[data-bi="' + i + '"]'); if (!el) return;
    const html = reactChips(_msgs[i]);
    const cur = el.querySelector('.wa-breact');
    if (!html) { if (cur) cur.remove(); return; }
    if (cur) { cur.outerHTML = html; return; }
    const time = el.querySelector('.wa-btime');
    if (time) time.insertAdjacentHTML('beforebegin', html); else el.insertAdjacentHTML('beforeend', html);
  }
  function closeReactPick() { const el = document.getElementById('wa-react-pick'); if (el) el.remove(); }
  function reactPick(i, ev) {
    if (ev) ev.stopPropagation();
    closeReactPick();
    if (!_msgs[i] || !_msgs[i].wa_id) return;
    const el = document.createElement('div');
    el.id = 'wa-react-pick';
    el.innerHTML = REACT_SET.map(e => '<span data-e="' + e + '">' + e + '</span>').join('') +
      '<span data-e="" title="Remove my reaction" style="color:#64748b;font-size:0.95rem;">✕</span>';
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    const x = ev ? ev.clientX : window.innerWidth / 2, y = ev ? ev.clientY : window.innerHeight / 2;
    el.style.left = Math.max(6, Math.min(x - r.width / 2, window.innerWidth - r.width - 6)) + 'px';
    el.style.top = Math.max(6, y - r.height - 10) + 'px';
    el.onclick = (e2) => {
      const t = e2.target.closest('[data-e]'); if (!t) return;
      e2.stopPropagation();
      doReact(i, t.getAttribute('data-e'));
      closeReactPick();
    };
    setTimeout(() => document.addEventListener('click', closeReactPick, { once: true }), 0);
  }
  const reactWhy = (reason) => ({
    rate: 'Too fast -- wait a moment (reaction safety limit).',
    cap: 'Hourly reaction limit reached.',
    not_found: 'That message is not in the cache.',
    not_connected: 'WhatsApp not connected.',
  }[reason] || ('Reaction failed: ' + (reason || 'error')));
  // Show it immediately, then undo if WhatsApp refused -- an emoji tap should feel instant.
  async function doReact(i, emoji) {
    const m = _msgs[i], c = _activeChat;
    if (!m || !m.wa_id || !c) return;
    const before = (_reactions[m.wa_id] || []).slice();
    const others = before.filter(r => !r.from_me);      // one reaction per person, WhatsApp's rule
    _reactions[m.wa_id] = emoji ? others.concat([{ emoji: emoji, from_me: true }]) : others;
    reactRedraw(i);
    const sm = q('wa-chat-sendmsg');
    try {
      const r = await (await fetch(WA_API + '/react', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid: c.jid, wa_id: m.wa_id, emoji: emoji }),
      })).json();
      if (!r.ok) throw new Error(r.reason || 'error');
      if (sm) sm.textContent = '';
    } catch (e) {
      _reactions[m.wa_id] = before;
      reactRedraw(i);
      if (sm) { sm.style.color = '#c0392b'; sm.textContent = reactWhy(e.message); }
    }
  }

  function renderMessages(msgs, c, reactions) {
    _reactions = reactions || {};
    const body = q('wa-chat-body'); if (!body) return;
    if (!msgs.length) {
      body.innerHTML = '<div class="wa-hint">No messages cached yet — you can still send below.</div>'; return;
    }
    // WhatsApp mixes protocol records into a chat (key rotation, context info, edits/
    // deletes). They are not messages — before this they rendered as literal rows saying
    // "(messageContextInfo)" / "(senderKeyDistributionMessage)". Drop them, and drop a
    // reaction we can't render (only reactions stored since 2026-09-02 carry the emoji).
    const NOISE = /^(messageContextInfo|senderKeyDistributionMessage|protocolMessage|secretEncryptedMessage)$/;
    msgs = msgs.filter(m => m.body || m.has_media || !(NOISE.test(m.type || '') || m.type === 'reactionMessage'));
    _msgs = msgs;                       // the reply affordance targets this array BY INDEX
    body.innerHTML = '<div class="wa-brow">' + msgs.map((m, i) => {
      const out = !!m.from_me;
      const sender = (!out && c.is_group && m.sender_name) ? '<div class="wa-bsender">' + esc(m.sender_name) + '</div>' : '';
      const del = out ? '<span class="wa-bdel" title="Delete for everyone" onclick=\'waDelMsg(' +
        JSON.stringify({ id: m.wa_id, jid: c.jid, fromMe: true, part: m.sender_jid || null }).replace(/'/g, '&#39;') + ')\'>🗑</span>' : '';
      const rep = m.wa_id ? '<span class="wa-brep" title="Reply to this message" onclick="event.stopPropagation();waReplyTo(' + i + ')">↩</span>' : '';
      const rct = m.wa_id ? '<span class="wa-bmoji" title="React to this message" onclick="waReactPick(' + i + ',event)">😊</span>' : '';
      // Clicking the message ARMS a reply to it — any message in the thread, not just the
      // newest. A media bubble keeps click = open the photo/video (otherwise you could
      // never view it), so those are answered via their ↩.
      const arm = (m.wa_id && !m.has_media) ? ' onclick="waReplyTo(' + i + ')" style="cursor:pointer;"' : '';
      return '<div class="wa-bubble ' + (out ? 'out' : 'in') + '" data-bi="' + i + '"' + arm + '>' + sender + msgBubbleBody(m, i) + reactChips(m) + rct + rep + del +
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
      const payload = { jid: c.jid, text };
      if (_replyTo && _replyTo.wa_id) payload.quoted_id = _replyTo.wa_id;   // reply to THAT message
      const r = await (await fetch(WA_API + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
      if (!r.ok) {
        const why = { rate: 'Too fast — wait a few seconds (safety limit).', cap: 'Hourly/daily send limit reached.', not_contact: 'Not in your contacts (blocked by contact-only).', not_connected: 'WhatsApp not connected.' }[r.reason] || ('Failed: ' + (r.reason || 'error'));
        if (sm) { sm.style.color = '#c0392b'; sm.textContent = why; }
        return;
      }
      inp.value = '';
      cancelReply();                    // the quote applies to that one message only
      if (sm) sm.textContent = '';
      // reload the thread to show the sent message
      const mr = await (await fetch(WA_API + '/messages?jid=' + encodeURIComponent(c.jid) + '&limit=200')).json();
      renderMessages(mr.messages || [], c, mr.reactions);
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
      if (_activeChat) { const mr = await (await fetch(WA_API + '/messages?jid=' + encodeURIComponent(_activeChat.jid) + '&limit=200')).json(); renderMessages(mr.messages || [], _activeChat, mr.reactions); }
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
      if (q('wa-set-reactgap')) q('wa-set-reactgap').value = s.react_min_gap_sec != null ? s.react_min_gap_sec : 2;
      if (q('wa-set-reacthour')) q('wa-set-reacthour').value = s.react_hourly_cap != null ? s.react_hourly_cap : 60;
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
      del_hourly_cap: parseInt(q('wa-set-delhour').value, 10),
      react_min_gap_sec: parseInt(q('wa-set-reactgap').value, 10),
      react_hourly_cap: parseInt(q('wa-set-reacthour').value, 10)
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
      if (q('wa-set-reactgap')) q('wa-set-reactgap').value = s.react_min_gap_sec;
      if (q('wa-set-reacthour')) q('wa-set-reacthour').value = s.react_hourly_cap;
      if (st) { st.textContent = '✓ Saved'; st.style.color = '#166534'; }
    } catch (e) {
      if (st) { st.textContent = 'Error: ' + e.message; st.style.color = '#c0392b'; }
    }
  }

  // ── Automation (rules in dashboard_settings.whatsapp.rules) — mirror of Email ──
  let _rules = [], _warSenders = [], _remindersEnabled = true;
  const warCsv = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  const csv = (a) => (a || []).join(', ');
  function warStatus(t) { const s = q('war-status'); if (s) s.textContent = t; }

  async function warLoad() {
    try { const r = await (await fetch('/api/dashboard-settings/whatsapp.rules')).json();
      _rules = Array.isArray(r.value) ? r.value : []; } catch (e) { _rules = []; }
    try { const s2 = await (await fetch(WA_API + '/automation/senders')).json(); _warSenders = s2.senders || []; } catch (e) { _warSenders = []; }
    try { const rr = await (await fetch('/api/dashboard-settings/reminders')).json(); _remindersEnabled = !(rr && rr.value && rr.value.enabled === false); } catch (e) { _remindersEnabled = true; }
    warStatus(''); warRender(); warLoadLog();
  }
  // From-picker: one entry per PERSON, A→Z, from /automation/senders. The option's
  // LABEL is the name you know them by; the VALUE is their identity id — because a
  // display name is not what arrives in a message (WhatsApp sends an anonymized @lid
  // that carries only the sender's profile name, never your address-book name), so a
  // name-valued pick silently never matched. The id always does, and the agent treats
  // a person's @lid and phone number as the same identity.
  function warFromPicker(i, scope) {
    const opts = _warSenders
      .filter(c => scope === 'all' ? true : (scope === 'groups' ? c.is_group : !c.is_group))
      .map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + (c.is_group ? ' 👥' : '') + '</option>').join('');
    return '<select title="pick who this rule listens to" onchange="warPickFrom(' + i + ',this.value);this.selectedIndex=0" style="max-width:190px;">' +
      '<option value="">➕ pick…</option>' + opts + '</select>';
  }
  // The From field holds an ID (the only thing that reliably matches — a saved contact
  // name never travels with a WhatsApp message), so WHO the rule listens to is shown
  // right under it, big and green. An unknown id falls back to its raw value so a stale
  // entry is never invisible.
  function warFromHint(m) {
    const froms = (m.from || []).filter(Boolean);
    if (!froms.length) return '';
    const label = froms.map(f => {
      const hit = _warSenders.find(s2 => s2.id === f || (s2.ids || []).includes(f));
      return hit ? esc(hit.name) : esc(f);
    }).join(', ');
    return '<div class="war-row" style="margin-top:3px;"><span class="war-lbl"></span>' +
      '<span style="font-size:15px;font-weight:700;color:#166534;margin-left:16px;">' + label + '</span></div>';
  }
  function warPickFrom(i, val) {
    if (!val || !_rules[i]) return;
    const from = _rules[i].match.from || (_rules[i].match.from = []);
    if (!from.includes(val)) from.push(val);
    warStatus('● unsaved'); warRender();
  }
  function warNew() {
    _rules.push({ id: 'wrule_' + Date.now(), name: 'New rule', active: true, mode: 'dryrun',
      match: { from: [], contains: [], scope: 'people' }, reply: null, popup: { text: '' } });
    warStatus('● unsaved'); warRender();
  }
  function warEdit(i, fn) { if (_rules[i]) { fn(_rules[i]); warStatus('● unsaved'); } }
  function warDel(i) { if (!confirm('Delete this rule?')) return; _rules.splice(i, 1); warStatus('● unsaved'); warRender(); }

  function warRender() {
    const host = q('war-rules'); if (!host) return;
    if (!_rules.length) { host.innerHTML = '<div class="wa-hint">No rules yet. Click "+ New rule".</div>'; return; }
    host.innerHTML = _rules.map((r, i) => {
      const m = r.match || {}, rep = r.reply || {}, pop = r.popup;
      const W = 'width:calc(50% - 74px);';   // every field input reaches the card middle
      return '<div class="war-rule ' + (r.mode === 'live' ? 'live' : 'dryrun') + '">' +
        '<div class="war-row">' +
          '<span class="war-lbl">Name</span><input type="text" value="' + esc(r.name || '') + '" placeholder="Rule name" style="width:calc(50% - 74px);min-width:150px;" onchange="warEdit(' + i + ',x=>x.name=this.value)">' +
          '<label style="font-size:0.82rem;"><input type="checkbox" ' + (r.active !== false ? 'checked' : '') + ' onchange="warEdit(' + i + ',x=>x.active=this.checked)"> active</label>' +
          '<select onchange="warEdit(' + i + ',x=>x.mode=this.value);waRerenderRules()">' +
            '<option value="dryrun"' + (r.mode !== 'live' ? ' selected' : '') + '>Test (dry-run)</option>' +
            '<option value="live"' + (r.mode === 'live' ? ' selected' : '') + '>LIVE</option>' +
          '</select>' +
          '<button class="btn btn-secondary btn-sm" onclick="warTest(' + i + ')">Test</button>' +
          '<button class="wa-del" title="Delete rule" onclick="warDel(' + i + ')">🗑</button>' +
        '</div>' +
        '<div class="war-row"><span class="war-lbl">From</span><input type="text" value="' + esc(csv(m.from)) + '" placeholder="anyone (or pick →)" style="' + W + '" onchange="warEdit(' + i + ',x=>x.match.from=waCsv(this.value))">' + warFromPicker(i, m.scope || 'people') +
          '<select onchange="warEdit(' + i + ',x=>x.match.scope=this.value);waRerenderRules()">' +
            ['all', 'people', 'groups'].map(s => '<option value="' + s + '"' + ((m.scope || 'people') === s ? ' selected' : '') + '>' + s + '</option>').join('') +
          '</select></div>' + warFromHint(m) +
        '<div class="war-row"><span class="war-lbl">Contains</span><input type="text" value="' + esc(csv(m.contains)) + '" placeholder="keywords" style="' + W + '" onchange="warEdit(' + i + ',x=>x.match.contains=waCsv(this.value))"></div>' +
        '<div class="war-row"><span class="war-lbl">↩ Reply</span><input type="text" value="' + esc(rep.text || '') + '" placeholder="auto-reply text (blank = no reply)" style="' + W + '" onchange="warEdit(' + i + ',x=>x.reply=this.value.trim()?{text:this.value}:null)"><span class="war-warn">⚠ auto-sends a real WhatsApp reply from your number</span></div>' +
        '<div class="war-row"><span class="war-lbl">🔔 Popup</span><input type="text" value="' + esc(pop ? (pop.text || '') : '') + '" placeholder="optional line shown above the message (blank = message only)" style="' + W + '"' + (pop ? '' : ' disabled') + ' onchange="warEdit(' + i + ',x=>{if(!x.popup)x.popup={};x.popup.text=this.value})">' +
          '<label style="font-size:0.82rem;white-space:nowrap;"><input type="checkbox" ' + (pop ? 'checked' : '') + ' onchange="warEdit(' + i + ',x=>x.popup=this.checked?{text:(x.popup&&x.popup.text)||String()}:null);waRerenderRules()"> show a popup</label>' +
          (_remindersEnabled
            ? '<span style="font-size:0.78rem;font-weight:600;color:#166534;white-space:nowrap;margin-left:18px;">Show Popup enabled in Reminders</span>'
            : '<span style="font-size:0.78rem;font-weight:600;color:#c0392b;white-space:nowrap;margin-left:18px;">Show Popup disabled in Reminders</span>') +
        '</div>' +
      '</div>';
    }).join('');
  }

  async function warSave() {
    try {
      await fetch('/api/dashboard-settings/whatsapp.rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: _rules }) });
      warStatus('✓ saved');
    } catch (e) { warStatus('save failed: ' + e.message); }
  }
  async function warTest(i) {
    const rule = _rules[i]; if (!rule) return; warStatus('testing…');
    try {
      const r = await (await fetch(WA_API + '/automation/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rule }) })).json();
      if (!r.ok) { warStatus('test error'); return; }
      const eg = r.matches[0] ? ' — e.g. ' + (r.matches[0].from_name || r.matches[0].chat_jid) : '';
      warStatus('Test: ' + r.matches.length + ' of last ' + r.scanned + ' messages match' + eg);
      // If the rule has a popup, show a live preview of it in the reminders card (top-right).
      if (rule.popup) {
        await fetch(WA_API + '/automation/test-popup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rule }) });
        warStatus('Test: ' + r.matches.length + ' match' + (r.matches.length === 1 ? '' : 'es') + ' · 🔔 popup preview shown top-right (Clear it there)');
      }
    } catch (e) { warStatus('test error: ' + e.message); }
  }
  async function warRunNow() {
    if (!confirm('Run rules against recent messages?\n\nThis is a PREVIEW — it logs what rules WOULD do and sends NOTHING (no replies, no popups).')) return;
    warStatus('running…');
    try {
      const r = await (await fetch(WA_API + '/automation/run-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 200 }) })).json();
      warStatus('Preview: scanned ' + r.scanned + ', logged ' + r.logged); warLoadLog();
    } catch (e) { warStatus('run error: ' + e.message); }
  }
  // How many log rows to show — remembered per browser so it survives navigation.
  function warLogSize() {
    const v = parseInt(localStorage.getItem('wa.logLimit'), 10);
    return [10, 20, 50].includes(v) ? v : 10;
  }
  function warLogLimit(v) {
    localStorage.setItem('wa.logLimit', String(parseInt(v, 10) || 10));
    warLoadLog();
  }
  async function warLoadLog() {
    const host = q('war-log'); if (!host) return;
    const lim = warLogSize();
    const sel = q('war-log-limit'); if (sel) sel.value = String(lim);
    try {
      const r = await (await fetch(WA_API + '/automation/log?limit=' + lim)).json();
      const rows = r.log || [];
      if (!rows.length) { host.innerHTML = '<div class="wa-hint">No activity yet.</div>'; return; }
      host.innerHTML = '<table class="war-table"><thead><tr><th>When</th><th>Rule</th><th>From</th><th>Message</th><th>Do</th><th>Mode</th><th>Note</th></tr></thead><tbody>' +
        rows.map(x => '<tr><td>' + esc(fmtTime(x.ts)) + '</td><td>' + esc(x.rule_name || '') + '</td><td>' + esc(x.from_name || x.chat_jid || '') + '</td><td>' + esc((x.matched_text || '').slice(0, 50)) + '</td><td>' + esc(x.action || '') + '</td><td><span class="war-pill ' + (x.mode === 'live' ? 'live' : 'dryrun') + '">' + esc(x.mode || '') + '</span></td><td>' + esc(x.note || '') + '</td></tr>').join('') +
        '</tbody></table>';
    } catch (e) { host.innerHTML = '<div class="wa-hint">Log unavailable.</div>'; }
  }
  function subTab(name, btn) {
    const chats = q('wa-sub-chats'), auto = q('wa-sub-automation');
    if (chats) chats.style.display = name === 'chats' ? '' : 'none';
    if (auto) auto.style.display = name === 'automation' ? '' : 'none';
    document.querySelectorAll('.wa-subtab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    if (name === 'automation') warLoad();
  }

  window.waSubTab = subTab;
  window.warNew = warNew; window.warEdit = warEdit; window.warDel = warDel;
  window.warSave = warSave; window.warDiscard = warLoad; window.warTest = warTest;
  window.warRunNow = warRunNow; window.warLogLimit = warLogLimit; window.waCsv = warCsv; window.waRerenderRules = warRender;
  window.warPickFrom = warPickFrom;
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
  window.waOpenRecent = openRecent;
  window.waToggleMonitor = toggleMonitor;
  window.waCloseChat = closeChat;
  window.waSendChat = sendChat;
  window.waReplyTo = replyTo; window.waCancelReply = cancelReply;
  window.waReactPick = reactPick;
  window.waOpenMedia = openMedia; window.waCloseMedia = closeMedia;
  window.waSaveToJournal = saveToJournal;
  window.waDelMsg = delMsg;
  window.waRenameChat = renameChat;
  window.waDeleteChat = deleteChat;
})();
