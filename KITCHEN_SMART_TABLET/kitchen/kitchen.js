// Kitchen fridge PWA — Steps 1+2.
// Served same-origin by kitchen_service.py on LXC 113 (relative URLs, no CORS).
//
// HOME  : one circle per category in a tidy grid, each gently "bobbing in place".
// TAP a circle -> CATEGORY screen: that category circle in the MIDDLE, its products
//                orbiting around it in a slow ring (same gentle speed). Back arrow returns.
// (Tapping a product does nothing yet — that's Step 3.)
(function () {
  let categories = [];
  let products = [];
  let nodes = [];                 // animated elements: each has .el + .upd(e)->{x,y}
  let mode = 'home';              // 'home' | 'category'
  let curCat = null;
  let raf = null, startT = 0, sig = '';

  const $ = id => document.getElementById(id);
  const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PALETTE = ['#2e9e5b', '#e0553f', '#e0a52e', '#4a90d9', '#9b59b6', '#e67e22',
                   '#e6608a', '#8d6e63', '#16a085', '#3f51b5', '#c0567a', '#00a5b5'];
  const catColor = i => (i < 0 ? '#7a8699' : PALETTE[i % PALETTE.length]);
  const tint = (hex, f) => {   // lighten toward white by fraction f
    const n = parseInt(hex.slice(1), 16);
    let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(r + (255 - r) * f); g = Math.round(g + (255 - g) * f); b = Math.round(b + (255 - b) * f);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  };

  async function jget(p) { const r = await fetch(p, { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

  function circleList() {
    const arr = categories.map((c, i) => ({ id: c.id, name: c.name, emoji: c.emoji, color: catColor(i) }));
    if (products.some(p => p.category_id == null)) arr.push({ id: 0, name: 'אחר', emoji: '🍽️', color: '#7a8699' });
    return arr;
  }
  const circleHTML = (cls, size, color, emoji, name) =>
    `<button class="circle ${cls}" style="--csize:${size}px;background:${color}">
       <span class="c-emoji">${emoji || '🏷'}</span><span class="c-name">${esc(name)}</span>
     </button>`;

  // ── HOME: bob-in-place grid ──
  function buildHome() {
    mode = 'home'; curCat = null;
    $('backbtn').hidden = true;
    $('title').textContent = '🧊 מקרר';
    const stage = $('stage'), box = $('circles');
    const items = circleList();
    if (!items.length) { box.innerHTML = '<div class="empty">אין קטגוריות עדיין</div>'; nodes = []; return; }
    const W = stage.clientWidth, H = stage.clientHeight, n = items.length;
    let bestCell = 0, cols = 1;
    for (let c = 1; c <= n; c++) { const rows = Math.ceil(n / c); const cell = Math.min(W / c, H / rows); if (cell > bestCell) { bestCell = cell; cols = c; } }
    const rows = Math.ceil(n / cols), cellW = W / cols, cellH = H / rows, cell = Math.min(cellW, cellH);
    const size = Math.max(90, Math.min(Math.floor(cell * 0.55), 160));
    const amp = Math.max(6, Math.round(size * 0.13));
    box.innerHTML = items.map(c => circleHTML('cat', size, c.color, c.emoji, c.name)).join('');
    const els = [...box.querySelectorAll('.circle')];
    nodes = els.map((el, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const inRow = (row === rows - 1) ? (n - cols * (rows - 1)) : cols;
      const offX = (W - inRow * cellW) / 2;
      const hx = offX + col * cellW + cellW / 2 - size / 2;
      const hy = row * cellH + cellH / 2 - size / 2;
      const wX = 0.45 + Math.random() * 0.35, wY = 0.40 + Math.random() * 0.35;
      const pX = Math.random() * 6.283, pY = Math.random() * 6.283;
      el.onclick = () => showCategory(items[i].id);
      return { el, upd: e => ({ x: hx + amp * Math.sin(e * wX + pX), y: hy + amp * Math.cos(e * wY + pY) }) };
    });
  }

  // ── CATEGORY: center circle + products orbiting around it ──
  function showCategory(catId) {
    mode = 'category'; curCat = catId;
    const idx = categories.findIndex(c => c.id === catId);
    const cat = categories.find(c => c.id === catId);
    $('backbtn').hidden = false;
    $('title').textContent = cat ? ((cat.emoji ? cat.emoji + ' ' : '') + cat.name) : 'אחר';
    buildCategory(catId, idx, cat);
  }
  window.showHome = buildHome;

  function buildCategory(catId, idx, cat) {
    const stage = $('stage'), box = $('circles');
    const list = products.filter(p => (catId === 0 ? p.category_id == null : p.category_id === catId));
    const W = stage.clientWidth, H = stage.clientHeight, S = Math.min(W, H);
    const cx = W / 2, cy = H / 2;
    const color = catColor(catId === 0 ? -1 : idx);
    const prodColor = tint(color, 0.20);
    const centerSize = Math.max(100, Math.min(Math.round(S * 0.22), 180));
    const N = list.length;
    const OMEGA = 0.03;                                   // ultra-slow revolution (~210s/turn)

    const cname = cat ? cat.name : 'אחר';
    let html = `<button class="circle center" style="--csize:${centerSize}px;background:${color}"><span class="c-name">${esc(cname)}</span></button>`;  // center = name only, no icon
    html += list.map(p => circleHTML('prod', 60, prodColor, p.emoji, p.name)).join('');   // size set below
    if (!N) html += '<div class="empty" style="bottom:12%;top:auto">אין מוצרים בקטגוריה זו</div>';
    box.innerHTML = html;
    const els = [...box.querySelectorAll('.circle')];

    nodes = [{ el: els[0], upd: () => ({ x: cx - centerSize / 2, y: cy - centerSize / 2 }) }];  // static center
    if (!N) return;

    // ── spread products over 1–3 concentric rings so they never cram / go tiny ──
    let ringCount = N <= 8 ? 1 : (N <= 18 ? 2 : 3);
    ringCount = Math.max(1, Math.min(ringCount, N));
    const perRing = Math.ceil(N / ringCount);
    let prov = Math.max(46, Math.min(Math.round((2 * Math.PI * (S * 0.40) / perRing) * 0.70), 112));
    const rOuter = S / 2 - prov / 2 - 8;
    const rInner = Math.min(rOuter, centerSize / 2 + prov / 2 + Math.max(10, Math.round(S * 0.02)));
    const radii = [];
    for (let k = 0; k < ringCount; k++) radii.push(ringCount === 1 ? (rInner + rOuter) / 2 : rInner + (rOuter - rInner) * k / (ringCount - 1));
    // per-ring counts ∝ radius (outer rings hold more)
    let counts;
    if (ringCount === 1) { counts = [N]; }
    else {
      const tot = radii.reduce((a, b) => a + b, 0);
      counts = radii.map(r => Math.max(1, Math.floor(N * r / tot)));
      let s = counts.reduce((a, b) => a + b, 0), k = ringCount - 1;
      while (s < N) { counts[k]++; s++; k = (k - 1 + ringCount) % ringCount; }
      while (s > N) { if (counts[k] > 1) { counts[k]--; s--; } k = (k - 1 + ringCount) % ringCount; }
    }
    // final product size = tightest ring's spacing (and radial gap), floored for readability
    let prodSize = prov;
    radii.forEach((r, k) => { if (counts[k] > 0) prodSize = Math.min(prodSize, (2 * Math.PI * r / counts[k]) * 0.72); });
    if (ringCount > 1) prodSize = Math.min(prodSize, ((rOuter - rInner) / (ringCount - 1)) * 0.86);
    prodSize = Math.max(44, Math.round(prodSize));
    els.forEach((el, i) => { if (i > 0) el.style.setProperty('--csize', prodSize + 'px'); });

    let placed = 0;
    for (let k = 0; k < ringCount; k++) {
      const cnt = counts[k], r = radii[k], om = OMEGA;   // all rings turn the same way — clockwise
      for (let j = 0; j < cnt; j++) {
        const el = els[1 + placed + j];
        const base = (j * 2 * Math.PI / cnt) - Math.PI / 2 + k * 0.4;
        nodes.push({ el, upd: e => { const a = base + e * om; return { x: cx + r * Math.cos(a) - prodSize / 2, y: cy + r * Math.sin(a) - prodSize / 2 }; } });
      }
      placed += cnt;
    }
  }

  // ── one animation loop for both screens ──
  function tick(t) {
    if (!startT) startT = t;
    const e = (t - startT) / 1000;
    for (const nd of nodes) { const p = nd.upd(e); nd.el.style.transform = `translate(${p.x}px,${p.y}px)`; }
    raf = requestAnimationFrame(tick);
  }
  function startAnim() { if (raf) cancelAnimationFrame(raf); startT = 0; raf = requestAnimationFrame(tick); }

  function rebuild() { if (mode === 'category' && curCat != null) showCategory(curCat); else buildHome(); }

  async function boot() {
    try { categories = await jget('/api/kitchen/categories') || []; } catch (e) { }
    try { products = await jget('/api/kitchen/products') || []; } catch (e) { }
    sig = circleList().map(c => c.emoji + c.name).join('|');
    buildHome(); startAnim();
    let t;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(rebuild, 200); });
    window.addEventListener('orientationchange', () => setTimeout(rebuild, 300));
    setInterval(async () => {
      try { categories = await jget('/api/kitchen/categories') || []; products = await jget('/api/kitchen/products') || []; } catch (e) { }
      const s = circleList().map(c => c.emoji + c.name).join('|');
      if (s !== sig) { sig = s; if (mode === 'home') buildHome(); }   // reflect category add/rename on home
    }, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
