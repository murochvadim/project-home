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
| POST   | `/api/medical/documents` | multipart upload — `file` + JSON-stringified `meta`. 25 MB cap. Inserts row then writes file as `<id>__<sanitized-name>.<ext>`. |
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

## Status

- 2026-06-02: Contacts tab shipped.
- 2026-06-03: Documents tab added (PDF + camera capture). 9 doc types, FK links to doctor + producer (clinic/hospital).
