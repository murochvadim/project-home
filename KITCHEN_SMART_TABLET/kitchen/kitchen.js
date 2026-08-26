// Kitchen PWA — served same-origin by kitchen_service.py on LXC 113.
// Data-only: fetches the CRUD API with relative URLs. No MQTT.
(function () {
  let products = [];
  let listItems = [];
  let mode = 'buy';                 // 'buy' | 'browse'

  const $ = id => document.getElementById(id);
  const esc = s => (s || '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function jget(p) {
    const r = await fetch(p, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function jpost(p, b) {
    const r = await fetch(p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b || {}),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ── mode ──
  function setMode(m) {
    mode = m;
    $('mode-buy').classList.toggle('active', m === 'buy');
    $('mode-browse').classList.toggle('active', m === 'browse');
  }
  window.setMode = setMode;

  // ── tile grid ──
  function renderGrid() {
    const g = $('grid');
    if (!products.length) {
      g.innerHTML = '<div id="empty">No products yet — add them from the dashboard Kitchen Agent page.</div>';
      return;
    }
    g.innerHTML = products.map(p => `
      <button class="tile" data-id="${p.id}">
        <div class="emoji">${p.emoji || '🍽️'}</div>
        <div class="pname">${esc(p.name)}</div>
      </button>`).join('');
    g.querySelectorAll('.tile').forEach(t => t.onclick = () => tileTap(+t.dataset.id, t));
  }

  async function tileTap(id, el) {
    const p = products.find(x => x.id === id);
    if (mode === 'buy') {
      try {
        await jpost('/api/kitchen/list/add', { product_id: id });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 350);
        await refreshList();
      } catch (e) { alert('Add failed: ' + e.message); }
    } else {
      showDetail(p);
    }
  }

  // ── shopping list ──
  async function refreshList() {
    try {
      const d = await jget('/api/kitchen/list');
      listItems = d.items || [];
      const unchecked = listItems.filter(i => !i.checked).length;
      $('listcount').textContent = unchecked;
      if ($('listview').classList.contains('open')) renderList();
    } catch (e) { /* keep last */ }
  }

  function renderList() {
    const box = $('listitems');
    if (!listItems.length) {
      box.innerHTML = '<div class="li-empty">List is empty. Tap 🛒 Buy tiles, or add an item below.</div>';
      return;
    }
    box.innerHTML = listItems.map(i => {
      const name = i.product_name || i.free_text || '(item)';
      const emoji = i.product_emoji || '🛒';
      const qty = (i.qty && +i.qty !== 1) ? ` ×${(+i.qty)}` : '';
      return `<div class="li ${i.checked ? 'checked' : ''}" data-id="${i.id}">
        <button class="li-check" data-act="check">${i.checked ? '✓' : ''}</button>
        <span class="li-emoji">${emoji}</span>
        <span class="li-name">${esc(name)}${qty}</span>
        <button class="li-rm" data-act="rm">🗑</button>
      </div>`;
    }).join('');
    box.querySelectorAll('.li').forEach(row => {
      const id = +row.dataset.id;
      row.querySelector('[data-act=check]').onclick = () => toggleCheck(id);
      row.querySelector('[data-act=rm]').onclick = () => removeItem(id);
    });
  }

  async function toggleCheck(id) {
    const it = listItems.find(x => x.id === id);
    await jpost('/api/kitchen/list/check', { id, checked: !it.checked });
    await refreshList();
  }
  async function removeItem(id) {
    await jpost('/api/kitchen/list/remove', { id });
    await refreshList();
  }
  async function manualAdd() {
    const inp = $('manualadd');
    const t = inp.value.trim();
    if (!t) return;
    await jpost('/api/kitchen/list/add', { free_text: t });
    inp.value = '';
    await refreshList();
  }
  window.manualAdd = manualAdd;

  window.openList = () => { $('listview').classList.add('open'); renderList(); };
  window.closeList = () => $('listview').classList.remove('open');

  // ── product detail (Browse) ──
  function showDetail(p) {
    const rows = [
      ['Category', p.category], ['Unit', p.unit],
      ['Price', p.price != null ? '₪' + p.price : null],
      ['Calories/unit', p.calories_per_unit],
      ['Nutri-Score', p.nutri_score], ['Health (1-5)', p.health_score],
      ['Barcode', p.barcode],
    ].filter(r => r[1] != null && r[1] !== '');
    $('detailbody').innerHTML =
      `<div class="dt-emoji">${p.emoji || '🍽️'}</div>
       <div class="dt-name">${esc(p.name)}${p.name_en ? ' · ' + esc(p.name_en) : ''}</div>` +
      rows.map(r => `<div class="dt-row"><span class="k">${r[0]}</span><span>${esc(String(r[1]))}</span></div>`).join('') +
      `<div class="ov-add" style="border:none;background:transparent;margin-top:16px;">
         <button style="flex:1" onclick="addFromDetail(${p.id})">🛒 Add to list</button>
       </div>`;
    $('detailview').classList.add('open');
  }
  window.closeDetail = () => $('detailview').classList.remove('open');
  window.addFromDetail = async (id) => {
    await jpost('/api/kitchen/list/add', { product_id: id });
    await refreshList();
    window.closeDetail();
  };

  // ── boot + poll ──
  async function boot() {
    try { products = await jget('/api/kitchen/products'); } catch (e) { products = []; }
    renderGrid();
    await refreshList();
    setInterval(async () => {
      try { products = await jget('/api/kitchen/products'); renderGrid(); } catch (e) {}
      await refreshList();
    }, 30000);          // reflect dashboard edits without a reload
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
