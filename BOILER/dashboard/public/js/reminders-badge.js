// Project-wide reminders badge — runs on every page (like alerts-monitor.js).
// Polls /api/reminders; if the badge is enabled AND this page is in the chosen
// page list, renders a red square top-right by the page title listing each due
// item (<User> — <pill / measurement>) with Clear / Delay. Self-injects its
// element, so it needs no per-page header markup. Settings live in Privacy →
// Settings (dashboard_settings.reminders).
(function () {
  const POLL_MS = 30000;
  const SLUG = (() => {
    let p = (location.pathname || '').split('/').pop() || 'index.html';
    if (!p) p = 'index.html';
    return p.replace(/\.html$/, '') || 'index';
  })();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let el = null;
  function ensureEl() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'reminders-badge';
    el.style.cssText = 'position:fixed;top:10px;right:14px;z-index:99999;background:#c0392b;' +
      'color:#fff;border-radius:8px;box-shadow:0 3px 12px rgba(0,0,0,.32);font-size:0.8rem;' +
      'line-height:1.25;max-width:360px;padding:8px 11px;display:none;';
    document.body.appendChild(el);
    return el;
  }
  function render(data) {
    const items = (data && data.items) || [];
    const show = data && data.enabled && Array.isArray(data.pages) && data.pages.indexOf(SLUG) !== -1 && items.length;
    const e = ensureEl();
    if (!show) { e.style.display = 'none'; e.innerHTML = ''; return; }
    e.style.display = 'block';
    e.innerHTML = '<div style="font-weight:700;margin-bottom:4px;">🔔 Reminders</div>' +
      items.map(it => `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-top:1px solid rgba(255,255,255,.28);">
        <span style="flex:1;"><b>${esc(it.user_name)}</b> — ${esc(it.label)}</span>
        <button data-rk="${esc(it.rkey)}" data-act="clear" title="Done until next time"
          style="background:#fff;color:#c0392b;border:none;border-radius:4px;cursor:pointer;font-size:0.72rem;padding:2px 7px;">Clear</button>
        <button data-rk="${esc(it.rkey)}" data-act="snooze" title="Remind again later"
          style="background:rgba(255,255,255,.22);color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:4px;cursor:pointer;font-size:0.72rem;padding:2px 7px;">Delay</button>
      </div>`).join('');
    e.querySelectorAll('button[data-rk]').forEach(b => {
      b.addEventListener('click', () => act(b.getAttribute('data-act'), b.getAttribute('data-rk')));
    });
  }
  async function poll() {
    try { const r = await fetch('/api/reminders'); render(await r.json()); } catch (e) { /* ignore */ }
  }
  async function act(which, rkey) {
    try {
      await fetch('/api/reminders/' + (which === 'clear' ? 'clear' : 'snooze'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rkey }),
      });
      // Clearing a water reminder adds +1 cup to today's row — tell the Personal
      // Health water card to refresh (if it's on this page) so it's not stale.
      if (which === 'clear' && String(rkey).startsWith('water:')) {
        window.dispatchEvent(new CustomEvent('ph-water-changed'));
      }
    } catch (e) { /* ignore */ }
    poll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poll);
  else poll();
  setInterval(poll, POLL_MS);
})();
