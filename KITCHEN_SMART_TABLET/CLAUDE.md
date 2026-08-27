# KITCHEN_SMART_TABLET — Fridge Food/Shopping Tablet

**STATUS: v1 BUILT + RUNNING (2026-08-24, remote/out-of-home). Backend + PWA + dashboard live over http; Caddy/HTTPS + Fully-Kiosk mount + real barcode camera deferred to home.**

**Built so far (all laptop-testable, no home hardware needed):**
- **LXC 113 "kitchen"** (`192.168.1.208`, Debian 12, DHCP-reserved BEFORE use per the IP-collision
  lesson `[[incident_dhcp_pool_ip_collision]]`) running **`kitchen-service.py`** (Flask CRUD, port
  **8772**, `kitchen-service.service`, trust-auth DB — no secret). Data-only: NO MQTT, no device control.
- **DB** (LXC 102): `kitchen_products` (catalog, forever+🔒), `kitchen_shopping_lists`,
  `kitchen_shopping_items` — migration `migrations/001_kitchen.sql`; 35 realistic **Hebrew-named**
  products seeded (`002_seed_products.sql`). Registered in Health DB-Volumes (`DBV_GROUPS` 'Kitchen').
- **Managed Hebrew categories** (migration `003_categories.sql`): `kitchen_categories` (Hebrew name +
  emoji + **`sort_order` = the fridge-tablet page/section order**, forever+🔒) + a `category_id` FK on
  `kitchen_products`; 8 Hebrew categories seeded, all 35 products migrated off the old English text
  `category` → `category_id` (0 orphans). Products GET JOINs → `category_name`/`category_emoji`.
  Endpoints `/api/kitchen/categories` GET/POST/delete/**reorder**. **Categories drive the tablet layout**
  (Part 2) — the PWA will group tiles into pages by category in `sort_order`.
- **PWA** (`kitchen/` served same-origin by the service at `http://192.168.1.208:8772/`): Hebrew-RTL
  tile grid + 🛒 Buy mode (tap → +1 to active list) + ℹ️ Browse (detail) + Shopping-List screen
  (check/remove/manual-add) + barcode-decode code (camera test = home). manifest = fullscreen PWA.
- **Dashboard Kitchen Agent page** (`BOILER/dashboard/public/kitchen.html` + `js/kitchen.js`, sidebar
  under **Agents**), **4 tabs** (order: **🍎 Products · 📦 Stock · 🧺 Shopping List · 🏷 Categories** —
  Categories last): **Products** CRUD (Hebrew name/emoji/**category dropdown**/price) + **Stock**
  (per-product `qty_on_hand` −/+ in its unit + low threshold, grouped by category, **"Check missing"** →
  adds at/below-threshold items to the list) + **Shopping List** (per-item **−/+ buy qty in the unit** +
  a **stock chip** (red when low); add **bumps qty** not duplicates, qty 0 removes; **📲 WhatsApp** text
  includes qty+unit) + **Categories** (add/rename/delete + **▲▼ reorder** = tablet page order, live
  counts). English-name field dropped (Hebrew-only UI); Products Name column centered. Unit-aware step
  (kg/L = 0.5, else 1). Calls LXC 113 directly (`http://192.168.1.208:8772`)
  — architecture-guard safe (no server.js business logic). `agents` table row + orchestrator SSH key
  authorized on 113 so the Health Services check passes.

**Remaining:** Caddy internal-CA HTTPS (needed for the barcode camera secure context) + Fully Kiosk on
the fridge tablet + real barcode camera test + install the Caddy root CA on the tablet — all **home
steps**. Optional Step 7: `svc-lxc113` Health cell + PVE vzdump backup (needs explicit host OK).

---

_Original plan below (2026-08-21):_

A tablet magnet-mounted on the fridge running a **PWA** whose tiles are **food products**
(🍎 apple, 🧀 cheese…) instead of device switches — a food-shaped sibling of the
[Balcony Smart Tablet](../BALCONY_SMART_TABLET/CLAUDE.md). Tap a product to add it to a
shopping list, log that you used it, or view its nutrition/price card. Each product carries
DB params (price, calories, last-bought, health rating, daily serving, allergens, stock…).
Managed from both the tablet and a dashboard **Kitchen** page.

