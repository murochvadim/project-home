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
| Sidebar entry | New top-level entry **MEDICAL** in the dashboard's sidebar navigation, under a new **Personal** section (the first section of that name). Personal will hold future personal-data trackers (fitness / journal / finances / etc.) alongside Medical. Pattern matches other dashboard-only agents (Living Room, Balcony, etc.) which each get a top-level sidebar entry. |
| Dashboard page | New dedicated page `BOILER/dashboard/public/medical.html` |
| Sub-tab structure | Inside `medical.html`, nested tabs split the domain into 5 focused sub-tabs for Phase 1: Today / Visits / Medications / Documents / Providers. Phase 4 adds a 6th: AI Investigation. Uses the same `.tab-btn` / `.tab-panel` pattern as the Project Health page and Project General page. |
| Dashboard JS | New `BOILER/dashboard/public/js/medical.js` (separate file, lazy-loaded on first tab visit — same pattern as `js/weather.js`) |
| Server endpoints | New cluster `/api/medical/*` in [BOILER/dashboard/server.js](../BOILER/dashboard/server.js) |
| Rule(s) | Pill-reminder rule in `RULES/rules/medical_pill_reminders.py` (rule group `medical`) — Phase 2 |
| File storage | QNAP NFS mount — `/mnt/qnap-laptop/Medical/` (existing mount, already in nightly backup) |
| DB tables (LXC 102) | `medical_documents`, `medical_visits`, `medical_appointments`, `medications`, `medication_schedules`, `medication_log`, `medical_conclusions`, `medical_providers` |
| Memory (Claude) | `project_agent_medical.md` once any non-obvious project context emerges |

## Existing "documents" tab on Project Health

