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

  async function openGroup(jid) {
    _activeJid = jid; renderGroups();
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
      if (_activeJid === jid) { _activeJid = null; const d = q('wa-detail'); if (d) d.innerHTML = '<div class="wa-hint">✓ Left the group. Select another to view.</div>'; }
      renderGroups();
    } catch (e) { alert('Error leaving group: ' + e.message); }
  }

  async function refresh() {
    const el = q('wa-status'); if (el) el.textContent = 'WhatsApp: refreshing groups…';
    try { await fetch(WA_API + '/groups/refresh', { method: 'POST' }); } catch (e) {}
    await loadStatus(); await loadGroups();
  }

  function onShow() {
    loadStatus();
    if (!_shown) { _shown = true; loadGroups(); }
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
      contact_only: !!q('wa-set-contact').checked
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
      if (st) { st.textContent = '✓ Saved'; st.style.color = '#166534'; }
    } catch (e) {
      if (st) { st.textContent = 'Error: ' + e.message; st.style.color = '#c0392b'; }
    }
  }

  window.waOnShow = onShow;
  window.waRefresh = refresh;
  window.waOpenGroup = openGroup;
  window.waLeaveGroup = leaveGroup;
  window.waFilter = renderGroups;
  window.waSettingsLoad = settingsLoad;
  window.waSettingsSave = settingsSave;
})();