**Full vision** (spread across phases): **build buy-list → send to WhatsApp → shop → import the
receipt → inventory + prices auto-update.** ⚠ **v1 ships only the first two** (build buy-list +
WhatsApp); stock/receipts/integrations are later phases.

## Locked decisions (2026-08-21)
- **Laptop-independent** → LXC-hosted PWA, exactly like the Balcony Smart Tablet (the dashboard
  is firewall-blocked + laptop-dependent; a fridge appliance must survive laptop-off).
- **Host = a NEW dedicated LXC ~113 "kitchen"** (verify a free IP + provision like FR/Email did).
  Chosen over reusing LXC 100 because this is a growing data+service app (catalog, receipts,
  OCR, barcode lookups, nutrition + budget/PH integrations) — it belongs off the media box, the
  same way Email got LXC 110 and Privacy got 109, not bolted onto the tiny read-only
  `panel_service` tablet-host on LXC 100. ⚠ LXC 112 is only *reserved* for the FR backend (not
  built) — verify the actual next-free id at build (kitchen may end up 112 or 113).
- **⚠ Serve the PWA over HTTPS (NOT plain HTTP).** The **barcode camera needs a secure context**
  (`getUserMedia` is blocked on `http://<LAN-IP>` — only HTTPS or `localhost` qualify). So the
  balcony tablet's plain-HTTP deploy does NOT transfer here. **Put Caddy (internal CA) in front of
  Flask** — the exact pattern **Privacy LXC 109** already runs (`https://192.168.1.196`,
  `PRIVACY/Caddyfile`) — and set Fully Kiosk → **"Ignore certificate errors"** (or install the CA
  on the tablet). *(Alternative: Fully Kiosk's native barcode scanner, which uses the Android
  camera and POSTs the code back — bypasses `getUserMedia`/HTTPS entirely.)*
- **Add-by-camera = BARCODE only** (in-browser decode → Open Food Facts lookup). Visual/AI product
  recognition is **parked** (too hard for arbitrary groceries — thousands of look-alike SKUs +
  loose produce; a future optional CLIP-enroll or LLM-vision fallback if ever wanted). ⚠ OFF's
  **Israeli-product coverage is partial**, so barcode is an **accelerator, not a guarantee** — the
  **manual add/edit path is first-class**, barcode just pre-fills it when the code is found.
- **WhatsApp send = `wa.me` share-link**, but **from the dashboard / the user's phone — NOT the
  shared fridge kiosk.** `wa.me` opens the WhatsApp *app*, which needs a logged-in account + the
  ability to leave the kiosk; the fridge tablet has neither. On the tablet, offer a **QR code of
  the list** to scan with a phone instead. Meta WhatsApp Cloud API (official, non-Chinese) is an
  optional later phase for automated sending.
- **Language:** Hebrew product names (RTL tiles) + English UI/menus/dashboard.
- **v1 scope = Core buy-list** (below). Stock/consumption/receipts/integrations are later phases.

## Architecture
- **`kitchen_service.py`** (Flask) on **LXC ~113** — serves the PWA static files **and** the CRUD
  API, talking directly to Postgres on LXC 102. Laptop-independent; mirrors `panel_service.py` /
  `bobo_game_service.py` but with a full write API like the Email agent's Flask app. **Behind Caddy
  for HTTPS** (see the serving decision above) + CORS for the dashboard cross-origin calls.
- **No MQTT / no rule engine / no broker changes** — the kitchen tablet controls nothing, it's
  pure data CRUD. Plain HTTPS (GET catalog / POST buy-list actions), polling for multi-user sync.
  This is the deliberate simplification vs the Balcony tablet (which needs MQTT-WS + the
  `panel_commands` rule to dispatch device control).
