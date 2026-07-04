// Project-wide reminders badge — runs on every page (like alerts-monitor.js).
// Polls /api/reminders; if enabled AND this page is in the chosen page list,
// renders a fixed top-right row: [journal capture panel] [red reminders badge].
// The red badge lists due items (pills / weight-BP / water / exercise) with
// Clear/Delay. Journal items (kind:'journal') render in the WIDE teal panel to
// its LEFT — an RTL Hebrew note + a 😞→😄 mood + Save/Skip/Later. Settings live
// in Privacy → Settings (dashboard_settings.reminders + .journal).
(function () {
  const POLL_MS = 30000;
  const MOODS = ['😞', '😕', '😐', '🙂', '😄'];   // 1..5
  const SLUG = (() => {
    let p = (location.pathname || '').split('/').pop() || 'index.html';
    if (!p) p = 'index.html';
    return p.replace(/\.html$/, '') || 'index';
  })();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Two INDEPENDENT fixed elements — the red badge stays exactly where it always
  // sits (top:10px right:14px); the journal panel is positioned a MEASURED
  // distance to its LEFT each render, so they can never overlap.
  let badgeEl = null, journalEl = null, _jsig = '';
  function ensureEls() {
    if (badgeEl) return;
    badgeEl = document.createElement('div');
    badgeEl.id = 'reminders-badge';
    badgeEl.style.cssText = 'position:fixed;top:10px;right:14px;z-index:99999;display:none;background:#c0392b;' +
      'color:#fff;border-radius:8px;box-shadow:0 3px 12px rgba(0,0,0,.32);font-size:0.8rem;line-height:1.25;max-width:360px;padding:8px 11px;';
    journalEl = document.createElement('div');
    journalEl.id = 'journal-capture';
    journalEl.style.cssText = 'position:fixed;top:10px;right:14px;z-index:99998;display:none;background:#0f766e;' +
      'color:#fff;border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,.32);width:400px;max-width:min(400px,90vw);padding:10px 12px;font-size:0.82rem;';
    document.body.appendChild(badgeEl);
    document.body.appendChild(journalEl);
  }

  function renderBadge(items) {
    if (!items.length) { badgeEl.style.display = 'none'; badgeEl.innerHTML = ''; return; }
    badgeEl.style.display = 'block';
    badgeEl.innerHTML = '<div style="font-weight:700;margin-bottom:4px;">🔔 Reminders</div>' +
      items.map(it => `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-top:1px solid rgba(255,255,255,.28);">
        <span style="flex:1;"><b>${esc(it.user_name)}</b> — ${esc(it.label)}</span>
        <button data-rk="${esc(it.rkey)}" data-act="clear" title="Done until next time"
          style="background:#fff;color:#c0392b;border:none;border-radius:4px;cursor:pointer;font-size:0.72rem;padding:2px 7px;">Clear</button>
        <button data-rk="${esc(it.rkey)}" data-act="snooze" title="Remind again later"
          style="background:rgba(255,255,255,.22);color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:4px;cursor:pointer;font-size:0.72rem;padding:2px 7px;">Delay</button>
      </div>`).join('');
    badgeEl.querySelectorAll('button[data-rk]').forEach(b => {
      b.addEventListener('click', () => act(b.getAttribute('data-act'), b.getAttribute('data-rk')));
    });
  }

  function renderJournal(items) {
    // Signature guard: don't re-render (and clobber what the user is typing) while
    // the same set of journal slots is due — only rebuild when a slot appears/goes.
    const sig = items.map(i => i.rkey).sort().join('|');
    if (!items.length) { journalEl.style.display = 'none'; journalEl.innerHTML = ''; _jsig = ''; return; }
    if (sig === _jsig && journalEl.style.display !== 'none') return;
    _jsig = sig;
    journalEl.style.display = 'block';
    journalEl.innerHTML = items.map(it => `
      <div class="jrn-item" data-rk="${esc(it.rkey)}" data-uid="${esc(it.user_id)}"
           data-sid="${esc(it.slot_id)}" data-sname="${esc(it.slot_name)}" data-date="${esc(it.entry_date)}"
           style="padding:4px 0;">
        <div style="font-weight:700;margin-bottom:6px;">📓 ${esc(it.slot_name || 'Journal')} · <span style="opacity:.85;font-weight:400;">${esc(it.entry_date)}</span></div>
        <textarea dir="rtl" rows="4" placeholder="מה קרה היום?…"
          style="width:100%;box-sizing:border-box;resize:vertical;border:none;border-radius:6px;padding:7px 9px;font-size:0.92rem;line-height:1.4;color:#0b3b37;background:#f0fdfa;"></textarea>
        <div class="jrn-mood" style="display:flex;gap:4px;justify-content:center;margin:8px 0;">
          ${MOODS.map((m, i) => `<button type="button" data-mood="${i + 1}" title="${i + 1}/5"
            style="font-size:1.35rem;line-height:1;background:rgba(255,255,255,.12);border:2px solid transparent;border-radius:8px;cursor:pointer;padding:2px 5px;">${m}</button>`).join('')}
        </div>
        <div style="display:flex;gap:6px;">
          <button data-jact="save"  style="flex:1;background:#fff;color:#0f766e;border:none;border-radius:5px;cursor:pointer;font-weight:700;font-size:0.8rem;padding:5px 0;">💾 שמור</button>
          <button data-jact="skip"  style="background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:5px;cursor:pointer;font-size:0.78rem;padding:5px 9px;">דלג</button>
          <button data-jact="later" style="background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:5px;cursor:pointer;font-size:0.78rem;padding:5px 9px;">אחר כך</button>
        </div>
      </div>`).join('');
    journalEl.querySelectorAll('.jrn-item').forEach(el => {
      el.querySelectorAll('.jrn-mood button').forEach(mb => mb.addEventListener('click', () => {
        el.dataset.mood = mb.getAttribute('data-mood');
        el.querySelectorAll('.jrn-mood button').forEach(b => { b.style.borderColor = 'transparent'; b.style.background = 'rgba(255,255,255,.12)'; });
        mb.style.borderColor = '#fff'; mb.style.background = 'rgba(255,255,255,.32)';
      }));
      el.querySelector('[data-jact="save"]').addEventListener('click', () => jSave(el));
      el.querySelector('[data-jact="skip"]').addEventListener('click', () => act('clear', el.dataset.rk));
      el.querySelector('[data-jact="later"]').addEventListener('click', () => act('snooze', el.dataset.rk));
    });
  }

  async function jSave(el) {
    const comment = (el.querySelector('textarea').value || '').trim();
    const mood = el.dataset.mood ? parseInt(el.dataset.mood) : null;
    if (!comment && !mood) { el.querySelector('textarea').focus(); return; }
    try {
      await fetch('/api/journal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: el.dataset.uid, entry_date: el.dataset.date,
          slot_id: el.dataset.sid, slot_name: el.dataset.sname, comment, mood,
        }),
      });
      window.dispatchEvent(new CustomEvent('ph-journal-changed'));
    } catch (e) { /* ignore */ }
    _jsig = '';        // force a rebuild so the saved slot drops off
    poll();
  }

  function render(data) {
    ensureEls();
    const all = (data && data.items) || [];
    const on = data && data.enabled && Array.isArray(data.pages) && data.pages.indexOf(SLUG) !== -1;
    if (!on) { badgeEl.style.display = 'none'; journalEl.style.display = 'none'; return; }
    const journalItems = all.filter(i => i.kind === 'journal');
    const badgeItems = all.filter(i => i.kind !== 'journal');
    renderBadge(badgeItems);       // sets badgeEl display + content
    renderJournal(journalItems);   // sets journalEl display + content
    // Park the journal panel to the LEFT of the red badge (measure its width so
    // they never overlap). If the badge isn't showing, the journal takes the corner.
    if (journalEl.style.display !== 'none') {
      const bw = (badgeEl.style.display !== 'none') ? badgeEl.getBoundingClientRect().width : 0;
      journalEl.style.right = (bw ? Math.round(bw + 14 + 12) : 14) + 'px';
    }
  }

  async function poll() {
    try { const r = await fetch('/api/reminders'); render(await r.json()); } catch (e) { /* ignore */ }
  }
  async function act(which, rkey) {
    try {
      await fetch('/api/reminders/' + (which === 'clear' ? 'clear' : 'snooze'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rkey }),
      });
      if (which === 'clear' && String(rkey).startsWith('water:')) {
        window.dispatchEvent(new CustomEvent('ph-water-changed'));
      }
    } catch (e) { /* ignore */ }
    _jsig = '';
    poll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poll);
  else poll();
  setInterval(poll, POLL_MS);
})();
