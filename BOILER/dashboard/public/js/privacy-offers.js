/* Privacy → Offers — PROTOTYPE Excel-like table.
 * Values or =formulas; ON-DEMAND 🧮 Calculate. Add/remove last row/column.
 * Per-cell fill + text colour + type (Number/Text). Conditional auto-colour by
 * value. Drag to select a RANGE; Merge/Split cells. Saved plaintext to
 * dashboard_settings.privacy.offers (encryption / lock is the NEXT layer).
 *
 * model.cells["r_c"] = {v,bg,fg,type}   model.conditional = [{scope,op,val,bg,fg}]
 * model.merges = [{r,c,rs,cs}]          (rs=rowspan, cs=colspan, anchored at r,c) */
(function () {
  'use strict';
  const KEY = 'privacy.offers';
  const $ = (id) => document.getElementById(id);
  let model = null, results = {};
  let selRange = null;            // {r1,c1,r2,c2}
  let dragging = false, selStart = null;

  const colName = (c) => { let s = '', n = c + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const colIndex = (name) => { let c = 0; for (const ch of name.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64); return c - 1; };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const fmt = (v) => (v === null || v === undefined || v === '') ? '' : (typeof v === 'number' ? (isNaN(v) ? '#ERR' : (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6))) : String(v));
  const defaultModel = () => ({ rows: 6, cols: 4, cells: {}, conditional: [], merges: [] });

  function cellObj(r, c) { let o = model.cells[r + '_' + c]; if (typeof o === 'string') o = { v: o }; return o || {}; }
  const raw = (r, c) => cellObj(r, c).v || '';
  function writeCell(r, c, patch) { const k = r + '_' + c; let o = model.cells[k]; if (typeof o === 'string') o = { v: o }; o = Object.assign({}, o || {}, patch); if ((!o.v) && !o.bg && !o.fg && !o.type) delete model.cells[k]; else model.cells[k] = o; }
  const setRaw = (r, c, v) => writeCell(r, c, { v: v });

  function status(msg, ok) { const s = $('pvof-status'); if (!s) return; s.textContent = msg; s.style.color = ok ? '#2e7d32' : '#c0392b'; if (ok) setTimeout(() => { if (s) s.textContent = ''; }, 1500); }

  async function load() {
    try { const j = await (await fetch('/api/dashboard-settings/' + KEY)).json(); const v = j && j.value; model = (v && v.rows) ? v : defaultModel(); }
    catch (e) { model = defaultModel(); }
    if (!model.cells) model.cells = {}; if (!model.conditional) model.conditional = []; if (!model.merges) model.merges = [];
    results = {}; selRange = null; render(); refreshColDropdowns(); renderCondList();
  }
  window.pvofSave = async function () {
    try { const r = await fetch('/api/dashboard-settings/' + KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: model }) }); status(r.ok ? '✓ Saved' : 'Save failed', r.ok); }
    catch (e) { status('Save failed: ' + e.message, false); }
  };

  // ── merges + selection helpers ──
  function sanitizeMerges() { model.merges = (model.merges || []).filter((m) => m.r + m.rs <= model.rows && m.c + m.cs <= model.cols && (m.rs > 1 || m.cs > 1)); }
  function coveredSet() { const cov = new Set(); for (const m of (model.merges || [])) for (let r = m.r; r < m.r + m.rs; r++) for (let c = m.c; c < m.c + m.cs; c++) if (!(r === m.r && c === m.c)) cov.add(r + '_' + c); return cov; }
  function mergeAt(r, c) { return (model.merges || []).find((m) => m.r === r && m.c === c) || null; }
  function norm() { if (!selRange) return null; return { r1: Math.min(selRange.r1, selRange.r2), c1: Math.min(selRange.c1, selRange.c2), r2: Math.max(selRange.r1, selRange.r2), c2: Math.max(selRange.c1, selRange.c2) }; }
  function inSel(r, c) { const n = norm(); return !!(n && r >= n.r1 && r <= n.r2 && c >= n.c1 && c <= n.c2); }

  function cellNumeric(r, c) { const rw = raw(r, c); if (rw.startsWith('=')) return results.hasOwnProperty(r + '_' + c) ? Number(results[r + '_' + c]) : NaN; const n = parseFloat(rw); return isNaN(n) ? NaN : n; }
  function condMatch(r, c) {
    const num = cellNumeric(r, c); if (isNaN(num)) return null;
    for (const rule of (model.conditional || [])) {
      if (rule.scope !== 'all' && Number(rule.scope) !== c) continue;
      const v = Number(rule.val); let ok = false;
      switch (rule.op) { case '>': ok = num > v; break; case '<': ok = num < v; break; case '>=': ok = num >= v; break; case '<=': ok = num <= v; break; case '=': ok = num === v; break; case '!=': ok = num !== v; break; }
      if (ok) return rule;
    }
    return null;
  }

  function render() {
    const host = $('pvof-grid'); if (!host || !model) return;
    sanitizeMerges();
    const cov = coveredSet();
    let h = '<table class="pvof-table"><thead><tr><th class="pvof-corner"></th>';
    for (let c = 0; c < model.cols; c++) h += '<th>' + colName(c) + '</th>';
    h += '</tr></thead><tbody>';
    for (let r = 0; r < model.rows; r++) {
      h += '<tr><th class="pvof-rownum">' + (r + 1) + '</th>';
      for (let c = 0; c < model.cols; c++) {
        if (cov.has(r + '_' + c)) continue;                 // covered by a merge → no cell
        const mg = mergeAt(r, c), span = mg ? (' colspan="' + mg.cs + '" rowspan="' + mg.rs + '"') : '';
        const o = cellObj(r, c), rw = o.v || '', isF = rw.startsWith('=');
        const disp = isF ? (results.hasOwnProperty(r + '_' + c) ? fmt(results[r + '_' + c]) : rw) : rw;
        const cond = condMatch(r, c);
        const bg = (cond && cond.bg) || o.bg || '';
        const fg = (cond && cond.fg) || o.fg || (isF ? '#1a7f37' : '');
        const align = (o.type === 'text') ? 'left' : (o.type === 'number' ? 'right' : (isF ? 'right' : 'left'));
        let st = 'text-align:' + align + ';'; if (bg) st += 'background:' + bg + ';'; if (fg) st += 'color:' + fg + ';'; if (isF) st += 'font-weight:600;';
        h += '<td' + span + '><input data-r="' + r + '" data-c="' + c + '"' + (inSel(r, c) ? ' class="pvof-sel"' : '') + ' value="' + esc(disp) + '" style="' + st + '"></td>';
      }
      h += '</tr>';
    }
    host.innerHTML = h + '</tbody></table>';
    host.querySelectorAll('input[data-r]').forEach((inp) => {
      const r = +inp.dataset.r, c = +inp.dataset.c;
      inp.addEventListener('mousedown', () => { dragging = true; selStart = { r, c }; selRange = { r1: r, c1: c, r2: r, c2: c }; paintSel(); });
      inp.addEventListener('mouseenter', () => { if (dragging && selStart) { selRange = { r1: selStart.r, c1: selStart.c, r2: r, c2: c }; paintSel(); } });
      inp.addEventListener('focus', () => { if (!dragging) { selStart = { r, c }; selRange = { r1: r, c1: c, r2: r, c2: c }; } inp.value = raw(r, c); syncFmtToolbar(); paintSel(); });
      inp.addEventListener('blur', () => { const val = inp.value.trim(); const ch = raw(r, c) !== val; setRaw(r, c, val); if (ch) delete results[r + '_' + c]; render(); });
    });
    paintSel();
  }
  function paintSel() { const host = $('pvof-grid'); if (!host) return; host.querySelectorAll('input[data-r]').forEach((inp) => inp.classList.toggle('pvof-sel', inSel(+inp.dataset.r, +inp.dataset.c))); }
  function syncFmtToolbar() { const n = norm(); if (!n) return; const o = cellObj(n.r1, n.c1); if ($('pvof-bg')) $('pvof-bg').value = o.bg || '#ffffff'; if ($('pvof-fg')) $('pvof-fg').value = o.fg || '#000000'; if ($('pvof-type')) $('pvof-type').value = o.type || 'auto'; }

  // ── format (applies to the whole selected range) ──
  function applyFmt(patch) { const n = norm(); if (!n) { status('Click or drag cells first', false); return; } for (let r = n.r1; r <= n.r2; r++) for (let c = n.c1; c <= n.c2; c++) writeCell(r, c, patch); render(); }
  window.pvofSetBg = () => applyFmt({ bg: $('pvof-bg').value });
  window.pvofSetFg = () => applyFmt({ fg: $('pvof-fg').value });
  window.pvofSetType = () => { const t = $('pvof-type').value; applyFmt({ type: t === 'auto' ? undefined : t }); };
  window.pvofClearFmt = () => applyFmt({ bg: undefined, fg: undefined, type: undefined });

  // ── merge / split ──
  const noOverlap = (m, n) => m.r + m.rs <= n.r1 || m.r > n.r2 || m.c + m.cs <= n.c1 || m.c > n.c2;
  window.pvofMerge = function () {
    const n = norm(); if (!n) { status('Select a range first', false); return; }
    if (n.r1 === n.r2 && n.c1 === n.c2) { status('Drag to select 2+ cells, then Merge', false); return; }
    model.merges = (model.merges || []).filter((m) => noOverlap(m, n));
    model.merges.push({ r: n.r1, c: n.c1, rs: n.r2 - n.r1 + 1, cs: n.c2 - n.c1 + 1 });
    render(); status('✓ Merged', true);
  };
  window.pvofSplit = function () {
    const n = norm(); if (!n) { status('Select the merged cell first', false); return; }
    const before = (model.merges || []).length;
    model.merges = (model.merges || []).filter((m) => noOverlap(m, n));
    render(); status(before > model.merges.length ? '✓ Split' : 'No merged cell in selection', before > model.merges.length);
  };

  // ── conditional rules ──
  window.pvofAddCond = function () {
    const scope = $('pvof-c-col').value, op = $('pvof-c-op').value, val = $('pvof-c-val').value;
    if (val === '' || isNaN(parseFloat(val))) { status('Enter a number for the rule', false); return; }
    model.conditional.push({ scope: scope, op: op, val: parseFloat(val), bg: $('pvof-c-bg').value, fg: $('pvof-c-fg').value });
    renderCondList(); render();
  };
  window.pvofDelCond = function (i) { model.conditional.splice(i, 1); renderCondList(); render(); };
  function refreshColDropdowns() {
    const sel = $('pvof-c-col'); if (!sel) return; const cur = sel.value; let o = '<option value="all">All cells</option>';
    for (let c = 0; c < model.cols; c++) o += '<option value="' + c + '">Col ' + colName(c) + '</option>';
    sel.innerHTML = o; if (cur && Array.prototype.some.call(sel.options, (op) => op.value === cur)) sel.value = cur;
  }
  function renderCondList() {
    const host = $('pvof-cond-list'); if (!host) return;
    host.innerHTML = (model.conditional || []).map((r, i) => {
      const where = r.scope === 'all' ? 'any' : ('col ' + colName(Number(r.scope)));
      return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:0.78rem;padding:3px 8px;border-radius:11px;border:1px solid #cbd5e1;">' +
        '<span style="width:11px;height:11px;border-radius:3px;border:1px solid #999;background:' + (r.bg || '#fff') + ';"></span>' +
        '<span style="color:' + (r.fg || '#333') + ';">' + where + ' ' + esc(r.op) + ' ' + esc(String(r.val)) + '</span>' +
        '<span onclick="pvofDelCond(' + i + ')" title="remove rule" style="cursor:pointer;color:#c0392b;font-weight:700;font-size:0.95rem;">×</span></span>';
    }).join(' ') || '<span style="color:#aaa;font-size:0.8rem;">no rules</span>';
  }

  // ── formula evaluation (only on Calculate) ──
  function cellVal(r, c, seen) { const rw = raw(r, c); if (rw === '') return 0; if (rw.startsWith('=')) { const k = r + '_' + c; if (seen.has(k)) return NaN; seen.add(k); const v = evalFormula(rw.slice(1), seen); seen.delete(k); return v; } const n = parseFloat(rw); return isNaN(n) ? 0 : n; }
  function refVal(ref, seen) { const m = ref.match(/^([A-Za-z]+)(\d+)$/); if (!m) return 0; const c = colIndex(m[1]), r = +m[2] - 1; return (c >= 0 && c < model.cols && r >= 0 && r < model.rows) ? cellVal(r, c, seen) : 0; }
  function rangeVals(a, b, seen) { const ma = a.match(/^([A-Za-z]+)(\d+)$/), mb = b.match(/^([A-Za-z]+)(\d+)$/); if (!ma || !mb) return []; let c1 = colIndex(ma[1]), r1 = +ma[2] - 1, c2 = colIndex(mb[1]), r2 = +mb[2] - 1; if (c1 > c2) { const t = c1; c1 = c2; c2 = t; } if (r1 > r2) { const t = r1; r1 = r2; r2 = t; } const out = []; for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (c >= 0 && c < model.cols && r >= 0 && r < model.rows) out.push(cellVal(r, c, seen)); return out; }
  function evalFormula(expr, seen) {
    expr = expr.replace(/(SUM|AVERAGE|AVG|MIN|MAX|COUNT)\s*\(([^()]*)\)/gi, (m, fn, args) => {
      fn = fn.toUpperCase(); let vals = [];
      args.split(/[,;]/).forEach((p) => { p = p.trim(); if (!p) return; const rng = p.match(/^([A-Za-z]+\d+)\s*:\s*([A-Za-z]+\d+)$/); if (rng) vals = vals.concat(rangeVals(rng[1], rng[2], seen)); else if (/^[A-Za-z]+\d+$/.test(p)) vals.push(refVal(p, seen)); else { const n = parseFloat(p); if (!isNaN(n)) vals.push(n); } });
      vals = vals.filter((v) => typeof v === 'number' && !isNaN(v)); let res = 0;
      if (fn === 'SUM') res = vals.reduce((a, b) => a + b, 0); else if (fn === 'AVERAGE' || fn === 'AVG') res = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0; else if (fn === 'MIN') res = vals.length ? Math.min.apply(null, vals) : 0; else if (fn === 'MAX') res = vals.length ? Math.max.apply(null, vals) : 0; else if (fn === 'COUNT') res = vals.length;
      return '(' + res + ')';
    });
    expr = expr.replace(/([A-Za-z]+\d+)/g, (m) => '(' + refVal(m, seen) + ')');
    return safeArith(expr);
  }
  function safeArith(str) {
    const s = str.replace(/\s+/g, ''); let i = 0;
    function expr() { let v = term(); while (s[i] === '+' || s[i] === '-') { const op = s[i++]; const t = term(); v = op === '+' ? v + t : v - t; } return v; }
    function term() { let v = factor(); while (s[i] === '*' || s[i] === '/') { const op = s[i++]; const f = factor(); v = op === '*' ? v * f : (f === 0 ? NaN : v / f); } return v; }
    function factor() { if (s[i] === '(') { i++; const v = expr(); if (s[i] === ')') i++; return v; } if (s[i] === '-') { i++; return -factor(); } if (s[i] === '+') { i++; return factor(); } let n = ''; while (i < s.length && /[0-9.]/.test(s[i])) n += s[i++]; return n === '' ? NaN : parseFloat(n); }
    try { const v = expr(); return i >= s.length ? v : NaN; } catch (e) { return NaN; }
  }

  window.pvofCalculate = function () { results = {}; for (let r = 0; r < model.rows; r++) for (let c = 0; c < model.cols; c++) if (raw(r, c).startsWith('=')) results[r + '_' + c] = cellVal(r, c, new Set()); render(); status('✓ Calculated', true); };
  window.pvofAddRow = function () { model.rows++; render(); };
  window.pvofDelRow = function () { if (model.rows > 1) { const r = model.rows - 1; for (let c = 0; c < model.cols; c++) { delete model.cells[r + '_' + c]; delete results[r + '_' + c]; } model.rows--; render(); } };
  window.pvofAddCol = function () { model.cols++; render(); refreshColDropdowns(); renderCondList(); };
  window.pvofDelCol = function () { if (model.cols > 1) { const c = model.cols - 1; for (let r = 0; r < model.rows; r++) { delete model.cells[r + '_' + c]; delete results[r + '_' + c]; } model.cols--; render(); refreshColDropdowns(); renderCondList(); } };

  document.addEventListener('mouseup', () => { dragging = false; });
  window.pvofOnTabShow = function () { if (!model) load(); };
})();
