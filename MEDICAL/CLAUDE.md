# Medical Agent

Centralized home for **all** medical information: visit history, upcoming
appointments, doctor + AI conclusions, lab/imaging documents, active
prescriptions, and pill-reminder alerts. Scoped 2026-06-02. Not yet built.

## Why

Today medical data is scattered across phone photos, paper printouts,
WhatsApp threads with doctors, and the orphaned-but-existing dashboard
`documents` table (currently 2 rows, neither medical). The user wants
ONE place to:

- Find every test result / prescription / scan from any visit
- See the timeline of doctor visits (past + scheduled future)
- See the timeline of conclusions — both doctor-stated AND AI-generated
  (user uploads documents → asks the AI to summarize / find patterns)
- Know which pills are currently active + take them on schedule via
  audible / phone alerts

Privacy: medical data is sensitive. Everything stays on the LAN
(PostgreSQL on LXC 102, file blobs on QNAP). AI investigation uses the
existing Anthropic API path (same pattern as Boiler Agent's AI
Investigation card) — only the data needed for a specific query is
sent, never the full medical history en bloc.

## File locations (planned)

| Artifact | Path |
|---|---|
| Sidebar entry | New top-level entry **MEDICAL** in [BOILER/dashboard/public/js/sidebar.js](../BOILER/dashboard/public/js/sidebar.js) (or equivalent — current sidebar pattern TBD) |
| Dashboard page | New `BOILER/dashboard/public/medical.html` (preferred over Health-page tab — medical deserves its own page, multi-card layout) |
| Dashboard JS | New `BOILER/dashboard/public/js/medical.js` |
| Server endpoints | New cluster `/api/medical/*` in [BOILER/dashboard/server.js](../BOILER/dashboard/server.js) |
| Rule(s) | Pill-reminder rule in `RULES/rules/medical_pill_reminders.py` (rule group `medical`) |
| File storage | QNAP NFS mount — `/mnt/qnap-laptop/Medical/` (private SMB share, restricted user) |
| DB tables (LXC 102) | `medical_documents`, `medical_visits`, `medical_appointments`, `medications`, `medication_schedules`, `medication_log`, `medical_conclusions`, `medical_providers` |
| Memory (Claude) | `project_agent_medical.md` once any non-obvious project context emerges |

## Existing "documents" tab on Project Health

