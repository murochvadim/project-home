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
  let listItems = [];             // current shopping-list items (for the "ברשימה" circle)
  let nodes = [];                 // animated elements: each has .el + .upd(e)->{x,y}
  let mode = 'home';              // 'home' | 'category' | 'recipes'  (the recipe list is a panel)
  let recipeCats = [], curRecipeCat = null, rsig = '';   // recipe categories (loaded lazily)
  let recipes = [], recSig = '';  // recipes (loaded lazily, listed in the recipe-category panel)
  const recItems = {};            // recipe id -> its ingredient rows, fetched once each
  let curCat = null;
  let raf = null, startT = 0, sig = '';

  const $ = id => document.getElementById(id);
  const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PALETTE = ['#2e9e5b', '#e0553f', '#e0a52e', '#4a90d9', '#9b59b6', '#e67e22',
                   '#e6608a', '#8d6e63', '#16a085', '#3f51b5', '#c0567a', '#00a5b5'];
  const catColor = i => (i < 0 ? '#7a8699' : PALETTE[i % PALETTE.length]);
  const LEFT_SAFE = 178;                 // left gutter reserved for the floating רשימה circle
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const tint = (hex, f) => {   // lighten toward white by fraction f
    const n = parseInt(hex.slice(1), 16);
    let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(r + (255 - r) * f); g = Math.round(g + (255 - g) * f); b = Math.round(b + (255 - b) * f);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  };

  async function jget(p) { const r = await fetch(p, { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
  async function jpost(p, b) { const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
  const numOf = v => (v == null ? 0 : parseFloat(v) || 0);
  const fmtN = v => { const n = +v; return Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toString(); };
  const UNIT_HE = { kg: 'ק"ג', l: 'ליטר', piece: 'יח׳', tray: 'תבנית', pack: 'חב׳', bottle: 'בקבוק', jar: 'צנצנת', tub: 'גביע', loaf: 'כיכר', bar: 'יח׳' , box: 'קופסה'};
  const unitHe = u => UNIT_HE[(u || '').toLowerCase()] || (u || '');
  // ── on-shelf season ──
  const isSeasonal = p => p && p.season_all_year === false && p.season_start_month && p.season_end_month;
  const inSeason = p => {                          // seasonal + current month outside window → false
    if (!isSeasonal(p)) return true;
    const m = new Date().getMonth() + 1, s = +p.season_start_month, e = +p.season_end_month;
    return s <= e ? (m >= s && m <= e) : (m >= s || m <= e);   // s>e wraps year-end
  };
  let panelProduct = null;

  function circleList() {
    const arr = categories.map((c, i) => ({ id: c.id, name: c.name, emoji: c.emoji, color: catColor(i) }));
    if (products.some(p => p.category_id == null)) arr.push({ id: 0, name: 'אחר', emoji: '🍽️', color: '#7a8699' });
    return arr;
  }
  const epochOf = ts => { const t = Date.parse(ts); return isNaN(t) ? '' : t; };
  // product art inside a circle: a photo (round-cropped by the circle) when set, else the emoji glyph.
  const artNode = (photo, ver, emoji, fallback) => photo
    ? `<img class="c-photo" src="/media/${encodeURIComponent(photo)}?v=${epochOf(ver)}" alt="">`
    : `<span class="c-emoji">${emoji || fallback || '🏷'}</span>`;
  const circleHTML = (cls, size, color, emoji, name, photo, ver) =>
    `<button class="circle ${cls}" style="--csize:${size}px;background:${color}">
       ${artNode(photo, ver, emoji)}${photo ? '' : `<span class="c-name">${esc(name)}</span>`}
     </button>`;   // photo present → photo only (no name); emoji tiles keep the name

  // ── HOME: bob-in-place grid ──
  function buildHome() {
    mode = 'home'; curCat = null;
    $('backbtn').hidden = true;
    $('title').textContent = '🧊 מקרר';
    buildBobGrid(circleList(), it => showCategory(it.id), 'אין קטגוריות עדיין');
  }

  // The bob-in-place grid, shared by the food home AND the מתכונים screen so the two move
  // identically by construction instead of by copy-paste. Lifted out of buildHome unchanged.
  function buildBobGrid(items, onPick, emptyMsg) {
    const stage = $('stage'), box = $('circles');
    if (!items.length) { box.innerHTML = '<div class="empty">' + emptyMsg + '</div>'; nodes = []; return; }
    const W = stage.clientWidth, H = stage.clientHeight, n = items.length;
    const UW = Math.max(80, W - LEFT_SAFE);              // content lives right of the floating circle
    let bestCell = 0, cols = 1;
    for (let c = 1; c <= n; c++) { const rows = Math.ceil(n / c); const cell = Math.min(UW / c, H / rows); if (cell > bestCell) { bestCell = cell; cols = c; } }
    const rows = Math.ceil(n / cols), cellW = UW / cols, cellH = H / rows, cell = Math.min(cellW, cellH);
    const size = Math.max(90, Math.min(Math.floor(cell * 0.55), 160));
    const amp = Math.max(6, Math.round(size * 0.13));
    box.innerHTML = items.map(c => circleHTML('cat', size, c.color, c.emoji, c.name)).join('');
    const els = [...box.querySelectorAll('.circle')];
    nodes = els.map((el, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const inRow = (row === rows - 1) ? (n - cols * (rows - 1)) : cols;
      const offX = LEFT_SAFE + (UW - inRow * cellW) / 2;
      const hx = offX + col * cellW + cellW / 2 - size / 2;
      const hy = row * cellH + cellH / 2 - size / 2;
      const wX = 0.45 + Math.random() * 0.35, wY = 0.40 + Math.random() * 0.35;
      const pX = Math.random() * 6.283, pY = Math.random() * 6.283;
      el.onclick = () => onPick(items[i]);
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
    const W = stage.clientWidth, H = stage.clientHeight, S = Math.min(W - LEFT_SAFE, H);
    const cx = LEFT_SAFE + (W - LEFT_SAFE) / 2, cy = H / 2;   // orbit centered in the right area
    const color = catColor(catId === 0 ? -1 : idx);
    const prodColor = tint(color, 0.20);
    const centerSize = Math.max(100, Math.min(Math.round(S * 0.22), 180));
    const N = list.length;
    const OMEGA = 0.02;                                   // ultra-slow revolution (~315s/turn)

    const cname = cat ? cat.name : 'אחר';
    let html = `<button class="circle center" style="--csize:${centerSize}px;background:${color}"><span class="c-name">${esc(cname)}</span></button>`;  // center = name only, no icon
    html += list.map(p => circleHTML('prod', 60, prodColor, p.emoji, p.name, p.photo_path, p.updated_at)).join('');   // size set below
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
        const prod = list[placed + j];
        el.onclick = () => openProduct(prod);
        const base = (j * 2 * Math.PI / cnt) - Math.PI / 2 + k * 0.4;
        nodes.push({ el, upd: e => { const a = base + e * om; return { x: cx + r * Math.cos(a) - prodSize / 2, y: cy + r * Math.sin(a) - prodSize / 2 }; } });
      }
      placed += cnt;
    }
  }

  // ── מתכונים (recipe categories) ────────────────────────────────────
  // Own floating circle under רשימה. Tapping it flies the RECIPE categories using the very same
  // grid as the food home (buildBobGrid). Fetched lazily — the fridge home must never wait on it.
  window.openRecipes = async function () {
    try { recipeCats = await jget('/api/kitchen/recipe-categories') || []; } catch (e) { recipeCats = []; }
    rsig = recipeCats.map(c => c.emoji + c.name).join('|');
    buildRecipes();
  };

  function buildRecipes() {
    mode = 'recipes'; curRecipeCat = null;
    $('backbtn').hidden = false;
    $('title').textContent = '📖 מתכונים';
    const items = recipeCats.map((c, i) => ({ id: c.id, name: c.name, emoji: c.emoji, color: catColor(i) }));
    buildBobGrid(items, it => showRecipeCat(it.id), 'אין קטגוריות מתכונים עדיין');
  }

  // Tapping a recipe category opens a RIGHT-SIDE panel over the flying categories — the same
  // .pp-inner shape a product uses, so it covers part of the screen, not all of it.
  // Each row is one recipe: its icon and name, plus its OWN two circles (ברשימה + one reserved).
  async function showRecipeCat(id) {
    curRecipeCat = id;
    const cat = recipeCats.find(c => c.id === id);
    $('rp-title').textContent = cat ? ((cat.emoji ? cat.emoji + ' ' : '') + 'מתכוני ' + cat.name) : 'מתכונים';
    $('rp-list').innerHTML = '';
    $('recipepanel').hidden = false;
    if (!recipes.length) await loadRecipes();
    if (curRecipeCat === id) renderRecipeRows(id);
  }
  window.closeRecipeCat = function () { $('recipepanel').hidden = true; curRecipeCat = null; };

  async function loadRecipes() {
    try { recipes = await jget('/api/kitchen/recipes') || []; } catch (e) { recipes = []; }
    // item_count is in the signature on purpose: editing only a recipe's INGREDIENTS changes
    // nothing else, and without it the cached items (and so the ברשימה count) would go stale.
    recSig = recipes.map(r => [r.id, r.category_id, r.emoji, r.name, r.item_count].join('~')).join('|');
  }

  function renderRecipeRows(id) {
    const list = recipes.filter(r => r.category_id === id);
    const box = $('rp-list');
    if (!list.length) { box.innerHTML = '<div class="rp-empty">אין מתכונים בקטגוריה זו</div>'; return; }
    // The circles sit inside the row and are placed by flexbox, not by measured pixels, so nothing
    // here can overlap or overflow on a different screen size.
    box.innerHTML = list.map(r => `<div class="rp-row" data-id="${r.id}">
        <span class="rp-emoji">${r.emoji || '📖'}</span>
        <span class="rp-name">${esc(r.name)}</span>
        <span class="rpc rp-inlist"><b class="rp-lbl">ברשימה</b><b class="rp-val" data-count="${r.id}">…</b></span>
        <span class="rpc rp-todo">?</span>
      </div>`).join('');
    paintRowCounts(list);
  }

  async function recipeItems(rid) {
    if (!recItems[rid]) {
      try { const r = await jget('/api/kitchen/recipes/' + rid); recItems[rid] = r.items || []; }
      catch (e) { recItems[rid] = []; }
    }
    return recItems[rid];
  }

  // ברשימה = how many of that recipe's ingredients are already on the shopping list. Only MATCHED
  // ingredients can count: an unmatched line has no product, so it could never be on the list.
  // Counted per distinct product, so two lines of the same product are one thing to buy.
  async function paintRowCounts(list) {
    await Promise.all(list.map(async r => {
      const items = await recipeItems(r.id);
      const need = [...new Set(items.map(i => i.product_id).filter(p => p != null))];
      const have = need.filter(pid => inListQty(pid) > 0).length;
      const el = document.querySelector('.rp-val[data-count="' + r.id + '"]');   // gone if closed
      if (el) el.textContent = have + '/' + need.length;
    }));
  }

  // One step back, not straight home: recipe category -> the flying recipe categories -> food home.
  window.goBack = function () {
    if (!$('recipepanel').hidden) { window.closeRecipeCat(); return; }   // panel -> categories
    buildHome();
  };

  // ── PRODUCT panel (opens on the right of the same screen; constant circles) ──
  async function loadList() { try { const d = await jget('/api/kitchen/list'); listItems = d.items || []; } catch (e) { } updateListBadge(); }
  const inListQty = pid => { const it = listItems.find(x => x.product_id === pid && !x.checked); return it ? numOf(it.qty) : 0; };
  const money = n => '₪' + fmtN(Math.round(numOf(n) * 100) / 100);
  const unitStepPWA = u => { u = (u || '').toLowerCase(); return (u === 'kg' || u === 'l') ? 0.5 : 1; };

  // רשימה circle in the bar — product COUNT (rows) + total price
  function updateListBadge() {
    const count = listItems.length;
    const total = listItems.reduce((s, i) => s + numOf(i.product_price) * numOf(i.qty), 0);
    const c = document.getElementById('lb-count'), pr = document.getElementById('lb-price'), dt = document.getElementById('lb-date');
    if (c) c.textContent = count;
    if (pr) pr.textContent = money(total);
    if (dt) {
      const times = listItems.map(i => i.added_at).filter(Boolean).map(t => new Date(t).getTime()).filter(t => !isNaN(t));
      if (times.length) { const d = new Date(Math.max(...times)); dt.textContent = d.getDate() + ' ' + MON[d.getMonth()]; }
      else dt.textContent = '';
    }
  }

  // ── shopping-list SCREEN (opens from the רשימה circle; +/- per product) ──
  window.openListScreen = async function () { await loadList(); renderListScreen(); $('listview').hidden = false; };
  window.closeListScreen = function () { $('listview').hidden = true; };
  window.clearListAll = async function () {
    if (!listItems.length) return;
    if (!confirm('לנקות את כל רשימת הקניות?')) return;
    try { await jpost('/api/kitchen/list/clear'); await loadList(); renderListScreen(); } catch (e) { }
  };
  function renderListScreen() {
    const box = $('lv-items');
    if (!listItems.length) { box.innerHTML = '<div class="empty">הרשימה ריקה</div>'; $('lv-total').textContent = 'מחיר 0 שיח'; return; }
    let total = 0;
    box.innerHTML = listItems.map(i => {
      const name = i.product_name || i.free_text || '(פריט)';
      const u = unitHe(i.product_unit);
      const q = numOf(i.qty), price = numOf(i.product_price);
      total += price * q;
      return `<div class="lv-row" data-id="${i.id}">
        <button class="lv-rm" data-act="rm">🗑</button>
        <span class="lv-step">
          <button data-act="dec">−</button>
          <span class="lv-qty">${fmtN(q)}${u ? ' ' + esc(u) : ''}</span>
          <button data-act="inc">+</button>
        </span>
        <span class="lv-name">${esc(name)}</span>
        <span class="lv-emoji">${i.product_photo
          ? `<img class="lv-photo" src="/media/${encodeURIComponent(i.product_photo)}?v=${epochOf(i.product_updated)}" alt="">`
          : (i.product_emoji || '🛒')}</span>
      </div>`;
    }).join('');
    $('lv-total').textContent = 'מחיר ' + fmtN(Math.round(total * 100) / 100) + ' שיח';
    box.querySelectorAll('.lv-row').forEach(row => {
      const id = +row.dataset.id, it = listItems.find(x => x.id === id);
      const step = unitStepPWA(it && it.product_unit);
      row.querySelector('[data-act=dec]').onclick = () => setListQty(id, numOf(it.qty) - step);
      row.querySelector('[data-act=inc]').onclick = () => setListQty(id, numOf(it.qty) + step);
      row.querySelector('[data-act=rm]').onclick = () => removeListItem(id);
    });
  }
  async function setListQty(id, qty) {
    qty = Math.max(0, Math.round(qty * 100) / 100);   // 0 → server removes it
    try { await jpost('/api/kitchen/list/qty', { id, qty }); await loadList(); renderListScreen(); } catch (e) { }
  }
  async function removeListItem(id) {
    try { await jpost('/api/kitchen/list/remove', { id }); await loadList(); renderListScreen(); } catch (e) { }
  }

  async function openProduct(p) { panelProduct = p; $('prodpanel').hidden = false; await loadList(); requestAnimationFrame(layoutProduct); }
  window.closeProduct = function () { panelProduct = null; $('prodpanel').hidden = true; $('pp-stage').innerHTML = ''; $('pp-toast').classList.remove('show'); };

  function layoutProduct() {
    const p = panelProduct; if (!p) return;
    const stage = $('pp-stage'); const W = stage.clientWidth, H = stage.clientHeight, S = Math.min(W, H);
    const idx = categories.findIndex(c => c.id === p.category_id);
    const color = catColor(p.category_id == null ? -1 : idx);
    const amtColor = tint(color, 0.20);
    const u = unitHe(p.unit);
    const margin = Math.max(12, Math.round(S * 0.035));
    const gap = Math.max(8, Math.round(S * 0.02));

    // main product circle — near the RIGHT edge, vertically centered
    const centerSize = Math.max(90, Math.min(Math.round(S * 0.30), 170));
    const mainX = W - margin - centerSize / 2, mainY = H / 2;

    // amounts in order קצת → הרבה מעוד; skip any set to 0
    const amounts = [
      ['קצת', numOf(p.amount_little)], ['בינוני', numOf(p.amount_medium)],
      ['הרבה', numOf(p.amount_lots)], ['הרבה מעוד', numOf(p.amount_extra)],
    ].filter(a => a[1] > 0);
    const n = amounts.length;
    const availW = (mainX - centerSize / 2 - gap) - margin;            // room to the LEFT of main
    let small = n ? Math.floor((availW - gap * (n - 1)) / n) : 0;
    small = Math.max(44, Math.min(small, Math.round(centerSize * 0.72)));
    const stockSize = Math.round(centerSize * 0.62);

    let html = `<button class="ppc center" style="--csize:${centerSize}px;left:${mainX - centerSize / 2}px;top:${mainY - centerSize / 2}px;background:${color}">
        ${artNode(p.photo_path, p.updated_at, p.emoji, '🍽️')}${p.photo_path ? '' : `<span class="c-name">${esc(p.name)}</span>`}</button>`;
    if (p.photo_path) {   // photo covers the in-circle name → show the name as a caption UNDER the circle
      const capW = Math.min(W - 2 * margin, centerSize + 60);
      const capLeft = Math.max(margin, Math.min(mainX - capW / 2, W - margin - capW));
      html += `<div class="pp-title" style="left:${capLeft}px;top:${mainY + centerSize / 2 + 8}px;width:${capW}px;">${esc(p.name)}</div>`;
    }
    // info circles above the main: stock (right) + this product's shopping-list qty (left)
    const infoTop = mainY - centerSize / 2 - gap - stockSize;
    html += `<button class="ppc small stock" style="--csize:${stockSize}px;left:${mainX - stockSize / 2}px;top:${infoTop}px;background:#5b6675">
        <span class="pp-lbl">במלאי</span><span class="pp-val">${esc(fmtN(numOf(p.qty_on_hand)) + (u ? ' ' + u : ''))}</span></button>`;
    html += `<button class="ppc small inlist" style="--csize:${stockSize}px;left:${mainX - stockSize * 1.5 - gap}px;top:${infoTop}px;background:#000">
        <span class="pp-lbl">ברשימה</span><span class="pp-val">${esc(fmtN(inListQty(p.id)) + (u ? ' ' + u : ''))}</span></button>`;
    // amounts — a row to the LEFT of main; the last (הרבה מעוד) sits nearest the main circle
    const nearestX = mainX - centerSize / 2 - gap - small / 2;
    amounts.forEach((a, k) => {
      const cxk = nearestX - (n - 1 - k) * (small + gap);
      const val = fmtN(a[1]) + (u ? ' ' + u : '');
      html += `<button class="ppc small amt" data-qty="${a[1]}" style="--csize:${small}px;left:${cxk - small / 2}px;top:${mainY - small / 2}px;background:${amtColor}">
          <span class="pp-val">${esc(val)}</span></button>`;   // amount only, no label
    });
    if (isSeasonal(p) && !inSeason(p)) {   // out of season → red "לא בעונה" blinking the whole time the panel is open
      const capW = Math.min(W - 2 * margin, centerSize + 80);
      const capLeft = Math.max(margin, Math.min(mainX - capW / 2, W - margin - capW));
      const capTop = mainY + centerSize / 2 + (p.photo_path ? 58 : 12);   // photo → clear the name caption (can wrap 2 lines)
      html += `<div class="pp-oos" style="left:${capLeft}px;top:${capTop}px;width:${capW}px;">לא בעונה</div>`;
    }
    stage.innerHTML = html;
    stage.querySelectorAll('.ppc.amt').forEach(el => { el.onclick = () => addAmount(p.id, numOf(el.dataset.qty), el); });
    const ilb = stage.querySelector('.ppc.inlist'); if (ilb) ilb.onclick = () => decFromList(p.id);   // tap ברשימה → −1
  }

  async function decFromList(pid) {
    const it = listItems.find(x => x.product_id === pid && !x.checked);
    if (!it) return;                                   // not on the list → nothing to decrease
    const newQty = Math.max(0, numOf(it.qty) - 1);     // −1 each click (0 removes it)
    try {
      await jpost('/api/kitchen/list/qty', { id: it.id, qty: newQty });
      await loadList(); if (panelProduct) layoutProduct();
      blinkListVal();
    } catch (e) { /* silent */ }
  }

  async function addAmount(pid, qty, el) {
    if (!qty || qty <= 0) qty = 1;
    try {
      await jpost('/api/kitchen/list/add', { product_id: pid, qty });   // adds that amount (bumps if already on the list)
      el.classList.add('flash'); $('pp-toast').classList.add('show');
      await loadList(); if (panelProduct) layoutProduct();              // refresh the ברשימה circle
      blinkListVal();
      setTimeout(window.closeProduct, Math.max(0, Math.round(panelReturnSec * 1000)));   // configurable return delay
    } catch (e) { /* silent on the fridge */ }
  }

  // ── one animation loop for both screens ──
  function tick(t) {
    if (!startT) startT = t;
    const e = (t - startT) / 1000;
    for (const nd of nodes) { const p = nd.upd(e); nd.el.style.transform = `translate(${p.x}px,${p.y}px)`; }
    raf = requestAnimationFrame(tick);
  }
  function startAnim() { if (raf) cancelAnimationFrame(raf); startT = 0; raf = requestAnimationFrame(tick); }

  function rebuild() {
    if (mode === 'category' && curCat != null) showCategory(curCat);
    else if (mode === 'recipes') buildRecipes();
    else buildHome();
  }

  // ── inactivity → always return to the flying-circles home ──
  let idleSec = 60, idleTimer = null, panelReturnSec = 1.5, blinkCount = 3;
  async function loadSettings() {
    try {
      const s = await jget('/api/kitchen/settings');
      if (s) {
        if (s.idle_return_sec != null) idleSec = +s.idle_return_sec || 0;
        if (s.panel_return_sec != null) panelReturnSec = +s.panel_return_sec || 0;
        if (s.blink_count != null) blinkCount = Math.max(0, parseInt(s.blink_count, 10) || 0);
      }
    } catch (e) { }
  }
  function blinkListVal() {
    const il = $('pp-stage').querySelector('.inlist .pp-val');
    if (il && blinkCount > 0) { il.style.animationIterationCount = String(blinkCount); il.classList.add('blink2'); }
  }
  function goIdleHome() {
    if (!$('prodpanel').hidden) window.closeProduct();
    if (!$('listview').hidden) window.closeListScreen();
    if (!$('recipepanel').hidden) window.closeRecipeCat();
    if (mode !== 'home') buildHome();
  }
  function resetIdle() { if (idleTimer) clearTimeout(idleTimer); if (idleSec > 0) idleTimer = setTimeout(goIdleHome, idleSec * 1000); }

  async function boot() {
    try { categories = await jget('/api/kitchen/categories') || []; } catch (e) { }
    try { products = await jget('/api/kitchen/products') || []; } catch (e) { }
    await loadList();                                   // seed the רשימה badge
    await loadSettings();                               // idle-return timeout
    sig = circleList().map(c => c.emoji + c.name).join('|');
    buildHome(); startAnim();
    ['pointerdown', 'touchstart', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, resetIdle, { passive: true }));
    resetIdle();
    let t;
    const refit = () => { rebuild(); if (panelProduct) layoutProduct(); };
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(refit, 200); });
    window.addEventListener('orientationchange', () => setTimeout(refit, 300));
    setInterval(async () => {
      try { categories = await jget('/api/kitchen/categories') || []; products = await jget('/api/kitchen/products') || []; } catch (e) { }
      const s = circleList().map(c => c.emoji + c.name).join('|');
      if (s !== sig) { sig = s; if (mode === 'home') buildHome(); }   // reflect category add/rename on home
      if (mode === 'recipes') {                                          // same for the recipe categories
        try {
          recipeCats = await jget('/api/kitchen/recipe-categories') || [];
          const r = recipeCats.map(c => c.emoji + c.name).join('|');
          if (r !== rsig) { rsig = r; if (mode === 'recipes') buildRecipes(); }
        } catch (e) { }
      }
      if (!$('recipepanel').hidden && curRecipeCat != null) {   // a recipe saved on the dashboard
        const before = recSig;
        await loadRecipes();
        if (recSig !== before) { for (const k in recItems) delete recItems[k]; renderRecipeRows(curRecipeCat); }
      }
      await loadList();                                 // keep the רשימה badge fresh
      if (!$('recipepanel').hidden && curRecipeCat != null)   // ...and the ברשימה circles with it
        paintRowCounts(recipes.filter(r => r.category_id === curRecipeCat));
      await loadSettings();                             // pick up a changed idle timeout
    }, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
