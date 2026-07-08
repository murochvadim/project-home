# People / Heritage — Family & Friends

**Status: Phase 1 BUILT (2026-07-08).** The Directory + relationship-edge foundation is live
(Privacy → **People** tab). Phases 2–4 (graph / reminders+map / legacy) are still planned — the
Visualization + Phasing sections below remain the contract for them.

## Phase 1 — what's built (2026-07-08)
- **DB (LXC 102):** tables `people` + `people_relations` (migration `PEOPLE/migrations/001_people.sql`).
  `people_relations.from/to_person_id` → `people(id)` **ON DELETE CASCADE** (a person's edges vanish
  with them); `people.household_user_id` → `household_users(id)` **ON DELETE SET NULL**; unique edge
  `(from,to,rel_type)`. Retention **forever + 🔒 protected** (seeded protected in the migration since
  the server's once-only protect-seed already ran). Registered in `server.js` `DBV_GROUPS` (new
  **'People'** group) + `tsCol` (`created_at`).
- **Backend:** `BOILER/dashboard/routes-people.js` (own module, one `require('./routes-people')(app, db)`
  line in server.js ~L124 — passes the architecture-guard hook). Endpoints:
  `GET /api/people` (`?q=` free-text + `?category=`) · `POST /api/people` · `PATCH /api/people/:id`
  (dynamic whitelist like routes-places) · `DELETE /api/people/:id` (also SSH-deletes the photo) ·
  `GET /api/people/relations?person_id=` · `POST /api/people/relations` (idempotent on the unique edge)
  · `DELETE /api/people/relations/:id` · `POST /api/people/:id/photo` (multer) · `GET /api/people/:id/photo`.
  **Relations routes are registered BEFORE `/:id`** so `relations` isn't parsed as an id.
- **Photos:** on QNAP `\\192.168.1.155\Claude_Data\People_Photos` (subfolder of the existing Claude_Data
  share, auto-created on startup). Upload/serve/delete mirrors `routes-privacy.js` — DELETE tunnels via
  LXC-104 SSH (`192.168.1.227`, `/mnt/qnap-claude/People_Photos`). Only the basename is in `people.photo`.
- **Frontend:** `BOILER/dashboard/public/js/privacy-people.js` (entry `pvPeopleOnShow()`) + a **People**
  tab on `privacy.html` — placed after a separator that follows **Doc Create**, grouped with
  Places + Daily Journal (`Sites · Doc Create ‖ Places · Daily Journal · 👥 People · Settings ‖ Budget`).
  **Free-canvas layout (NOT a card, per the user):** a slim top toolbar = **＋ add icon (top-left)** +
  search + category filter + **totals legend** (count+color per category); below it an open
  `#ppl-canvas` where each person is a **draggable figure = colored icon (photo or 👤 silhouette,
  ring colored by category) + first/last name only** — nothing else on the figure. **Drag to arrange**
  (pointer events; saves `pos_x`/`pos_y` per person via PATCH — migration `002_people_positions.sql`);
  unplaced people auto-grid until first drag. **Click a figure → a window** opens with ALL fields to
  view/edit (`_openModal`) + photo + a **🔗 Relations** sub-section (add `rel_type → person`, delete an
  edge) + Delete. The **＋ opens the SAME window empty** to add a person (name + fields + photo +
  category + household-member dropdown from `/api/household-users` + 📍 Find geocode via Nominatim).
  This canvas is the **foundation for the Phase-2 graph** (connecting lines over the same figures).

## Phase 2 — relationship graph + Settings (2026-07-08)
Pure front-end + config (no DB/schema change; `people_relations` already holds the edges).
- **Relationship LINES:** `pvPeopleRender` injects an `<svg id="ppl-svg">` layer as the first child of
  `#ppl-canvas` (`pointer-events:none`), then draws a `<line>` for every `_rels` edge between the two
  figures' centers (`x+44, y+32`), **styled per relation type** (color + `stroke-dasharray`:
  solid/dashed/dotted). Lines follow live while dragging (`_updateLines` patches endpoints of
  `line[data-from|to]`), full redraw on drop/render. `_loadRels()` = `GET /api/people/relations` (all edges).
- **Network ↔ Groups toggle** (segmented control in the toolbar, `localStorage['people.view']`;
  the old Tree view was dropped 2026-07-08 per user — a strict tree can't hold friends/in-laws):
  **Network** = saved `pos_x/pos_y` snap-grid + every per-relation line; **Groups** = `_groupLayout`
  **clusters people into labeled region-boxes by CATEGORY** (groups = categories, so "add a group" =
  add a category in Settings — unlimited), and draws **only USER-DEFINED group connections**
  (`dashboard_settings.people.group_edges = [{a,b}]`, edited in Settings → 👥 People → 🔗 Group connections:
  pick two groups + Connect), each line drawn between the two boxes' **nearest corners** (`_nearestCorners`,
  recomputed live as a box is dragged via `_regionById`), styled by the configurable **group-link**
  (`group_link = {color, style}`). **PERSON → GROUP connections too** (`person_group_edges = [{p,g}]`,
  same Settings section, e.g. Vadim → Vadim friends) — a line from that person's figure to the group
  box's nearest corner. (The earlier auto-derived-from-people aggregation was dropped 2026-07-08 — the
  user wanted explicit links only.) **The group boxes are
  DRAGGABLE** (grab a box → the box + its people + its lines move together, snap-to-grid, persisted in
  `dashboard_settings.people.group_pos = {<catId>:{x,y}}`; boxes without a saved pos auto-flow).
  People inside a box aren't individually draggable in Groups (click icon = open, click name = highlight).
  A **"gray unconnected" toggle** (Groups toolbar, `localStorage['people.dimUnconnected']`) grayscales
  every person who is NOT `_connectedOutside` their group — i.e. has neither a person→group edge NOR a
  relation to someone in a different group — so the cross-group "connectors" (like Vadim) stand out.