- **Fridge tablet** runs **Fully Kiosk** pointed at **`https://192.168.1.<113>/`** (Caddy) — the
  daily-use surface, laptop-off-safe.
- **Dashboard `kitchen.html`** = the management surface (bulk product entry with a keyboard beats
  on-tablet typing). It calls the LXC service cross-origin like `email.html` does (so no
  `server.js` business logic — architecture-safe). ⚠ **Management needs the laptop on** (the
  dashboard is laptop-hosted); the **tablet's daily use works laptop-off**. Conscious split.

## Data model (LXC 102, migration `KITCHEN_SMART_TABLET/migrations/001_kitchen.sql`)
v1 tables (Core buy-list) — the rest land in later phases:
- **`kitchen_products`** — the catalog: `id, name (Hebrew), name_en, category
  (dairy/produce/meat/bakery/pantry/frozen/beverage…), emoji, photo_path (nullable — cached
  locally, NOT a live OFF URL), unit (piece/kg/L/pack), price, calories_per_unit,
  nutri_score (A–E from OFF, nullable), health_score (manual 1–5 override, nullable),
  daily_serving, allergens jsonb, barcode, qty_on_hand, low_stock_threshold, expiry_at, notes,
  active, sort_order, created_at, updated_at`. *(forever + 🔒 protected)*
  - **Health rating = one consistent field:** store OFF's **Nutri-Score (A–E)** when the barcode
    resolves it, with a **manual `health_score` 1–5 override**; the Pantry Health Score aggregates
    whichever is set.
  - **Photos:** v1 = **emoji only**. If photos are added later, **download + cache to LXC 113 disk**
    (or QNAP like Medical docs) — never render a live OFF image URL (offline-fragile).
- **`kitchen_shopping_lists`** — `id, name, store, active, created_at, closed_at`.
- **`kitchen_shopping_items`** — `list_id FK, product_id FK (nullable), free_text, qty, checked,
  added_at, checked_at`. *(Concurrent fridge+phone edits → append-based writes; a single `active`
  list is the shared target.)*

Later-phase tables + columns (for the borrowed features):
- **`kitchen_products`** gains: `location` (fridge/freezer/pantry/shelf), `is_opened` + `opened_at`
  (opened = shorter shelf life), `min_stock` (par level → auto-add), `qty_unit_buy` / `qty_unit_consume`
  + `unit_factor` (pack↔piece conversion), `aisle` / `store_section` (aisle-ordered lists).
- **`kitchen_purchase_log`** — price history + last-bought (fed by receipts). *(retention: forever.)*
- **`kitchen_consumption_log`** — who ate what (`user_id FK household_users`) → Personal Health
  calories. *(retention: forever; **default household member + quick override** on the shared kiosk,
  never a forced per-tap picker.)*
- **`kitchen_receipts`** / **`kitchen_receipt_items`** — imported bills (email/camera), parsed
  line-items → review/confirm → purchase log + stock/price updates. *(retention: 365 d — images/PDFs
  are bulky; the derived purchase rows are the permanent record.)*
- **`kitchen_waste_log`** — thrown-away items (`product_id, qty, reason (expired/spoiled/other),
  cost, wasted_at`) → waste/cost insight + the Pantry Health Score.
- **`kitchen_staples`** — regular-staples template rows (one-tap weekly-basics → new list).
- **`kitchen_batches`** *(optional, FEFO)* — per-purchase lots of the same product with their own
  expiry, consumed first-expires-first-out.

Register all tables in Health **DB-Volumes** (`DBV_GROUPS`, new "Kitchen" group) + **retention_policies**
(catalog = forever + protected; logs per the notes above).

## v1 build (Core buy-list) — what ships first
1. **LXC ~113 "kitchen"** — new Debian LXC; `kitchen_service.py` serves PWA + CRUD API → Postgres,
   **behind Caddy (internal-CA HTTPS)** so the barcode camera works.
