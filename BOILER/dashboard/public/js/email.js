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
    const r = await fetch(API + path, { cache: 'no-store' });
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
            <button class="btn btn-secondary btn-sm" onclick="emTrash('${id}')">🗑 Delete</button>
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

  async function emTrash(id) {
    if (!confirm('Move this email to Trash? (recoverable in Gmail for ~30 days)')) return;
    try { await jpost('/api/email/' + encodeURIComponent(id) + '/trash'); } catch (e) {}
    document.getElementById('email-read').innerHTML = '<div class="em-hint">Moved to Trash. Select a message to read.</div>';
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

  // ==================== automation ====================
  // Rules stored in dashboard_settings.email.rules via the DASHBOARD (same-origin)
  // endpoint; the agent reads the same key. Extractions + log come from the LXC API.
  let _rules = [], _rulesDirty = false, _autoLoaded = false, _setLoaded = false;

  function fmtDT(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('he-IL',
      { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  }
  function erDirty(on) { _rulesDirty = on; document.getElementById('er-dirty').style.display = on ? 'inline' : 'none'; }

  function emShowTab(name, btn) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    btn.classList.add('active');
    if (name === 'automation' && !_autoLoaded) { _autoLoaded = true; erLoadExtractions(); erLoadLog(); }
    if (name === 'settings' && !_setLoaded) { _setLoaded = true; esLoad(); }
  }

  async function esLoad() {
    try {
      const d = await (await fetch('/api/dashboard-settings/email.settings', { cache: 'no-store' })).json();
      const s = (d && d.value) || {};
      document.getElementById('es-trash-days').value = s.trash_spam_after_days || 0;
    } catch (e) {}
  }
  async function esSave() {
    const days = Math.max(0, Math.min(60, parseInt(document.getElementById('es-trash-days').value) || 0));
    const st = document.getElementById('es-status');
    st.style.color = '#64748b'; st.textContent = 'Saving…';
    try {
      const r = await fetch('/api/dashboard-settings/email.settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: { trash_spam_after_days: days } }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      st.style.color = '#1e7e34';
      st.textContent = days > 0 ? ('✓ Saved — spam → Trash after ' + days + ' days') : '✓ Saved — off';
    } catch (e) { st.style.color = '#c0392b'; st.textContent = 'Save failed: ' + e.message; }
  }

  async function erLoad() {
    try {
      const d = await (await fetch('/api/dashboard-settings/email.rules', { cache: 'no-store' })).json();
      _rules = Array.isArray(d.value) ? d.value : [];
    } catch (e) { _rules = []; }
    erDirty(false); erRender();
  }
  function erNew() {
    _rules.push({ id: 'erule_' + Date.now(), name: 'New rule', active: true, mode: 'dryrun',
      match: { from: [] }, disposition: 'trash', extract: [] });
    erDirty(true); erRender();
  }
  function erDelete(i) { if (confirm('Delete this rule?')) { _rules.splice(i, 1); erDirty(true); erRender(); } }
  function erSet(i, k, v) {
    const r = _rules[i];
    if (k === 'from' || k === 'contains') {
      r.match = r.match || {};
      r.match[k] = String(v).split(',').map(s => s.trim()).filter(Boolean);
    } else r[k] = v;
    erDirty(true);
  }
  function erAddField(i) { (_rules[i].extract = _rules[i].extract || []).push({ field: '', pattern: '', source: 'body' }); erDirty(true); erRender(); }
  function erDelField(i, j) { _rules[i].extract.splice(j, 1); erDirty(true); erRender(); }
  function erSetField(i, j, k, v) { _rules[i].extract[j][k] = v; erDirty(true); }

  function renderRule(i) {
    const r = _rules[i];
    const live = r.mode === 'live';
    const froms = ((r.match || {}).from || []).join(', ');
    const contains = ((r.match || {}).contains || []).join(', ');
    const fields = (r.extract || []).map((f, j) => `
        <div class="er-xf">
          <input type="text" placeholder="field name" value="${esc(f.field)}" style="width:110px" onchange="erSetField(${i},${j},'field',this.value)">
          <input type="text" placeholder="regex (1st group = value)" value="${esc(f.pattern)}" style="width:250px" onchange="erSetField(${i},${j},'pattern',this.value)">
          <select onchange="erSetField(${i},${j},'source',this.value)">
            <option value="body"${f.source !== 'subject' ? ' selected' : ''}>body</option>
            <option value="subject"${f.source === 'subject' ? ' selected' : ''}>subject</option>
          </select>
          <button class="btn btn-secondary btn-sm" onclick="erDelField(${i},${j})">×</button>
        </div>`).join('');
    return `<div class="er-rule ${live ? 'live' : 'dryrun'}">
        <div class="er-head">
          <input type="text" value="${esc(r.name)}" style="width:150px;font-weight:600" onchange="erSet(${i},'name',this.value)">
          <input type="text" value="${esc(r.group || '')}" placeholder="group…" title="Group name — rules sharing a group collapse together" style="width:95px" onchange="erSet(${i},'group',this.value);erRender()">
          <label style="font-size:0.8rem"><input type="checkbox" ${r.active ? 'checked' : ''} onchange="erSet(${i},'active',this.checked)"> active</label>
          <select onchange="erSet(${i},'mode',this.value)" title="dry-run only logs; LIVE acts">
            <option value="dryrun"${!live ? ' selected' : ''}>dry-run</option>
            <option value="live"${live ? ' selected' : ''}>LIVE</option>
          </select>
          <span class="er-pill ${live ? 'live' : 'dryrun'}">${live ? 'live' : 'dry-run'}</span>
          <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="erTest(${i})">▶ Test</button>
          <button class="btn btn-secondary btn-sm" onclick="erDelete(${i})">× Delete</button>
        </div>
        <div class="er-row"><span class="er-lbl">From has</span>
          <input type="text" style="flex:1;min-width:200px" placeholder="sender substrings, comma-separated (e.g. @promo.x.com, newsletter@)" value="${esc(froms)}" onchange="erSet(${i},'from',this.value)"></div>
        <div class="er-row"><span class="er-lbl">Text has</span>
          <input type="text" style="flex:1;min-width:200px" placeholder="optional — email must ALSO contain this text (subject / preview / body); comma = OR" value="${esc(contains)}" onchange="erSet(${i},'contains',this.value)"></div>
        <div class="er-row"><span class="er-lbl">Then</span>
          <select onchange="erSet(${i},'disposition',this.value)">
            <option value="trash"${r.disposition === 'trash' ? ' selected' : ''}>Trash the email (recoverable)</option>
            <option value="spam"${r.disposition === 'spam' ? ' selected' : ''}>Mark as Spam</option>
            <option value="archive"${r.disposition === 'archive' ? ' selected' : ''}>Archive (keep, out of inbox)</option>
            <option value="keep"${r.disposition === 'keep' ? ' selected' : ''}>Keep in inbox</option>
          </select></div>
        <div class="er-row" style="align-items:flex-start"><span class="er-lbl">Extract</span>
          <div style="flex:1">${fields || '<span style="font-size:0.78rem;color:#8a93a6">none (optional)</span>'}
            <div><button class="btn btn-secondary btn-sm" style="margin-top:5px" onclick="erAddField(${i})">+ field</button></div></div></div>
        <div id="er-test-${i}" style="font-size:0.8rem;color:#64748b;margin-top:6px"></div>
      </div>`;
  }

  function erToggleGroup(enc) {
    const g = decodeURIComponent(enc), key = 'email.rg.' + g;
    localStorage.setItem(key, localStorage.getItem(key) === '1' ? '0' : '1');
    erRender();
  }

  function erRender() {
    const el = document.getElementById('er-list');
    if (!_rules.length) { el.innerHTML = '<div class="em-hint">No rules yet — click <b>+ Rule</b>.</div>'; return; }
    // group rules by their .group field (first-seen order); rules with no group → "Ungrouped"
    const groups = {}, order = [];
    _rules.forEach((r, i) => {
      const g = ((r.group || '').trim()) || 'Ungrouped';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(i);
    });
    // no groups assigned anywhere → flat list (no collapsible headers)
    if (order.length === 1 && order[0] === 'Ungrouped') {
      el.innerHTML = groups['Ungrouped'].map(renderRule).join('');
      return;
    }
    el.innerHTML = order.map(g => {
      const collapsed = localStorage.getItem('email.rg.' + g) === '1';
      const body = groups[g].map(renderRule).join('');
      return `<div class="er-group">
        <div class="er-group-head" onclick="erToggleGroup('${encodeURIComponent(g)}')">
          <span class="er-caret">${collapsed ? '▸' : '▾'}</span> ${esc(g)}
          <span style="color:#8a93a6;font-weight:400;font-size:0.8rem;"> (${groups[g].length})</span>
        </div>
        <div style="${collapsed ? 'display:none' : 'padding:8px 10px'}">${body}</div>
      </div>`;
    }).join('');
  }

  async function erSave() {
    try {
      const r = await fetch('/api/dashboard-settings/email.rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: _rules }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      erDirty(false);
    } catch (e) { alert('Save failed: ' + e.message); }
  }
  function erDiscard() { erLoad(); }

  async function erRunNow() {
    if (_rulesDirty && !confirm('You have unsaved rule changes — Run now uses the SAVED rules. Save first, or continue with saved?')) return;
    if (!confirm('Apply your LIVE rules to recent inbox mail now?\nMatching mail will be moved (Spam/Trash/Archive — recoverable); dry-run rules only log. Already-actioned mail is skipped.')) return;
    try {
      const d = await jpost('/api/email/automation/run-now', {});
      alert('Run complete — scanned ' + d.scanned + ' recent emails:\n  ' + d.applied + ' acted (live rules)\n  ' + d.logged + ' logged (dry-run).');
      erLoadExtractions(); erLoadLog();
    } catch (e) { alert('Run failed: ' + e.message); }
  }

  async function erTest(i) {
    const box = document.getElementById('er-test-' + i);
    box.textContent = 'Testing against recent inbox…';
    try {
      const d = await jpost('/api/email/automation/test', { rule: _rules[i] });
      if (!d.matches || !d.matches.length) { box.textContent = 'No matches in the last ~80 messages.'; return; }
      box.innerHTML = `<b>${d.count}</b> match(es) — would <b>${esc(d.disposition || 'keep')}</b>:<br>` +
        d.matches.slice(0, 6).map(m => '• ' + esc((m.from || '').slice(0, 42)) + ' — ' + esc((m.subject || '').slice(0, 50)) +
          (Object.keys(m.extracted || {}).length ? ' → <span style="color:#166534">' + esc(JSON.stringify(m.extracted)) + '</span>' : '')).join('<br>');
    } catch (e) { box.textContent = 'Test failed: ' + e.message; }
  }

  async function erLoadExtractions() {
    const el = document.getElementById('er-extractions');
    try {
      const d = await jget('/api/email/extractions?limit=100');
      const rows = d.rows || [];
      if (!rows.length) { el.innerHTML = '<div class="em-hint">No extracted data yet.</div>'; return; }
      el.innerHTML = '<table class="er-table"><tr><th>When</th><th>Rule</th><th>From</th><th>Subject</th><th>Data</th></tr>' +
        rows.map(r => `<tr><td>${fmtDT(r.extracted_at)}</td><td>${esc(r.rule_name || '')}</td>
          <td>${esc(shortFrom(r.from_addr))}</td><td>${esc((r.subject || '').slice(0, 48))}</td>
          <td><code>${esc(JSON.stringify(r.data))}</code></td></tr>`).join('') + '</table>';
    } catch (e) { el.innerHTML = '<div class="em-hint">Could not load.</div>'; }
  }
  async function erLoadLog() {
    const el = document.getElementById('er-log');
    const sel = document.getElementById('er-log-limit');
    const limit = sel ? sel.value : '20';
    try {
      const d = await jget('/api/email/automation-log?limit=' + limit);
      const rows = d.rows || [];
      if (!rows.length) { el.innerHTML = '<div class="em-hint">No activity yet.</div>'; return; }
      el.innerHTML = '<table class="er-table"><tr><th>When</th><th>Rule</th><th>From</th><th>Do</th><th>Mode</th><th>Applied</th><th>Extracted</th></tr>' +
        rows.map(r => `<tr><td>${fmtDT(r.ts)}</td><td>${esc(r.rule_name || '')}</td>
          <td>${esc(shortFrom(r.from_addr))}</td><td>${esc(r.disposition || '')}</td>
          <td><span class="er-pill ${r.mode === 'live' ? 'live' : 'dryrun'}">${esc(r.mode || '')}</span></td>
          <td>${r.applied ? '✓' : '—'}</td>
          <td>${r.extracted ? '<code>' + esc(JSON.stringify(r.extracted)) + '</code>' : ''}</td></tr>`).join('') + '</table>';
    } catch (e) { el.innerHTML = '<div class="em-hint">Could not load.</div>'; }
  }

  window.addEventListener('beforeunload', (e) => { if (_rulesDirty) { e.preventDefault(); e.returnValue = ''; } });

  window.emShowTab = emShowTab;
  window.erNew = erNew; window.erDelete = erDelete; window.erSet = erSet;
  window.erAddField = erAddField; window.erDelField = erDelField; window.erSetField = erSetField;
  window.erSave = erSave; window.erDiscard = erDiscard; window.erTest = erTest; window.erRunNow = erRunNow; window.erToggleGroup = erToggleGroup;
  window.erLoadExtractions = erLoadExtractions; window.erLoadLog = erLoadLog;
  window.esLoad = esLoad; window.esSave = esSave;

  window.emOpen = emOpen; window.emArchive = emArchive; window.emTrash = emTrash; window.emMarkRead = emMarkRead;
  window.emCompose = emCompose; window.emReply = emReply; window.emCloseCompose = emCloseCompose;
  window.emSend = emSend; window.emReload = emReload;

  window.addEventListener('DOMContentLoaded', () => {
    emReload();
    erLoad();                            // rules for the always-visible top toolbar
    setInterval(loadMessages, 30000);   // light auto-refresh
  });
})();
