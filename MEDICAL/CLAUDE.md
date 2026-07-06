# Medical Agent

Flat address book of medical contacts — doctors, clinics, hospitals — plus a
Documents tab for PDF + camera-captured uploads. Dashboard-only agent. No
service, no rules.

History:
- 2026-06-02 (round 1): scoped 5-tab build (Today / Visits / Medications / Documents / Providers, 8 tables). Dropped same day per user — too wide.
- 2026-06-02 (round 2): simplified to Contacts-only (1 table). Shipped.
- 2026-06-03: Documents tab added back as the second sub-tab. PDF uploads + laptop-camera capture, stored on QNAP Claude_Data share.

## Purpose

Today the user keeps doctor / clinic phone numbers + addresses + health-fund
affiliations in a mix of phone contacts, paper, and memory. This agent gives
them ONE searchable address book on the home dashboard, organized by kind
(doctor / clinic / hospital) and filterable by health fund.

That's it. No visits, no prescriptions, no documents, no conclusions. If those
return as future scope, they'll come back as new tabs alongside Contacts.

## File locations

| Artifact | Path |
|---|---|
| Sidebar entry | New top-level **MEDICAL** entry under a **Personal** section in the dashboard sidebar (first Personal entry — future personal-data trackers will land here too) |
| Dashboard page | [`BOILER/dashboard/public/medical.html`](../BOILER/dashboard/public/medical.html) |
| Dashboard JS | [`BOILER/dashboard/public/js/medical.js`](../BOILER/dashboard/public/js/medical.js) |
| Server endpoints | `/api/medical/contacts` cluster in [`BOILER/dashboard/server.js`](../BOILER/dashboard/server.js) |
| DB table (LXC 102) | `medical_contacts` (retention=forever) |
| Migrations | `MEDICAL/migrations/setup.sql` (original 8-table scope) + `MEDICAL/migrations/002_simplify_to_contacts.sql` (drops 7 tables, renames `medical_providers` → `medical_contacts`, adds `health_fund`) |
| Memory note | `memory/project_agent_medical.md` |

## Schema (`medical_contacts`)

| Column | Type | Note |
|---|---|---|
| `id` | SERIAL PK |  |
| `kind` | TEXT CHECK ∈ {doctor, clinic, hospital} | required — kind chip on every row |
| `name` | TEXT NOT NULL | "Dr. Cohen" / "Clalit Tel Aviv" / "Sourasky Medical Center" |
| `specialty` | TEXT | "Cardiology" / "Imaging center" / "General hospital" |
| `health_fund` | TEXT | Clalit / Maccabi / Meuhedet / Leumit / free text (private / abroad / —) |
| `address` | TEXT | Street, city |
| `phone` | TEXT |  |
| `email` | TEXT |  |
| `website_url` | TEXT |  |
| `notes` | TEXT |  |
| `next_appointment_at` | TIMESTAMPTZ | optional — single upcoming-appointment slot per contact, added 2026-06-03 (migration `005_appointment_fields.sql`); surfaces as a red nested card on the contact row |
| `next_appointment_note` | TEXT | optional — short reason for the appointment (e.g. "Routine check", "fast 12h") |
| `reminder_text` | TEXT | optional — standalone reminder text (no date), added 2026-06-03 (migration `006_reminder_text.sql`); surfaces as a blue nested card on the contact row, independent of the appointment slot |
| `created_at` | TIMESTAMPTZ DEFAULT NOW() |  |

Dropped vs original `medical_providers` shape:
- `lab` kind (now 3 kinds, not 4)
- `parent_id` self-FK (doctor↔clinic linkage; each row is now fully self-contained)
- `patient_portal_url` column (folded into the single website_url field)

Added:
- `health_fund` column

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET    | `/api/medical/contacts`       | list all, ordered by kind then name |
| POST   | `/api/medical/contacts`       | create — body = full row (kind + name required) |
| PATCH  | `/api/medical/contacts/:id`   | partial update — only provided fields are written |
| DELETE | `/api/medical/contacts/:id`   | hard delete (no soft-delete column) |