2. **DB migration 001** — `kitchen_products`, `kitchen_shopping_lists`, `kitchen_shopping_items`.
3. **Tablet PWA** — Hebrew-RTL **tile grid** (emoji + name + optional stock badge) +
   **🛒 Buy mode** (tap → +1 to the active shopping list) + **ℹ️ Browse mode** (tap → product
   detail card + inline edit) + **Shopping List screen** with **🔖 barcode add** (in-browser
   BarcodeDetector/ZXing decode → Open Food Facts lookup, manual-add fallback when not found) +
   a **QR-of-the-list** to hand off to a phone. *(No WhatsApp button on the shared kiosk.)*
4. **Dashboard `kitchen.html`** — **Products** CRUD tab (add/edit params + barcode lookup +
   Hebrew name) + **Shopping Lists** tab **with the 📲 Send-to-WhatsApp (`wa.me`)** button (this is
   where a real WhatsApp account lives).
5. **Deploy** — Fully Kiosk on the fridge tablet → the **HTTPS** LXC URL (ignore-cert on).

## Phases
- **P1** — DB + `kitchen_service.py` (+ Caddy HTTPS) + dashboard **Products** CRUD. *(no tablet yet)*
- **P2** — PWA tile grid + **Buy mode** + shopping list + **barcode add** + **WhatsApp send from
  dashboard/phone** + QR-to-phone on the tablet. *(= v1 Core buy-list; everything below is later.)*
- **P3 — Inventory:** Use mode + stock + purchase/consumption logs, plus the borrowed inventory
  features → **min-stock par levels per product → auto-add to the buy list** (precise version of
  "low-stock"), **product location** (fridge/freezer/pantry/shelf), **opened-vs-unopened** (opened =
  shorter shelf life), **quantity-unit conversion** (buy by pack, consume by piece).
