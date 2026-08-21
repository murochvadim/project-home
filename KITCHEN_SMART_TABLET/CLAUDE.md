# KITCHEN_SMART_TABLET — Fridge Food/Shopping Tablet

**STATUS: PLANNED (scoped 2026-08-21). Nothing built yet — plan only.**

A tablet magnet-mounted on the fridge running a **PWA** whose tiles are **food products**
(🍎 apple, 🧀 cheese…) instead of device switches — a food-shaped sibling of the
[Balcony Smart Tablet](../BALCONY_SMART_TABLET/CLAUDE.md). Tap a product to add it to a
shopping list, log that you used it, or view its nutrition/price card. Each product carries
DB params (price, calories, last-bought, health rating, daily serving, allergens, stock…).
Managed from both the tablet and a dashboard **Kitchen** page.

Closes the full loop: **build buy-list → send to WhatsApp → shop → import the receipt →
inventory + prices auto-update.**

## Locked decisions (2026-08-21)
- **Laptop-independent** → LXC-hosted PWA, exactly like the Balcony Smart Tablet (the dashboard
  is firewall-blocked + laptop-dependent; a fridge appliance must survive laptop-off).
- **Host = a NEW dedicated LXC ~113 "kitchen"** (verify a free IP + provision like FR/Email did).
  Chosen over reusing LXC 100 because this is a growing data+service app (catalog, receipts,
  OCR, barcode lookups, nutrition + budget/PH integrations) — it belongs off the media box, the
  same way Email got LXC 110 and Privacy got 109, not bolted onto the tiny read-only
  `panel_service` tablet-host on LXC 100. ⚠ LXC 112 is reserved for the FR backend, so kitchen ≈ 113.
- **Add-by-camera = BARCODE only** (in-browser scan → Open Food Facts). Visual/AI product
  recognition is **parked** (too hard for arbitrary groceries — thousands of look-alike SKUs +
  loose produce; a future optional CLIP-enroll or LLM-vision fallback if ever wanted).
- **WhatsApp send = `wa.me` share-link** for v1 (opens WhatsApp with the list pre-filled → user
  picks the contact/family group + sends; zero infra, zero API keys, zero trust risk). Meta
  WhatsApp Cloud API (official, non-Chinese) is an optional later phase for automated sending.
- **Language:** Hebrew product names (RTL tiles) + English UI/menus/dashboard.
- **v1 scope = Core buy-list** (below). Stock/consumption/receipts/integrations are later phases.

## Architecture
- **`kitchen_service.py`** (Flask) on **LXC ~113** — serves the PWA static files **and** the CRUD
  API, talking directly to Postgres on LXC 102. Laptop-independent; mirrors `panel_service.py` /
  `bobo_game_service.py` but with a full write API like the Email agent's Flask app.
- **No MQTT / no rule engine / no broker changes** — the kitchen tablet controls nothing, it's
  pure data CRUD. Plain HTTP (GET catalog / POST buy-list actions), polling for multi-user sync.
  This is the deliberate simplification vs the Balcony tablet (which needs MQTT-WS + the
  `panel_commands` rule to dispatch device control).
- **Fridge tablet** runs **Fully Kiosk** pointed at `http://192.168.1.<113>:<port>/` — same deploy
  as the Balcony tablet.
- **Dashboard `kitchen.html`** = the management surface (bulk product entry with a keyboard beats
  on-tablet typing). It calls the LXC service cross-origin like `email.html` does (so no
  `server.js` business logic — architecture-safe).

## Data model (LXC 102, migration `KITCHEN_SMART_TABLET/migrations/001_kitchen.sql`)
v1 tables (Core buy-list) — the rest land in later phases:
- **`kitchen_products`** — the catalog: `id, name (Hebrew), name_en, category
  (dairy/produce/meat/bakery/pantry/frozen/beverage…), emoji|photo, unit (piece/kg/L/pack),
  price, calories_per_unit, health_score (1–5 / Nutri-Score A–E), daily_serving, allergens jsonb,
  barcode, qty_on_hand, low_stock_threshold, expiry_at, notes, active, sort_order, created_at,
  updated_at`. *(forever + 🔒 protected)*
- **`kitchen_shopping_lists`** — `id, name, store, active, created_at, closed_at`.
- **`kitchen_shopping_items`** — `list_id FK, product_id FK (nullable), free_text, qty, checked,
  added_at, checked_at`.

Later-phase tables + columns (for the borrowed features):
- **`kitchen_products`** gains: `location` (fridge/freezer/pantry/shelf), `is_opened` + `opened_at`
  (opened = shorter shelf life), `min_stock` (par level → auto-add), `qty_unit_buy` / `qty_unit_consume`
  + `unit_factor` (pack↔piece conversion), `aisle` / `store_section` (aisle-ordered lists).
