// Kitchen Agent — dashboard controller.
// Calls the LXC 113 kitchen_service.py CRUD API DIRECTLY (cross-origin) — NO server.js
// business logic (architecture-guard safe). Same pattern as js/email.js.
(function () {
  const API = 'http://192.168.1.208:8772';   // LXC 113 kitchen-service (http; Caddy/HTTPS deferred to home)

  let products = [];
  let listItems = [];
  let categories = [];
  let recipeCats = [];   // recipe categories (own table, separate from the food categories)

  // ── product-photo editor (square crop + zoom + pan → 400×400 JPEG) ──
  const PE_V = 320, PE_OUT = 400;          // viewport px / output px
  let _peImg = null, _peScale = 1, _peMin = 1, _peOx = 0, _peOy = 0, _peUrl = null, _peDrag = null;

  const $ = id => document.getElementById(id);
  const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const UNIT_HE = { kg: 'ק"ג', l: 'ליטר', piece: 'יח׳', tray: 'תבנית', pack: 'חבילה', bottle: 'בקבוק', jar: 'צנצנת', tub: 'גביע', loaf: 'כיכר', bar: 'חטיף' , box: 'קופסה'};
  const unitHe = u => UNIT_HE[(u || '').toLowerCase()] || (u || '');
  const numOf = v => (v == null ? 0 : parseFloat(v) || 0);
  const fmtN = v => { const n = +v; return Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toString(); };
  const unitStep = u => { u = (u || '').toLowerCase(); return (u === 'kg' || u === 'l' || u.includes('ק') || u.includes('ליטר')) ? 0.5 : 1; };
  const epochOf = ts => { const t = Date.parse(ts); return isNaN(t) ? '' : t; };
  // product art, dropped INSIDE each render site's existing emoji wrapper:
  //  - photo present → a round <img> that sizes itself (class default k-thumb)
  //  - else → the emoji glyph string (parent's font-size renders it)
  const artHtml = (photo, upd, emoji, cls) => photo
    ? `<img class="${cls || 'k-thumb'}" src="${API}/media/${encodeURIComponent(photo)}?v=${epochOf(upd)}" alt="">`
    : (emoji || '🍽️');
  const prodArt = (p, cls) => artHtml(p && p.photo_path, p && p.updated_at, p && p.emoji, cls);
  // ── on-shelf season ──
  const MON_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const isSeasonal = p => p && p.season_all_year === false && p.season_start_month && p.season_end_month;
  const inSeason = (p, m) => {                     // m = 1..12; not seasonal → always in season
    if (!isSeasonal(p)) return true;
    const s = +p.season_start_month, e = +p.season_end_month;
    return s <= e ? (m >= s && m <= e) : (m >= s || m <= e);   // s>e wraps year-end
  };
  const seasonCell = p => {                        // Season table cell — only when a season is set
    if (!isSeasonal(p)) return '';
    const on = inSeason(p, new Date().getMonth() + 1);
    const range = `${MON_HE[p.season_start_month - 1]}–${MON_HE[p.season_end_month - 1]}`;
    return `<span class="k-season ${on ? 'on' : 'off'}" title="${esc(range)}">${on ? 'בעונה' : 'לא בעונה'}</span>`;
  };

  async function jget(p) {
    const r = await fetch(API + p, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function jpost(p, b) {
    const r = await fetch(API + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b || {}),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ── tabs ──
  window.kTab = function (name, btn) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.k-tab').forEach(b => b.classList.remove('active'));
    $('tab-' + name).classList.add('active');
    if (btn) btn.classList.add('active');
  };

  // ── products ──
  async function loadProducts() {
    try { products = await jget('/api/kitchen/products') || []; }
    catch (e) { products = []; $('p-rows').innerHTML =
      `<tr><td colspan="6" style="color:#ef5a6a">Can't reach kitchen service (${esc(e.message)}) — ${API}</td></tr>`; return; }
    renderProducts();
    if (categories.length) { renderCategories(); renderStock(); renderAmounts(); renderCommon(); }   // keep counts/stock/amounts/common fresh
  }

  function renderProducts() {
    const tb = $('p-rows');
    $('p-count').textContent = `${products.length} product${products.length === 1 ? '' : 's'}`;
    if (!products.length) { tb.innerHTML = '<tr><td colspan="6" class="k-hint">No products yet — add one above.</td></tr>'; return; }
    const catIds = categories.map(c => c.id);
    const groups = {};
    products.forEach(p => { const k = (p.category_id == null ? 0 : p.category_id); (groups[k] = groups[k] || []).push(p); });
    const order = [...catIds, 0].filter((v, i, a) => a.indexOf(v) === i);
    let html = '';
    order.forEach(cid => {
      const list = groups[cid]; if (!list || !list.length) return;
      const cat = categories.find(c => c.id === cid);
      const label = cat ? (cat.emoji ? cat.emoji + ' ' : '') + cat.name : '— ללא קטגוריה —';
      html += `<tr><td colspan="6" class="k-cat-cell">${esc(label)}</td></tr>`;
      html += list.map(p => `
        <tr data-id="${p.id}">
          <td class="k-emoji">${prodArt(p)}</td>
          <td style="text-align:center;padding-left:24px">${seasonCell(p)}</td>
          <td class="heb">${esc(p.name)}</td>
          <td>${esc(unitHe(p.unit))}</td>
          <td>${p.price != null ? '₪' + (+p.price).toFixed(2).replace(/\.00$/, '') : ''}</td>
          <td style="white-space:nowrap;text-align:right">
            <button class="k-edit" data-act="edit" title="Edit">✎</button>
            <button class="k-x" data-act="del" title="Delete">🗑</button>
          </td>
        </tr>`).join('');
    });
    tb.innerHTML = html;
    tb.querySelectorAll('tr[data-id]').forEach(row => {
      const id = +row.dataset.id;
      const eb = row.querySelector('[data-act=edit]'); if (eb) eb.onclick = () => editProduct(id);
      const db = row.querySelector('[data-act=del]');  if (db) db.onclick = () => delProduct(id);
    });
  }

  function editProduct(id) {
    const p = products.find(x => x.id === id); if (!p) return;
    $('p-id').value = p.id;
    $('p-name').value = p.name || '';
    $('p-emoji').value = p.emoji || '';
    $('p-category').value = p.category_id || '';
    $('p-unit').value = p.unit || 'piece';
    $('p-price').value = p.price != null ? p.price : '';
    $('p-barcode').value = p.barcode || '';
    $('p-allyear').checked = p.season_all_year !== false;
    $('p-season-from').value = p.season_start_month || '';
    $('p-season-to').value = p.season_end_month || '';
    kSeasonToggle();
    $('pform-title').textContent = 'Edit: ' + (p.name || '');
    refreshFormPhoto();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  window.kResetForm = function () {
    ['p-id', 'p-name', 'p-emoji', 'p-unit', 'p-price', 'p-barcode'].forEach(i => $(i).value = '');
    $('p-category').value = '';
    $('p-allyear').checked = true;
    $('p-season-from').value = ''; $('p-season-to').value = '';
    kSeasonToggle();
    $('pform-title').textContent = 'Add product';
    refreshFormPhoto();
  };

  window.kSeasonToggle = function () {   // disable the month pickers while "כל השנה" (always) is checked
    const off = $('p-allyear').checked;
    $('p-season-from').disabled = off; $('p-season-to').disabled = off;
  };

  window.kSaveProduct = async function () {
    const name = $('p-name').value.trim();
    if (!name) { alert('Name (Hebrew) is required.'); return; }
    const allYear = $('p-allyear').checked;
    const body = {
      name,
      emoji: $('p-emoji').value.trim() || null,
      category_id: $('p-category').value ? +$('p-category').value : null,
      unit: $('p-unit').value.trim() || null,
      price: $('p-price').value !== '' ? +$('p-price').value : null,
      barcode: $('p-barcode').value.trim() || null,
      season_all_year: allYear,
      season_start_month: allYear ? null : (+$('p-season-from').value || null),
      season_end_month: allYear ? null : (+$('p-season-to').value || null),
    };
    const id = $('p-id').value;
    if (id) body.id = +id;
    try {
      const saved = await jpost('/api/kitchen/products', body);
      await loadProducts();
      // stay in edit mode for the saved product so its 📷 Photo button is usable right away
      if (saved && saved.id) { $('p-id').value = saved.id; $('pform-title').textContent = 'Edit: ' + (saved.name || ''); }
      refreshFormPhoto();
    } catch (e) { alert('Save failed: ' + e.message); }
  };

  async function delProduct(id) {
    const p = products.find(x => x.id === id);
    if (!confirm(`Delete "${p ? p.name : id}" from the catalog?`)) return;
    try { await jpost('/api/kitchen/products/delete', { id }); await loadProducts(); }
    catch (e) { alert('Delete failed: ' + e.message); }
  }

  // ── product photo: form preview + crop editor ──
  function refreshFormPhoto() {          // sync the form's photo preview + button state to the current p-id
    const id = $('p-id').value;
    const p = id ? products.find(x => x.id === +id) : null;
    const prev = $('p-photo-prev'), btn = $('p-photo-btn');
    if (!prev) return;
    if (!id) {                            // new product — need a saved id before uploading a photo
      prev.innerHTML = '🍽️'; prev.classList.remove('has');
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    if (p && p.photo_path) {
      prev.innerHTML = artHtml(p.photo_path, p.updated_at, 'p-photo-img');
      prev.classList.add('has');
    } else {
      prev.innerHTML = (p && p.emoji) || '🍽️'; prev.classList.remove('has');
    }
  }

  window.kOpenPhoto = function () {
    if (!$('p-id').value) { alert('Save the product first, then add a photo.'); return; }
    _peImg = null; $('kpe-file').value = ''; $('kpe-zoom').value = 1;
    $('kpe-hint').style.display = ''; $('kpe-save').disabled = true;
    _peDraw();                            // clears the canvas
    $('k-photo-modal').style.display = 'flex';
  };
  window.kClosePhoto = function () {
    $('k-photo-modal').style.display = 'none';
    if (_peUrl) { URL.revokeObjectURL(_peUrl); _peUrl = null; }
    _peImg = null;
  };
  window.kPhotoFile = function (input) {
    const f = input.files && input.files[0]; if (!f) return;
    if (_peUrl) URL.revokeObjectURL(_peUrl);
    _peUrl = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      _peImg = img;
      _peMin = Math.max(PE_V / img.width, PE_V / img.height);   // "cover" the square
      $('kpe-zoom').value = 1;
      _peSetZoom(1);                       // sets scale + centers + draws
      $('kpe-hint').style.display = 'none'; $('kpe-save').disabled = false;
    };
    img.onerror = () => alert('Could not read that image.');
    img.src = _peUrl;
  };
  function _peClamp() {                    // keep the image covering the viewport (no empty edges)
    if (!_peImg) return;
    const w = _peImg.width * _peScale, h = _peImg.height * _peScale;
    _peOx = Math.min(0, Math.max(PE_V - w, _peOx));
    _peOy = Math.min(0, Math.max(PE_V - h, _peOy));
  }
  function _peDraw() {
    const c = $('kpe-canvas'); if (!c) return;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0f1729'; ctx.fillRect(0, 0, PE_V, PE_V);
    if (_peImg) ctx.drawImage(_peImg, _peOx, _peOy, _peImg.width * _peScale, _peImg.height * _peScale);
  }
  function _peSetZoom(mult) {              // zoom around the viewport centre
    if (!_peImg) return;
    const cx = PE_V / 2, cy = PE_V / 2;
    const ix = (cx - _peOx) / _peScale, iy = (cy - _peOy) / _peScale;
    _peScale = _peMin * mult;
    _peOx = cx - ix * _peScale; _peOy = cy - iy * _peScale;
    _peClamp(); _peDraw();
  }
  window.kPhotoZoom = function (v) { _peSetZoom(parseFloat(v) || 1); };
  function _peStart(e) { if (!_peImg) return; const p = _pePt(e); _peDrag = { x: p.x, y: p.y }; e.preventDefault(); }
  function _peMove(e) {
    if (!_peDrag || !_peImg) return;
    const p = _pePt(e);
    _peOx += p.x - _peDrag.x; _peOy += p.y - _peDrag.y; _peDrag = { x: p.x, y: p.y };
    _peClamp(); _peDraw(); e.preventDefault();
  }
  function _peEnd() { _peDrag = null; }
  function _pePt(e) {
    const r = $('kpe-canvas').getBoundingClientRect();
    const t = e.touches && e.touches[0];
    const cx = t ? t.clientX : e.clientX, cy = t ? t.clientY : e.clientY;
    return { x: (cx - r.left) * (PE_V / r.width), y: (cy - r.top) * (PE_V / r.height) };
  }
  window.kPhotoSave = async function () {
    if (!_peImg) return;
    const pid = +$('p-id').value; if (!pid) return;
    const r = PE_OUT / PE_V;
    const out = document.createElement('canvas'); out.width = PE_OUT; out.height = PE_OUT;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff'; octx.fillRect(0, 0, PE_OUT, PE_OUT);
    octx.drawImage(_peImg, _peOx * r, _peOy * r, _peImg.width * _peScale * r, _peImg.height * _peScale * r);
    const blob = await new Promise(res => out.toBlob(res, 'image/jpeg', 0.85));
    if (!blob) { alert('Encode failed.'); return; }
    try {
      const fd = new FormData(); fd.append('file', blob, pid + '.jpg');
      const resp = await fetch(`${API}/api/kitchen/products/${pid}/photo`, { method: 'POST', body: fd });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      window.kClosePhoto();
      await loadProducts();
      refreshFormPhoto();
    } catch (e) { alert('Upload failed: ' + e.message); }
  };
  function _peWire() {                     // attach canvas drag handlers once
    const c = $('kpe-canvas'); if (!c || c._wired) return; c._wired = true;
    c.addEventListener('mousedown', _peStart); window.addEventListener('mousemove', _peMove); window.addEventListener('mouseup', _peEnd);
    c.addEventListener('touchstart', _peStart, { passive: false }); c.addEventListener('touchmove', _peMove, { passive: false }); c.addEventListener('touchend', _peEnd);
  }

  // ── shopping list ──
  async function loadList() {
    try { const d = await jget('/api/kitchen/list'); listItems = d.items || []; listRecipes = d.recipes || []; }
    catch (e) { listItems = []; $('l-rows').innerHTML =
      `<div class="k-hint" style="color:#ef5a6a">Can't reach kitchen service (${esc(e.message)})</div>`; return; }
    renderList();
  }

  let listRecipes = [];        // recipes that put things on this list (the מתכונים section)
  function renderList() {
    const box = $('l-rows');
    if (!listItems.length && !listRecipes.length) { box.innerHTML = '<div class="k-hint">List is empty. Add items from the fridge tablet, or the 📦 Stock tab.</div>'; return; }
    const catIds = categories.map(c => c.id);
    const groups = {};
    listItems.forEach(i => { const k = (i.product_category_id == null ? 0 : i.product_category_id); (groups[k] = groups[k] || []).push(i); });
    const order = [...catIds, 0].filter((v, idx, a) => a.indexOf(v) === idx);
    const rowHtml = i => {
      const name = i.product_name || i.free_text || '(item)';
      const emoji = i.product_emoji || '🛒';
      const unit = i.product_unit || '';
      const hasStock = i.product_stock != null;
      const stockN = numOf(i.product_stock);
      const lowN = i.product_low != null ? numOf(i.product_low) : null;
      const isLow = lowN != null && stockN <= lowN;
      const chip = hasStock ? `<span class="k-instock ${isLow ? 'low' : ''}">${fmtN(stockN)}</span>` : '<span></span>';
      // an ingredient with no product of its own: always dark red, it is a gap in the list
      const miss = !i.product_id && (i.free_text || '').startsWith('חסר');
      return `<div class="k-li ${i.checked ? 'checked' : ''}${miss ? ' k-miss' : ''}" data-id="${i.id}">
        <input type="checkbox" ${i.checked ? 'checked' : ''} data-act="check">
        <span class="em">${artHtml(i.product_photo, i.product_updated, emoji, 'k-thumb-li')}</span>
        <span class="nm">${esc(name)}</span>
        <span class="k-step">
          <button data-act="dec" title="less">−</button>
          <span class="qn">${fmtN(numOf(i.qty))}</span>
          <button data-act="inc" title="more">+</button>
        </span>
        <span class="k-unit">${esc(unitHe(unit))}</span>
        ${chip}
        <button class="k-x" data-act="rm" title="Remove">🗑</button>
      </div>`;
    };
    let html = '<div class="k-li k-li-head"><span></span><span></span><span></span><span></span><span></span><span class="lh">במלאי</span><span></span></div>';
    order.forEach(cid => {
      const list = groups[cid]; if (!list || !list.length) return;
      const cat = categories.find(c => c.id === cid);
      const label = cat ? (cat.emoji ? cat.emoji + ' ' : '') + cat.name : '— ללא קטגוריה —';
      html += `<div class="k-stock-h">${esc(label)}</div>` + list.map(rowHtml).join('');
    });
    // which מתכונים put things here - 🗑 undoes exactly that recipe's contribution
    if (listRecipes.length) {
      html += '<div class="k-stock-h">מתכונים</div>' + listRecipes.map(r => `
        <div class="k-li" data-lr="${r.id}">
          <span></span><span>${r.recipe_emoji || '📖'}</span>
          <span class="heb" style="grid-column:span 3">${esc(r.recipe_name)}</span><span></span>
          <button class="k-x" data-act="rmrec" title="Remove this recipe from the list">🗑</button>
        </div>`).join('');
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-lr]').forEach(row => {
      row.querySelector('[data-act=rmrec]').onclick = () => removeListRecipe(+row.dataset.lr);
    });
    box.querySelectorAll('.k-li[data-id]').forEach(row => {   // skip the header row
      const id = +row.dataset.id;
      const it = listItems.find(x => x.id === id);
      const step = unitStep(it && it.product_unit);
      row.querySelector('[data-act=check]').onchange = e => toggleCheck(id, e.target.checked);
      row.querySelector('[data-act=rm]').onclick = () => removeItem(id);
      row.querySelector('[data-act=dec]').onclick = () => setItemQty(id, numOf(it.qty) - step);
      row.querySelector('[data-act=inc]').onclick = () => setItemQty(id, numOf(it.qty) + step);
    });
  }

  async function toggleCheck(id, checked) {
    try { await jpost('/api/kitchen/list/check', { id, checked }); await loadList(); }
    catch (e) { alert('Update failed: ' + e.message); }
  }
  async function removeListRecipe(id) {
    const r = listRecipes.find(x => x.id === id);
    if (!confirm(`Remove "${r ? r.recipe_name : id}" and everything it added to the list?`)) return;
    try { await jpost('/api/kitchen/list/remove-recipe', { id }); await loadList(); }
    catch (e) { alert('Remove failed: ' + e.message); }
  }
  async function removeItem(id) {
    try { await jpost('/api/kitchen/list/remove', { id }); await loadList(); }
    catch (e) { alert('Remove failed: ' + e.message); }
  }
  async function setItemQty(id, qty) {
    qty = Math.max(0, Math.round(qty * 100) / 100);   // 0 → server removes it
    try { await jpost('/api/kitchen/list/qty', { id, qty }); await loadList(); }
    catch (e) { alert('Qty failed: ' + e.message); }
  }
  window.kClearChecked = async function () {
    const done = listItems.filter(i => i.checked);
    if (!done.length) { alert('Nothing checked.'); return; }
    if (!confirm(`Remove ${done.length} checked item(s) from the list?`)) return;
    try { for (const i of done) await jpost('/api/kitchen/list/remove', { id: i.id }); await loadList(); }
    catch (e) { alert('Clear failed: ' + e.message); }
  };

  window.kWhatsApp = function () {
    const pending = listItems.filter(i => !i.checked);
    if (!pending.length) { alert('Nothing to send — list is empty (or all checked).'); return; }
    const lines = pending.map(i => {
      const name = i.product_name || i.free_text || '(item)';
      const q = numOf(i.qty);
      const unit = i.product_unit || '';
      const qtyPart = q ? ` ${fmtN(q)}${unit ? ' ' + unitHe(unit) : ''}` : '';
      return '• ' + name + qtyPart;
    });
    const text = '🧺 Shopping list:\n' + lines.join('\n');
    // wa.me with no number → user picks the chat in WhatsApp.
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
  };

  // ── categories (managed Hebrew set; order = fridge-tablet page order) ──
  async function loadCategories() {
    try { categories = await jget('/api/kitchen/categories') || []; }
    catch (e) { categories = []; }
    renderCategoryOptions();
    renderCategories();
    renderStock();
    renderAmounts();
    renderProducts();   // re-group products by category
    renderList();       // re-group the shopping list by category
    renderCommon();     // common-list tab
  }

  function renderCategoryOptions() {
    const sel = $('p-category');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">—</option>' +
      categories.map(c => `<option value="${c.id}">${c.emoji ? c.emoji + ' ' : ''}${esc(c.name)}</option>`).join('');
    sel.value = cur;
  }

  function renderCategories() {
    const tb = $('c-rows');
    if (!tb) return;
    if (!categories.length) { tb.innerHTML = '<tr><td colspan="5" class="k-hint">No categories yet — add one above.</td></tr>'; return; }
    const counts = {};
    products.forEach(p => { if (p.category_id != null) counts[p.category_id] = (counts[p.category_id] || 0) + 1; });
    tb.innerHTML = categories.map((c, i) => `
      <tr data-id="${c.id}">
        <td class="k-emoji">${c.emoji || '🏷'}</td>
        <td class="heb">${esc(c.name)}</td>
        <td>${counts[c.id] || 0}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="k-edit" data-act="up"   title="Move up"   ${i === 0 ? 'disabled style="opacity:.3"' : ''}>▲</button>
          <button class="k-edit" data-act="down" title="Move down" ${i === categories.length - 1 ? 'disabled style="opacity:.3"' : ''}>▼</button>
        </td>
        <td style="white-space:nowrap;text-align:right">
          <button class="k-edit" data-act="edit" title="Edit">✎</button>
          <button class="k-x" data-act="del" title="Delete">🗑</button>
        </td>
      </tr>`).join('');
    tb.querySelectorAll('tr[data-id]').forEach(row => {
      const id = +row.dataset.id;
      const up = row.querySelector('[data-act=up]');   if (up && !up.disabled)   up.onclick   = () => moveCategory(id, -1);
      const dn = row.querySelector('[data-act=down]'); if (dn && !dn.disabled)   dn.onclick   = () => moveCategory(id, 1);
      row.querySelector('[data-act=edit]').onclick = () => editCategory(id);
      row.querySelector('[data-act=del]').onclick  = () => delCategory(id);
    });
  }

  function editCategory(id) {
    const c = categories.find(x => x.id === id); if (!c) return;
    $('c-id').value = c.id;
    $('c-name').value = c.name || '';
    $('c-emoji').value = c.emoji || '';
    $('cform-title').textContent = 'Edit: ' + (c.name || '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  window.kResetCatForm = function () {
    ['c-id', 'c-name', 'c-emoji'].forEach(i => $(i).value = '');
    $('cform-title').textContent = 'Add category';
  };

  window.kSaveCategory = async function () {
    const name = $('c-name').value.trim();
    if (!name) { alert('Category name (Hebrew) is required.'); return; }
    const body = { name, emoji: $('c-emoji').value.trim() || null };
    const id = $('c-id').value;
    if (id) body.id = +id; else body.sort_order = categories.length + 1;
    try { await jpost('/api/kitchen/categories', body); window.kResetCatForm(); await loadCategories(); }
    catch (e) { alert('Save failed: ' + e.message); }
  };

  async function delCategory(id) {
    const c = categories.find(x => x.id === id);
    const n = products.filter(p => p.category_id === id).length;
    if (!confirm(`Delete category "${c ? c.name : id}"?` + (n ? `\n${n} product(s) will become uncategorized.` : ''))) return;
    try { await jpost('/api/kitchen/categories/delete', { id }); await loadCategories(); await loadProducts(); }
    catch (e) { alert('Delete failed: ' + e.message); }
  }

  async function moveCategory(id, dir) {
    const i = categories.findIndex(x => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= categories.length) return;
    const order = categories.map(c => c.id);
    order.splice(i, 1); order.splice(j, 0, id);
    try { await jpost('/api/kitchen/categories/reorder', { order }); await loadCategories(); }
    catch (e) { alert('Reorder failed: ' + e.message); }
  }

  // ── recipes + import from a site (step 3) ──
  // The window never saves what it parsed without showing it first: every ingredient row is listed
  // with how it matched (exact / alias / fuzzy / none), and an unmatched row gets a product dropdown
  // so YOU choose. Picking one also stores an alias, so that ingredient is never asked about again.
  let recipes = [], recipeSites = [], impParsed = null, impEditId = null;

  async function loadRecipes() {
    try { recipes = await jget('/api/kitchen/recipes') || []; }
    catch (e) { recipes = []; }
    renderRecipes();
  }

  function renderRecipes() {
    const tb = $('rec-rows');
    if (!tb) return;
    if (!recipes.length) {
      tb.innerHTML = '<tr><td colspan="7" class="k-hint">No recipes yet — use ⬇ Import from site.</td></tr>';
      return;
    }
    tb.innerHTML = recipes.map(r => `
      <tr data-id="${r.id}">
        <td class="k-emoji">${r.emoji || '📖'}</td>
        <td class="heb">${esc(r.name)}</td>
        <td class="heb">${r.category_emoji ? r.category_emoji + ' ' : ''}${esc(r.category_name || '—')}</td>
        <td>${r.item_count}</td>
        <td>${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener">↗</a>` : ''}</td>
        <td><button class="k-edit" data-act="steps" title="Preparation steps">📋</button></td>
        <td style="text-align:right">
          <button class="k-edit" data-act="edit" title="Edit">✎</button>
          <button class="k-x" data-act="del" title="Delete">🗑</button></td>
      </tr>`).join('');
    tb.querySelectorAll('tr[data-id]').forEach(row => {
      row.querySelector('[data-act=steps]').onclick = () => kStepsOpen(+row.dataset.id);
      row.querySelector('[data-act=edit]').onclick  = () => kRecipeEdit(+row.dataset.id);
      row.querySelector('[data-act=del]').onclick  = () => delRecipe(+row.dataset.id);
    });
  }

  async function delRecipe(id) {
    const r = recipes.find(x => x.id === id);
    if (!confirm(`Delete recipe "${r ? r.name : id}"?`)) return;
    try { await jpost('/api/kitchen/recipes/delete', { id }); await loadRecipes(); }
    catch (e) { alert('Delete failed: ' + e.message); }
  }

  // ── preparation steps, in their own window ──
  // Deliberately NOT in the edit window: that one is a dense table for fixing ingredients, and the
  // method is what you actually read while cooking, so it gets room, RTL and a comfortable line height.
  window.kStepsOpen = async function (id) {
    try {
      const r = await jget('/api/kitchen/recipes/' + id);
      const steps = (r.instructions || '').split('\n').map(x => x.trim()).filter(Boolean)
        // the site numbers its own steps ("1. ..."), so strip that - the <ol> numbers them
        .map(x => x.replace(/^\s*\d+[.)]\s*/, ''));
      $('stp-title').textContent = r.name || '';
      const src = $('stp-src');
      if (r.source_url) { src.href = r.source_url; src.style.display = ''; } else { src.style.display = 'none'; }
      $('stp-list').innerHTML = steps.length
        ? steps.map(x => `<li style="margin-bottom:10px;">${esc(x)}</li>`).join('')
        : '<div class="k-hint">This recipe has no preparation steps saved.</div>';
      $('k-steps').style.display = 'flex';
    } catch (e) { alert('Could not open the steps: ' + e.message); }
  };
  window.kStepsClose = function () { $('k-steps').style.display = 'none'; };

  // ── the import window ──
  window.kImportOpen = async function () {
    impParsed = null; impEditId = null;
    $('imp-head').textContent = '⬇ Import recipe';
    $('imp-search').style.display = '';        // the search box is import-only
    $('imp-hits').style.display = '';
    $('imp-result').style.display = 'none';
    $('imp-hits').innerHTML = '';
    $('imp-msg').textContent = '';
    $('imp-save-msg').textContent = '';
    await loadRecipeSites();
    $('imp-emoji').value = '';                 // a fresh import must not inherit the last edit's icon
    $('imp-site').innerHTML = recipeSites.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
    $('imp-cat').innerHTML = recipeCats.map(c => `<option value="${c.id}">${c.emoji ? c.emoji + ' ' : ''}${esc(c.name)}</option>`).join('');
    $('k-import').style.display = 'flex';
    setTimeout(() => $('imp-q').focus(), 60);
  };
  window.kImportClose = function () { $('k-import').style.display = 'none'; };

  // Editing reuses the import window: same table, same product dropdowns, same Save - only the
  // search step is hidden and Save carries the id, so the service UPDATEs instead of inserting.
  window.kRecipeEdit = async function (id) {
    try {
      const r = await jget('/api/kitchen/recipes/' + id);
      impEditId = id;
      impParsed = {
        title: r.name, source_url: r.source_url, site: r.source_site,
        steps: (r.instructions || '').split('\n').filter(Boolean),
        items: (r.items || []).map(i => ({
          raw_line: i.raw_line, group_label: i.group_label, qty: i.qty == null ? null : +i.qty,
          unit: i.unit, parsed_name: i.parsed_name, product_id: i.product_id,
          match: i.product_id ? 'exact' : 'none',
        })),
      };
      $('imp-head').textContent = '✎ Edit recipe';
      $('imp-search').style.display = 'none';
      $('imp-hits').style.display = 'none';
      $('imp-hits').innerHTML = '';
      $('imp-msg').textContent = '';
      $('imp-save-msg').textContent = '';
      $('imp-cat').innerHTML = recipeCats.map(c => `<option value="${c.id}">${c.emoji ? c.emoji + ' ' : ''}${esc(c.name)}</option>`).join('');
      if (r.category_id) $('imp-cat').value = r.category_id;
      $('imp-title').value = r.name || '';
      $('imp-emoji').value = r.emoji || '';
      $('imp-src').href = r.source_url || '#';
      renderImportRows();
      $('imp-result').style.display = '';
      $('k-import').style.display = 'flex';
    } catch (e) { alert('Could not open the recipe: ' + e.message); }
  };

  window.kImportSearch = async function () {
    const site = $('imp-site').value, q = $('imp-q').value.trim();
    if (!q) return;
    $('imp-msg').textContent = 'Searching…';
    $('imp-hits').innerHTML = '';
    try {
      const r = await jget('/api/kitchen/recipe-search?site=' + encodeURIComponent(site) + '&q=' + encodeURIComponent(q));
      const hits = r.hits || [];
      $('imp-msg').textContent = hits.length ? hits.length + ' found — pick one' : 'nothing found';
      $('imp-hits').innerHTML = hits.map((h, i) =>
        `<div class="k-hitrow" data-i="${i}" style="padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:4px;cursor:pointer;">
           <span class="heb">${esc(h.title)}</span>
         </div>`).join('');
      $('imp-hits').querySelectorAll('.k-hitrow').forEach(el => {
        el.onclick = () => kImportParse(site, hits[+el.dataset.i].url);
      });
    } catch (e) { $('imp-msg').textContent = 'Search failed: ' + e.message; }
  };

  async function kImportParse(site, url) {
    $('imp-msg').textContent = 'Reading the recipe…';
    try {
      const p = await jget('/api/kitchen/recipe-parse?site=' + encodeURIComponent(site) + '&url=' + encodeURIComponent(url));
      impParsed = p;
      $('imp-title').value = p.title || '';
      const miss = (p.items || []).filter(i => !i.product_id).length;
      $('imp-counts').textContent = `${p.items.length} ingredients · ${p.steps.length} steps · ${miss} not in your products`;
      $('imp-src').href = p.source_url;
      $('imp-msg').textContent = p.already_imported
        ? '⚠ already imported as "' + p.already_imported.name + '" — saving again will be refused'
        : '';
      renderImportRows();
      $('imp-result').style.display = '';
    } catch (e) { $('imp-msg').textContent = 'Could not read that page: ' + e.message; }
  }

  const MATCH_TAG = {
    exact: '<span style="color:#166534;">✓ exact</span>',
    alias: '<span style="color:#166534;">✓ learned</span>',
    fuzzy: '<span style="color:#b45309;">≈ guess</span>',
    none:  '<span style="color:#b91c1c;">✗ missing</span>',
  };

  function renderImportRows() {
    const tb = $('imp-rows');
    if (!tb || !impParsed) return;
    const opts = products.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    tb.innerHTML = impParsed.items.map((it, i) => {
      const grp = (i === 0 || impParsed.items[i - 1].group_label !== it.group_label) && it.group_label
        ? `<tr><td colspan="6" class="heb" style="background:#e2e8f0;font-weight:700;font-size:0.9rem;padding:6px 8px;border-top:2px solid #94a3b8;">${esc(it.group_label)}</td></tr>` : '';
      // EVERY row is editable - a wrong parse or a wrong guess must be as easy to fix as a blank
      const sel = `<select data-i="${i}" class="imp-prod" style="padding:4px 6px;border:1px solid #cbd5e1;border-radius:5px;max-width:180px;">
             <option value="">— choose —</option>${opts}
           </select> ${MATCH_TAG[it.match] || ''}`;
      return grp + `
        <tr>
          <td>${i + 1}</td>
          <td class="heb" style="font-size:0.82rem;color:#64748b;">${esc(it.raw_line)}</td>
          <td><input data-i="${i}" class="imp-qty" type="number" step="any" value="${it.qty == null ? '' : it.qty}"
                     style="width:64px;padding:3px 5px;border:1px solid #cbd5e1;border-radius:5px;"></td>
          <td><input data-i="${i}" class="imp-unit heb" value="${esc(it.unit || '')}"
                     style="width:74px;padding:3px 5px;border:1px solid #cbd5e1;border-radius:5px;"></td>
          <td>${sel}</td>
          <td style="text-align:right"><button class="k-x" data-act="rm" data-i="${i}" title="Remove line">✕</button></td>
        </tr>`;
    }).join('');
    tb.querySelectorAll('input.imp-qty').forEach(inp => {
      inp.onchange = () => {
        const v = inp.value.trim();
        impParsed.items[+inp.dataset.i].qty = v === '' ? null : parseFloat(v);
      };
    });
    tb.querySelectorAll('input.imp-unit').forEach(inp => {
      inp.onchange = () => { impParsed.items[+inp.dataset.i].unit = inp.value.trim() || null; };
    });
    tb.querySelectorAll('button[data-act=rm]').forEach(btn => {
      btn.onclick = () => {                       // drop a line you do not want to shop for
        impParsed.items.splice(+btn.dataset.i, 1);
        renderImportRows();
        impCounts();
      };
    });
    tb.querySelectorAll('select.imp-prod').forEach(sel => {
      const it = impParsed.items[+sel.dataset.i];
      if (it.product_id) sel.value = it.product_id;         // a fuzzy guess is pre-selected, not hidden
      sel.onchange = async () => {
        it.product_id = sel.value ? +sel.value : null;
        it.match = it.product_id ? 'alias' : 'none';
        if (it.product_id && it.parsed_name) {              // remember it so it is never asked again
          try { await jpost('/api/kitchen/ingredient-aliases', { alias: it.parsed_name, product_id: it.product_id }); }
          catch (e) { /* the recipe still saves; only the learning is lost */ }
        }
        impCounts();
      };
    });
  }

  function impCounts() {
    if (!impParsed) return;
    const miss = impParsed.items.filter(x => !x.product_id).length;
    $('imp-counts').textContent =
      `${impParsed.items.length} ingredients · ${impParsed.steps.length} steps · ${miss} not in your products`;
  }

  function productName(id) {
    const p = products.find(x => x.id === id);
    return p ? p.name : '';
  }

  window.kImportSave = async function () {
    if (!impParsed) return;
    const cat = $('imp-cat').value;
    if (!cat) { $('imp-save-msg').textContent = 'Pick a category first.'; return; }
    $('imp-save-msg').style.color = '#8a93a6';
    $('imp-save-msg').textContent = 'Saving…';
    const name = ($('imp-title').value || '').trim();
    if (!name) { $('imp-save-msg').textContent = 'Give the recipe a name.'; return; }
    const body = {
      id: impEditId || undefined,           // present => UPDATE, absent => INSERT
      category_id: +cat, name: name, emoji: ($('imp-emoji').value || '').trim() || null,
      source_url: impParsed.source_url,
      source_site: impParsed.site, instructions: (impParsed.steps || []).join('\n'),
      items: impParsed.items.map((it, n) => ({
        sort_order: n, group_label: it.group_label, raw_line: it.raw_line,
        qty: it.qty, unit: it.unit, parsed_name: it.parsed_name, product_id: it.product_id,
      })),
    };
    try {
      const r = await jpost('/api/kitchen/recipes', body);
      if (r && r.error === 'already_imported') {
        $('imp-save-msg').style.color = '#b45309';
        $('imp-save-msg').textContent = 'Already imported as "' + (r.recipe && r.recipe.name) + '" — not saved twice.';
        return;
      }
      $('imp-save-msg').style.color = '#166534';
      $('imp-save-msg').textContent = '✓ Saved';
      await loadRecipes();
      setTimeout(window.kImportClose, 700);
    } catch (e) {
      $('imp-save-msg').style.color = '#b91c1c';
      $('imp-save-msg').textContent = 'Save failed: ' + e.message;
    }
  };

  // ── Recipe Settings: what the importer has LEARNED ──
  // Picking a product for an unrecognised ingredient is remembered forever. Without this screen a
  // mis-click is permanent AND invisible - a stray pick once stored עגבניות -> אורז and kept
  // re-applying on every import, findable only by reading the database.
  let aliases = [];

  async function loadAliases() {
    try { aliases = await jget('/api/kitchen/ingredient-aliases') || []; }
    catch (e) { aliases = []; }
    renderAliases();
  }

  function renderAliases() {
    const tb = $('al-rows');
    if (!tb) return;
    if ($('al-count')) $('al-count').textContent = aliases.length ? aliases.length + ' remembered' : '';
    if (!aliases.length) {
      tb.innerHTML = '<tr><td colspan="3" class="k-hint">Nothing learned yet — map an ingredient while importing and it appears here.</td></tr>';
      return;
    }
    const opts = products.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    tb.innerHTML = aliases.map(a => `
      <tr data-id="${a.id}">
        <td class="heb">${esc(a.alias)}</td>
        <td>
          <select class="al-prod" data-id="${a.id}" style="padding:4px 6px;border:1px solid #cbd5e1;border-radius:5px;max-width:220px;">
            <option value="">— choose —</option>${opts}
          </select>
          ${a.product_id ? '' : '<span style="color:#b91c1c;font-size:0.8rem;"> product missing</span>'}
        </td>
        <td style="text-align:right"><button class="k-x" data-act="del" title="Forget this">🗑</button></td>
      </tr>`).join('');
    tb.querySelectorAll('select.al-prod').forEach(sel => {
      const a = aliases.find(x => x.id === +sel.dataset.id);
      if (a && a.product_id) sel.value = a.product_id;
      sel.onchange = () => kAliasSet(a, sel.value);
    });
    tb.querySelectorAll('tr[data-id]').forEach(row => {
      row.querySelector('[data-act=del]').onclick = () => kAliasDel(+row.dataset.id);
    });
  }

  async function kAliasSet(a, productId) {
    if (!a || !productId) return;
    try { await jpost('/api/kitchen/ingredient-aliases', { alias: a.alias, product_id: +productId }); await loadAliases(); }
    catch (e) { alert('Could not save: ' + e.message); }
  }

  async function kAliasDel(id) {
    const a = aliases.find(x => x.id === id);
    if (!confirm(`Forget "${a ? a.alias : id}"?
The next import will ask about it again. Saved recipes are not changed.`)) return;
    try { await jpost('/api/kitchen/ingredient-aliases/delete', { id }); await loadAliases(); }
    catch (e) { alert('Could not delete: ' + e.message); }
  }

  // ── Recipe Settings: cards fold, and start closed on every load ──
  window.kFold = function (h) {
    const body = h.nextElementSibling, caret = h.querySelector('.k-caret');
    const open = body.hidden;                 // about to open
    body.hidden = !open;
    if (caret) caret.textContent = open ? '▾' : '▸';
  };

  // ── Recipe Settings: recipe amount -> how many PRODUCTS to buy ──
  let convRules = [];
  async function loadConversions() {
    try { convRules = await jget('/api/kitchen/recipe-conversions') || []; }
    catch (e) { convRules = []; }
    renderConversions();
  }
  function renderConversions() {
    const tb = $('cv-rows'); if (!tb) return;
    if (!convRules.length) { tb.innerHTML = '<tr><td colspan="5" class="k-hint">No rules — everything becomes 1.</td></tr>'; return; }
    tb.innerHTML = convRules.map((r, i) => `
      <tr>
        <td class="heb">${esc(r.unit || '')}${r.unit ? '' : '<span class="k-hint">(plain count)</span>'}</td>
        <td>${fmtNum(r.min)}</td><td>${fmtNum(r.max)}</td>
        <td><b>${esc(String(r.buy))}</b></td>
        <td style="text-align:right"><button class="k-x" data-i="${i}" title="Delete">🗑</button></td>
      </tr>`).join('');
    tb.querySelectorAll('button[data-i]').forEach(b => {
      b.onclick = () => { convRules.splice(+b.dataset.i, 1); saveConversions(); };
    });
  }
  const fmtNum = v => (Math.round((+v || 0) * 1000) / 1000);
  async function saveConversions() {
    try {
      convRules = await jpost('/api/kitchen/recipe-conversions', { rules: convRules });
      renderConversions();
      $('cv-msg').textContent = 'Saved.'; setTimeout(() => $('cv-msg').textContent = '', 1500);
    } catch (e) { $('cv-msg').textContent = 'Save failed: ' + e.message; }
  }
  window.kConvAdd = function () {
    const buyRaw = ($('cv-buy').value || '').trim();
    const buy = buyRaw.toLowerCase() === 'same' ? 'same' : Math.max(1, parseInt(buyRaw, 10) || 1);
    convRules.push({ unit: ($('cv-unit').value || '').trim(),
                     min: +$('cv-min').value || 0, max: +$('cv-max').value || 0, buy });
    $('cv-unit').value = ''; $('cv-buy').value = '';
    saveConversions();
  };

  // ── Recipe Settings: the site list ──
  async function loadRecipeSites() {
    try { recipeSites = await jget('/api/kitchen/recipe-sites') || []; }
    catch (e) { recipeSites = []; }
    renderRecipeSites();
  }

  function renderRecipeSites() {
    const tb = $('rs-rows');
    if (!tb) return;
    if (!recipeSites.length) { tb.innerHTML = '<tr><td colspan="4" class="k-hint">No sites yet.</td></tr>'; return; }
    tb.innerHTML = recipeSites.map((s, i) => `
      <tr data-i="${i}">
        <td>${esc(s.name)}</td>
        <td style="font-size:0.8rem;color:#64748b;">${esc(s.base)}</td>
        <td>${esc(s.adapter)}</td>
        <td style="text-align:right"><button class="k-x" data-act="del" title="Remove">🗑</button></td>
      </tr>`).join('');
    tb.querySelectorAll('tr[data-i]').forEach(row => {
      row.querySelector('[data-act=del]').onclick = () => kSiteDel(+row.dataset.i);
    });
  }

  async function saveSites(list) {
    try {
      recipeSites = await jpost('/api/kitchen/recipe-sites', { sites: list });
      renderRecipeSites();
      $('rs-msg').textContent = '✓ saved';
      setTimeout(() => { if ($('rs-msg')) $('rs-msg').textContent = ''; }, 1500);
    } catch (e) { $('rs-msg').textContent = 'Save failed: ' + e.message; }
  }

  window.kSiteAdd = function () {
    const name = $('rs-name').value.trim(), base = $('rs-base').value.trim();
    if (!base.startsWith('http')) { $('rs-msg').textContent = 'Address must start with http.'; return; }
    const key = (name || base).replace(/^https?:\/\//, '').split('.')[0].toLowerCase();
    saveSites(recipeSites.concat([{ key, name: name || base, base, adapter: $('rs-adapter').value }]));
    $('rs-name').value = ''; $('rs-base').value = '';
  };

  function kSiteDel(i) {
    const s = recipeSites[i];
    if (!confirm(`Remove site "${s ? s.name : i}"?`)) return;
    saveSites(recipeSites.filter((_, n) => n !== i));
  }

  // ── recipe categories (מרקים / סלטים …) — step 1 of the Recipes feature ──
  // Their own table + endpoints, deliberately NOT kitchen_categories: the fridge home screen draws a
  // circle for every food category, so recipe categories there would appear among the food.
  // No "Recipes" count column yet — there are no recipes, so it could only ever print 0.
  async function loadRecipeCats() {
    try { recipeCats = await jget('/api/kitchen/recipe-categories') || []; }
    catch (e) { recipeCats = []; }
    renderRecipeCats();
  }

  function renderRecipeCats() {
    const tb = $('rc-rows');
    if (!tb) return;
    if (!recipeCats.length) { tb.innerHTML = '<tr><td colspan="4" class="k-hint">No recipe categories yet — add one above.</td></tr>'; return; }
    tb.innerHTML = recipeCats.map((c, i) => `
      <tr data-id="${c.id}">
        <td class="k-emoji">${c.emoji || '📖'}</td>
        <td class="heb">${esc(c.name)}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="k-edit" data-act="up"   title="Move up"   ${i === 0 ? 'disabled style="opacity:.3"' : ''}>▲</button>
          <button class="k-edit" data-act="down" title="Move down" ${i === recipeCats.length - 1 ? 'disabled style="opacity:.3"' : ''}>▼</button>
        </td>
        <td style="white-space:nowrap;text-align:right">
          <button class="k-edit" data-act="edit" title="Edit">✎</button>
          <button class="k-x" data-act="del" title="Delete">🗑</button>
        </td>
      </tr>`).join('');
    tb.querySelectorAll('tr[data-id]').forEach(row => {
      const id = +row.dataset.id;
      const up = row.querySelector('[data-act=up]');   if (up && !up.disabled) up.onclick = () => moveRecipeCat(id, -1);
      const dn = row.querySelector('[data-act=down]'); if (dn && !dn.disabled) dn.onclick = () => moveRecipeCat(id, 1);
      row.querySelector('[data-act=edit]').onclick = () => editRecipeCat(id);
      row.querySelector('[data-act=del]').onclick  = () => delRecipeCat(id);
    });
  }

  function editRecipeCat(id) {
    const c = recipeCats.find(x => x.id === id); if (!c) return;
    $('rc-id').value = c.id;
    $('rc-name').value = c.name || '';
    $('rc-emoji').value = c.emoji || '';
    $('rcform-title').textContent = 'Edit: ' + (c.name || '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  window.kResetRecipeCatForm = function () {
    $('rc-id').value = ''; $('rc-name').value = ''; $('rc-emoji').value = '';
    $('rcform-title').textContent = 'Add recipe category';
  };

  window.kSaveRecipeCat = async function () {
    const name = $('rc-name').value.trim();
    if (!name) { alert('Recipe category name (Hebrew) is required.'); return; }
    const body = { name, emoji: $('rc-emoji').value.trim() || null };
    const id = $('rc-id').value;
    if (id) body.id = +id; else body.sort_order = recipeCats.length + 1;
    try { await jpost('/api/kitchen/recipe-categories', body); window.kResetRecipeCatForm(); await loadRecipeCats(); }
    catch (e) { alert('Save failed: ' + e.message); }
  };

  async function delRecipeCat(id) {
    const c = recipeCats.find(x => x.id === id);
    if (!confirm(`Delete recipe category "${c ? c.name : id}"?`)) return;
    try { await jpost('/api/kitchen/recipe-categories/delete', { id }); await loadRecipeCats(); }
    catch (e) { alert('Delete failed: ' + e.message); }
  }

  async function moveRecipeCat(id, dir) {
    const i = recipeCats.findIndex(x => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= recipeCats.length) return;
    const order = recipeCats.map(c => c.id);
    order.splice(i, 1); order.splice(j, 0, id);
    try { await jpost('/api/kitchen/recipe-categories/reorder', { order }); await loadRecipeCats(); }
    catch (e) { alert('Reorder failed: ' + e.message); }
  }

  // ── stock (qty_on_hand + low threshold per product, in its unit) ──
  function renderStock() {
    const box = $('stock-rows');
    if (!box) return;
    if (!products.length) { box.innerHTML = '<div class="k-hint">No products yet — add them on the 🍎 Products tab.</div>'; return; }
    const catIds = categories.map(c => c.id);
    const groups = {};
    products.forEach(p => { const k = (p.category_id == null ? 0 : p.category_id); (groups[k] = groups[k] || []).push(p); });
    const order = [...catIds, 0].filter((v, i, a) => a.indexOf(v) === i);
    let html = '<div class="k-srow st k-st-head"><span></span><span></span><span></span><span></span><span class="lh" style="grid-column:5 / 7">מינימום נדרש</span></div>';
    order.forEach(cid => {
      const list = groups[cid]; if (!list || !list.length) return;
      const cat = categories.find(c => c.id === cid);
      const label = cat ? (cat.emoji ? cat.emoji + ' ' : '') + cat.name : '— ללא קטגוריה —';
      html += `<div class="k-stock-h">${esc(label)}</div>`;
      html += list.map(p => {
        const unit = p.unit || '';
        const stock = numOf(p.qty_on_hand);
        const low = p.low_stock_threshold != null ? numOf(p.low_stock_threshold) : null;
        const isLow = low != null && stock <= low;
        return `<div class="k-srow st" data-id="${p.id}">
          <span class="em">${prodArt(p)}</span>
          <span class="nm">${esc(p.name)}</span>
          <span class="k-step">
            <button data-act="dec" title="less">−</button>
            <span class="qn">${fmtN(stock)}</span>
            <button data-act="inc" title="more">+</button>
          </span>
          <span class="k-unit">${esc(unitHe(unit))}</span>
          <input class="k-lowin" data-act="low" type="number" step="0.5" min="0" placeholder="low" title="Low-stock threshold" value="${low != null ? fmtN(low) : ''}">
          ${isLow ? '<span class="k-stock-chip low">⚠ חסר</span>' : '<span></span>'}
        </div>`;
      }).join('');
    });
    box.innerHTML = html;
    box.querySelectorAll('.k-srow[data-id]').forEach(row => {   // skip the k-st-head header (no data-id / no buttons)
      const id = +row.dataset.id;
      const p = products.find(x => x.id === id);
      const step = unitStep(p && p.unit);
      row.querySelector('[data-act=dec]').onclick = () => setStock(id, numOf(p.qty_on_hand) - step);
      row.querySelector('[data-act=inc]').onclick = () => setStock(id, numOf(p.qty_on_hand) + step);
      row.querySelector('[data-act=low]').onchange = e => setLow(id, e.target.value);
    });
  }

  async function setStock(id, qty) {
    qty = Math.max(0, Math.round(qty * 100) / 100);
    try { await jpost('/api/kitchen/stock', { id, qty_on_hand: qty }); await loadProducts(); await loadList(); }   // refresh במלאי on the list
    catch (e) { alert('Stock failed: ' + e.message); }
  }
  async function setLow(id, val) {
    const low = (val === '' || val == null) ? null : Math.max(0, parseFloat(val) || 0);
    try { await jpost('/api/kitchen/stock', { id, low_stock_threshold: low }); await loadProducts(); await loadList(); }
    catch (e) { alert('Low failed: ' + e.message); }
  }

  window.kCheckMissing = async function () {
    try {
      const r = await jpost('/api/kitchen/stock/check-missing');
      if (!r.missing.length) { alert('אין מוצרים חסרים 👍\n(No items are at/below their low threshold — set thresholds in the Stock rows.)'); return; }
      alert(`חסרים: ${r.missing.length}\nנוספו לרשימה: ${r.added.length}` + (r.added.length ? '\n• ' + r.added.join('\n• ') : '\n(all already on the list)'));
      await loadList();
      kTab('lists', [...document.querySelectorAll('.k-tab')].find(b => b.textContent.includes('Shopping')));
    } catch (e) { alert('Check failed: ' + e.message); }
  };

  // ── common list (weekly staple qty per product; like stock, no low) ──
  function renderCommon() {
    const box = $('common-rows');
    if (!box) return;
    if (!products.length) { box.innerHTML = '<div class="k-hint">No products yet — add them on the 🍎 Products tab.</div>'; return; }
    const catIds = categories.map(c => c.id);
    const groups = {};
    products.forEach(p => { const k = (p.category_id == null ? 0 : p.category_id); (groups[k] = groups[k] || []).push(p); });
    const order = [...catIds, 0].filter((v, i, a) => a.indexOf(v) === i);
    let html = '';
    order.forEach(cid => {
      const list = groups[cid]; if (!list || !list.length) return;
      const cat = categories.find(c => c.id === cid);
      const label = cat ? (cat.emoji ? cat.emoji + ' ' : '') + cat.name : '— ללא קטגוריה —';
      html += `<div class="k-stock-h">${esc(label)}</div>`;
      html += list.map(p => `
        <div class="k-srow cm" data-id="${p.id}">
          <span class="em">${prodArt(p)}</span>
          <span class="k-cmseason">${seasonCell(p)}</span>
          <span class="nm">${esc(p.name)}</span>
          <span class="k-step">
            <button data-act="dec" title="less">−</button>
            <span class="qn">${fmtN(numOf(p.common_qty))}</span>
            <button data-act="inc" title="more">+</button>
          </span>
          <span class="k-unit">${esc(unitHe(p.unit))}</span>
        </div>`).join('');
    });
    box.innerHTML = html;
    box.querySelectorAll('.k-srow').forEach(row => {
      const id = +row.dataset.id;
      const p = products.find(x => x.id === id);
      const step = unitStep(p && p.unit);
      row.querySelector('[data-act=dec]').onclick = () => setCommon(id, numOf(p.common_qty) - step);
      row.querySelector('[data-act=inc]').onclick = () => setCommon(id, numOf(p.common_qty) + step);
    });
  }
  async function setCommon(id, qty) {
    qty = Math.max(0, Math.round(qty * 100) / 100);
    try { await jpost('/api/kitchen/common', { id, common_qty: qty }); await loadProducts(); }
    catch (e) { alert('Save failed: ' + e.message); }
  }

  // ── settings: per-product buy amounts (קצת / בינוני / הרבה) ──
  function renderAmounts() {
    const box = $('amt-rows');
    if (!box) return;
    if (!products.length) { box.innerHTML = '<div class="k-hint">No products yet — add them on the 🍎 Products tab.</div>'; return; }
    const catIds = categories.map(c => c.id);
    const groups = {};
    products.forEach(p => { const k = (p.category_id == null ? 0 : p.category_id); (groups[k] = groups[k] || []).push(p); });
    const order = [...catIds, 0].filter((v, i, a) => a.indexOf(v) === i);
    let html = '';
    order.forEach(cid => {
      const list = groups[cid]; if (!list || !list.length) return;
      const cat = categories.find(c => c.id === cid);
      const label = cat ? (cat.emoji ? cat.emoji + ' ' : '') + cat.name : '— ללא קטגוריה —';
      html += `<div class="k-stock-h">${esc(label)}</div>`;
      html += list.map(p => {
        const v = k => (p[k] != null ? +p[k] : '');
        const cell = (k, lbl) => `<span class="amt-cell">${lbl}<input class="k-lowin" data-k="${k}" type="number" step="0.25" min="0" value="${v(k)}"></span>`;
        return `<div class="k-srow" data-id="${p.id}">
          <span class="em">${prodArt(p)}</span>
          <span class="nm">${esc(p.name)}</span>
          <span class="k-unit">${esc(unitHe(p.unit))}</span>
          ${cell('amount_little', 'קצת')}${cell('amount_medium', 'בינוני')}${cell('amount_lots', 'הרבה')}${cell('amount_extra', 'הרבה מעוד')}
          <button class="btn btn-primary btn-sm amt-save" data-act="save">💾 Save</button>
        </div>`;
      }).join('');
    });
    box.innerHTML = html;
    box.querySelectorAll('.k-srow').forEach(row => {
      const id = +row.dataset.id;
      const btn = row.querySelector('[data-act=save]');
      row.querySelectorAll('input[data-k]').forEach(inp => { inp.oninput = () => btn.classList.add('dirty'); });
      btn.onclick = () => saveAmounts(id, row, btn);
    });
  }
  async function saveAmounts(id, row, btn) {
    const body = { id };
    row.querySelectorAll('input[data-k]').forEach(inp => {
      body[inp.dataset.k] = (inp.value === '') ? null : Math.max(0, parseFloat(inp.value) || 0);
    });
    try {
      await jpost('/api/kitchen/amounts', body);
      const p = products.find(x => x.id === id);   // keep the local copy in sync (no full reload)
      if (p) row.querySelectorAll('input[data-k]').forEach(inp => { p[inp.dataset.k] = body[inp.dataset.k]; });
      btn.classList.remove('dirty'); btn.textContent = '✓ Saved';
      setTimeout(() => { btn.textContent = '💾 Save'; }, 1200);
    } catch (e) { alert('Save failed: ' + e.message); }
  }

  // ── Settings sub-tabs (Product Settings / Tech Settings) ──
  window.kSub = function (name, btn) {
    document.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.k-subtab').forEach(b => b.classList.remove('active'));
    const p = document.getElementById('sub-' + name); if (p) p.classList.add('active');
    if (btn) btn.classList.add('active');
  };
  async function loadTech() {
    try {
      const s = await jget('/api/kitchen/settings') || {};
      if ($('ts-idle')) $('ts-idle').value = s.idle_return_sec != null ? s.idle_return_sec : 60;
      if ($('ts-return')) $('ts-return').value = s.panel_return_sec != null ? s.panel_return_sec : 1.5;
      if ($('ts-blink')) $('ts-blink').value = s.blink_count != null ? s.blink_count : 3;
    } catch (e) { }
  }
  window.kSaveTech = async function () {
    const idle = parseInt($('ts-idle').value, 10);
    const ret = parseFloat($('ts-return').value);
    const blink = parseInt($('ts-blink').value, 10);
    const body = {
      idle_return_sec: isNaN(idle) ? 60 : Math.max(0, idle),
      panel_return_sec: isNaN(ret) ? 1.5 : Math.max(0, ret),
      blink_count: isNaN(blink) ? 3 : Math.max(0, blink),
    };
    try { await jpost('/api/kitchen/settings', body); const b = event && event.target; if (b) { b.textContent = '✓ Saved'; setTimeout(() => b.textContent = '💾 Save', 1200); } }
    catch (e) { alert('Save failed: ' + e.message); }
  };

  // ── boot ──
  window.kLoad = async function () {
    _peWire(); refreshFormPhoto();
    await loadProducts(); await loadCategories(); await loadList(); await loadTech(); await loadRecipeCats(); await loadRecipes(); await loadRecipeSites(); await loadConversions(); await loadAliases();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.kLoad);
  else window.kLoad();
})();
