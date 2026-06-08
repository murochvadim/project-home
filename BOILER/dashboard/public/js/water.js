// Water Consumption tab (Boiler Agent page). Mirrors the Project Power Settings
// tab (js/power.js ps*/pb*) but adapted for Israeli household water billing.
// Backed by /api/water/* (routes-water.js) + the water_bills table.
//
// Phase 1: works entirely from manually entered / pasted bills. The Current
// Period card shows a "meter not connected" placeholder until a flow sensor is
// added (Phase 2), at which point /api/water/status returns live m³ + cost and
// wcRender lights the card up automatically.
//
// All globals are prefixed ws/wb/wc/water to avoid colliding with the Boiler
// page's existing main.js / graph.js / data.js symbols.

function wEscHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Compact bimonthly period label: "2024-05-01"+"2024-06-30" → "5-6 2024".
function wbPeriodLabel(b) {
  const s = b.period_start, e = b.period_end;
  if (!s && !e) return '<span style="color:#aaa;">—</span>';
  const sm = s ? parseInt(s.slice(5, 7), 10) : null;
  const em = e ? parseInt(e.slice(5, 7), 10) : null;
  const yr = (s || e).slice(0, 4);
  if (sm && em) return `${sm}-${em} ${yr}`;
  if (sm) return `${sm} ${yr}`;
  return yr;
}

// Entry point — called by index.html's showMainTab('water') + handlePageRefresh.
window.waterOnTabShow = function () {
  wsLoad();
  wbLoad();
  wcLoad();
};

// ─── Settings (billing + tariff) ──────────────────────────────────
function wsShowSewage() {
  const mode = document.getElementById('ws-tariff-sewage-mode').value;
  document.getElementById('ws-sewage-rate-wrap').style.display = (mode === 'separate') ? '' : 'none';
}

async function wsLoad() {
  try {
    const d = await (await fetch('/api/water/settings')).json();
    const bl = d.billing || {};
    document.getElementById('ws-billing-start-day').value     = bl.start_day ?? '';
    document.getElementById('ws-billing-length').value        = bl.length_months ?? '';
    document.getElementById('ws-billing-current-start').value = bl.current_period_start_date ?? '';
    const t = d.tariff || {};
    document.getElementById('ws-tariff-persons').value          = t.persons_in_household ?? '';
    document.getElementById('ws-tariff-low-rate').value         = t.low_tier_rate_ils_per_m3 ?? '';
    document.getElementById('ws-tariff-quota-base').value       = t.low_tier_quota_base_m3 ?? '';
    document.getElementById('ws-tariff-quota-per-person').value = t.low_tier_quota_per_person_m3 ?? '';
    document.getElementById('ws-tariff-high-rate').value        = t.high_tier_rate_ils_per_m3 ?? '';
    document.getElementById('ws-tariff-sewage-mode').value      = t.sewage_mode ?? 'bundled';
    document.getElementById('ws-tariff-sewage-rate').value      = t.sewage_rate_ils_per_m3 ?? '';
    document.getElementById('ws-tariff-fixed-charge').value     = t.fixed_charge_ils ?? '';
    document.getElementById('ws-tariff-vat').value              = t.vat_pct ?? '';
    document.getElementById('ws-tariff-currency').value         = t.currency_symbol ?? '₪';
    wsShowSewage();
  } catch (e) {
    const msg = document.getElementById('ws-save-msg');
    if (msg) { msg.textContent = `Load error: ${e.message}`; msg.style.color = '#c0392b'; }
  }
}