- **`kitchen_purchase_log`** — price history + last-bought (fed by receipts).
- **`kitchen_consumption_log`** — who ate what (`user_id FK household_users`) → Personal Health calories.
- **`kitchen_receipts`** / **`kitchen_receipt_items`** — imported bills (email/camera), parsed
  line-items → review/confirm → purchase log + stock/price updates.
- **`kitchen_waste_log`** — thrown-away items (`product_id, qty, reason (expired/spoiled/other),
  cost, wasted_at`) → waste/cost insight + the Pantry Health Score.
- **`kitchen_staples`** — regular-staples template rows (one-tap weekly-basics → new list).
- **`kitchen_batches`** *(optional, FEFO)* — per-purchase lots of the same product with their own
  expiry, consumed first-expires-first-out.

Register all tables in Health **DB-Volumes** (`DBV_GROUPS`) + **retention_policies** (catalog =
forever + protected).

## v1 build (Core buy-list) — what ships first
1. **LXC ~113 "kitchen"** — new Debian LXC; `kitchen_service.py` serves PWA + CRUD API → Postgres.
2. **DB migration 001** — `kitchen_products`, `kitchen_shopping_lists`, `kitchen_shopping_items`.
3. **Tablet PWA** — Hebrew-RTL **tile grid** (emoji/photo + name + optional stock badge) +
   **🛒 Buy mode** (tap → +1 to the active shopping list) + **ℹ️ Browse mode** (tap → product
   detail card + inline edit) + **Shopping List screen** with **📲 Send to WhatsApp (wa.me)** +
   **🔖 barcode add** (in-browser BarcodeDetector/ZXing → Open Food Facts autofill).
4. **Dashboard `kitchen.html`** — **Products** CRUD tab (add/edit params + barcode lookup +
   Hebrew name + photo) + **Shopping Lists** tab.
5. **Deploy** — Fully Kiosk on the fridge tablet → the LXC URL.

## Phases
- **P1** — DB + `kitchen_service.py` + dashboard **Products** CRUD. *(no tablet yet)*
- **P2** — PWA tile grid + **Buy mode** + shopping list + **WhatsApp send (wa.me)** + **barcode add**.
  *(= v1 Core buy-list; everything below is a later phase.)*
- **P3 — Inventory:** Use mode + stock + purchase/consumption logs, plus the borrowed inventory
  features → **min-stock par levels per product → auto-add to the buy list** (precise version of
  "low-stock"), **product location** (fridge/freezer/pantry/shelf), **opened-vs-unopened** (opened =
  shorter shelf life), **quantity-unit conversion** (buy by pack, consume by piece).
- **P4 — List UX (borrowed):** **aisle / store-section-ordered shopping list** (big in-store win),
  **"already in stock" flag** while adding a product (prevents duplicate buys), **regular-staples
  templates** (one-tap weekly basics onto a new list), **color-coded expiry alerts** (matches the
  project's color-band UI pattern, e.g. Privacy appointments).
- **P5 — Receipt import** (email line-item parser → camera **Tesseract** OCR + Hebrew pack, with a
  **review/confirm** screen; imperfect thermal-receipt OCR never writes unconfirmed).
- **P6 — Integrations:** **Personal Health calories** (`ph_*`, per `household_users`), **Privacy
  Budget** price history, **expiry → reminders/Notifications**, **allergen/health cross-check** vs a
  member's stored conditions/allergies, plus **waste log + "Pantry Health Score"** (a single
  pantry-quality metric that reuses each product's `health_score`).
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
  Chinese service**, passes [[feedback_no_chinese_tools]].
- **Barcode decode** runs **in-browser** (BarcodeDetector API / ZXing) — no cloud, no server.
- **Receipt OCR** = **Tesseract self-hosted** + Hebrew (`heb`) language pack (private, non-Chinese);
  thermal-receipt accuracy is imperfect → always a human review/confirm step.
- **WhatsApp** = `wa.me` link (no third-party relay); if automated later, Meta Cloud API (non-Chinese).

## Integrations with existing systems
`household_users` (who eats) · `ph_*` (Personal Health calories) · Privacy Budget (spend) · Email
Agent LXC 110 (receipt email) · reminders-badge / Notifications (expiry, low-stock) · Voice LXC 106
(optional) · Health DB-Volumes + retention (`protected` on the catalog).

## Prerequisites before P1
- **Proxmox host access** to create LXC ~113 (+ verify a free IP, add to Project Health System
  Status, add a backup job — the standard new-LXC treatment, like FR/Email/Privacy).
- **Tablet hardware + fridge mount** confirmed.

## Related
- Sibling: [BALCONY_SMART_TABLET](../BALCONY_SMART_TABLET/CLAUDE.md) — the device-control tablet this
  is modeled on ([[project_balcony_smart_tablet]]).
- [EMAIL](../EMAIL/CLAUDE.md) — receipt-email path (LXC 110 + `/create-email-rule` pattern).
- Personal Health ([PERSONAL_HEALTH](../PERSONAL_HEALTH/CLAUDE.md)) — calorie/allergen integration.
