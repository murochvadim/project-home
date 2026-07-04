# Email Agent

## Purpose
Two-way Gmail client on the dashboard (read / send / reply / archive / label) **plus**
incoming-mail automation: new mail is published to MQTT so the rule engine can trigger on it.

## System Overview
A dedicated **LXC 110 "Email"** (192.168.1.162, unprivileged, `onboot=0`) runs a single Python
service, `email-agent`, with two threads:
- **Poller** — walks Gmail's History API from a stored `historyId` watermark, caches new-message
  **metadata + snippet only** into `email_messages`, publishes `mur/home/email/message` per new mail,
  and advances the watermark in `email_state`. **Full-mirror sync (2026-07-01):** it processes ALL history
  types (messagesAdded / **labelsAdded / labelsRemoved** / messagesDeleted), re-fetching each touched
  message's current labels and deleting removed ones — so **label changes (spam/trash/archive/read) and
  deletions stay in sync**, not just new mail. Automation also refreshes a message's cached labels the
  instant it acts. Initial/re-sync uses `q="in:inbox OR newer_than:7d"` so the dashboard Inbox reflects
  Gmail's real inbox. **`POST /api/email/resync`** re-fetches every cached message's labels by id (fixes
  drift; a search-based backfill can't, since Gmail search hides Spam/Trash). The message **list hides
  Spam/Trash** (`api_messages`) like Gmail's Inbox/All-Mail.
- **Flask API (:8780)** — `list / read / send / reply / archive / label / labels` endpoints the
  dashboard calls **directly** (dashboard stays UI-only per the architecture rule). Full bodies are
  fetched on-demand from Gmail and **HTML-sanitized (bleach)** before returning — never stored.

Chosen as its OWN LXC (not co-located on the Privacy box 109) because email is internet-facing and
ingests untrusted content — it must not share a kernel / daemon / filesystem with the password vault.

## Data Source / App LXC
- Proxmox LXC ID: **110** — IP **192.168.1.162** — hostname `Email`
- Service: `email-agent.service` — entry `/opt/email-agent/agent.py` (venv `/opt/email-agent/venv`)
- Env: `/etc/email-agent.env` (root 600) — DB (trust auth, empty pass), MQTT creds, `GMAIL_TOKEN`
- Postgres: LXC 102 (192.168.1.219) — MQTT: LXC 107 (192.168.1.189), user `email_agent`
- **Orchestrator note:** the `agents` row has `data_table`/`settings_table` = **NULL** — email is a service agent, NOT a boiler-style decision loop, so it must not get the schedule/next_ts check (else `agent_schedule_check_failed`). LXC 110's `/root/.ssh/authorized_keys` must also include the orchestrator's key (LXC 105 `root@MainAgent`) so its per-agent service check can SSH in (else `service_ssh_failed`).

## Tables (LXC 102, migration `EMAIL/migrations/001_email.sql`)
- `email_messages` — gmail_id PK, thread_id, from/to, subject, snippet, labels jsonb, msg_ts, seen.
  **Metadata + snippet only — no bodies.** Retention 180 d auto_clean.
- `email_labels` — Gmail label cache (id → name/type) for the UI. Forever.
- `email_state` — singleton: `history_id` watermark + `last_poll_ts` + settings. Forever.
- `email_extractions` — automation-extracted data that's KEPT (buckets 2 & 3): rule, gmail_id, from,
  subject, `data` jsonb. Forever. (migration `003_automation.sql`)
- `email_automation_log` — automation audit trail incl. dry-run (what a rule would/did do): rule, disposition,
  mode, applied, extracted. 90 d auto_clean. (migration `003_automation.sql`)

## Gmail OAuth (Phase 1 — one-time)
- Google Cloud project → enable Gmail API → OAuth **Desktop** client → download `credentials.json`.
- Scopes (minimal): `gmail.modify` + `gmail.send`.
- **Publishing status = In production** (not Testing). ⚠ A Testing-mode app **expires refresh tokens after
  7 days**; publishing (unverified is fine for a single self-user — 1/100 cap) makes them non-expiring. If
  you re-mint, do it AFTER publishing. `oauth_setup.py` passes `prompt='consent'` so a re-run returns a
  fresh refresh token.
- `EMAIL/agent/oauth_setup.py` (run on a machine WITH a browser — the Windows host) mints
  `token.json` from `credentials.json`; copy it to `LXC 110:/opt/email-agent/token.json`.
- The service auto-refreshes the access token from the stored refresh token. Until the token exists,
  the service stays up and logs `waiting for OAuth`; the dashboard shows a "not connected" banner.

## Automation (phase 1 — sender rules → extract + dispose, dry-run first)
User-defined rules act on **new incoming mail** in the poller (`_apply_automation`, called from
`_poll_once` right after `_upsert_message`, under `_gmail_lock`). Phase-1 scope: **match by sender,
extract via regex, dispose = Trash/Spam/keep/archive** (no permanent delete — `gmail.modify` can't;
Trash is the ceiling), **dry-run first**.
- **Rules** live in `dashboard_settings.email.rules` (edited on the Email → **Automation** tab; agent
  reads the key with a 30 s TTL cache via `_load_rules`). Shape:
  `{id,name,active,mode:dryrun|live, match:{from:[substrings]}, disposition:spam|trash|keep|archive,
  extract:[{field,pattern,source:body|subject}]}`. Evaluated top-to-bottom; **first matching active rule
  wins**.
- **Dry-run** (`mode=dryrun`, default for new rules): logs the would-be action + extraction to
  `email_automation_log` (`applied=false`); **no Gmail change, nothing stored**. Flip to `live` after
  reviewing the log.
- **Live**: stores extraction → `email_extractions` (if any), applies disposition via `_modify_raw`
  (`spam`→+SPAM/−INBOX, `trash`→+TRASH/−INBOX, `archive`→−INBOX, `keep`→no-op), logs `applied=true`.
  ⚠ `_modify_raw` is the **lock-free** variant — automation already holds `_gmail_lock`; calling the
  locking `_modify` would deadlock (non-reentrant lock).
- **Match on TEXT too (`match.contains`, added same day):** besides `from`, a rule may require the email to
  contain any of a list of substrings (searched in subject + Gmail snippet + body; body fetched only when
  needed). AND-combined with the sender match. Drove the first real rules (AliExpress / EL AL ads → spam via
  the `Advertisement |` / `פרסומת |` ad-prefix text). UI field: "Text has" (comma = OR).
- **Run now (retroactive):** `POST /api/email/automation/run-now` (button on the Automation toolbar) applies
  the current rules to the last ~200 cached messages — live rules ACT, dry-run rules log; dedupes on
  `applied=true` so repeat clicks/poll overlaps never re-process. Shared core `_apply_rules` (poller + run-now).
- **Spam → Trash cleanup (Settings tab):** `dashboard_settings.email.settings.trash_spam_after_days` (0 = off).
  A poller-driven **hourly** sweep (`_trash_old_spam`, throttled) moves automation-spammed emails from Spam to
  **Trash** once older than N days — recoverable (Gmail purges Trash ~30 d later), uses `gmail.modify` (**no
  permanent delete**). `email_automation_log.trashed_at` (migration `004_spam_trash.sql`) marks swept rows so
  it never re-touches a message.
- **Tables**: `email_extractions` (kept data — forever, `003_automation.sql`) + `email_automation_log` (audit
  incl. dry-run — 90 d, `003`; `trashed_at` added by `004_spam_trash.sql`).
- **Endpoints** (LXC 110): `GET /api/email/extractions`, `GET /api/email/automation-log?limit=` (the Activity
  Log card's 10/20/50-rows selector), `POST /api/email/automation/test {rule}` (dry-run a rule vs the last ~80
  cached messages — powers ▶ Test), `POST /api/email/automation/run-now` (retroactive sweep).
- **Dashboard tabs:** 📬 Inbox · ⚙ Automation (Rules + Extracted data + Activity log) · 🔧 Settings
  (trash-after-N-days). Rules in `dashboard_settings.email.rules`, settings in `dashboard_settings.email.settings`.
- **Future (phase 2):** AI extraction (Claude), match on Gmail category, **permanent** delete (needs the
  full `https://mail.google.com/` scope + re-consent — current cleanup only Trashes).

## Receipt extraction (PDF → a Privacy Site) — added 2026-07-02
A rule with **`store:"receipt"`** pulls structured fields (vendor / amount / invoice_date / invoice_no) and
saves them **under a Privacy Site** so they're graph/CSV-able, and files the **original PDF** into that
site's Docs window. `store:"row"` (default) just writes the generic `email_extractions` audit row.
- **PDF text** = **PyMuPDF (`fitz`)** in the agent (`_pdf_text`). Chosen over pdfplumber because fitz keeps
  **logical Hebrew/RTL order** (`סה"כ מחיר`), while pdfplumber reverses it (`ריחמ כ"הס`). ⚠ In these bills
  the **value precedes the label** (`57.83\nסה"כ מחיר`, `30/06/26 :תאריך חשבונית`) → use **value-before-label**
  anchors: `([\d.,]+)\s*<label>`, `(\d{2}/\d{2}/\d{2})\s*:?\s*<label>`. Digits/dates aren't reversed, so the
  captured VALUES are always correct — only the Hebrew anchor must match the extractor.
- **⚠ Exception — RTL segment-swapped decimals (2026-07-04, Partner):** SOME invoices render the DECIMAL
  amount right-to-left too, so `100.86` extracts **segment-swapped** as `86.100` (proven: before-VAT
  `85.47` + VAT `15.39` = `100.86`, all swapped in the text; PyMuPDF also splits it across lines as
  `86\n.\n100`). A single-capture regex can't reorder, so set **`swap_decimal:true`** on that extract field
  → the agent un-swaps `A.B → B.A` (whitespace-stripped) before parsing. **Only dotted decimals swap** —
  slash-format dates (`19/06/26`) and invoice numbers are fine. Capture the swapped number normally
  (`([\d]+\s*\.\s*[\d]+)\s*\{?\s*<label>`; `{` = the ₪ glyph) and let `swap_decimal` fix it.
- **Extract field extras:** `source:"pdf"` (first PDF attachment), `as:"amount"|"date"|"vendor"|"invoice_no"`
  (maps the field to a receipt column), `date_format` (e.g. `DD/MM/YY` → ISO), **`swap_decimal:true`**
  (un-swap an RTL `A.B`→`B.A`, e.g. Partner `86.100`→`100.86`; opt-in per field, in `_run_extract`). Vendor =
  rule `vendor` else derived from the sender domain (`aviem-evm.co.il` → `Aviem`).
- **On live fire** (`_apply_rules`): writes the `email_extractions` audit row **and** upserts
  **`privacy_site_receipts`** (`site_id, vendor, amount, currency, invoice_date, invoice_no, gmail_id, data`,
  `ON CONFLICT (gmail_id)` = one receipt per email). It does **NOT** touch QNAP.
- **PDF filing (dashboard, not the agent):** LXC 110 has no QNAP mount, so the **dashboard** pulls the PDF
  from the agent (`GET /api/email/attachment/:gmail_id`) and writes it into the site's Docs window
  (`privacy_site_docs`, plain `kind='receipt'`), linking back via `privacy_site_receipts.doc_id`. This
  happens lazily when the site's Receipts window is opened (`GET /api/privacy/sites/:id/receipts` files any
  `doc_id IS NULL` rows). Surface: **Privacy → Sites → 🧾 Receipts window** (list + total + CSV export **+ a
  per-vendor spend bar chart** — Chart.js, `pvRenderReceiptChart`, groups the receipts by the vendor's
  chosen **period (yearly / monthly / daily)** and sums `amount`; client-side. The period is per-VENDOR in
  `dashboard_settings.privacy.chart_periods` (`{site_id: period}`, default monthly), asked by
  `/create-email-rule` and returned by `GET /api/privacy/sites/:id/receipts` as `chart_period`) and the
  filed PDF in **📄 Docs**.
  Endpoints in `routes-privacy.js`; table migration `PRIVACY/006_site_receipts.sql` (forever + protected).
