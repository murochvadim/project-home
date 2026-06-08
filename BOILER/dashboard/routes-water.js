// Water Consumption — settings + bills for the Boiler Agent page's "Water" tab.
//
// Kept in its own module (wired from server.js via a single require line) so
// server.js stays free of new route handlers — the repo's architecture-guard
// hook blocks adding `app.<method>(` (and new top-level `async function`)
// directly to server.js. Same `db` (pg Pool) query style + the same
// billing/tariff/bills shape as the inline /api/power/* routes, adapted for
// Israeli household WATER billing (two-tier volume tariff + sewage + VAT).
//
// Phase 1 (this module): works entirely from manually entered / pasted bills.
// No water meter exists yet — GET /api/water/status returns meter_connected:false
// so the frontend Current-Period card renders a "meter not connected" placeholder.
// Phase 2 (future, when a flow sensor is added): a live ingest fills period m3
// and this status endpoint computes the live cost.
//
// Endpoints:
//   GET    /api/water/settings          billing + tariff (merged with defaults)
//   PUT    /api/water/settings          { billing, tariff }
//   GET    /api/water/bills             list, newest first
//   POST   /api/water/bills/upload      multipart pdf -> parse-and-RETURN (no insert)
//   POST   /api/water/bills             { period_start, period_end, total_m3, total_cost_ils, source? } -> insert
//   DELETE /api/water/bills/:id
//   GET    /api/water/status            Phase 1: { meter_connected:false }

const os = require('os');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// 8 MB cap — plenty for a water-corp bill PDF (typically 100-300 KB).
const waterBillPdfUpload = multer({
  dest: path.join(os.tmpdir(), 'water-bills'),
  limits: { fileSize: 8 * 1024 * 1024 },
});

// ── Defaults ────────────────────────────────────────────────────────────────
// Israeli household water is billed bi-monthly (every 2 months).
const _WATER_BILLING_DEFAULTS = {
  start_day:                 15,
  length_months:              2,
  current_period_start_date: null,
};

// Full Israeli household water tariff. Water is billed in two volume tiers:
//   - a "recognized / low" quantity tier (cheaper ₪/m³), with a monthly quota of
//     m³ = household base + persons × per-person allowance;
//   - a "high / additional" tier (more expensive ₪/m³) for anything above quota.
// Plus a sewage component (often bundled INTO the tier rates; some corporations
// bill it as a separate ₪/m³ line), a fixed/standing charge, and VAT.
//
// ⚠ These numbers are PLACEHOLDERS — Israeli water rates + quotas are set per
// period by the Water Authority and differ by corporation (תאגיד מים). VERIFY
// every value against your actual bill via the Settings card.
const _WATER_TARIFF_DEFAULTS = {
  persons_in_household:          2,
  low_tier_rate_ils_per_m3:      6.50,        // recognized-quantity tier ₪/m³
  low_tier_quota_base_m3:        3.5,         // m³ / household / month at low tier
  low_tier_quota_per_person_m3:  3.5,         // extra m³ / additional person / month
  high_tier_rate_ils_per_m3:     13.00,       // above-quota tier ₪/m³
  sewage_mode:                   'bundled',   // 'bundled' (in tier rates) | 'separate'
  sewage_rate_ils_per_m3:        0,           // only used when sewage_mode = 'separate'
  fixed_charge_ils:              0,           // standing charge ₪ / period
  vat_pct:                       18,          // Israel VAT (2025: 17% → 18%)
  currency_symbol:               '₪',
};

async function _waterLoadSettings(db) {
  const r = await db.query(
    "SELECT key, value FROM dashboard_settings WHERE key IN ('water.billing','water.tariff')",
  );
  const map = {};
  for (const row of r.rows) map[row.key] = row.value || {};
  return {
    billing: { ..._WATER_BILLING_DEFAULTS, ...(map['water.billing'] || {}) },
    tariff:  { ..._WATER_TARIFF_DEFAULTS,  ...(map['water.tariff']  || {}) },
  };
}