Field-trim normalization: empty strings in PATCH/POST become NULL.

## UI

`medical.html` has ONE sub-tab: **Contacts**. Three cards inside:
1. **+ Add contact** — collapsible form (kind selector at top + 8 fields).
2. **Filter** — kind dropdown (`All` / `Doctors` / `Clinics` / `Hospitals`) + free-text search box (matches `name` / `specialty` / `health_fund` / `address`).
3. **List** — one card per row showing kind chip + name + specialty + health-fund line + address + tel / mailto / site link buttons + per-row Edit / Delete.

Edit opens the SAME form pre-filled, with the Save button labeled "Update". The form is fully self-rendered from the row's columns — no separate edit template.

## Why the simplify migration (2026-06-02)

Initial scope (committed earlier same day) included 5 sub-tabs (Today / Visits / Medications / Documents / Providers) backed by 8 tables. Built and shipped end-to-end. User reviewed and said:

> "stop you did mishmash from all i want to start with only one tab"

then:

> "tab contacts , go — but i dont want the rest tabs of medical delete all of them"

Read: scope was too wide for the user's actual need today. Visits / prescriptions / documents / conclusions are features that may return later but aren't wanted in v1. Contacts is the load-bearing one — "where's Dr. Cohen's phone number" is the question they need answered.

Migration `002_simplify_to_contacts.sql` is the clean break: drop 7 tables, drop 7 endpoint groups, rewrite `medical.html` + `js/medical.js` from scratch around just the Contacts form + list. The history is preserved in the migration files (run order setup → 002) so the path is traceable.

## Documents tab (added 2026-06-03)

