# Medical Agent

Flat address book of medical contacts — doctors, clinics, hospitals. Single
sub-tab on a dedicated dashboard page. No service, no rules, no other tabs.

Scoped + simplified 2026-06-02 (two rounds — the first scope was 5 sub-tabs +
8 tables, dropped same day per user feedback).

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

## Future (NOT scoped)

Possible future tabs alongside Contacts, all gated on explicit user ask:
- **Visits** — past doctor visits
- **Medications** — active prescriptions + manual taken log
- **Documents** — PDF / lab-result uploads
- **AI Investigation** — Anthropic-API question over the address book + future visit/document data

None of these are committed. Adding any of them = new migration, new endpoints, new sub-tab + JS section. The Contacts code is intentionally self-contained so future additions don't have to be aware of it.

## Status

Phase 1 = **Contacts only**, shipped 2026-06-02 after a same-day simplify. No further phases scoped.