- **Click split:** the **avatar** carries drag + click→`pvPeopleEdit` (open window); the **name** div
  carries click→`pvPeopleHighlight` (sets `_focusId`; re-render dims every figure + line except that
  person, their connections, and the lines between — opacity 0.12–0.15; click name again / empty canvas clears).
- **Settings — 👥 People card** (Privacy → Settings, now a **uniform 2-column grid** of all settings
  cards): two editors mirroring the journal category editor — **Categories** (name + `<input type=color>`)
  , **Relation types** (name + line color + solid/dashed/dotted), and **TWO Groups-view connection-line
  styles** — 🫂 **Group ↔ group** (`group_link`) and 👤 **Person → group** (`pg_link`), each color + style,
  so the two link kinds look distinct. Saved as the WHOLE blob to
  `dashboard_settings.people = {categories, rel_types, group_link:{color,style}, pg_link:{color,style}, group_pos, group_edges, person_group_edges}`
  (server replaces the whole value → both arrays re-emitted every save). Stable ids (`c…`/`r…`) so
  renames don't break existing people/edges. `pvPeopleSettingsLoad()` is called from the Settings-tab
  branch in `privacy.js`. The Edit-modal relation dropdown + line colors both read `_relTypes`.
- **Defaults** (when config absent): cats = the 4 Phase-1 buckets; rels = parent(solid dark-red)/
  child(solid red)/spouse(solid pink)/sibling(dashed amber)/friend(dashed green)/other(dotted grey).
  Config was seeded with these on 2026-07-08.
- **Verified:** config round-trips (4 cats + 6 rel types persist); `/api/people/relations` (all) returns
  the edge array; endpoints unchanged. Cache-busts `privacy-people.js?v=8` + `privacy.js?v=83`.
- **v1 limits:** Groups cluster by the person's single `category` (one group per person — a many-to-many
  groups layer was the alternative, not taken); aggregated group lines join box centroids (can cross a
  box). Cache-bust `privacy-people.js?v=9`. **Phases 3–4** (birthday reminders + origins map, legacy) still planned.
- **Categories** default to the 4 buckets client-side (`PPL_DEFAULT_CATS`: 🔵 My family / 🟣 Wife's
  family / 🟢 Friends / ⚪ People I know) with per-bucket colors; overridable later via
  `dashboard_settings.people.categories`.
- **Verified end-to-end 2026-07-08:** create (w/ category) · patch · relation add/list · search +
  member-name join · photo upload+serve (image/png) · person delete → relation CASCADE + photo
  SSH-removed from QNAP · both tables show protected in Project Health → DB Volumes.
- **Not yet:** the network/tree graph (Phase 2), birthday reminders + origins map (Phase 3), legacy
  layer (Phase 4). Cache-bust `privacy-people.js?v=1`.

---

## (Original design — retained as the contract for Phases 2–4)

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
  chosen over photo-avatars and plain dots). Fill color = `people.category` (the 4 buckets below).
  **Nothing else on the node** — keep the graph clean; all other
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
- **Totals panel — top-right corner (user request):** a live count per `category`, doubling as the
  graph's **color legend**. Rows: 🔵 **My family** N · 🟣 **Wife's family** N · 🟢 **Friends** N ·
  ⚪ **People I know** N · **Total** N. Counts recompute from the current people set (and honor any
  active filter). One panel = both the legend (what each color means) and the summary.

## Placement (user decision)

**A new "People" tab on the Privacy page** (`BOILER/dashboard/public/privacy.html`) — same pattern
as **Daily Journal** and **Places**. NOT a standalone sidebar page. Exact tab order in the Privacy
tab row is still **TBD** (open item below).

Dashboard-only module — no LXC service (like Corridor / Living Room / the other Privacy-page tabs).

## Data model (LXC 102 `home_data`, designed to grow)

- **`people`** — `id`, names (`given_name` / `family_name` / `maiden_name`), **`category`** — the
  bucket that drives BOTH the node color AND the top-right totals; user's set: **`family_mine`
  ("My family") / `family_spouse` ("Wife's family") / `friend` ("Friends") / `other` ("People I
  know")**. Note family splits into TWO sides (mine vs spouse's). Extensible — labels + colors come
  from a small config (`dashboard_settings.people.categories`) so buckets can be renamed/added
  (e.g. "colleagues") without a schema change. Assignment is **manual** to start (explicit per
  person); auto-deriving "wife's family" from the spouse link on the graph is a possible later add.
  Then: `gender` (for tree layout), `birth_date`, `death_date`
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

## Adding people & relations (UX)

Core interaction the user asked for: **add people, and connect them to other people.**

- **Add/edit person** via a form (all Directory fields). A **Relations** sub-section links them to
  OTHER people: **+ Add relation** → choose `rel_type` (parent / spouse / child / sibling / friend /
  …) + pick the other person from a **searchable list of existing people** (or create a new person
  inline). Each link writes one `people_relations` row and instantly appears as a line on the graph.
- **Reciprocal relations stored ONCE (no double-entry):** parent↔child, spouse↔spouse,
  sibling↔sibling, friend↔friend are inverses — enter the edge once; the app derives/renders the
  reverse. **Directed** types (parent→child) store direction; **symmetric** types (spouse / friend /
  sibling) are order-independent. (Store canonical `rel_type` + direction; render both ways.)
- **Phase 2 on-graph editing:** drag a line between two figures, or select a figure → "Add relation",
  as an alternate path to the same `people_relations` write.
- Delete/edit a relation from either person's card (removes the single shared edge).

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