- **P4 — List UX (borrowed):** **aisle / store-section-ordered shopping list** (big in-store win),
  **"already in stock" flag** while adding a product (prevents duplicate buys), **regular-staples
  templates** (one-tap weekly basics onto a new list), **color-coded expiry alerts** (matches the
  project's color-band UI pattern, e.g. Privacy appointments).
- **P5 — Receipt import** — the **hardest, least-reliable phase**. Start **email-only** (digital
  receipts, per-store line-item parser — note the Email agent's `pdf-text` endpoint is built for
  single-*total* receipts, so grocery multi-line parsing is new work). **Camera Tesseract OCR +
  Hebrew pack is best-effort** (thermal receipts scan poorly) behind a **review/confirm** screen
  that never writes unconfirmed.
- **P6 — Integrations:** **Personal Health calories** (`ph_*`, per `household_users`), **Privacy
  Budget** price history, **expiry → reminders/Notifications**, **allergen/health cross-check** vs a
  member's stored conditions/allergies, plus **waste log + "Pantry Health Score"** (a single
  pantry-quality metric that reuses each product's Nutri-/health-score).
- **P7 — Fully Kiosk deploy** on the fridge tablet.
- **Optional later:** **meal-planning calendar → auto-generate a shopping list from planned meals**
  (its own sub-system) + recipes / "what can I make" from on-hand stock; **batch/lot tracking +
  FEFO** (first-expires-first-out consume); Meta WhatsApp Cloud API (automated send); voice add
  ("add milk") via LXC 106; visual product recognition (CLIP-enroll self-hosted, or LLM-vision
  cloud); AI weekly-planning cycle (cloud LLM).

## Landscape & borrowed features (researched 2026-08-21)
This is a mature category — the core design (tile tap-to-add lists, barcode → Open Food Facts,
expiry tracking, min-stock → auto-list, receipt/nutrition, notifications) matches how the reference
apps do it, so the plan is on-target. Features borrowed into P3–P6 above come from studying:
- **[Grocy](https://grocy.info/)** — the open-source self-hosted "ERP beyond your fridge" (the
  closest analog): min-stock → auto shopping list, aisle-ordered lists, product location,
  opened-vs-unopened, quantity-unit conversion, batch/FEFO, recipes/meal-plan, Open Food Facts barcodes.
- **KitchenPal / Pantryfy / FoodiePrep** — barcode + household sync, "flag items already in stock"
  (no dup buys), auto-list when you run out, meal-plan → list loop.
- **NoWaste / Eatvora** — expiry-first design, **color-coded expiry alerts**, **Pantry Health Score**,
  waste reduction.

Deliberately NOT borrowed: Grocy's chores/batteries modules (out of scope — this is food only).

## Tooling / trust notes
- **Open Food Facts** (barcode → product data): free, open, French/global nonprofit — **not a
  Chinese service**, passes [[feedback_no_chinese_tools]]. ⚠ **partial Israeli coverage** → many
  local products won't resolve; manual add is first-class.
- **Barcode:** the **decode** runs **in-browser** (BarcodeDetector API / ZXing — no cloud). The
  subsequent **product-data lookup IS an outbound cloud GET to OFF** → cache results locally.
  Camera needs **HTTPS** (see serving decision).
- **Receipt OCR** = **Tesseract self-hosted** + Hebrew (`heb`) language pack (private, non-Chinese);
  thermal-receipt accuracy is imperfect → always a human review/confirm step (best-effort).
- **WhatsApp** = `wa.me` link (no third-party relay) **from the phone/dashboard, not the kiosk**;
  if automated later, Meta Cloud API (non-Chinese).

## Integrations with existing systems
`household_users` (who eats) · `ph_*` (Personal Health calories) · Privacy Budget (spend) · Email
Agent LXC 110 (receipt email) · reminders-badge / Notifications (expiry, low-stock) · Voice LXC 106
(optional) · Health DB-Volumes + retention (`protected` on the catalog).

## Prerequisites before P1
- **Proxmox host access** to create LXC ~113 (+ verify a **free IP AND set a DHCP reservation** —
  the /24 is DHCP-saturated, so verify via ARP + `net_devices` like the robot LXC did for `.249`;
  add to Project Health System Status + a backup job — the standard new-LXC treatment).
- **Internal-CA cert / Caddy** for HTTPS (reuse the Privacy LXC 109 pattern) — required for the
  barcode camera.
- **Tablet hardware + fridge mount** confirmed.

## Audit revisions folded in (2026-08-21)
Side-to-side audit against the live project changed the plan in these ways (see git history):
1. **HTTPS is mandatory** (camera secure-context) — added Caddy/internal-CA serving; the "plain-HTTP
   like balcony" deploy was wrong (balcony never uses the camera).
2. **WhatsApp moved off the shared fridge kiosk** → dashboard/phone + a QR-to-phone on the tablet
   (the kiosk has no WhatsApp account and blocks app-switching).
3. **OFF Israeli coverage is partial** → manual add is first-class; barcode only pre-fills.
4. **Receipt import re-scoped** email-first + camera OCR best-effort (the Email `pdf-text` endpoint
   is single-total, so grocery line-parsing is new work; Hebrew thermal OCR is unreliable).
5. **Photo storage** = emoji v1, cache-locally if added (never live OFF URLs).
6. **Health rating** = OFF Nutri-Score (A–E) + manual 1–5 override, one consistent field.
7. **Free IP + DHCP reservation**, verify next-free LXC id; **per-table retention** set; **shared-
   kiosk "who ate" default** + **append-based concurrent list writes**; **management-needs-laptop**
   split made explicit.

## Related
- Sibling: [BALCONY_SMART_TABLET](../BALCONY_SMART_TABLET/CLAUDE.md) — the device-control tablet this
  is modeled on ([[project_balcony_smart_tablet]]).
- [EMAIL](../EMAIL/CLAUDE.md) — receipt-email path (LXC 110 + `/create-email-rule` pattern).
- Personal Health ([PERSONAL_HEALTH](../PERSONAL_HEALTH/CLAUDE.md)) — calorie/allergen integration.
- [PRIVACY](../PRIVACY/CLAUDE.md) — Caddy internal-CA HTTPS pattern (LXC 109) reused here for the camera.