// Estimated cost of `periodM3` cubic metres over `daysElapsed` days, using the
// two-tier Israeli tariff. Pro-rates the low-tier quota + fixed charge to the
// elapsed fraction of the period, so it works for a full closed bill OR a live
// partial period. Mirrors the structure of _powerComputeCost (volume + fixed
// pro-rated + VAT) but swaps the flat rate for the two-tier split.
function _waterComputeCost(tariff, periodM3, daysElapsed) {
  const t = tariff || {};
  const m3 = Math.max(0, Number(periodM3) || 0);
  const days = Math.max(0, Number(daysElapsed) || 0);
  const monthsElapsed = days / 30.42;

  const persons = Math.max(0, Number(t.persons_in_household) || 0);
  const quotaPerMonth =
    (Number(t.low_tier_quota_base_m3) || 0) +
    persons * (Number(t.low_tier_quota_per_person_m3) || 0);
  const quotaForElapsed = quotaPerMonth * monthsElapsed;

  const lowM3 = Math.min(m3, quotaForElapsed);
  const highM3 = Math.max(0, m3 - quotaForElapsed);

  const waterCost =
    lowM3 * (Number(t.low_tier_rate_ils_per_m3) || 0) +
    highM3 * (Number(t.high_tier_rate_ils_per_m3) || 0);
  const sewageCost =
    t.sewage_mode === 'separate' ? m3 * (Number(t.sewage_rate_ils_per_m3) || 0) : 0;
  const fixedCost = (Number(t.fixed_charge_ils) || 0) * monthsElapsed;

  const pretax = waterCost + sewageCost + fixedCost;
  const vat = Math.max(0, Number(t.vat_pct) || 0);
  return Math.round(pretax * (1 + vat / 100) * 100) / 100;
}

// Water-bill text parser — tuned to the "מי הוד השרון" / Maya Water bill
// (חשבון תקופתי מים וביוב, mayawater.co.il). KEY FINDING: on these bills the
// summary labels (סה"כ לחיוב / סה"כ לתשלום / נפשות) are rendered as GRAPHICS, so
// pdf-parse never emits them — label anchoring is impossible. Instead we anchor
// on the two signals that DO survive as text:
//   • the total-to-pay amount printed after the shekel sign ("₪ 236.47"); and
//   • the total consumption m³ printed immediately before it ("21.53\n₪ 236.47").
// The excl-VAT subtotal keeps its text label ("סה"כ ללא מע"מ"), so VAT% derives
// from subtotal + total. Validated on a real bill → period 03-04/2026,
// total_m3 21.53, total_cost 236.47, vat 18%. Never throws; unmatched fields stay
// null and the editable confirm modal lets the user fill/fix before saving.
//
// ⚠ Tuned to the Maya Water layout per the user. Other corporations / older
// layouts will mostly fall through to the confirm modal (parse returns nulls).
function _parseWaterBill(text) {
  const out = { period_start: null, period_end: null,
                private_m3: null, shared_m3: null, total_m3: null,
                total_cost_ils: null, vat_pct: null };
  if (!text) return out;
  const t = String(text);
  try {
    // Period "MM-MM/YYYY" → start = 1st of first month, end = last day of second.
    const per = t.match(/\b(\d{2})-(\d{2})\/(20\d{2})\b/);
    if (per) {
      const m1 = per[1], m2 = per[2], y = Number(per[3]);
      const lastDay = new Date(y, Number(m2), 0).getDate(); // day 0 of next month
      out.period_start = `${y}-${m1}-01`;
      out.period_end   = `${y}-${m2}-${String(lastDay).padStart(2, '0')}`;
    }

    // Total to pay — the amount printed after the shekel sign ("₪ 236.47").
    const cost = t.match(/₪\s*([\d,]+\.\d{2})/);
    if (cost) out.total_cost_ils = Number(cost[1].replace(/,/g, ''));

    // Total consumption m³ — the decimal immediately before that "₪ <total>"
    // block ("61\n21.53\n₪ 236.47" → 21.53). This is the real total (private +
    // shared), not a tier sub-quantity from the breakdown table.
    const m3 = t.match(/(\d{1,4}(?:[.,]\d{2}))\s*\n?\s*₪\s*[\d,]+\.\d{2}/);
    if (m3) out.total_m3 = Number(m3[1].replace(/,/g, ''));

    // Private + shared split (תמצית החשבון: צריכה פרטית / צריכה משותפת). On these
    // bills they print as a consecutive decimal triple A,B,C where A+B = C
    // ("15.00\n6.53\n21.53" → private 15.00, shared 6.53, total 21.53). Take the
    // first such summing triple. Validated across 6 real bills (private always
    // ≥ shared, A+B=C exactly).
    const nums = [];
    for (const mm of t.matchAll(/(\d{1,4}(?:[.,]\d{2}))/g)) nums.push(Number(mm[1].replace(/,/g, '')));
    for (let i = 0; i + 2 < nums.length; i++) {
      const A = nums[i], B = nums[i + 1], C = nums[i + 2];
      if (A > 0 && B > 0 && C > 0 && Math.abs(A + B - C) < 0.05) {
        out.private_m3 = A; out.shared_m3 = B;
        if (out.total_m3 == null) out.total_m3 = C;
        break;
      }
    }

    // VAT% — from the excl-VAT subtotal ("NNN.NN סה"כ ללא מע"מ") + the total.
    const lab = t.search(/ללא\s*מע/);
    if (lab >= 0 && out.total_cost_ils) {
      const before = t.slice(Math.max(0, lab - 30), lab);
      const e = [...before.matchAll(/(\d{1,6}(?:[.,]\d{2}))/g)];
      if (e.length) {
        const excl = Number(e[e.length - 1][1].replace(/,/g, ''));
        if (excl > 0 && out.total_cost_ils > excl) {
          out.vat_pct = Math.round((out.total_cost_ils - excl) / excl * 100);
        }
      }
    }
  } catch (_) { /* never throw on a best-effort parse */ }
  return out;
}