The Project Health page has a `Documents` tab today
([health.html](../BOILER/dashboard/public/health.html#L335)) backed by a 6-column
`documents` table (id, title, url, theme, sort_order, created_at). Currently
holds 2 unrelated bookmarks (HOOK, Home Connect Re-auth). The user
explicitly OK'd repurposing/removing it.

Plan: **remove the Documents tab from Project Health**. Migrate the 2 existing
rows to a simple URL-bookmark spot elsewhere if they're still useful, OR
just leave them in the DB (harmless). The medical work gets its own
top-level page, not a Health-page tab.

## Data domains

### 1. Visits (past)

A record of a doctor visit that already happened.

Columns: `id`, `visit_date`, `doctor_name`, `specialty`, `clinic`,
`reason` (the complaint/topic), `notes` (what was discussed), `conclusion`
(diagnosis / recommendation), `follow_up_needed` (bool), `follow_up_after_weeks`
(int, optional), `linked_document_ids` (int[]), `created_at`.

### 2. Appointments (future)

Scheduled visits. Drives reminders.

Columns: `id`, `scheduled_at`, `doctor_name`, `specialty`, `clinic`,
`address` (optional), `reason`, `reminder_at` (when to alert — usually
24h + 1h before), `confirmed` (bool, did the doctor's office confirm?),
`linked_visit_id` (set once it happens → the past-visit row), `status`
('scheduled' / 'completed' / 'cancelled' / 'no_show'), `created_at`.

When an appointment's date passes, it should either auto-flip to
'completed' status and prompt the user to fill in a `medical_visits`
row, or remain 'scheduled' until manually resolved.

### 3. Medical documents

PDFs / images / scanned results.

Columns: `id`, `title`, `file_path` (relative to `/mnt/qnap-laptop/Medical/`),
`mime_type`, `size_bytes`, `doc_type` ('prescription' / 'lab_result' /
'imaging' / 'doctor_letter' / 'invoice' / 'other'), `issued_date` (date
on the document itself), `linked_visit_id` (int, optional), `tags`
(text[]), `notes` (free text — patient annotations), `uploaded_at`,
`uploaded_by` (probably always the user, but reserved for future
family-member support).

Upload via the dashboard — file goes to QNAP under
`/mnt/qnap-laptop/Medical/<year>/<id>_<safe_title>.<ext>`. The DB row
holds the path; the file itself is on QNAP.

### 4. Medications (current + past)

Active prescriptions + history of what's been discontinued.

Columns: `id`, `name` (generic + brand, free text), `dosage` (e.g.
"10 mg"), `prescribed_by` (doctor name), `prescribed_at_visit_id`
(int, optional), `start_date`, `end_date` (NULL = ongoing), `purpose`
(why it was prescribed — "BP control", "Cholesterol", etc.), `notes`
(side effects observed, etc.), `active` (bool — convenience flag,
derivable from `end_date IS NULL`).

### 5. Medication schedules

When to take each pill. One row per "time slot" per medication. A pill
taken twice daily = 2 rows.

Columns: `id`, `medication_id`, `time_of_day` (HH:MM local, e.g. '08:00'
and '20:00'), `days_of_week` (int[] 0-6, 0=Sun), `with_food` (bool),
`alert_minutes_before` (int, default 0 = exact time), `alert_methods`
(text[] — e.g. `{'alexa', 'phone_notify', 'dashboard'}`), `active` (bool).

### 6. Medication taken log

When the user confirmed taking a pill.

Columns: `id`, `medication_id`, `schedule_id`, `due_at` (the scheduled
moment), `taken_at` (when user confirmed), `skipped` (bool — user
explicitly skipped), `note` (optional — why skipped, or if late).

Drives the "did you take your morning pills?" follow-up if `taken_at`
is more than 30 min past `due_at`.

### 7. Medical providers / centers

Address book for clinics + doctors. Holds contact details so the user
can look up "what's Dr. Cohen's email?" without leaving the page.

One table covering both clinics and individual doctors via a `kind`
field. Two-table clinics+doctors design would be cleaner long-term but
the single-user single-table v1 keeps queries trivial.

Columns: `id`, `kind` ('clinic' | 'doctor' | 'hospital' | 'lab'),
`name`, `parent_id` (self-FK — for doctors, links to their clinic),
`specialty` (text, for doctors), `address`, `phone`, `email`,
`website_url`, `patient_portal_url`, `notes`, `created_at`.

`medical_visits` and `medical_appointments` keep their free-text
`doctor_name` + `clinic` fields (most flexible) but gain an OPTIONAL
`center_id` FK to this table. When the user picks from the directory,
the FK is set; when they type freely (a new place), they can save to
the directory inline or leave as free-text only.

Surfaced on the Medical page as **Card 8: Medical providers** —
searchable list, edit/add inline, mailto/tel links on the cards.

### 8. Medical conclusions

A timeline of statements about the user's health. Doctor-stated, AI-
generated, or self-recorded.

Columns: `id`, `ts` (when stated), `source` ('doctor' / 'ai' / 'self'),
`source_name` (doctor name if source='doctor', model name if 'ai'),
`category` ('diagnosis' / 'recommendation' / 'observation' / 'risk_factor'),
`text` (the conclusion itself), `confidence` (TEXT for now —
'definite' / 'probable' / 'speculative'), `linked_visit_id` (int, optional),
`linked_document_ids` (int[], optional), `created_at`.

### 9. AI investigation (future, not table — pattern only)

Mirror the Boiler Agent's `/api/ai-investigate` shape. User clicks "🧠
Investigate" on the Medical page → server gathers a relevant slice of
their data (recent visits + recent documents' OCR'd text + current
medications) → sends to Claude API → response is displayed AND
optionally saved as a `medical_conclusions` row with `source='ai'`.

## Dashboard layout (Medical page)

Single page (`medical.html`) with **cards** (not tabs — too much scrolling
for tabs; cards laid out vertically work for medical's chronological
nature):

1. **Status / Today** — "Next pill: 08:00 · Cholesterol", "Next visit:
   Tue 09:30 Dr. Cohen, Cardiology, in 3 days". Headline-style chips.
2. **Active medications** — table: pill name / dosage / schedule / last
   taken / next due. Buttons: ✓ Taken / ⊘ Skipped.
3. **Upcoming appointments** — chronological list. Edit / Cancel.
4. **Recent visits** — last 5 visits with their conclusions. Click to
   expand.
5. **Medical conclusions timeline** — combined doctor + AI + self. Filter
   by source / category.
6. **Documents** — searchable list. Filter by doc_type / date / tags.
   Upload button.
7. **Medical providers / centers** — address book with mailto/tel links.
   Add/edit clinics + doctors. Filter by specialty / kind.
8. **AI Investigation** — same pattern as Boiler's. Question textbox +
   Investigate button + results panel. (Phase 4)

Optional left-rail navigation if the page gets too long.

## Pill reminder system

Rule engine on LXC 105 (group=`medical`):

- **Rule**: `Pill Reminders`. Triggers on `heartbeat` (every 60 s).
- **Logic**: query `medication_schedules` joined with active `medications`.
  For each schedule, compute next `due_at` (today's `time_of_day` + the
  next day if past). If `now >= due_at - alert_minutes_before` AND no
  `medication_log` row exists for `due_at` AND not already alerted this
  cycle: fire alert via `alert_methods`.
- **Alert methods**:
  - `alexa` — text-to-speech via the existing Alexa Speech path
    (`@Alexa <Device> speak "Time for your <pill name>"`)
  - `phone_notify` — HA Companion notification with action button "Mark
    taken"
  - `dashboard` — a chip on the Medical page + a sidebar badge
- **Follow-up**: if `due_at` is >= 30 min ago AND no `taken_at` yet AND
  not `skipped` → re-alert.
- **Snooze**: dashboard / phone action "Snooze 10 min" — updates
  `medication_log.due_at` forward.

## AI investigation flow

Same pattern as Boiler Agent's `/api/ai-investigate`:

1. User types a question (e.g. "What's my blood pressure trend over
   the last year?" or "Could this lab result indicate diabetes?")
2. Server gathers a focused slice of relevant data (NOT the full
   history — token-budget aware):
   - All visits + conclusions in the time window
   - Active medications + recent log
   - Document titles + extracted text snippets (OCR'd once on upload —
     stored in `medical_documents.ocr_text`)
3. Sends to Claude API with a system prompt that establishes:
   - "You are reviewing medical history. Do not diagnose; suggest what
     to discuss with a doctor."
   - "Cite sources by visit_id / document_id."
4. Response saved as a `medical_conclusions` row with `source='ai'`.
   Visible immediately on the timeline.

## Privacy / safety constraints

- Files stored on QNAP NFS (`/mnt/qnap-laptop/Medical/`). NFS export
  scoped to LXC 103 + Proxmox host. SMB share `Medical_Data` restricted
  to a NEW user (not the existing `claude` user — separate permissions).
- DB rows hold paths and metadata only; raw images/PDFs only flow
  through the dashboard's `/api/medical/documents/file` endpoint which
  re-validates ownership before streaming.
- Anthropic API calls: include ONLY the data the question requires.
  System prompt explicitly tells the model not to retain / not to
  diagnose. Each request is one-shot; no persistent memory.
- Retention: `medical_*` tables retention=forever (this is the user's
  lifetime medical record). Cleanup is opt-in only.
- No public-internet exposure. The Medical page is behind the same
  dashboard auth as everything else (LAN-only or via NetBird tunnel).
- Backup: medical data MUST be in the daily LXC 102 dump that goes to
  QNAP. Already covered by the existing backup script.

## Phases (build order)

Building this is multi-session work. Honest staged plan:

### Phase 1 — Foundation (next ~1-2 sessions)
- Decide: replace Documents tab vs add new top-level page (recommended:
  new top-level page)
- Sidebar entry "Medical" added
- DB schema: create 7 tables + retention policy rows
- Server endpoints: CRUD for visits / appointments / documents / medications
- Dashboard page skeleton with the 7 cards, hardcoded styling
- File upload to QNAP working
- NO rule engine yet, NO AI investigation yet

### Phase 2 — Pill reminders (next)
- `medication_schedules` + `medication_log` populated
- Rule engine rule fires alerts via Alexa + phone notification
- Dashboard chip + sidebar badge for "pill due now"

### Phase 3 — Conclusions timeline + manual entry
- Unified timeline view
- Inline editor for adding self-conclusions

### Phase 4 — OCR + AI investigation
- On document upload: send PDF to a local OCR (tesseract via LXC 103?) or
  cloud OCR; store extracted text in `medical_documents.ocr_text`
- AI Investigation card on the Medical page, mirroring Boiler's pattern
- AI conclusions saved with `source='ai'`

### Phase 5 — Mobile-friendly + auto-prompt
- Phone notification when an appointment is approaching (24h / 1h before)
- "Did you take your morning pills?" follow-up
- Voice control via Alexa ("Alexa, what pills do I have at 8 PM?")

## Decisions locked in 2026-06-02

| # | Question | Decision |
|---|---|---|
| 1 | Single user or family? | **Single user.** Schema designed for one person (the home owner). Adding `family_member_id` later is a non-breaking column add. |
| 2 | Document file storage | **QNAP NFS at `/mnt/qnap-laptop/Medical/`** (existing mount, already in nightly backup). |
| 3 | OCR strategy (Phase 4) | **Tesseract on LXC 103**, fully local. No medical data leaves the LAN. Phases 1-3 ship without OCR; Phase 4 adds it. |
| 4 | AI provider | **Same Anthropic API key** used by Boiler Agent's AI Investigation (in `BOILER/dashboard/.env`). Same usage pattern, same model tier. |
| 5 | Calendar import | **Manual entry only for v1.** Google Calendar import is a future enhancement. |
| 6 | Alert escalation | **None for v1.** Missed pills produce a follow-up "did you take your morning pills?" notification 30 min after due_at, then go quiet. No third-party escalation. |
| 7 | Existing Documents tab on Health | **Kill the tab + DELETE the 2 stale rows.** Clean slate. The 2 bookmark rows (HOOK, Home Connect Re-auth) are unrelated and stale. |

## Why this is a separate top-level page, not a Health-page tab

The Project Health page is for system health (DB volumes, alerts,
retention, services). Medical is human health — a different domain.
Mixing the two on one page conflates "is the home-automation system OK"
with "is the user OK". Separation is cleaner; sidebar entries make
medical's prominence appropriate without burying it.

Bottom line: new top-level **MEDICAL** sidebar entry, new `medical.html`
page, Project Health's Documents tab gets retired.

## Status

**Scoped 2026-06-02. All 7 decisions locked in 2026-06-02.** Ready for
Phase 1 implementation when the user signals to start.