async function wsSave() {
  const msg = document.getElementById('ws-save-msg');
  msg.textContent = '';
  const body = {
    billing: {
      start_day:                 parseInt(document.getElementById('ws-billing-start-day').value, 10),
      length_months:             parseInt(document.getElementById('ws-billing-length').value, 10),
      current_period_start_date: document.getElementById('ws-billing-current-start').value || null,
    },
    tariff: {
      persons_in_household:         parseInt(document.getElementById('ws-tariff-persons').value, 10),
      low_tier_rate_ils_per_m3:     parseFloat(document.getElementById('ws-tariff-low-rate').value),
      low_tier_quota_base_m3:       parseFloat(document.getElementById('ws-tariff-quota-base').value),
      low_tier_quota_per_person_m3: parseFloat(document.getElementById('ws-tariff-quota-per-person').value),
      high_tier_rate_ils_per_m3:    parseFloat(document.getElementById('ws-tariff-high-rate').value),
      sewage_mode:                  document.getElementById('ws-tariff-sewage-mode').value,
      sewage_rate_ils_per_m3:       parseFloat(document.getElementById('ws-tariff-sewage-rate').value),
      fixed_charge_ils:             parseFloat(document.getElementById('ws-tariff-fixed-charge').value),
      vat_pct:                      parseFloat(document.getElementById('ws-tariff-vat').value),
      currency_symbol:              document.getElementById('ws-tariff-currency').value,
    },
  };
  const btn = document.getElementById('ws-save-btn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/water/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) { msg.textContent = `Save failed: ${d.error || r.statusText}`; msg.style.color = '#c0392b'; return; }
    msg.textContent = '✓ Saved'; msg.style.color = '#27ae60';
    setTimeout(() => { msg.textContent = ''; }, 2500);
    wbLoad();   // estimates depend on tariff — refresh the bills table
  } catch (e) {
    msg.textContent = `Save error: ${e.message}`; msg.style.color = '#c0392b';
  } finally {
    btn.disabled = false;
  }
}

// ─── Past Water Bills ─────────────────────────────────────────────
async function wbLoad() {
  try {
    const rows = await (await fetch('/api/water/bills')).json();
    const tbody = document.getElementById('wb-tbody');
    if (!Array.isArray(rows) || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:14px; color:#aaa; text-align:center;">No water bills yet. Paste a PDF or add one manually with the buttons above.</td></tr>';
      return;
    }
    // Rows arrive newest-first; each row's "previous period" is the next (older)
    // row, used for the Private/Shared consumption Δ.
    tbody.innerHTML = rows.map((b, i) => {
      const prev = rows[i + 1];
      const est = b.est_cost_ils != null ? Number(b.est_cost_ils).toFixed(2) : '—';
      const act = b.total_cost_ils != null ? Number(b.total_cost_ils).toFixed(2) : '<span style="color:#aaa;">—</span>';
      let diffCell = '—';
      if (b.total_cost_ils != null && b.est_cost_ils != null && Number(b.est_cost_ils) !== 0) {
        const diff = Number(b.total_cost_ils) - Number(b.est_cost_ils);
        const pct  = (Math.abs(diff) / Number(b.est_cost_ils)) * 100;
        const col  = Math.abs(pct) <= 5 ? '#27ae60' : Math.abs(pct) <= 15 ? '#e67e22' : '#c0392b';
        diffCell = `<span style="color:${col}; font-weight:600;">${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (${pct.toFixed(1)}%)</span>`;
      }
      // Compact bimonthly label, e.g. "5-6 2024".
      const period = wbPeriodLabel(b);
      // m³ value + Δ vs previous period (▲ more = red, ▼ less = green).
      const m3cell = (val, prevVal) => {
        if (val == null) return '—';
        let d = '';
        if (prevVal != null) {
          const delta = Number(val) - Number(prevVal);
          if (Math.abs(delta) >= 0.01) {
            const up = delta > 0;
            d = ` <span style="font-size:0.72rem; color:${up ? '#c0392b' : '#27ae60'};">${up ? '▲' : '▼'}${Math.abs(delta).toFixed(1)}</span>`;
          }
        }
        return `${Number(val).toFixed(1)}${d}`;
      };
      return `
        <tr style="border-bottom:1px solid #e6e1da;">
          <td style="padding:10px 14px; white-space:nowrap;">${period}</td>
          <td style="padding:10px 14px; text-align:right; white-space:nowrap;">${m3cell(b.private_m3, prev && prev.private_m3)}</td>
          <td style="padding:10px 14px; text-align:right; white-space:nowrap;">${m3cell(b.shared_m3, prev && prev.shared_m3)}</td>
          <td style="padding:10px 14px; text-align:right;">${est}</td>
          <td style="padding:10px 14px; text-align:right;">${act}</td>
          <td style="padding:10px 14px; text-align:right;">${diffCell}</td>
          <td style="padding:10px 14px; text-align:center;">
            <button class="btn btn-secondary btn-sm" style="color:#c0392b; padding:4px 10px;" onclick="wbDelete(${b.id})">×</button>
          </td>
        </tr>`;
    }).join('');
  } catch (e) {
    document.getElementById('wb-tbody').innerHTML =
      `<tr><td colspan="7" style="padding:14px; color:#c0392b; text-align:center;">Load failed: ${wEscHtml(e.message)}</td></tr>`;
  }
}