Second sub-tab. PDF + camera-captured image uploads with metadata. Files
live on QNAP at `\\192.168.1.155\Claude_Data\Medical_Documents\` (Option A
of the storage-location choice — same share as project backups, with the
`claude` SMB user as the writer).

### Schema (`medical_documents`)

| Column | Type | Note |
|---|---|---|
| `id` | SERIAL PK |  |
| `name` | TEXT NOT NULL | user-set or auto-filled from filename |
| `doc_type` | TEXT NOT NULL CHECK | one of: `lab_result`, `imaging`, `prescription`, `visit_summary`, `referral`, `insurance`, `vaccine_record`, `id_card`, `other` |
| `doctor_id` | INTEGER REFERENCES medical_contacts(id) ON DELETE SET NULL | optional — links to a `kind='doctor'` row |
| `producer_id` | INTEGER REFERENCES medical_contacts(id) ON DELETE SET NULL | optional — links to a `kind IN ('clinic','hospital')` row |
| `file_path` | TEXT NOT NULL | basename only (`<id>__<sanitized-name>.<ext>`) — storage root in server.js |
| `file_size` | BIGINT NOT NULL | bytes |
| `mime_type` | TEXT NOT NULL | typically `application/pdf` or `image/jpeg` |
| `doc_date` | DATE | optional — when doc was issued (not uploaded) |
| `notes` | TEXT |  |
| `uploaded_at` | TIMESTAMPTZ DEFAULT NOW() |  |

Retention=forever (registered in `retention_policies`).

### Storage location + permissions (Option A — Claude_Data share)

- Path: `\\192.168.1.155\Claude_Data\Medical_Documents\` (UNC from Windows host) = `/mnt/qnap-claude/Medical_Documents/` (LXC 104 CIFS mount of same share).
- Windows host needs `cmdkey /add:192.168.1.155 /user:claude /pass:<qnap-claude-pass>` set once for the `muroc` user. Then Node.js `fs.writeFile` / `createReadStream` to the UNC path works natively.
- **QNAP SMB ACL quirk**: the `claude` user via Windows-side SMB has **read + write but NOT delete** on Claude_Data files. The same `claude` user via LXC 104's CIFS mount CAN delete (mount runs as root + uses different SMB flags). So the DELETE endpoint **tunnels through LXC 104 SSH** to run `rm /mnt/qnap-claude/Medical_Documents/<filename>`. Read + write stay direct from Windows (fast).

### Server endpoints (`server.js`, after the contacts endpoints)

| Method | Path | Purpose |
|---|---|---|
| GET    | `/api/medical/documents` | list — optional filters: `?type=`, `?doctor_id=`, `?producer_id=`, `?q=` (name+notes search) |
| GET    | `/api/medical/documents/:id/file` | stream file inline (PDF browser-preview, JPEG inline); `?download=1` forces attachment |
| POST   | `/api/medical/documents` | multipart upload — `file` + JSON-stringified `meta`. **1 GB cap** (raised from 25 MB 2026-06-07 to allow imaging studies added as `.zip`). Server stores ANY file type as-is (mime from upload, ext from filename) — no type validation. Writes `<id>__<sanitized-name>.<ext>` via async `fs.promises.copyFile` (non-blocking on large zips). |
| PATCH  | `/api/medical/documents/:id` | metadata-only update (rename / change type / retarget doctor or producer / edit notes / change doc_date) |
| DELETE | `/api/medical/documents/:id` | SSH → LXC 104 → `rm` the file, then DELETE the row |

### UI

`medical.html` now has TWO tabs: **Contacts** (default) and **Documents** (lazy-loaded on first click).

**+ Add document card** (top of Documents tab):
- Two mode buttons: `📄 Upload PDF` and `📷 Camera capture`.
- PDF mode shows a `<input type="file" accept="application/pdf">`.
- Camera mode opens a dark stage with a live `<video>` from `getUserMedia({video:{facingMode:'environment'},audio:false})` + a `📸 Snap` button. Snap draws the frame to a canvas → `toBlob('image/jpeg', 0.85)` (~80% quality, good for paper docs).
- Form fields (shared by both modes): name (auto-filled from filename if empty), doc_type (9 options), doctor (dropdown of `kind='doctor'` contacts), producer (dropdown of `kind IN ('clinic','hospital')`), doc_date (optional), notes.
- Upload button POSTs `multipart/form-data` with the file + JSON meta.

**Filter card**: type dropdown + doctor dropdown + free-text search (matches name and notes).

**List card**: one row per document showing type chip, name, doctor name, producer name + kind, doc_date, mime_type + size + uploaded_at, notes. Per-row buttons: `👁 View` (opens in new tab via `/file`), `⬇ Download`, `Edit`, `✕ Delete`.

### Storage root constant + sanity-check on startup

`MEDICAL_DOCS_ROOT = '\\\\192.168.1.155\\Claude_Data\\Medical_Documents'` declared in server.js. Auto-`fs.mkdirSync(..., {recursive:true})` at startup so the folder gets created on first run if Windows credentials are set + UNC path is reachable. Console-error if not.

### Pre-existing requirement before the tab works

- **`cmdkey` setup for the Windows host** (one-time):
  ```powershell
  cmdkey /add:192.168.1.155 /user:claude /pass:<QNAP claude password>
  ```
- After cmdkey, `Test-Path '\\192.168.1.155\Claude_Data'` should return `True`. The dashboard's mkdirSync + writes will then succeed.

## Future (NOT scoped)

- **Visits** — past doctor visits
- **Medications** — active prescriptions + manual taken log
- **AI Investigation** — Anthropic-API question over the address book + documents (would also extract PDF text via `pdf-parse` for search)

None committed. The Documents code is intentionally self-contained.

## Per-contact appointment slot + reminder (2026-06-03)

Each `medical_contacts` row carries two **independent** optional fields:

- **Appointment slot** — `next_appointment_at TIMESTAMPTZ` + `next_appointment_note TEXT`, added by migration `005_appointment_fields.sql`.
- **Reminder text** — `reminder_text TEXT` (no date — just free-form text), added by migration `006_reminder_text.sql`.

Both can be set simultaneously on the same contact. Setting one does not
affect the other; cleared via independent ✕ clear buttons in the form.

### UI

**Edit form** has two color-coded sections at the bottom:

- **📅 Next appointment** (red border) — three separate inputs for the
  date+time: `<input type="date">` + `<input type="number" min="0" max="23">` (HH) +
  `<input type="number" min="0" max="59">` (MM), plus a "Reason" text field.
  The 3-input split exists because `<input type="datetime-local">` follows
  OS locale and shows AM/PM on en-US Windows regardless of HTML attributes
  — no way to force 24-hour there. Number inputs are always 24-hour.
  Empty date → `next_appointment_at = NULL` + `next_appointment_note`
  force-cleared client-side. A ✕ clear button blanks all 4 inputs at once.
- **🔔 Reminder** (blue border) — a single text input + ✕ clear button.
  No date logic; whatever text is typed stays on the contact until
  manually edited or cleared.

**Contact card in the List** renders up to two nested mini-cards (~260 px
wide each) side-by-side in the middle of the contact row, between the
address line and the contact-method link row. Both are centered via a
`flex; flex-wrap:wrap; justify-content:center` container:

- **Red card** when `next_appointment_at` is set — title "📅 NEXT APPOINTMENT" +
  formatted date (`15 Jun 2026, 14:30`, always 24h via `toLocaleString('en-GB', {hour12:false})`) + italic reason.
  Past appointments (`appointment_at < now`) switch to muted red bg/border + a small "past" pill in the title — visual nudge to clear via Edit.
- **Blue card** when `reminder_text` is set — title "🔔 REMINDER" + the text.

When both are set the cards render side-by-side; if only one is set it
centers alone. If neither is set the whole flex container is omitted.

### Timezone round-trip

`<input type="date">` returns `YYYY-MM-DD` (no TZ). HH+MM are integers.
On save the JS combines them: `new Date(\`${date}T${HH}:${MM}\`)` parses
as **browser-local** time → `.toISOString()` → UTC ISO with `Z` suffix.
The server stores that in TIMESTAMPTZ. Read-back: server returns ISO,
JS Date parses to UTC then `getHours()/getMinutes()` returns browser-local
values → same wall-clock the user originally typed. Works regardless of
the Postgres session timezone (this is why the bare datetime-local
approach failed before this round — it sent values without a timezone
marker, so PG interpreted them in its session TZ and the round-trip lost hours).

### Why no rule engine integration (yet)

The Level-3 design discussed before shipping included an LXC 105 rule
that would push reminders to Awtrix + Alexa N hours before each
appointment. User chose Level 2 instead — dashboard surface only, no
automated reminders. If/when automated reminders are wanted later, the
rule would read `next_appointment_at` straight from `medical_contacts`
(no schema change needed); the columns are designed to be rule-engine-
friendly. The standalone `reminder_text` field is intentionally static —
it's a sticky note, not a notification trigger.

## Tests tab (hearing test, 2026-06-07)

Third sub-tab on `medical.html`: **Tests** — self-tests run in the browser, results
stored in a generic DB table so future tests (e.g. an **Eye test**) reuse it.

First test: **Hearing** — a pure-tone screening via the browser **Web Audio API**
(our own code, no library). Per ear (right then left), per frequency, a
**descending staircase**: the tone gets quieter each time the user taps "I hear
it"; "I hear nothing" records the threshold = the last step heard. Hard-panned per
ear via `StereoPannerNode`. **Frequency-band selector** in the setup row (2026-06-07):
`standard` 250 Hz–8 kHz (6 freqs), `extended` 250 Hz–16 kHz (8), `highfreq` 8–16 kHz
(5) — chosen band drives the step list (band × 2 ears = N steps) and is saved in
`meta.band`. Renders an **audiogram** (Chart.js: Right = red circles, Left = blue
crosses); the chart derives its X-axis frequencies from the result itself
(`htFreqsOf`) so any band — incl. old saved tests — renders, and it can be hidden
via **✕ Close graph** (also auto-hidden on start/discard/save). **Uncalibrated** —
relative screening / left-right comparison / tracking, NOT clinical dB HL; wired
headphones recommended. (The verbose inline disclaimer was removed 2026-06-07 per
user — the card stays clean.)

### 🧠 Cognitive test (2026-07-03)
Third card in the Tests grid (beside Hearing + Eye) — a ~2–3 min browser self-screen, module
**`js/medical-cognitive.js`** (`ct*` fns), stored as **`test_type='cognitive'`** (no schema change,
no new endpoint). Three sub-tasks, run in sequence, each injected into `#ct-runner`:
1. **Reaction time** — box turns green after a random 1.2–3.8 s wait; tap ASAP; 5 trials (early taps
   retried) → `results.reaction.avg_ms`.
2. **Digit span** — digits flash one at a time; type them back; length grows until 2 misses at a length
   → `results.digit_span.max_span`.
3. **Stroop** — 30 s; a colour word in a **conflicting** ink; tap the **ink** colour → `results.stroop.net`
   (correct − wrong, floored at 0).
**Age (per user request):** on Start (after the shared "🧑 Who is taking this test?" modal), `ctStart`
resolves the person's **age from `ph_profiles.date_of_birth`** (via `GET /api/personal-health/profiles`,
matched on `user_id`); if the person has no DOB (or is unassigned) it shows an **age-band picker** and
requires one. The band drives an **age-normed "below/average/above" rating** per domain from
**approximate reference midpoints** baked into `CT_NORMS` (rt lower-is-better; span/stroop higher). Stored
in `meta.{age, age_band, notes}`. **⚠ Self-screen, NOT a diagnosis** (prominent disclaimer on the card);
norms are rough reference ranges, not a clinical instrument (MoCA/MMSE are clinician-administered). The
shared **Test Results** list + View dispatch are wired in `medical-hearing.js` (`htRowHtml` cognitive chips
+ `ctRowSummary`; `medTestView` → `ctRenderResult` → the 3 domain scores + ratings in `#ct-result-wrap`).
No trend chart (user declined).

