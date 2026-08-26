// Kitchen Agent — dashboard controller.
// Calls the LXC 113 kitchen_service.py CRUD API DIRECTLY (cross-origin) — NO server.js
// business logic (architecture-guard safe). Same pattern as js/email.js.
(function () {
  const API = 'http://192.168.1.208:8772';   // LXC 113 kitchen-service (http; Caddy/HTTPS deferred to home)

  let products = [];
  let listItems = [];

  const $ = id => document.getElementById(id);
  const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
  }

  function renderProducts() {
    const tb = $('p-rows');
    $('p-count').textContent = `${products.length} product${products.length === 1 ? '' : 's'}`;
    if (!products.length) { tb.innerHTML = '<tr><td colspan="6" class="k-hint">No products yet — add one above.</td></tr>'; return; }
    tb.innerHTML = products.map(p => `
      <tr data-id="${p.id}">
        <td class="k-emoji">${p.emoji || '🍽️'}</td>
        <td class="heb">${esc(p.name)}</td>
        <td>${esc(p.category || '')}</td>
        <td>${esc(p.unit || '')}</td>
        <td>${p.price != null ? '₪' + (+p.price).toFixed(2).replace(/\.00$/, '') : ''}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="k-edit" data-act="edit" title="Edit">✎</button>
          <button class="k-x" data-act="del" title="Delete">🗑</button>
        </td>
      </tr>`).join('');
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
    $('p-category').value = p.category || '';
    $('p-unit').value = p.unit || '';
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
      category: $('p-category').value || null,
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
    if (!listItems.length) { box.innerHTML = '<div class="k-hint">List is empty. Add items from the fridge tablet, or check the Products tab.</div>'; return; }
    box.innerHTML = listItems.map(i => {
      const name = i.product_name || i.free_text || '(item)';
      const emoji = i.product_emoji || '🛒';
      const qty = (i.qty && +i.qty !== 1) ? ` ×${+i.qty}` : '';
      return `<div class="k-li ${i.checked ? 'checked' : ''}" data-id="${i.id}">
        <input type="checkbox" ${i.checked ? 'checked' : ''} data-act="check">
        <span class="em">${emoji}</span>
        <span class="nm">${esc(name)}${qty}</span>
        <button class="k-x" data-act="rm" title="Remove">🗑</button>
      </div>`;
    }).join('');
    box.querySelectorAll('.k-li').forEach(row => {
      const id = +row.dataset.id;
      row.querySelector('[data-act=check]').onchange = e => toggleCheck(id, e.target.checked);
      row.querySelector('[data-act=rm]').onclick = () => removeItem(id);
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
      const qty = (i.qty && +i.qty !== 1) ? ` x${+i.qty}` : '';
      return '• ' + name + qty;
    });
    const text = '🧺 Shopping list:\n' + lines.join('\n');
    // wa.me with no number → user picks the chat in WhatsApp.
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
  };

  // ── boot ──
  window.kLoad = async function () { await loadProducts(); await loadList(); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.kLoad);
  else window.kLoad();
})();