The Project Health page has a `Documents` tab today
([health.html](../BOILER/dashboard/public/health.html#L335)) backed by a 6-column
`documents` table (id, title, url, theme, sort_order, created_at). Currently
holds 2 unrelated bookmarks (HOOK, Home Connect Re-auth). The user
explicitly OK'd removing it.

Plan: **remove the Documents tab from Project Health** + DELETE the 2
existing rows. Clean slate. The medical work lives in the new
dedicated `medical.html` page (separate scope — that old `documents`
table never held medical content anyway).

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

Surfaced on the **Providers** sub-tab — searchable list, edit/add
inline, mailto/tel/portal links on each card. Filterable by specialty
+ kind.

### 8. Medical conclusions

A timeline of statements about the user's health. Doctor-stated, AI-
generated, or self-recorded.

Columns: `id`, `ts` (when stated), `source` ('doctor' / 'ai' / 'self'),
`source_name` (doctor name if source='doctor', model name if 'ai'),
`category` ('diagnosis' / 'recommendation' / 'observation' / 'risk_factor'),
`text` (the conclusion itself), `confidence` (TEXT for now —
'definite' / 'probable' / 'speculative'), `linked_visit_id` (int, optional),
`linked_document_ids` (int[], optional), `created_at`.

### 9. AI investigation (Phase 4, not a table — pattern only)

Mirror the Boiler Agent's `/api/ai-investigate` shape. User clicks "🧠
Investigate" in the **AI Investigation** sub-tab → server gathers a
relevant slice of their data (recent visits + recent documents' OCR'd
text + current medications) → sends to Claude API → response is
displayed AND optionally saved as a `medical_conclusions` row with
`source='ai'`. AI-source conclusions then surface in the Today and
Visits sub-tabs alongside doctor and self conclusions.

## Dashboard layout (dedicated Medical page)

`medical.html` is a top-level page reached via a **MEDICAL** entry in
the sidebar. Inside the page, nested sub-tabs split the domain into 5
focused views (Phase 1) plus a 6th in Phase 4:

| Sub-tab | Phase | What it shows |
|---|---|---|
| **Today** | 1 | Overview cards: next pill, next visit, latest conclusion, recent activity. Global search bar (queries visits + conclusions + documents + meds + providers in one shot). Quick-add buttons. |
| **Visits** | 1 | Chronological feed of past **visits** + future **appointments** in one list. Past show conclusion + linked documents inline (expand to detail). Future show reminder time, can be "marked completed" inline (converts the appointment row → a visit row). |
| **Medications** | 1 | Active medications table (name / dosage / schedule / last taken / next due / ✓ Taken / ⊘ Skipped buttons). Manual taken-log (medication_log table — added in Phase 1 even though rule-engine alerts come in Phase 2). Discontinued history below. |
| **Documents** | 1 | Drag-drop upload zone at the top. Below: searchable list with filter chips (doc_type / linked visit / tags). Each row: thumbnail, title, doc_type, issue date, size, view/download buttons, link-to-visit dropdown. |
| **Providers** | 1 | Address-book grid of clinics + individual doctors. Each card: name, kind chip, specialty, mailto/tel/portal links. Add/edit inline form. Filter by specialty. |
| **AI Investigation** | 4 | Same pattern as Boiler Agent's. Question textbox + Investigate button + results panel. Conclusions saved with source='ai' appear in Today and Visits. |

Sub-tab switching uses the existing `.tab-btn` / `.tab-panel` pattern
already used by Project Health and Project General (`showTab()` helper).
Only one sub-tab visible at a time → page stays focused.

Mobile-first inside each sub-tab — single column, big tap targets,
forms stack vertically.

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

### Phase 1 — Foundation (~3-4 hours, possibly split into DB+API and UI)
- DB schema on LXC 102: create 8 tables + retention policies (all forever)
- Server endpoints: full CRUD for visits / appointments / documents /
  medications / medication_log / conclusions / providers + search + JSON
  export. ~22 endpoints total under `/api/medical/*`.
- New dedicated page `BOILER/dashboard/public/medical.html` with 5
  sub-tabs (Today / Visits / Medications / Documents / Providers),
  mobile-first responsive forms with smart defaults
- New `BOILER/dashboard/public/js/medical.js` (separate file, lazy-init
  on first sub-tab visit — same pattern as `js/weather.js`)
- New **MEDICAL** entry in the sidebar navigation, with link to
  `/medical.html`
- File upload pipeline to QNAP `/mnt/qnap-laptop/Medical/<YYYY>/<uuid>.<ext>`
  with EXIF rotate + compress + thumbnail
- Manual pill log via `medication_log` table + ✓ Taken / ⊘ Skipped buttons
  (pulled forward from Phase 2 so adherence tracking starts day 1)
- Search across all domains via `/api/medical/search?q=X`
- Kill Documents tab on Project Health + DELETE the 2 stale rows
- Docs update: root `CLAUDE.md` (DB tables + agent index + Dashboard
  Pages table entry for the new page), memory note
- NO rule-engine pill reminders (Phase 2), NO OCR/AI investigation (Phase 4)

### Phase 2 — Auto pill reminders
- Rule engine rule on LXC 105 (group=`medical`): triggers on heartbeat,
  queries `medication_schedules`, fires alerts when due
- Alert methods: Alexa TTS + HA Companion phone notification + dashboard
  chip
- 30-min follow-up notification for missed pills
- Snooze action support

### Phase 3 — Conclusions polish + appointment lifecycle
- Inline self-conclusion editor on the Visits sub-tab
- Auto-flip past appointments → "completed" with a prompt to fill in
  the corresponding visit row
- Doctor + clinic autocomplete from the Providers directory
- Optional: appointment reminder notifications 24h / 1h before

### Phase 4 — OCR + AI investigation
- On document upload: shell out to Tesseract on LXC 103, store
  extracted text in `medical_documents.ocr_text`
- AI Investigation sub-tab on the Medical tab (the 6th sub-tab),
  mirroring Boiler Agent's pattern
- AI conclusions saved with `source='ai'`

### Phase 5 — Voice + opportunistic helpers
- Voice control via Alexa ("Alexa, what pills do I have at 8 PM?")
- "Did you take your morning pills?" proactive prompt if log shows skipped
- Possible: Google Calendar import for appointments

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

## Placement decision (final, 2026-06-02)

The placement was discussed three times during scoping:

1. **First proposal** — top-level MEDICAL page + sidebar entry.
2. **Mid-discussion revision** — moved to a tab inside Project General
   to avoid adding another sidebar entry.
3. **Final decision** — reverted to the original top-level page + sidebar
   entry, after a deeper assessment of scope. Sidebar entry placed in a
   NEW **Personal** section (not General or Agents) — Personal will
   host future personal-data trackers (fitness, journal, etc.).
   Service layer: **none** (dashboard-only); rules live in group=`medical`
   on the shared rule engine at LXC 105.

Reasoning for the final decision:
- **Scale fit.** Medical has 5 sub-tabs in Phase 1 alone (Today / Visits /
  Medications / Documents / Providers) and a 6th in Phase 4. That's
  larger than Curtain + Geolocation + Weather combined. Project General
  would feel cramped with Medical as a 4th peer.
- **Pattern consistency.** Other substantial domains in this project
  (Balcony, Living Room, My BathRoom, Corridor) each get their own
  top-level page even though most are smaller in scope than Medical.
- **Discoverability.** "Medical" in the sidebar → one click. As a
  3-deep sub-tab inside Project General, it's buried.
- **Domain isolation.** Medical is a different concern category from
  the personal-utility surfaces in Project General. Mixing them
  conflates "where's the weather forecast" with "when's my next blood
  test."
- **Privacy posture.** Distinct page makes future per-page restrictions
  easier (different log-in, restricted Anthropic logging, etc.) if
  the user ever wants stricter access control on medical data.
- **Future-proofing.** Phase 4 + Phase 5 grow this further (AI
  investigation, voice control, OCR). A dedicated page scales there.

The Project Health Documents tab still gets retired — that decision
didn't change across either revision.

## Status

**Scoped 2026-06-02. 8 decisions locked in 2026-06-02** (7 original
question-pack answers + placement = Medical is its own agent with a
top-level page `medical.html` and a dedicated MEDICAL sidebar entry;
5 nested sub-tabs inside for Phase 1).

Phase 1 build is queued and ready to start on the user's signal. No
code touched yet — only this doc.