### Storage — generic `medical_test_results` table (LXC 102)
| Column | Type | Note |
|---|---|---|
| `id` | SERIAL PK | |
| `test_type` | TEXT NOT NULL | `hearing` now; `vision` later (no schema change) |
| `tested_at` | TIMESTAMPTZ DEFAULT NOW() | |
| `results` | JSONB NOT NULL | hearing: `{"right":{"250":dB,…,"8000":dB},"left":{…}}` — dB = attenuation tolerated below reference, **higher = better** |
| `meta` | JSONB | `{headphones, notes}` |
| `created_at` | TIMESTAMPTZ DEFAULT NOW() | |
| `user_id` | INT FK → `household_users(id)` ON DELETE SET NULL | added 2026-06-25 — which household member the result belongs to (SET NULL preserves test history if the member is removed) |

Index `(test_type, tested_at DESC)` + `(user_id)`. Retention=forever. Migrations:
`MEDICAL/migrations/007_test_results.sql` + `008_test_results_user.sql`.

**Person attribution (2026-06-25):** pressing **▶ Start** on either test opens a **🧑 "Who is taking this test?" modal** (`#med-person-modal`, dropdown `#med-person-pick` populated from `/api/household-users`); the button onclicks are `medStartTest('hearing'|'vision')`, and `medPersonConfirm()` stores the choice in `window._medTestUserId` (persists across consecutive tests) before running the real `htStart()`/`vtStart()`. Both `htSave`/`vtSave` send that `user_id`; the POST stores it and the GET **LEFT JOINs `household_users`** to return `member_name`, rendered as a 🧑 chip on each result row.