module.exports = (app, db) => {
  const err = (res, e) => res.status(500).json({ error: (e && e.message) || String(e) });

  // ── Settings ──────────────────────────────────────────────────────────────
  app.get('/api/water/settings', async (req, res) => {
    try { res.json(await _waterLoadSettings(db)); }
    catch (e) { err(res, e); }
  });

  app.put('/api/water/settings', async (req, res) => {
    const body = req.body || {};
    const existing = await db.query("SELECT value FROM dashboard_settings WHERE key = 'water.billing' LIMIT 1");
    const existingBilling = existing.rows[0]?.value || {};
    const cleanedBilling = {
      start_day:     Math.min(28, Math.max(1, parseInt(body?.billing?.start_day, 10) || _WATER_BILLING_DEFAULTS.start_day)),
      length_months: Math.min(12, Math.max(1, parseInt(body?.billing?.length_months, 10) || _WATER_BILLING_DEFAULTS.length_months)),
      current_period_start_date: body?.billing?.current_period_start_date || existingBilling.current_period_start_date || _WATER_BILLING_DEFAULTS.current_period_start_date,
    };
    const tt = body?.tariff || {};
    const _num = (v, dflt, { min = 0 } = {}) => {
      const x = Number(v);
      if (!Number.isFinite(x)) return dflt;
      return Math.max(min, x);
    };
    const cleanedTariff = {
      persons_in_household:         Math.min(20, Math.max(1, parseInt(tt.persons_in_household, 10) || _WATER_TARIFF_DEFAULTS.persons_in_household)),
      low_tier_rate_ils_per_m3:     _num(tt.low_tier_rate_ils_per_m3,     _WATER_TARIFF_DEFAULTS.low_tier_rate_ils_per_m3),
      low_tier_quota_base_m3:       _num(tt.low_tier_quota_base_m3,       _WATER_TARIFF_DEFAULTS.low_tier_quota_base_m3),
      low_tier_quota_per_person_m3: _num(tt.low_tier_quota_per_person_m3, _WATER_TARIFF_DEFAULTS.low_tier_quota_per_person_m3),
      high_tier_rate_ils_per_m3:    _num(tt.high_tier_rate_ils_per_m3,    _WATER_TARIFF_DEFAULTS.high_tier_rate_ils_per_m3),
      sewage_mode:                  ['bundled','separate'].includes(tt.sewage_mode) ? tt.sewage_mode : _WATER_TARIFF_DEFAULTS.sewage_mode,
      sewage_rate_ils_per_m3:       _num(tt.sewage_rate_ils_per_m3,       _WATER_TARIFF_DEFAULTS.sewage_rate_ils_per_m3),
      fixed_charge_ils:             _num(tt.fixed_charge_ils,             _WATER_TARIFF_DEFAULTS.fixed_charge_ils),
      vat_pct:                      Math.max(0, Math.min(100, Number(tt.vat_pct) || _WATER_TARIFF_DEFAULTS.vat_pct)),
      currency_symbol:              String(tt.currency_symbol || _WATER_TARIFF_DEFAULTS.currency_symbol).slice(0, 4),
    };
    try {
      const writes = [
        ['water.billing', cleanedBilling],
        ['water.tariff',  cleanedTariff],
      ];
      for (const [key, value] of writes) {
        await db.query(`
          INSERT INTO dashboard_settings (key, value, updated_at)
          VALUES ($1, $2::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = NOW()
        `, [key, JSON.stringify(value)]);
      }
      res.json({ ok: true, billing: cleanedBilling, tariff: cleanedTariff });
    } catch (e) { err(res, e); }
  });

  // ── Bills ─────────────────────────────────────────────────────────────────
  app.get('/api/water/bills', async (req, res) => {
    try {
      const r = await db.query(`
        SELECT id, uploaded_at,
               to_char(period_start, 'YYYY-MM-DD') AS period_start,
               to_char(period_end,   'YYYY-MM-DD') AS period_end,
               private_m3, shared_m3, total_m3, total_cost_ils, est_cost_ils, source, notes
        FROM water_bills
        ORDER BY COALESCE(period_start, uploaded_at::date) DESC, uploaded_at DESC
        LIMIT 200
      `);
      res.json(r.rows);
    } catch (e) { err(res, e); }
  });

  // Parse-and-RETURN: extracts best-effort fields from the PDF and hands them
  // back for the frontend's editable confirm modal. Does NOT insert — the
  // confirmed values come back via POST /api/water/bills. (The parser is a stub
  // pending a sample bill, so blind-inserting would store empty rows.)
  app.post('/api/water/bills/upload', waterBillPdfUpload.single('pdf'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'pdf file required' });
    let text = '';
    try {
      const pdfBytes = fs.readFileSync(req.file.path);
      try {
        const { PDFParse } = require('pdf-parse');
        const result = await (new PDFParse({ data: pdfBytes })).getText();
        text = result.text || '';
      } catch (pe) {
        // pdf-parse failure is non-fatal — return empty parsed fields so the
        // user can still type the values into the confirm modal.
        text = '';
      }
      const parsed = _parseWaterBill(text);
      res.json({ ok: true, parsed, raw_text_preview: text.slice(0, 6000) });
    } catch (e) {
      err(res, e);
    } finally {
      fs.unlink(req.file.path, () => {});
    }
  });

  // Confirmed insert (from the editable modal, or a manual entry).
  app.post('/api/water/bills', async (req, res) => {
    const b = req.body || {};
    const periodStart = b.period_start || null;
    const periodEnd   = b.period_end || null;
    const _opt = (v) => (v == null || v === '') ? null : Number(v);
    const privateM3 = _opt(b.private_m3);
    const sharedM3  = _opt(b.shared_m3);
    // Total m³ = private + shared when either is given; else fall back to an
    // explicit total_m3 (older callers / single-value entry).
    let totalM3 = _opt(b.total_m3);
    if (privateM3 != null || sharedM3 != null) totalM3 = (privateM3 || 0) + (sharedM3 || 0);
    const totalCost = _opt(b.total_cost_ils);
    for (const [k, v] of [['private_m3', privateM3], ['shared_m3', sharedM3], ['total_m3', totalM3], ['total_cost_ils', totalCost]]) {
      if (v != null && !Number.isFinite(v)) return res.status(400).json({ error: `${k} must be a number` });
    }
    const source = ['pdf_parsed', 'manual_confirmed', 'auto_rollover'].includes(b.source) ? b.source : 'manual_confirmed';
    try {
      const { tariff } = await _waterLoadSettings(db);
      // Estimate over the bill's own span (fallback to a 2-month period if dates absent).
      let days = 61;
      if (periodStart && periodEnd) {
        const d = (new Date(periodEnd) - new Date(periodStart)) / 86400000;
        if (Number.isFinite(d) && d > 0) days = d;
      }
      const est = totalM3 != null ? _waterComputeCost(tariff, totalM3, days) : null;
      const r = await db.query(`
        INSERT INTO water_bills (period_start, period_end, private_m3, shared_m3, total_m3, total_cost_ils, est_cost_ils, parsed, source, notes)
        VALUES ($1::date, $2::date, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
        RETURNING id, uploaded_at,
                  to_char(period_start, 'YYYY-MM-DD') AS period_start,
                  to_char(period_end,   'YYYY-MM-DD') AS period_end,
                  private_m3, shared_m3, total_m3, total_cost_ils, est_cost_ils, source, notes
      `, [periodStart, periodEnd, privateM3, sharedM3, totalM3, totalCost, est, JSON.stringify(b.parsed || {}), source, b.notes || null]);
      res.json({ ok: true, row: r.rows[0] });
    } catch (e) { err(res, e); }
  });

  app.delete('/api/water/bills/:id', async (req, res) => {
    try {
      const r = await db.query('DELETE FROM water_bills WHERE id = $1', [parseInt(req.params.id, 10)]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // ── Live meter status (Phase 2 stub) ──────────────────────────────────────
  // No water meter exists yet. Returns meter_connected:false so the frontend
  // Current-Period card renders its "meter not connected" placeholder. When a
  // flow sensor is added (Phase 2), this returns live period m3 + cost via
  // _waterComputeCost, and the card lights up automatically.
  app.get('/api/water/status', async (req, res) => {
    res.json({ meter_connected: false });
  });
};