- **New agent endpoints:** `GET /api/email/attachment/<gmail_id>` (stream first PDF) + `POST /api/email/pdf-text`
  `{gmail_id}` (return PDF text — used by `/create-email-rule` to auto-build + test regex).
- **Authoring:** use **`/create-email-rule`** (asks store-type + which site, pulls the real PDF/body text,
  builds + TESTS the regex, writes the rule). ⚠ Writing regex into `email.rules` via `node -e "…"` inside a
  bash double-quoted string **eats the backslashes** (`[\d.,]`→`[d.,]`) — write the updater to a FILE with
  single-backslash JS literals, then verify the stored pattern shows `\d`. First live rule: **Aviem service
  invoice** (site #30 AVIEM - CAR CHARGING → ₪57.83 / 2026-06-30 / SI266003502).

## Rule engine integration (group `email`)
- `rule_engine.on_mqtt_event` subscribes to `mur/home/email/message` and fires a synthetic event
  `device_id='email'` with `dps = {from, subject, snippet, labels, thread_id, ts}`. A rule declares
  `triggers=['email']` to react (e.g. "mail from the bank → notify"). Rules authored via `/create-rule`
  with `"group": "email"`. No `email` devices row is needed (state is not persisted for it).

## Dashboard
- Page `BOILER/dashboard/public/email.html` + `js/email.js` — two-pane client (inbox list + read pane),
  compose/reply modal, archive / mark-read. **Calls `http://192.168.1.162:8780/api/email/*` directly**
  (the Flask API sends permissive CORS for the LAN-only dashboard). Sidebar: **Personal** group, under
  Privacy. Auto-refreshes the list every 30 s.

## Deploy
- Service code: `scp EMAIL/agent/agent.py root@192.168.1.162:/opt/email-agent/agent.py && \
  ssh root@192.168.1.162 systemctl restart email-agent`
- Rule-engine ingest lives in `RULES/rule_engine.py` (engine-core — needs `systemctl restart rule-engine`
  on LXC 105, already deployed).
- Dashboard files: static — hard-refresh (cache-bust `js/email.js?v=N`).

## Files
| Artifact | Path |
|----------|------|
| Service | `EMAIL/agent/agent.py`, `EMAIL/agent/email-agent.service` |
| OAuth helper | `EMAIL/agent/oauth_setup.py` |
| Migrations | `EMAIL/migrations/001_email.sql` (tables), `002_agent_row.sql`, `003_automation.sql`, `004_spam_trash.sql`; receipts: `PRIVACY/migrations/006_site_receipts.sql` |
| Dashboard | `BOILER/dashboard/public/email.html`, `js/email.js`; receipts UI in `routes-privacy.js` + `public/privacy.html` + `js/privacy.js` (per-site 🧾 Receipts window) |
| Rule ingest | `RULES/rule_engine.py` (`mur/home/email/message` → `device_id='email'`) |
| Skill | `.claude/skills/create-email-rule/SKILL.md` (`/create-email-rule` — build+test rule, receipt→site) |
| Memory | `memory/project_agent_email.md` |

## Planned / future
- Rich HTML rendering + attachments + server-side search (currently metadata + sanitized body).
- Email-group rules (bill/medical arrivals → notify/tag/file) via `/create-rule`.
