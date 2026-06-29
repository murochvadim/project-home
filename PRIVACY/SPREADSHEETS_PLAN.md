# Privacy → Spreadsheets ("Offers" tab) — build plan (x-spreadsheet, phased)

Status: **prototype confirmed the approach; flushing it and starting fresh on x-spreadsheet.**
The earlier hand-built grid (commit edf9f35) proved the idea; it is being replaced by the
x-spreadsheet library wrapped with our encryption.

## Goal
A real, Excel-like spreadsheet on the **Privacy → Offers** tab. Full editing via the
**x-spreadsheet** library; the **real cell values are encrypted (server-blind)** and unlocked
with the **same Vaultwarden "Documents" password** used by Privacy → Documents. Backed up to
Google Drive as ciphertext.

## Library: x-spreadsheet (MIT, FREE) — vendored locally
- Full toolbar: **formulas** (SUM/AVERAGE/MIN/MAX/COUNT + cell refs), **cell fill + text colour**,
  **merge/split**, **number/text formats**, alignment, borders, **freeze panes**, copy/paste,
  **undo/redo**, insert/delete rows & cols, **multiple sheets** (bottom tabs).
- NOT included: **conditional formatting** (auto-colour by value) — accepted gap; **charts** — not needed.
- Pure **front-end**, no DB of its own — gives/takes data as JSON (`getData()`/`loadData()`).
  Vendored to `BOILER/dashboard/public/vendor/sheets/` (no CDN; MIT).

## Decisions
1. **One x-spreadsheet workbook** in the Offers tab, using the library's **own bottom sheet-tabs**
   (multi-sheet = Option A) → one encrypted unit, one unlock for all sheets. Inactive sheets are
   just JSON in memory (cheap) — multi-sheet costs almost no extra memory.
2. **Same Vaultwarden "Documents" password** — reuse `privacy_doc_crypto` (salt + verifier) + the
   AES-256-GCM / PBKDF2-SHA256-600k helpers already in `privacy.js`. Server-blind.
3. **No new LXC** — the encrypted **workbook JSON blob** → PostgreSQL **LXC 102** (`privacy_sheets`).
   Password stays in **Vaultwarden LXC 109**.
4. **No .xlsx import/export** (an export would be a plaintext download — conflicts with server-blind).
5. **⚠ Library trade-off:** with a 3rd-party grid, the original "structure + formulas visible /
   values hidden / 🧪 sandbox" granularity is NOT practical (we don't control x-spreadsheet's
   rendering). The realistic model is **whole-workbook lock/unlock**: 🔒 locked = workbook not
   loaded (blank "unlock to view"), 🔓 unlock = load decrypted. Decide at Phase 2 whether that's OK
   (it's the simple, robust path) or whether the per-cell hiding is worth dropping x-spreadsheet.

## Phased build

**PHASE 1 — flush + working x-spreadsheet (PLAINTEXT, to confirm it's right)**
1. **Flush** the prototype: remove the custom toolbar + `#tab-offers .pvof-table` CSS from
   `privacy.html`, empty `js/privacy-offers.js`, clear the (empty) `dashboard_settings.privacy.offers`.
   Keep the Offers **tab button** + the panel **card shell** + the script tag.
2. **Vendor x-spreadsheet** → `public/vendor/sheets/xspreadsheet.css` + `.js`.
3. **Rewrite `privacy-offers.js`** — init x-spreadsheet in the Offers container (one workbook, its
   own bottom sheet-tabs); load/save its native JSON to `dashboard_settings.privacy.offers`; **💾 Save**.
   **Plaintext** for now so it can be tested freely.
4. **Verify:** full toolbar + multi-sheet works, fits the page (contained, internal scroll),
   save → reload persists.

**PHASE 2 — encryption (server-blind)**
- `privacy_sheets` table on LXC 102: `id` singleton, `enc_data` + `enc_iv` (ciphertext), `updated_at`
  — **protected/forever**; register in server.js `DBV_GROUPS` + retention.
- `routes-privacy.js`: `GET/POST /api/privacy/sheet` (server only ever handles ciphertext).
- `privacy-offers.js`: **🔒 Locked** default → **🔓 Unlock** (Vaultwarden password → derive/verify vs
  `privacy_doc_crypto` → decrypt → `loadData`) → **💾 Save** (`getData` → encrypt → POST). Re-lock wipes
  the decrypted workbook from memory. (Whole-workbook lock per the trade-off above.)

**PHASE 3 — encrypted Google-Drive backup**
- LXC 104 cron (same family as `scripts/privacy-vault-backup.sh`): export the `privacy_sheets`
  encrypted blob → `rclone` to **Google Drive** (+ QNAP). **Full** backup, **ciphertext only** —
  Google never sees plaintext; restore = pull file → unlock with the password. Optional **⬇ Backup now** button.

## Guarantees
Full Excel-like editing; real values never leave the browser unencrypted; same Vaultwarden password
as Documents; whole workbook backed up to Drive as ciphertext; **no new LXC** (data on LXC 102).

## Footprint to flush in Phase 1 (audited, commit edf9f35)
- `js/privacy-offers.js` (174 lines) → rewrite. `privacy.html`: the `#tab-offers` toolbar (`pvof-*`
  controls) + `.pvof-table` CSS → remove; keep the tab button + card shell + script tag.
  `dashboard_settings.privacy.offers` → clear (empty test grid, 0 cells). `privacy_sheets` table not
  created yet (prototype used `dashboard_settings`).
