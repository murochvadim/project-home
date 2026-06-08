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
  wgLoad();
};

// ─── Consumption graph (Private vs Shared m³) ─────────────────────
let _wgChart = null;
async function wgLoad() {
  const canvas = document.getElementById('water-consumption-chart');
  const empty = document.getElementById('wg-empty');
  if (!canvas || typeof Chart === 'undefined') return;
  try {
    const rows = await (await fetch('/api/water/bills')).json();
    // Chronological ascending, only rows with a period + some consumption.
    const bills = (Array.isArray(rows) ? rows : [])
      .filter(b => b.period_start)
      .sort((a, b) => (a.period_start < b.period_start ? -1 : 1));
    const mode = document.getElementById('wg-range')?.value || 'monthly';
    let labels = [], priv = [], shar = [];

    if (mode === 'yearly') {
      const byYear = {};
      for (const b of bills) {
        const y = b.period_start.slice(0, 4);
        (byYear[y] = byYear[y] || { p: 0, s: 0 });
        byYear[y].p += Number(b.private_m3 || 0);
        byYear[y].s += Number(b.shared_m3 || 0);
      }
      const years = Object.keys(byYear).sort();
      const rnd = (v) => Math.round(v * 100) / 100;   // kill float-sum artifacts (39.6500…006)
      labels = years; priv = years.map(y => rnd(byYear[y].p)); shar = years.map(y => rnd(byYear[y].s));
    } else {
      let list = bills;
      const nYears = { '2': 2, '3': 3, '4': 4, '5': 5 }[mode];
      if (nYears && bills.length) {
        const newestYear = Number(bills[bills.length - 1].period_start.slice(0, 4));
        const cutoff = newestYear - nYears + 1;
        list = bills.filter(b => Number(b.period_start.slice(0, 4)) >= cutoff);
      }
      labels = list.map(b => `${wbPeriodLabel(b)}`.replace(/<[^>]+>/g, ''));
      priv = list.map(b => Number(b.private_m3 || 0));
      shar = list.map(b => Number(b.shared_m3 || 0));
    }

    const hasData = labels.length > 0;
    canvas.style.display = hasData ? '' : 'none';
    if (empty) empty.style.display = hasData ? 'none' : '';
    if (!hasData) { if (_wgChart) { _wgChart.destroy(); _wgChart = null; } return; }

    if (_wgChart) _wgChart.destroy();
    _wgChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Private m³', data: priv, backgroundColor: '#4a9eff' },
          { label: 'Shared m³',  data: shar, backgroundColor: '#27ae60' },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top' } },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'm³' } } },
      },
    });
  } catch (e) {
    if (empty) { empty.style.display = ''; empty.textContent = `Graph error: ${e.message}`; }
  }
}

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
      tbody.innerHTML = '<tr><td colspan="6" style="padding:14px; color:#aaa; text-align:center;">No water bills yet. Paste a PDF or add one manually with the buttons above.</td></tr>';
      return;
    }
    // Rows arrive newest-first; each row's "previous period" is the next (older)
    // row, used for the Private/Shared consumption Δ.
    tbody.innerHTML = rows.map((b, i) => {
      const prev = rows[i + 1];
      const act = b.total_cost_ils != null ? Number(b.total_cost_ils).toFixed(2) : '<span style="color:#aaa;">—</span>';
      // Cost difference vs the previous bill (▲ red = costs more, ▼ green = less).
      let diffCell = '—';
      if (b.total_cost_ils != null && prev && prev.total_cost_ils != null) {
        const diff = Number(b.total_cost_ils) - Number(prev.total_cost_ils);
        if (Math.abs(diff) < 0.01) {
          diffCell = '<span style="color:#888;">0.00</span>';
        } else {
          const up = diff > 0;
          diffCell = `<span style="color:${up ? '#c0392b' : '#27ae60'}; font-weight:600;">${up ? '▲' : '▼'}${Math.abs(diff).toFixed(2)}</span>`;
        }
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
          <td style="padding:10px 14px; text-align:right;">${act}</td>
          <td style="padding:10px 14px; text-align:right;">${diffCell}</td>
          <td style="padding:10px 14px; text-align:center;">
            <button class="btn btn-secondary btn-sm" style="color:#c0392b; padding:4px 10px;" onclick="wbDelete(${b.id})">×</button>
          </td>
        </tr>`;
    }).join('');
  } catch (e) {
    document.getElementById('wb-tbody').innerHTML =
      `<tr><td colspan="6" style="padding:14px; color:#c0392b; text-align:center;">Load failed: ${wEscHtml(e.message)}</td></tr>`;
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
    // Stash any tariff drift so we can prompt to update Settings after the bill
    // is saved (same idea as the Project Power bill upload).
    window._wbDiff = Array.isArray(d.diff) ? d.diff : [];
    wbShowConfirmModal(d.parsed || {}, 'pdf_parsed');
  } catch (e) {
    msg.textContent = `Upload error: ${e.message}`; msg.style.color = '#c0392b';
  } finally {
    event.target.value = '';
  }
}

function wbOpenManual() {
  document.getElementById('wb-upload-msg').textContent = '';
  window._wbDiff = [];
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
    // If this bill's tariff differs from saved Settings, prompt to update.
    if (Array.isArray(window._wbDiff) && window._wbDiff.length) {
      wbShowDriftModal(window._wbDiff);
    }
  } catch (e) {
    mMsg.textContent = `Save error: ${e.message}`; mMsg.style.color = '#c0392b';
  }
}

// ─── Tariff-drift modal (like Project Power) ──────────────────────
// Shown after a bill is saved whose recognized rate / VAT differs from the
// saved Water Tariff. "Update settings" syncs the changed fields.
function wbShowDriftModal(diff) {
  wbCloseDrift();
  const rows = diff.map(d => `
    <tr style="border-bottom:1px solid #e6e1da;">
      <td style="padding:8px 14px;">${wEscHtml(d.label)}</td>
      <td style="padding:8px 14px; text-align:right; color:#888;">${d.current == null ? '—' : d.current}</td>
      <td style="padding:8px 14px; text-align:right; color:#c0392b; font-weight:600;">→ ${d.new}</td>
    </tr>`).join('');
  const html = `
    <div id="wb-drift-modal" style="position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:1011; display:flex; align-items:center; justify-content:center;">
      <div style="background:#fff; max-width:560px; width:90%; max-height:90vh; overflow-y:auto; border-radius:8px; padding:24px;">
        <h2 style="margin-top:0; color:#c0392b;">⚠ Tariff change detected</h2>
        <p style="font-size:0.95rem; color:#444;">
          This bill's rates don't match your current Water Tariff settings.
          Update them to match?
        </p>
        <table style="width:100%; border-collapse:collapse; font-size:0.9rem; margin-top:14px;">
          <thead><tr style="background:#fafaf6;">
            <th style="text-align:left;  padding:8px 14px;">Field</th>
            <th style="text-align:right; padding:8px 14px;">Current</th>
            <th style="text-align:right; padding:8px 14px;">From bill</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:22px; display:flex; gap:10px;">
          <button class="btn btn-primary btn-sm"   onclick="wbApplyDrift()" style="padding:9px 22px; font-size:0.95rem;">Update settings</button>
          <button class="btn btn-secondary btn-sm" onclick="wbCloseDrift()" style="padding:9px 18px; font-size:0.95rem;">Keep current</button>
        </div>
      </div>
    </div>`;
  window._wbDriftDiff = diff;
  document.body.insertAdjacentHTML('beforeend', html);
}

function wbCloseDrift() {
  const el = document.getElementById('wb-drift-modal');
  if (el) el.remove();
  window._wbDriftDiff = null;
  window._wbDiff = [];
}

async function wbApplyDrift() {
  const diff = window._wbDriftDiff || [];
  if (!diff.length) { wbCloseDrift(); return; }
  try {
    const cur = await (await fetch('/api/water/settings')).json();
    const tariff = { ...(cur.tariff || {}) };
    for (const d of diff) tariff[d.field] = d.new;
    const r = await fetch('/api/water/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tariff, billing: cur.billing }),
    });
    const data = await r.json();
    if (!r.ok) { alert(`Update failed: ${data.error || r.statusText}`); return; }
    wbCloseDrift();
    wsLoad();   // refresh the Tariff card so the user sees the new values
  } catch (e) {
    alert(`Update error: ${e.message}`);
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