// PDF upload → server parses (best-effort) and RETURNS fields without inserting.
// We then open the editable confirm modal pre-filled, so an imperfect/empty
// parse is still usable. The confirmed values are inserted via wbConfirmSave.
async function wbUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const msg = document.getElementById('wb-upload-msg');
  msg.textContent = `Reading "${file.name}"…`;
  msg.style.color = '#666';
  const fd = new FormData();
  fd.append('pdf', file);
  try {
    const r = await fetch('/api/water/bills/upload', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) { msg.textContent = `Failed: ${d.error || r.statusText}`; msg.style.color = '#c0392b'; return; }
    msg.textContent = 'Parsed — review the values below.';
    msg.style.color = '#666';
    wbShowConfirmModal(d.parsed || {}, 'pdf_parsed');
  } catch (e) {
    msg.textContent = `Upload error: ${e.message}`; msg.style.color = '#c0392b';
  } finally {
    event.target.value = '';
  }
}

function wbOpenManual() {
  document.getElementById('wb-upload-msg').textContent = '';
  wbShowConfirmModal({}, 'manual_confirmed');
}

// Editable confirm modal — collects period + m³ + actual ₪ before insert.
function wbShowConfirmModal(parsed, source) {
  wbCloseModal();
  const p = parsed || {};
  const html = `
    <div id="wb-modal" style="position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:1010; display:flex; align-items:center; justify-content:center;">
      <div style="background:#fff; max-width:560px; width:90%; max-height:90vh; overflow-y:auto; border-radius:8px; padding:24px;">
        <h2 style="margin-top:0;">${source === 'pdf_parsed' ? 'Confirm parsed water bill' : 'Add water bill'}</h2>
        <p style="font-size:0.85rem; color:#888; margin-top:4px;">
          ${source === 'pdf_parsed'
            ? 'The parser is preliminary — check each field and fill any blanks before saving.'
            : 'Enter the values from your water bill.'}
        </p>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:14px;">
          <div>
            <label class="w-form-label">Period start</label>
            <input id="wb-m-start" type="date" class="w-form-input" value="${wEscHtml(p.period_start || '')}">
          </div>
          <div>
            <label class="w-form-label">Period end</label>
            <input id="wb-m-end" type="date" class="w-form-input" value="${wEscHtml(p.period_end || '')}">
          </div>
          <div>
            <label class="w-form-label">Private consumption (m³)</label>
            <input id="wb-m-private" type="number" min="0" step="0.01" class="w-form-input" value="${p.private_m3 != null ? wEscHtml(p.private_m3) : ''}">
          </div>
          <div>
            <label class="w-form-label">Shared consumption (m³)</label>
            <input id="wb-m-shared" type="number" min="0" step="0.01" class="w-form-input" value="${p.shared_m3 != null ? wEscHtml(p.shared_m3) : ''}">
          </div>
          <div>
            <label class="w-form-label">Actual total (₪)</label>
            <input id="wb-m-cost" type="number" min="0" step="0.01" class="w-form-input" value="${p.total_cost_ils != null ? wEscHtml(p.total_cost_ils) : ''}">
          </div>
        </div>
        <div style="margin-top:22px; display:flex; gap:10px; align-items:center;">
          <button class="btn btn-primary btn-sm" onclick="wbConfirmSave('${source}')" style="padding:9px 22px; font-size:0.95rem;">Save bill</button>
          <button class="btn btn-secondary btn-sm" onclick="wbCloseModal()" style="padding:9px 18px; font-size:0.95rem;">Cancel</button>
          <span id="wb-m-msg" style="font-size:0.85rem; font-weight:600;"></span>
        </div>
      </div>
    </div>`;
  window._wbParsed = p;
  document.body.insertAdjacentHTML('beforeend', html);
}

