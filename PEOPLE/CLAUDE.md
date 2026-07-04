# People / Heritage — Family & Friends

**Status: PLANNING (scoped 2026-07-04 — NOT built yet).** This file is the module index +
agreed design. No tables, endpoints, or UI exist yet; it's the contract to build against.

## Purpose

A "People hub" for **family and friends** — one people graph behind two views:

- **Directory** (CRM side) — searchable cards: photo, names, how you're related / how you know
  them, key dates, contact, origin, notes/story, tags (friend circles / side of family).
- **Relationship graph** (heritage side) — the headline view: an interactive **node-link / network
  graph** where each person is a **colored figure** and lines connect related people. See
  Visualization below.

Design principle locked with the user: **start small, grow** — model the close circle now, but
shape the schema + graph so it extends to deep, multi-generational ancestry later without rework.

## Visualization (confirmed 2026-07-04 — the marquee feature)

The user's core want: *"a figure of people, colored by relation, connected by lines to whom they're
connected."* This is a **node-link graph**, and it's the RIGHT primary view for a family **+**
friends hub — a strict top-down genealogy tree can't hold friends (they aren't ancestors), but a
graph holds a friend as just another figure with a line. Maps **1:1** onto the model: `people` =
nodes, `people_relations` = edges. No schema change needed — this is what the edge-list was for.

- **Nodes = colored person-figure icon + name ONLY** (👤 silhouette + the person's name label —
  chosen over photo-avatars and plain dots). Fill color = `people.category` (family / friend /
  colleague / …) with a **legend**. **Nothing else on the node** — keep the graph clean; all other
  detail (contact, dates, notes, photo) lives in the **Directory card** opened on click. (Photos are
  still stored per person for that card; the graph node itself stays icon + name.)
- **Edges = lines** between connected people (`people_relations`); optionally colored/styled by
  `rel_type` (parent / spouse / friend).
- **Interactive:** drag figures, zoom/pan, **click-a-figure-to-focus** (dim everything not connected),
  filter by color, click → open that person's Directory card.
- **Two layouts, toggle over the SAME data** (user chose "Network + Tree"):
  - **Network** (DEFAULT) — force-directed, everyone (family + friends), colored figures + lines.
  - **Tree** — strict top-down **generational** layout, **family edges only** (parent/spouse/child),
    for pure genealogy.
- **Rendering:** best done with a small vetted graph lib loaded from CDN (candidates **Cytoscape.js**
  or **vis-network** — same CDN pattern as Leaflet/Chart.js already on the dashboard); hand-rolled
  SVG is the fallback for small graphs. **Pin the choice at Phase-2 build time**, not now.

## Placement (user decision)

**A new "People" tab on the Privacy page** (`BOILER/dashboard/public/privacy.html`) — same pattern
as **Daily Journal** and **Places**. NOT a standalone sidebar page. Exact tab order in the Privacy
tab row is still **TBD** (open item below).

Dashboard-only module — no LXC service (like Corridor / Living Room / the other Privacy-page tabs).

## Data model (LXC 102 `home_data`, designed to grow)

- **`people`** — `id`, names (`given_name` / `family_name` / `maiden_name`), `category`
  (family / friend / colleague / …), `gender` (for tree layout), `birth_date`, `death_date`
  (nullable → living vs deceased), `photo` (basename → QNAP), `phone` / `email` / `address`,
  `relationship_to_me` (how related / how you know them), `origin_place` / `origin_country`
  (+ optional `lat` / `lon` for the origins map), `notes` (story text), `tags` (jsonb — friend
  circles / side of family), `household_user_id` (nullable FK → `household_users`, so the members
  already in the system are the SAME identities), `created_at`, `updated_at`.
- **`people_relations`** — an **edge list** (`id`, `from_person_id`, `to_person_id`, `rel_type`
  ∈ parent / spouse / child / sibling / friend / …, `notes`). An edge table (NOT fixed
  mother/father columns) is what lets it scale from the close circle to deep ancestry AND hold
  friend links — that's the "grow" part. Parent/spouse/child edges drive the tree; friend/other
  edges are the CRM graph.

