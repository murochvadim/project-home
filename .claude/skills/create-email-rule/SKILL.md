---
description: Create an email automation rule — extract data (incl. PDF receipts → a Privacy Site) and/or dispose (spam/trash/archive) incoming Gmail
user-invocable: true
---

# /create-email-rule — Email Automation Rule Builder

You are building one rule for the **Email Agent** (LXC 110, `192.168.1.162`). Rules live in
`dashboard_settings.email.rules` (a JSON array) and are read by the agent with a 30 s TTL cache — so
a rule is **config, not code: NO agent restart is needed** to add/change one (only `agent.py` code
changes need `systemctl restart email-agent`).

A rule does two independent things on a matching email: **extract data** and/or **dispose** it. The
big value of this skill is that it **auto-builds and tests the regex against the real email/PDF text**
so you never hand-write a pattern.

Follow the steps in order. Use AskUserQuestion for choices. Confirm before writing. Default new rules
to **dry-run** and verify before flipping to live.

## Rule shape (what you will write into `dashboard_settings.email.rules`)
```jsonc
{
  "id": "erule_<slug>_<yyyymmdd>", "name": "…", "active": true,
  "mode": "dryrun",                       // "dryrun" | "live"  (start dryrun)
  "store": "receipt",                     // "receipt" | "row"  (receipt = under a Privacy Site)
  "site_id": 30,                          // receipt only — which privacy_sites.id
  "vendor": "Aviem", "currency": "ILS",   // receipt only, optional (vendor derives from domain)
  "match": { "from": ["aviem-evm.co.il"], "contains": ["חוזה שרות"] },   // contains optional
  "disposition": "keep",                  // "keep" | "archive" | "trash" | "spam"
  "extract": [
    { "field": "amount",       "as": "amount",     "source": "pdf", "pattern": "([\\d.,]+)\\s*סה.?כ מחיר" },
    { "field": "invoice_date", "as": "date",       "source": "pdf", "date_format": "DD/MM/YY",
      "pattern": "(\\d{2}/\\d{2}/\\d{2})\\s*:?\\s*תאריך חשבונית" },
    { "field": "invoice_no",   "as": "invoice_no", "source": "pdf", "pattern": "(SI\\d{6,})" }
  ]
}
```
- `store:"receipt"` → the agent writes a **`privacy_site_receipts`** row (vendor/amount/invoice_date/
  invoice_no, linked to `site_id`) **and** an `email_extractions` audit row; the dashboard files the
  original **PDF into that site's Docs window** on first view. Viewed on **Privacy → Sites → 🧾 Receipts**
  (total + CSV export).
- `store:"row"` → only an `email_extractions` audit row (the generic "Extracted data" card). No site,
  no PDF filing, no `as:` mapping needed.
- `as:` maps an extract field to a receipt column: `amount` (parsed number), `date` (parsed with
  `date_format`), `invoice_no`, `vendor`. Plain fields omit `as`.
- `source:` = `body` | `subject` | `pdf` (first PDF attachment). Default `body`.

## Step 1 — Identify the email
Ask the user for a **sender** or a **unique piece of subject/preamble text**. Find the cached message(s):
```
ssh root@192.168.1.227 "PGPASSWORD='' psql -h 192.168.1.219 -U postgres -d home_data -P pager=off -c \
\"SELECT gmail_id, from_addr, subject, msg_ts FROM email_messages
   WHERE from_addr ILIKE '%<term>%' OR subject ILIKE '%<term>%' ORDER BY msg_ts DESC LIMIT 5;\""
```
Note the `gmail_id` + the **sender domain** (the part after `@` in `from_addr`) — that domain is the
match key and the vendor default (`aviem-evm.co.il` → `Aviem`).

## Step 2 — Match criteria
- **From** = the sender domain (case-insensitive substring; `@domain` and `addr@` both work).
- Optional **contains** = any of a list of substrings that must appear in subject+snippet+body(+pdf).
  Use it when one sender sends different mail types (e.g. only invoices, not their newsletters).

## Step 3 — Store type  → AskUserQuestion
- **🧾 Receipt** — money + date; saved under a **Privacy Site** (structured row + the PDF filed there,
  graph/CSV-able). Ask **which site** (Step 4).
- **📄 Just a row** — extract fields into `email_extractions` only (tracking numbers, codes, confirmations).

## Step 4 — (Receipt) which Privacy Site
List the sites and let the user pick, or create a new one:
```
ssh root@192.168.1.227 "PGPASSWORD='' psql -h 192.168.1.219 -U postgres -d home_data -P pager=off -c \
\"SELECT id, kind, name FROM privacy_sites ORDER BY name;\""
```
The picked `id` → `site_id`. `vendor` defaults from the sender domain (offer to override, e.g. to the
site name). `currency` defaults `ILS`.