function wbCloseModal() {
  const el = document.getElementById('wb-modal');
  if (el) el.remove();
  window._wbParsed = null;
}

async function wbConfirmSave(source) {
  const start = document.getElementById('wb-m-start').value || null;
  const end   = document.getElementById('wb-m-end').value || null;
  const priv  = document.getElementById('wb-m-private').value;
  const shar  = document.getElementById('wb-m-shared').value;
  const cost  = document.getElementById('wb-m-cost').value;
  const mMsg  = document.getElementById('wb-m-msg');
  if (priv === '' && shar === '' && cost === '' && !start && !end) {
    mMsg.textContent = 'Enter at least the period + consumption.'; mMsg.style.color = '#c0392b'; return;
  }
  try {
    const r = await fetch('/api/water/bills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        period_start: start, period_end: end,
        private_m3: priv === '' ? null : Number(priv),
        shared_m3:  shar === '' ? null : Number(shar),
        total_cost_ils: cost === '' ? null : Number(cost),
        source, parsed: window._wbParsed || {},
      }),
    });
    const d = await r.json();
    if (!r.ok) { mMsg.textContent = `Save failed: ${d.error || r.statusText}`; mMsg.style.color = '#c0392b'; return; }
    wbCloseModal();
    document.getElementById('wb-upload-msg').textContent = '✓ Bill saved';
    document.getElementById('wb-upload-msg').style.color = '#27ae60';
    setTimeout(() => { const m = document.getElementById('wb-upload-msg'); if (m) m.textContent = ''; }, 4000);
    wbLoad();
  } catch (e) {
    mMsg.textContent = `Save error: ${e.message}`; mMsg.style.color = '#c0392b';
  }
}

async function wbDelete(id) {
  if (!confirm('Delete this water bill record?')) return;
  try {
    const r = await fetch(`/api/water/bills/${id}`, { method: 'DELETE' });
    if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || r.statusText); return; }
    wbLoad();
  } catch (e) { alert(e.message); }
}

// ─── Current Period card (meter-ready placeholder) ────────────────
async function wcLoad() {
  try {
    const d = await (await fetch('/api/water/status')).json();
    wcRender(d || {});
  } catch (e) {
    wcRender({ meter_connected: false });
  }
}

function wcRender(d) {
  const card = document.getElementById('water-current-card');
  const placeholder = document.getElementById('wc-placeholder');
  const live = document.getElementById('wc-live');
  const tag = document.getElementById('wc-meter-state-tag');
  if (!card) return;
  if (!d.meter_connected) {
    card.setAttribute('data-meter-state', 'none');
    if (placeholder) placeholder.style.display = '';
    if (live) live.style.display = 'none';
    if (tag) tag.textContent = '- meter not connected';
    return;
  }
  // Phase 2 — live meter feeding period m³ + cost.
  card.setAttribute('data-meter-state', 'live');
  if (placeholder) placeholder.style.display = 'none';
  if (live) live.style.display = '';
  if (tag) tag.textContent = '- live';
  const p = d.period || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('wc-period-m3', p.m3 != null ? `${Number(p.m3).toFixed(1)} m³` : '—');
  set('wc-period-cost', p.cost != null ? `₪${Number(p.cost).toFixed(2)}` : '—');
  set('wc-period-start', p.start ? String(p.start).slice(0, 10) : '—');
  set('wc-meter-last-update', d.age_sec != null ? `${Math.round(d.age_sec)}s ago` : '—');
}
