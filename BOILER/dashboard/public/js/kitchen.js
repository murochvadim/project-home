// Kitchen Agent — dashboard controller.
// Calls the LXC 113 kitchen_service.py CRUD API DIRECTLY (cross-origin) — NO server.js
// business logic (architecture-guard safe). Same pattern as js/email.js.
(function () {
  const API = 'http://192.168.1.208:8772';   // LXC 113 kitchen-service (http; Caddy/HTTPS deferred to home)

  let products = [];
  let listItems = [];
  let categories = [];

  const $ = id => document.getElementById(id);
  const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const UNIT_HE = { kg: 'ק"ג', l: 'ליטר', piece: 'יח׳', tray: 'תבנית', pack: 'חבילה', bottle: 'בקבוק', jar: 'צנצנת', tub: 'גביע', loaf: 'כיכר', bar: 'חטיף' };
  const unitHe = u => UNIT_HE[(u || '').toLowerCase()] || (u || '');
  const numOf = v => (v == null ? 0 : parseFloat(v) || 0);
  const fmtN = v => { const n = +v; return Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toString(); };
  const unitStep = u => { u = (u || '').toLowerCase(); return (u === 'kg' || u === 'l' || u.includes('ק') || u.includes('ליטר')) ? 0.5 : 1; };

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
    if (!products.length) { tb.innerHTML = '<tr><td colspan="5" class="k-hint">No products yet — add one above.</td></tr>'; return; }
    const catIds = categories.map(c => c.id);
    const groups = {};
    products.forEach(p => { const k = (p.category_id == null ? 0 : p.category_id); (groups[k] = groups[k] || []).push(p); });
    const order = [...catIds, 0].filter((v, i, a) => a.indexOf(v) === i);
    let html = '';
    order.forEach(cid => {
      const list = groups[cid]; if (!list || !list.length) return;
      const cat = categories.find(c => c.id === cid);
      const label = cat ? (cat.emoji ? cat.emoji + ' ' : '') + cat.name : '— ללא קטגוריה —';
      html += `<tr><td colspan="5" class="k-cat-cell">${esc(label)}</td></tr>`;
      html += list.map(p => `
        <tr data-id="${p.id}">
          <td class="k-emoji">${p.emoji || '🍽️'}</td>
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
    $('pform-title').textContent = 'Edit: ' + (p.name || '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  window.kResetForm = function () {
    ['p-id', 'p-name', 'p-emoji', 'p-unit', 'p-price', 'p-barcode'].forEach(i => $(i).value = '');
    $('p-category').value = '';
    $('pform-title').textContent = 'Add product';
  };

  window.kSaveProduct = async function () {
    const name = $('p-name').value.trim();
    if (!name) { alert('Name (Hebrew) is required.'); return; }
    const body = {
      name,
      emoji: $('p-emoji').value.trim() || null,
      category_id: $('p-category').value ? +$('p-category').value : null,
      unit: $('p-unit').value.trim() || null,
      price: $('p-price').value !== '' ? +$('p-price').value : null,
      barcode: $('p-barcode').value.trim() || null,
    };
    const id = $('p-id').value;
    if (id) body.id = +id;
    try {
      await jpost('/api/kitchen/products', body);
      window.kResetForm();
      await loadProducts();
    } catch (e) { alert('Save failed: ' + e.message); }
  };

  async function delProduct(id) {
    const p = products.find(x => x.id === id);
    if (!confirm(`Delete "${p ? p.name : id}" from the catalog?`)) return;
    try { await jpost('/api/kitchen/products/delete', { id }); await loadProducts(); }
    catch (e) { alert('Delete failed: ' + e.message); }
  }

  // ── shopping list ──
  async function loadList() {
    try { const d = await jget('/api/kitchen/list'); listItems = d.items || []; }
    catch (e) { listItems = []; $('l-rows').innerHTML =
      `<div class="k-hint" style="color:#ef5a6a">Can't reach kitchen service (${esc(e.message)})</div>`; return; }
    renderList();
  }

  function renderList() {
    const box = $('l-rows');
    if (!listItems.length) { box.innerHTML = '<div class="k-hint">List is empty. Add items from the fridge tablet, or the 📦 Stock tab.</div>'; return; }
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
      return `<div class="k-li ${i.checked ? 'checked' : ''}" data-id="${i.id}">
        <input type="checkbox" ${i.checked ? 'checked' : ''} data-act="check">
        <span class="em">${emoji}</span>
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
    box.innerHTML = html;
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

  // ── stock (qty_on_hand + low threshold per product, in its unit) ──
  function renderStock() {
    const box = $('stock-rows');
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
        const unit = p.unit || '';
        const stock = numOf(p.qty_on_hand);
        const low = p.low_stock_threshold != null ? numOf(p.low_stock_threshold) : null;
        const isLow = low != null && stock <= low;
        return `<div class="k-srow st" data-id="${p.id}">
          <span class="em">${p.emoji || '🍽️'}</span>
          <span class="nm">${esc(p.name)}</span>
          <span class="k-step">
            <button data-act="dec" title="less">−</button>
            <span class="qn">${fmtN(stock)}</span>
            <button data-act="inc" title="more">+</button>
          </span>
          <span class="k-unit">${esc(unitHe(unit))}</span>
          <span class="k-unit">low</span>
          <input class="k-lowin" data-act="low" type="number" step="0.5" min="0" value="${low != null ? fmtN(low) : ''}">
          ${isLow ? '<span class="k-stock-chip low">⚠ חסר</span>' : '<span></span>'}
        </div>`;
      }).join('');
    });
    box.innerHTML = html;
    box.querySelectorAll('.k-srow').forEach(row => {
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
          <span class="em">${p.emoji || '🍽️'}</span>
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
          <span class="em">${p.emoji || '🍽️'}</span>
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
  window.kLoad = async function () { await loadProducts(); await loadCategories(); await loadList(); await loadTech(); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.kLoad);
  else window.kLoad();
})();
