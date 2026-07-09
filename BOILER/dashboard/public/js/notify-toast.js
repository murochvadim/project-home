// Project-wide notification popup — a small corner card (same style/height as the
// Medical reminders/water popup). It is MEASURED, not hardcoded: it always sits
// just to the LEFT of the daily-journal popup (#journal-capture). When the journal
// is showing it snugs to its real left edge; when hidden it computes the journal's
// reserved slot (400px, left of the reminders/water badge — mirrors
// reminders-badge.js's own math) and sits there. It never uses the top-right
// corner, so it can never land where the water/reminders badge is. NOT a
// full-screen modal. Polls /api/notifications/feed and pops one card per fired
// notification targeted at this page. Per-browser cursor in localStorage so each
// event shows ONCE (history isn't replayed; a first load still shows anything
// fired in the last 90 s so a fresh notification survives a refresh).
//
// A `set_people` notification is interactive: the card shows a number input
// pre-filled with the calculated count + Save that writes the manual people
// count (POST /api/main-agent/manual-people) — same as Main Agent → Home Activity.
//
// Producers: the LXC rule engine (RULES/rules/notifications.py). Pure rendering.
(function () {
  const POLL_MS = 10000;
  const AUTODISMISS_MS = 12000;
  const CURSOR_KEY = 'notifyToast.cursor';
  const SLUG = (() => {
    let p = (location.pathname || '').split('/').pop() || 'index.html';
    return p.replace(/\.html$/, '') || 'index';
  })();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ACCENT = { info: '#2b4c7e', warn: '#e67e22', alert: '#c0392b' };

  let card = null, _timer = null, _posTimer = null;
  const _queue = [];
  let _showing = false;

  const CARD_W = 320, GAP = 12;

  function ensureCard() {
    if (card) return;
    card = document.createElement('div');
    card.id = 'notify-toast';
    // Metrics matched to the reminders badge + journal popup (font 0.82rem, ~8px
    // padding, box-shadow 0 3px 12px rgba(0,0,0,.32)). positionCard() anchors it by
    // `right` so its right edge sits just left of the journal — never right:14px
    // (the water/reminders corner). left:14px here is only an initial value.
    card.style.cssText = 'position:fixed; top:10px; left:14px; z-index:99997; display:none; ' +
      'width:' + CARD_W + 'px; max-width:min(' + CARD_W + 'px,90vw); border-radius:10px; ' +
      'box-shadow:0 3px 12px rgba(0,0,0,.32); color:#fff; font-size:0.82rem; overflow:hidden;';
    document.body.appendChild(card);
    window.addEventListener('resize', () => { if (_showing) positionCard(); });
    // React the INSTANT the water/reminders badge or journal popup shows, hides,
    // or resizes (they toggle their inline `style.display`) — so we re-flow with
    // zero lag instead of waiting for a poll. Only acts while we're visible.
    try {
      const mo = new MutationObserver(() => { if (_showing) positionCard(); });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    } catch (e) { /* ignore */ }
  }

  // DETERMINISTIC placement — sit on the LEFT SIDE of the daily-journal popup.
  // The journal popup (#journal-capture) is the teal card top-center-right; the
  // water/reminders badge is to ITS right. So placing ourselves just left of the
  // journal's left edge keeps us on the far side from water — no overlap, ever.
  // If the journal isn't showing, fall back to the top-LEFT corner (still never
  // the top-right water corner).
  const JOURNAL_W = 400;   // #journal-capture fixed width (reminders-badge.js)
  function positionCard() {
    if (!card) return;
    card.style.top = '10px';
    card.style.left = 'auto';
    const j = document.querySelector('#journal-capture');
    const jVisible = j && j.style.display !== 'none' && j.getBoundingClientRect().width > 0;
    let jLeft;
    if (jVisible) {
      jLeft = j.getBoundingClientRect().left;
    } else {
      // Journal not currently shown — compute where its LEFT edge WOULD be so we
      // still sit right beside it (it's right-anchored, 400px wide, left of the
      // reminders badge; mirrors reminders-badge.js's own math).
      const b = document.querySelector('#reminders-badge');
      const bw = (b && b.style.display !== 'none') ? b.getBoundingClientRect().width : 0;
      const journalRight = bw ? (bw + 14 + 12) : 14;
      jLeft = window.innerWidth - journalRight - JOURNAL_W;
    }
    // Snug: our RIGHT edge sits GAP px left of the journal's left edge.
    card.style.right = Math.round(window.innerWidth - jLeft + GAP) + 'px';
  }

  function dismiss() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    if (_posTimer) { clearInterval(_posTimer); _posTimer = null; }
    if (card) card.style.display = 'none';
    _showing = false;
    if (_queue.length) setTimeout(showNext, 250);
  }

  async function savePeople(inp) {
    const raw = (inp.value || '').trim();
    const body = raw === '' ? { value: null } : { value: parseInt(raw, 10) };
    try {
      await fetch('/api/main-agent/manual-people', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (typeof window.loadState === 'function') window.loadState();
    } catch (e) { /* ignore */ }
    dismiss();
  }

  function showNext() {
    if (_showing || !_queue.length) return;
    ensureCard();
    const ev = _queue.shift();
    const accent = ACCENT[ev.level] || ACCENT.info;
    const data = ev.data || {};
    const isSet = data.action === 'set_people';
    const cur = (data.people_home != null) ? data.people_home : '';

    card.style.background = accent;
    card.innerHTML =
      '<div style="display:flex; align-items:center; gap:8px; padding:7px 11px; font-weight:700; line-height:1.25;">' +
        '<span style="flex:1;">' + esc(ev.title || 'Notification') + '</span>' +
        '<span id="nt-x" style="cursor:pointer; opacity:.85; font-size:1rem; line-height:1;">&times;</span>' +
      '</div>' +
      '<div style="background:#fff; color:#222; padding:8px 11px;">' +
        '<div style="font-size:0.9rem; line-height:1.3;' + (isSet ? ' margin-bottom:8px;' : '') + '">' + esc(ev.body) + '</div>' +
        (isSet ?
          '<label style="display:block; font-size:0.76rem; color:#555; margin-bottom:4px;">People at home:</label>' +
          '<div style="display:flex; gap:7px;">' +
            '<input id="nt-people" type="number" min="0" value="' + esc(cur) + '" ' +
            'style="flex:1; min-width:0; padding:5px 8px; font-size:1rem; text-align:center; border:1px solid #cdd3da; border-radius:5px;">' +
            '<button id="nt-save" style="background:' + accent + '; color:#fff; border:none; border-radius:5px; padding:0 14px; font-size:0.84rem; cursor:pointer;">Save</button>' +
          '</div>'
          : '') +
      '</div>';

    card.style.display = 'block';
    _showing = true;
    positionCard();
    // Re-measure continuously while visible: the reminders badge (water) + journal
    // popup render on their OWN async polls, so they may appear/resize/vanish after
    // us — keep re-flowing left of them every 300 ms so we can never overlap.
    if (_posTimer) clearInterval(_posTimer);
    _posTimer = setInterval(positionCard, 300);
    card.querySelector('#nt-x').addEventListener('click', dismiss);
    if (isSet) {
      const inp = card.querySelector('#nt-people');
      card.querySelector('#nt-save').addEventListener('click', () => savePeople(inp));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') savePeople(inp); });
      inp.focus(); inp.select();
      // interactive → no auto-dismiss; wait for Save or ×
    } else {
      _timer = setTimeout(dismiss, AUTODISMISS_MS);
    }
  }

  function pageWants(ev) {
    const s = ev.surfaces || {};
    if (s.popup === false) return false;
    const pages = s.pages;
    if (!pages || pages === 'all') return true;
    return Array.isArray(pages) && pages.indexOf(SLUG) !== -1;
  }

  async function poll() {
    let cursor = parseInt(localStorage.getItem(CURSOR_KEY));
    const since = Number.isFinite(cursor) ? cursor : 0;
    let data;
    try {
      const r = await fetch('/api/notifications/feed?since=' + since);
      data = await r.json();
    } catch (e) { return; }
    if (!data) return;
    // First load on this browser (or after a refresh): still show anything fired
    // in the last 90 s so a fresh notification is visible on reload — then set the
    // cursor. (Older history is not replayed.)
    if (!Number.isFinite(cursor)) {
      const nowSec = Date.now() / 1000;
      const fresh = (data.events || []).filter(e => !e.expired && pageWants(e) && (nowSec - Number(e.ts_epoch || 0) < 90));
      for (const ev of fresh) _queue.push(ev);
      localStorage.setItem(CURSOR_KEY, String(data.max_id || 0));
      if (_queue.length) showNext();
      return;
    }
    if (_showing) positionCard();   // journal/badge may have appeared/moved
    const events = (data.events || []).filter(e => !e.expired && pageWants(e));
    for (const ev of events) _queue.push(ev);
    const seenMax = Math.max(since, ...(data.events || []).map(e => e.id));
    localStorage.setItem(CURSOR_KEY, String(seenMax));
    if (_queue.length) showNext();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poll);
  else poll();
  setInterval(poll, POLL_MS);
  // Let the Notifications tab's ▶ Test ask for an immediate check.
  window.addEventListener('notify-toast-poll', poll);
})();
