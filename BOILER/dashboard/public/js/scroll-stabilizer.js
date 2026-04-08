// Prevents scroll jumps when content above the viewport changes height.
// Works for any element: tables, status grids, dynamic text, etc.
window._scrollStabilizerPaused = false;
(function () {
  if (typeof ResizeObserver === 'undefined') return;

  const prevHeights = new WeakMap();

  const ro = new ResizeObserver(entries => {
    if (window._scrollStabilizerPaused) return;
    // Never move scroll when window doesn't have focus —
    // avoids unwanted scrolls while user is in another app.
    if (!document.hasFocus()) return;
    if (window.scrollY < 1) return; // Already at top, nothing to preserve

    for (const entry of entries) {
      const el     = entry.target;
      const newH   = entry.contentRect.height;
      const oldH   = prevHeights.get(el);
      prevHeights.set(el, newH);

      if (oldH === undefined) continue; // First observation — baseline only
      const delta = newH - oldH;
      if (Math.abs(delta) < 1) continue; // No meaningful change

      // Compensate whenever the element's TOP is above the viewport.
      // If the card starts above the viewport (even if its bottom is visible),
      // its growth shifts all content below — we must scroll to compensate.
      const top = el.getBoundingClientRect().top;
      if (top < 0) {
        window.scrollBy(0, delta);
      }
    }
  });

  function seed(selector) {
    document.querySelectorAll(selector).forEach(el => {
      prevHeights.set(el, el.getBoundingClientRect().height);
      ro.observe(el);
    });
  }

  // Observe the card containers — any content change inside a card
  // (tables, status items, badges) will be reflected in the card's height.
  seed('.card');
}());