**Then ask the chart period (AskUserQuestion): yearly / monthly / daily.** This is how that vendor's
📊 Chart on the Privacy page groups its receipts. Write it into the per-vendor map
`dashboard_settings.privacy.chart_periods` keyed by `site_id` (string), merging (don't clobber other
vendors):
```
# read current, merge {"<site_id>":"<yearly|monthly|daily>"}, POST back:
GET  http://127.0.0.1:3000/api/dashboard-settings/privacy.chart_periods   → { value: {…} }
POST http://127.0.0.1:3000/api/dashboard-settings/privacy.chart_periods   body { "value": {…merged…} }
```
Default is `monthly` if you skip it. (The chart reads this via `GET /api/privacy/sites/:id/receipts` →
`chart_period`.) This is per-VENDOR (site), not per-rule.

## Step 5 — Extract fields (auto-build + test the regex — the important part)
First, get the **real text** the regex will run against:
- **PDF** (receipts usually): `POST http://192.168.1.162:8780/api/email/pdf-text {"gmail_id":"<id>"}`
  → `{text}`. The agent uses **PyMuPDF (fitz)**, which keeps **logical Hebrew/RTL order** — anchors read
  normally (`סה"כ מחיר`, `תאריך חשבונית`). ⚠ **In these bills the VALUE often comes BEFORE the label**
  (`57.83\nסה"כ מחיר`, `30/06/26 :תאריך חשבונית`), so use **value-before-label** anchors:
  `([\d.,]+)\s*<label>` and `(\d{2}/\d{2}/\d{2})\s*:?\s*<label>`. (Digits/dates are never reversed, so
  the extracted VALUES are always correct — only the Hebrew label anchor must match the extractor.)
- **Body**: `GET http://192.168.1.162:8780/api/email/message/<gmail_id>` → `{body}` (HTML-stripped).

For each field the user wants (amount / date / invoice_no / custom):
1. Find the anchor in the real text and build a regex with **one capture group**.
2. **Test it** against the pulled text (Python `re.search(pat, text, re.I|re.S)` or a Node one-off) and
   **show the user the captured value** — do not ship a pattern you didn't see match.
3. For receipts, set `as`: amount→`amount`, date→`date` (+ `date_format`, e.g. `DD/MM/YY`),
   invoice→`invoice_no`. Plain fields omit `as`.

## Step 6 — Disposition + mode
- **Disposition**: `keep` (default for receipts — leave it in the inbox), `archive`, `trash`, or `spam`.
  (No permanent delete — `gmail.modify` can't; Trash is the ceiling.)
- **Mode**: default **`dryrun`** (logs a preview, stores nothing). Flip to `live` only after verifying.

## Step 7 — Write the rule  ⚠ (escaping gotcha — read this)
Append the new rule object to the existing array and POST it back to
`http://127.0.0.1:3000/api/dashboard-settings/email.rules` as `{ "value": <rules[]> }`.

**Do NOT build the JSON with `node -e "…"` inside a bash double-quoted string** — the bash + JS double
layer **eats the regex backslashes** (`[\d.,]` becomes `[d.,]`, extraction returns null). Instead:
- **Write a small updater script to a FILE** (Write tool, no shell escaping) that fetches the array,
  appends/edits the rule with **single-backslash** JS literals (`'([\\d.,]+)\\s*…'` → the string value
  is `([\d.,]+)\s*…`), and POSTs it. Run it with `node <file>`.
- **Verify the stored pattern** shows a real backslash:
  ```
  ssh root@192.168.1.227 "PGPASSWORD='' psql -h 192.168.1.219 -U postgres -d home_data -P pager=off -tA -c \
  \"SELECT value->N->'extract'->0->>'pattern' FROM dashboard_settings WHERE key='email.rules';\""
  ```
  It must print `([\d.,]+)\s*…` (backslash-d), **not** `([d.,]+)`.

## Step 8 — Verify (dry-run → live)
1. `systemctl restart email-agent` (forces an immediate rule reload; or wait ≤30 s for the TTL).
2. `POST http://192.168.1.162:8780/api/email/automation/run-now` (retroactively applies rules to the
   last ~200 cached messages — **needed because live rules otherwise only fire on NEW incoming mail**).
3. Check the dry-run preview:
   ```
   ssh root@192.168.1.227 "PGPASSWORD='' psql … -c \"SELECT mode,applied,extracted FROM email_automation_log
     WHERE rule_name='<name>' ORDER BY ts DESC LIMIT 1;\""
   ```
   Confirm the `_receipt` preview has the right amount / invoice_date / invoice_no (not null).
4. **Flip to `live`** (edit the rule's `mode`), restart or wait, **Run-now once more**, then verify:
   - `SELECT * FROM privacy_site_receipts;` → the row (site_id, vendor, amount, invoice_date, invoice_no).
   - Open `GET http://127.0.0.1:3000/api/privacy/sites/<site_id>/receipts` → this **files the PDF** into
     the site's Docs window and returns `doc_id`.
   - On the dashboard: **Privacy → hard-refresh → the site's 🧾 Receipts** shows it (+ 📄 view + CSV);
     **📄 Docs** shows the filed PDF.

Notes:
- **Dedupe**: live storage is `ON CONFLICT (gmail_id)` → one receipt per email; Run-now is safe to repeat.
- **Dry-run rows are NOT deduped** (each Run-now logs one) — that's expected; they're just previews.
- First-matching **active** rule wins (top-to-bottom); keep receipt rules above broad spam rules.