### Endpoints — `BOILER/dashboard/routes-medical-tests.js`
A **separate route module** (not inline in `server.js`) wired via one line —
`require('./routes-medical-tests')(app, db)` right after the pg pool. This keeps
`server.js` free of new `app.<method>(` handlers, which the architecture-guard hook
(`.claude/settings.local.json`, PreToolUse Edit on server.js) would otherwise block.
Same `db` (pg Pool) query style as the contacts cluster.

| Method | Path | Purpose |
|---|---|---|
| GET    | `/api/medical/test-results[?type=hearing]` | list, newest first |
| POST   | `/api/medical/test-results` | `{test_type, results, meta?, user_id?}` |
| DELETE | `/api/medical/test-results/:id` | hard delete |

### Eye test (visual acuity, 2026-06-07)

Second test in the Tests tab: **laptop-screen acuity screening** (`test_type='vision'`).
**Calibrate once** (localStorage `med.vision.calib`): drag an on-screen outline to
match a real credit/ID card (85.6 mm) → `px_per_mm`; enter viewing distance (cm).
Then **per eye** (cover the other), a **read-down chart** of mixed letters+numbers at
decreasing logMAR sizes (1.0→0.0, 6/60→6/6) computed from `px_per_mm` + distance via
`vtSizePx` (optotype = 5 × 10^logMAR arcmin → mm → px); the user **taps the smallest
line they can read** ("Can't read even the top line" → below-chart sentinel logMAR 1.3).
Result = per-eye `{logmar, snellen}` + `distance_cm` + `px_per_mm`; `meta={correction
(none/glasses/contacts), notes}`. **Screening only** — acuity WITH current correction,
does NOT measure refractive error.