**Storage: plaintext, LAN-only** — like `medical_contacts` + `journal_entries`: sensitive but stays
on the LAN, and **AI-readable** for future story/reflection help. NOT client-side-encrypted (that's
only the Privacy **site Docs**). **Photos on QNAP** (`\\192.168.1.155\Claude_Data\…`, the
`medical_documents` pattern; DELETE tunneled via LXC-104 SSH — Windows `claude` user has RW but not
delete on that share). Retention **forever + 🔒 protected** (like the other Personal tables).

## Backend & front-end (planned)

| Artifact | Path |
|---|---|
| Route module | `BOILER/dashboard/routes-people.js` (own module, ONE `require()` line in server.js — past the architecture-guard hook, like `routes-journal.js` / `routes-medical-tests.js`) |
| Front-end | `BOILER/dashboard/public/js/people.js` (loaded on `privacy.html`) + a **People** tab button + `#tab-people` panel |
| Migration | `PEOPLE/migrations/001_people.sql` (both tables + retention rows + DBV registration) |
| Config | `dashboard_settings.people.*` (e.g. reminder days-ahead) |
| Memory | `memory/project_agent_people.md` |

Endpoints (planned): `GET/POST/PATCH/DELETE /api/people` · `GET/POST/DELETE /api/people/relations`
· photo upload/serve (medical-docs pattern). Register both tables in `server.js` `DBV_GROUPS`
('Privacy' group) + `tsCol`, and in `retention_policies` (forever + protected).

## Reuses (don't reinvent)

- **`household_users`** — family members already identified; `people.household_user_id` FKs to it.
- **Reminders badge** (`routes-reminders.js` + `js/reminders-badge.js`) — birthdays / anniversaries /
  remembrance dates ride the same rail as the journal/water/exercise nudges.
- **QNAP photo storage** — the `medical_documents` upload + LXC-104-tunnel-delete pattern.
- **Leaflet + OSM** — the Places / Geolocation / Cellular map pattern, for the origins map.

## Phasing (start small, grow)

1. **Phase 1 — foundation:** the two tables + the **Directory** (add/edit/delete, all rich fields
   incl. photo + origin, search/filter, link to `household_users`).
2. **Phase 2 — the graph (marquee):** relationship links + the interactive **network graph**
   (colored person-figures + connecting lines, DEFAULT) + the **Tree** layout toggle (family edges
   only). See Visualization.
3. **Phase 3 — reminders + map:** birthdays / anniversaries / remembrance dates on the reminders
   badge; origins map (Leaflet).
4. **Phase 4 (later) — legacy layer:** memories, stories, voice notes attached per person.

## Features chosen (first version)

Network graph + Tree toggle · Directory + search · Birthday/date reminders · Photos + origins — **all
selected**. The earlier unspecified **"Other"** was **very likely the figure-graph idea**, now
captured as the Visualization above. (If "Other" also meant something else — memories/stories,
documents per person, "how we met", relationship strength, gift ideas, shared events — that lands in
Phase 4; confirm if so.)

## Open items (resolve before Phase 1 build)

1. ~~The "Other" feature~~ — **resolved**: it was the figure/network graph, now the Visualization.
   (Only reopen if the user meant an *additional* thing like a memories/documents layer → Phase 4.)
2. **Exact tab order** for "People" in the Privacy page tab row (e.g. after Daily Journal, or right
   after Sites).
3. **Migration home** — `PEOPLE/migrations/` (module-owned, chosen here) vs `PRIVACY/migrations/`
   (matches the "tab lives on Privacy" precedent of `007_journal.sql`). Confirm at build time.
4. **Graph library** — Cytoscape.js vs vis-network vs hand-rolled SVG. Decide at Phase-2 build.
