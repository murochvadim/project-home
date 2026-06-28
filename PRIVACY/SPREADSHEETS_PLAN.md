# Privacy → Spreadsheets — build plan (APPROVED, not yet built)

Status: **planning complete, awaiting build.** No code written yet. Pick up from Step 0.

## Goal
An **encrypted, formula-capable spreadsheet** on the **Privacy page**. You always see the grid
layout + the **formulas**, but the **real cell values are encrypted (server-blind)** — reveal them
by entering the **same Vaultwarden "Documents" password** used for Privacy → Documents.

## Decisions locked in
1. **One** persistent sheet (singleton — not multiple).
2. **3 modes:** 🔒 Locked (`•••`) · 🧪 Sandbox (type throwaway test numbers, **never saved**, formulas
   compute live, for learning how a formula behaves) · 🔓 Unlocked (real values via password).
3. **All visible except data**; optionally some **headers also lockable** (revealed only on unlock).
4. **Same password as Privacy → Documents** (Vaultwarden), reuse the existing `privacy_doc_crypto`
   salt + verifier + the AES-256-GCM / PBKDF2-SHA256-600k helpers already in `privacy.js`.
5. **No new LXC.** Data is encrypted *in the browser* before saving (server-blind), so the storage
   host never sees plaintext — a new LXC adds zero privacy, just maintenance. Encrypted blob →
   **PostgreSQL LXC 102** (like the other `privacy_*` tables); password stays in **Vaultwarden LXC 109**.
6. **`.xlsx` import/export left out** for now (an export would be a plaintext Excel download — conflicts
   with server-blind). Optional later.
7. **ON-DEMAND calculation (key requirement):** formulas evaluate **only when the user clicks a 🧮 Calculate
   button — NOT live/continuous recalc.** So we do NOT depend on a live formula engine: the grid just holds
   data + formula *text*, and Calculate runs the math once and fills results. This lets us use **`formulajs`
   (MIT)** for the calc on click and a lightweight grid just for the Excel *look* — **sidesteps the
   jspreadsheet license question** (jspreadsheet, if used at all, is only for the visual grid, not its engine).
8. **Optional add-on (decide at build):** a 📊 **Chart** button — turn a selected range into a Chart.js
   bar/line/pie. Renders **only when unlocked** (needs real values), **client-side only** (the picture is
   never sent to / stored on the server). The chart *definition* (range + type) can be saved in the plaintext
   structure so it auto-rebuilds on each unlock. No live/always-on chart (would break server-blind).

## Build steps

**Step 0 — Grid look + on-click calc engine.** Calculation is **on-demand only** (🧮 Calculate button), so
the formula engine = **`formulajs` (MIT)** evaluated once per click — no live engine needed. For the Excel
*look* (A/B/C cols, 1/2/3 rows, cell editing): prefer a **lightweight MIT grid** (or a styled HTML grid);
**jspreadsheet CE** is optional and only for visuals — if used, verify its license first. Vendor locally to
`BOILER/dashboard/public/vendor/sheets/`. Do NOT ship anything license-unsafe.

**Step 1 — Migration `PRIVACY/migrations/0XX_sheets.sql`** (LXC 102). Singleton table:
```
privacy_sheets(
  id        INT PRIMARY KEY DEFAULT 1,   -- only row id=1
  name      TEXT DEFAULT 'My Sheet',
  structure JSONB,   -- PLAINTEXT: grid size, columns, data-vs-formula per cell, formula text,
                     --            per-column "locked header" flags
  enc_data  TEXT,    -- CIPHERTEXT (base64): real cell VALUES + locked header names (AES-256-GCM)
  enc_iv    TEXT,    -- base64 IV
  updated_at TIMESTAMPTZ DEFAULT now()
)
```
+ `retention_policies` row → **protected, forever**. No QNAP files (all in PG).

**Step 2 — Backend (`BOILER/dashboard/routes-privacy.js`, existing module).** Server-blind endpoints:
- `GET  /api/privacy/sheet` → `{name, structure, enc_data, enc_iv}`
- `POST /api/privacy/sheet` → upsert same
- No new crypto endpoint — browser fetches the existing `privacy_doc_crypto` to derive/verify the key.

**Step 3 — HTML (`BOILER/dashboard/public/privacy.html`).** New **"Spreadsheets" tab**: toolbar (sheet
name · 🔒 Locked / 🧪 Sandbox / 🔓 Unlock · 💾 Save [unlocked only]) + jspreadsheet grid container +
reuse the Documents-unlock password modal.

**Step 4 — JS (`BOILER/dashboard/public/js/privacy-sheets.js`, new).**
- Load → `GET /sheet` → render structure + formula text; data + locked headers = `•••` (Locked, default).
- 🧪 Sandbox → editable data cells, formulas compute live on typed numbers; in-memory only, never POSTed;
  exit → discard, reload Locked.
- 🔓 Unlock → password modal → reuse `privacy.js` AES-GCM/PBKDF2 → verify vs `privacy_doc_crypto` →
  decrypt `enc_data` → fill real values + reveal locked headers + compute formulas.
- 💾 Save (unlocked) → read values + structure → encrypt values → POST. Re-lock wipes decrypted values.

**Step 5 — `server.js` registration** (past the architecture hook): add `privacy_sheets` to `DBV_GROUPS`
(Privacy group) + `tsCol` (`updated_at`) + the protected-seed list.

**Step 6 — Docs (after it works):** `PRIVACY/CLAUDE.md` + root `CLAUDE.md` (Privacy Spreadsheets tab) + memory.

**Step 7 — Deploy:** migration on LXC 102 → vendor libs (cache-bust) → `pm2 delete boiler-dashboard &&
pm2 start ecosystem.config.js` (routes-privacy.js changed) → hard-refresh.

**Step 8 — Verify:** create sheet (`Qty`, `Price`, `=A2*B2`, `=SUM(...)`) → Sandbox test → Unlock (real
numbers) → Save → reload (back to `•••`) → Unlock again (data + totals persist).

## Guarantees
Structure + formulas plaintext/visible; **real values never leave the browser unencrypted**; same
Vaultwarden password as Documents; sandbox numbers throwaway; no new LXC.