### Unified Test Results card
The single **Test Results** card lists **all** test types (`medTestsLoad` fetches
`/api/medical/test-results` with no type filter). Rows branch by `test_type`: hearing →
🔊 chip + band + R/L avg dB; vision → 👁 chip + correction + R/L Snellen. **View**
(`medTestView`) dispatches: hearing → `renderAudiogram` (#ht-chart-wrap), vision →
`renderVision` (#vt-result-body). Delete is type-agnostic.

### UI / files
- `medical.html` — Chart.js CDN in `<head>`; **Tests** tab; `#tab-tests` with the **Hearing test** + **👁 Eye test** cards **side-by-side in a 2-col grid** (`minmax(340px,1fr)`, `align-items:stretch` → equal height; stacks on narrow screens), then a full-width unified **Test Results** card (`#ht-chart-wrap` audiogram + `#vt-result-wrap` acuity readout + saved list). The eye-test **runner is a full-screen centered overlay `#vt-overlay`** (white bg, chart in the middle of the screen — like a real eye chart) so the user can sit back; opens on Start, closes on finish/cancel. Saved-result rows show **date only** (`DD/MM/YYYY`, `toLocaleDateString('en-GB')`) in a fixed-width centered box so dates line up.
- `js/medical-hearing.js` — Web Audio tone generator + staircase + `renderAudiogram()` + the **unified** list/view (`medTestView`) + save/delete. No IIFE (inline onclick handlers stay global); `htEsc()` avoids colliding with medical.js's top-level `esc`.
- `js/medical-vision.js` — calibration + `vtSizePx`/`vtSnellen` + per-eye read-down flow + `renderVision()` + `vtRowSummary()` (called by the hearing.js list) + save. Reuses `htEsc()`; calls `medTestsLoad()` (hearing.js) after save.



- 2026-06-02: Contacts tab shipped.
- 2026-06-03: Documents tab added (PDF + camera capture). 9 doc types, FK links to doctor + producer (clinic/hospital).
- 2026-06-07: Documents uploader also accepts **`.zip`** (drop-zone + form `accept` lists zip) so a zipped imaging study (MRI/CT) can be added + stored on QNAP like any other doc; upload cap raised to **1 GB**, file copy made async. Zip rows show a distinct **📦 icon** (amber) and **no "Open"** — they get a **🩻 View slices** button instead.
- 2026-06-07: **In-dashboard DICOM viewer** (`js/medical-dicom.js` + `#med-dicom-modal`). Fully client-side: fetch the zip → unzip (JSZip) → render slices with **cornerstone-core + dicom-parser + cornerstone-wado-image-loader**. Libs **vendored in `public/vendor/dicom/`** (NOT CDN — web workers must be same-origin) using the **`NoWebWorkers` bundle** (main-thread decode, codecs included → no cross-origin worker / WASM-path config). Detects DICOM by `.dcm` ext OR `DICM` magic @ byte 128, groups by SeriesInstanceUID, shows the **largest series** sorted by InstanceNumber. Full-screen overlay: scroll=slice, slider=jump, left-drag=window/level, right-drag=pan, 🔍 zoom, ↺ Fit, Esc=close, slice counter. No server/DB changes. Caveats: main-thread decode → **large studies are heavy**; a slice with an unsupported/exotic transfer syntax shows a per-slice error (fall back to Download); if libs fail to load it degrades to Download. Built blind (no browser test here) — may need an iteration on a real study.
- 2026-06-03: Per-contact appointment slot + standalone reminder text — `next_appointment_at` + `next_appointment_note` + `reminder_text` on `medical_contacts`. Red + blue nested mini-cards rendered side-by-side on the contact row. Round-trip safe across timezones via UTC ISO wrap; 24h display forced via `hour12:false` + 3-input split form.
- 2026-06-07: **Tests tab** added — Web Audio **hearing test** (descending-staircase pure-tone screening) + audiogram, stored in the generic `medical_test_results` table. Endpoints in `routes-medical-tests.js` (separate module to clear the server.js architecture hook). See "Tests tab" section above.
- 2026-06-07: **Eye test** (visual acuity) added to the same tab — laptop-screen, credit-card+distance calibration, per-eye read-down letters/numbers chart, tap-smallest-line → logMAR/Snellen, `test_type='vision'` in the same table. Test Results card unified across both types (`js/medical-vision.js`).
- 2026-06-25: **Household-member attribution** across Medical. Documents + Tests now record **who** they belong to via the canonical `household_users` table. **Documents:** a **Person** dropdown in the upload/edit form (`#df-person`, from `/api/household-users`), `medical_documents.user_id` FK (ON DELETE SET NULL, migration `009_documents_user.sql`), 🧑 chip in the list, GET LEFT JOINs `household_users` → `member_name`; **all 89 pre-existing docs backfilled to Vadim** per request. **Tests:** a 🧑 "Who is taking this test?" modal on ▶ Start (`medical_test_results.user_id`, migration `008`). Both surface the member name in their lists.
- 2026-07-06: **BoBo balance-board — in the Settings tab.** Two cards share one full-width 2-col row:
  **🛹 BoBo Balance Board — Calibration** (guided wizard for the `balcony_bridge` ESP32 balance board;
  `js/medical-bobo.js`, MQTT-WS to the board's `pos` stream — see the `project-bobo-balance-bridge` memory)
  + **🎮 BoBo Game** (a lightweight "Colour Tunnel" lean-to-steer game — `js/bobo-game.js` renders the start
  screen into `#bobo-root`, **▶ Play → full-viewport overlay**; reads the calibrated `x` over MQTT-WS;
  **arrow-key fallback** for desktop). Score → `medical_test_results` (`test_type='balance'`,
  `{score,obstacles,duration_s,level}`) → shows in **Tests → Test Results** (⚖ Balance branch in
  `medical-hearing.js` `htRowHtml`/`medTestView` + `window.renderBalance` detail). Difficulty remembered
  per user in `dashboard_settings.medical.bobo_game`. **mqtt.js vendored locally**
  (`public/vendor/mqtt/mqtt.min.js`, no CDN — `medical.html` loads the local copy; the calibration wizard
  uses the same global). No server.js/DB/firmware change — reuses `medical_test_results` +
  `/api/dashboard-settings` + `/api/household-users`.
- 2026-06-25: **Personal Health tab** added (4th tab) — per-person body-metrics + medications record. **Owned by its own module, NOT documented in detail here** — see [PERSONAL_HEALTH/CLAUDE.md](../PERSONAL_HEALTH/CLAUDE.md). In brief: people come from the canonical **`household_users` table** (`/api/household-users`); each gets a profile (sex/DOB/height/allergies/conditions) + weight log → BMI/age/ideal-weight + a **medications list** (row = name·dose·schedule; an **ℹ️ Info window** holds the safety info — purpose/ingredients/avoid_with/contraindications/side_effects/warnings/prescriber — feeding a future med-safety cross-check). Backend `BOILER/dashboard/routes-personal-health.js` (one `require()` line, like `routes-medical-tests.js`); front-end `js/personal-health.js` + `#tab-personal-health` in `medical.html`; tables `ph_profiles`/`ph_measurements`/`ph_medications` on LXC 102 (migration `PERSONAL_HEALTH/migrations/setup.sql`).
