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
- **PWA** (`kitchen/` served same-origin by the service at `http://192.168.1.208:8772/`): **redesigned
  circle UI** (2026-08-27) — bobbing **category circles** on home; tap → that category centred with its
  products **orbiting** in slow concentric rings; tap a product → a right-side panel with amount circles
  (קצת/בינוני/הרבה/הרבה מעוד) + stock + a black **ברשימה** −1 circle; a floating black **רשימה** circle
  (top-left) opens the shopping-list screen (per-product −/+ unit-aware, remove, total, 🗑 נקה הכל). Tech
  Settings (idle-return / panel-return / blink). Barcode-decode code present (camera test = home).
  manifest = fullscreen PWA.
- **Product PHOTOS** (2026-08-28) — a product tile shows a **real photo** (round-cropped) instead of its
  emoji when set; **emoji stays the fallback**. Photos are **imported + cropped on the dashboard** (file
  pick — the phone photo moved to the laptop — square **crop + zoom + pan** canvas editor → one 400×400
  JPEG; no live camera, so no HTTPS/secure-context needed). Stored on **LXC 113's own disk**
  (`/opt/kitchen/product_media/<id>.jpg`, one file per product, replace-in-place) via
  `POST/DELETE /api/kitchen/products/<id>/photo` (multipart; 2 MB + image-mimetype guards); served by
  `GET /media/<file>` with `Cache-Control: max-age=300` (a route BEFORE the no-cache PWA catch-all),
  cache-busted by `?v=<updated_at>`. The `kitchen_products.photo_path` column already existed → **no
  migration**. Shown on both the fridge PWA (orbit circle + product panel + list rows — the circles are
  already `overflow:hidden;border-radius:50%` so they round-crop for free) and every dashboard table.
  Editor = hand-rolled `<canvas>` (the `medical.js` crop pattern; no vendored crop lib). product_media is
  covered by 113's existing vzdump + off-site guest backup (no extra step).
- **Dashboard Kitchen Agent page** (`BOILER/dashboard/public/kitchen.html` + `js/kitchen.js`, sidebar
  under **Agents**), **6 tabs** (order: **🍎 Products · 🧾 Common list · 📦 Stock list · 🧺 Shopping List**
  ⟶gap⟶ **⚙ Settings · 🏷 Categories**): **Products** CRUD (Hebrew name/emoji/**📷 photo**/**category
  dropdown**/price) + **Common list** (per-product weekly-staple `common_qty` −/+ in its unit, grouped by
  category, like Stock but no low threshold; column `kitchen_products.common_qty`, migration
  `007_common.sql`, `POST /api/kitchen/common`) + **Stock list** (per-product `qty_on_hand` −/+ + low
  threshold, grouped by category, **"Check missing"** → adds at/below-threshold items to the list) +
  **Shopping List** (per-item **−/+ buy qty in the unit** + a **stock chip** (red when low); add **bumps
  qty** not duplicates, qty 0 removes; **📲 WhatsApp** text includes qty+unit; 🗑 clear via the PWA) +
  **Settings** (Tech Settings — idle/panel/blink) + **Categories** (add/rename/delete + **▲▼ reorder** =
  tablet page order, live counts). English-name field dropped (Hebrew-only UI); Products Name column
  centered. Unit-aware step (kg/L = 0.5, else 1). Calls LXC 113 directly (`http://192.168.1.208:8772`)
  — architecture-guard safe (no server.js business logic). `agents` table row + orchestrator SSH key
  authorized on 113 so the Health Services check passes.

**Product on-shelf SEASON (setting-only, 2026-08-29):** every product carries a **season** in the
Products form — a **"כל השנה / Always" checkbox** (default) + **From-month → To-month** dropdowns (Hebrew
months, enabled only when Always is unchecked). Stored in `kitchen_products.season_all_year` (BOOLEAN
DEFAULT true) + `season_start_month` / `season_end_month` (SMALLINT 1–12), migration `008_season.sql`;
`start>end` wraps year-end (e.g. Nov→Feb). Threaded through `products_upsert` (months NULL when Always).
**Display = a "Season" COLUMN on the Products table** (added 2026-08-29) — for a product WITH a season
set it shows **בעונה** (green) when today's month is in the window / **לא בעונה** (grey) when not (month
range as a tooltip); **Always products show nothing** in the column. Computed client-side from the
current month (`inSeason`/`seasonCell` in `js/kitchen.js`). No word on the fridge tiles or other lists —
Products column only. Pre-seeded seasons: **אבוקדו** (id 7) Nov–Apr, **תותים** (id 39) Dec–Apr; all
other 36 products left Always (year-round in Israel). Form JS: `kSeasonToggle` + `editProduct`/
`kResetForm`/`kSaveProduct`.

**Remaining:** Caddy internal-CA HTTPS (needed for the barcode camera secure context) + Fully Kiosk on
the fridge tablet + real barcode camera test + install the Caddy root CA on the tablet — all **home
steps**. **Step 7 DONE 2026-08-27:** `svc-lxc113` Health cell (server.js `tcpCheck` + `health.js`) +
**full backup** — on-site PVE vzdump (`QNAP_KITCHEN_Backup` → `/PBS_Data/KITCHEN_Data`, 05:25, keep-daily=4)
+ off-site (`113` in `guests-cloud-backup.sh` GUESTS → gpg→Drive `Guest_Images/113/`), verified end-to-end.

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
  - **Photos:** IMPLEMENTED 2026-08-28 (see "Product PHOTOS" above) — `photo_path` = a filename served
    from LXC 113's own disk (`/media/<id>.jpg`), imported+cropped on the dashboard; emoji is the
    fallback. Never a live OFF image URL (offline-fragile), as planned.
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

## 🖨 Shopping-list printer — Phomemo M08F (decided 2026-09-02, not yet wired)

An **A4 thermal printer** (no ink, no toner) so the buy-list can leave the fridge as paper.

**Hardware (from Phomemo's own page):** A4 thermal sheets **210 × 297 mm** ("A4 Thermal Paper Quick
Dry", Letter version also sold) · **203 dpi** · **USB-C + Bluetooth** · 1200 mAh ≈ **140 pages** per
charge. Sold as Phomemo / COLORWING / AIMO — same device.

**Paper to buy:** A4 **thermal** sheets (NOT plain paper — there is no ink; the head burns the
coating). Third-party A4 thermal packs fit. Prefer **BPA/BPS-free** for a kitchen, and "long-life"
coating if a list ever needs to survive.
⚠ **Thermal fades** — months to a couple of years, faster in heat and sunlight. Fine for a shopping
list; never use it for anything that must be kept (those belong in the Privacy docs vault).

**How to drive it — CUPS, not raw Bluetooth.**
1. Plug it in by **USB** and add a CUPS queue:
   `sudo lpadmin -p M08F -v 'usb://Phomemo/M08F' -P M08F.ppd -E` → then anything can `lp -d M08F`.
2. Share that queue on the LAN so any LXC or the dashboard can print, with no protocol code at all.
3. Raw **ESC/POS over Bluetooth** exists as a fallback (reverse-engineered from the Android app —
   `vivier/phomemo-tools`), but only if CUPS disappoints.
⚠ Both the community `rastertoM08F` filter and Phomemo's own Linux driver are **binary, no source**;
and the printer feeds **full A4 lengths only** (a 5-line list still ejects a whole page).

**First use:** a **🧾 Print** button on the Kitchen page / fridge PWA → the active buy-list as A4.
Later candidates: the daily journal summary, reminders, a medical document for an appointment.

**Open before building:** which machine hosts it (the mini PC, next to the two camera extenders, is
the natural choice), and USB vs Bluetooth. Also **which variant it is** — the M08F ships as
**A4** (210x297) or **Letter** (216x279); measure a sheet. Buy **A4** paper (Letter is a nuisance to
restock in Israel): Phomemo folded/Z-fold A4 packs, Amazon `B0CL4B2Q8P` (200 sheets) or `B0C4N6SV2L`
(100). ⚠ avoid `B0CR1LLBXH` — its title says A4 but it also claims "M08F-Letter" compatibility.

### ⚠ What we can and cannot control — TEST THESE FIRST (2026-09-02, unverified)
Printing itself is fully ours: as a CUPS queue any service can print any PDF/image, and we render the
page, so layout / Hebrew / barcodes are ours to decide. Device management is NOT:

| | |
|---|---|
| full control | what is printed, and when |
| partial | darkness / speed / feed — only what the binary driver exposes |
| probably not | battery level, sleep state, paper-out (the phone app reads battery over BT; USB likely won't) |
| no | power on/off — physical button |

⚠ **It is a battery-powered PORTABLE printer, so it is not a server printer by default.** A "print the
list" button only works if it is awake and powered, and a sleeping printer may fail **silently**.
**Three tests to run the day it is connected — do not build the button before these pass:**
1. On permanent USB power, does it stay reachable, or sleep so deep CUPS cannot wake it?
2. Does an incoming job **wake** it, or does it need a physical button press first?
3. With **no paper loaded**, does the job error visibly in CUPS, or vanish silently?

The answers decide whether the Kitchen gets a plain 🧾 Print button or a button plus a
"check the printer" warning when a job is not confirmed.

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

## Recipes (מתכונים) — STEP 1: recipe categories (BUILT 2026-09-03)

First slice of the Recipes feature. **Dashboard only — the fridge tablet is untouched.**

The end shape (later steps): a **מתכונים circle of its own** beside רשימה on the tablet → tap it and the
**recipe categories fly like the food categories** → tap one for its recipes → tap a recipe for its
products, each with a **+** that puts it on the shopping list at the required amount (recipe units,
converted to the product's purchase unit).

**Step 1 delivers only the place to create those categories:**
- **`kitchen_recipe_categories`** (migration `009_recipe_categories.sql`) — `id, name (Hebrew), emoji,
  sort_order, active, created_at, updated_at`; retention **forever + 🔒 protected**; registered in
  Health DB-Volumes under **Kitchen** (`DBV_GROUPS` server.js:2403 + the `tsCol` literal at :2440).
- ⚠ **Deliberately its OWN table, not a `kind` column on `kitchen_categories`:** the fridge home screen
  draws a circle for **every** row of `kitchen_categories` (`circleList()` in `kitchen/kitchen.js`), so
  recipe categories living there would appear among the food. A separate table cannot leak — verified
  after the build (tablet still shows exactly its 10 food categories).
- **4 endpoints** on LXC 113, mirroring the product-category ones: `GET /api/kitchen/recipe-categories`
  (`?all=1` includes inactive) · `POST` upsert · `POST /delete` (**soft**, `active=false`) ·
  `POST /reorder` (`{order:[ids]}` → `sort_order = i+1`).
- **Dashboard 📖 Recipes tab.** Tab order (set 2026-09-03): `🍎 Products · 🧾 Common · 📦 Stock · 🧺 Shopping List · 🏷 Categories` ⟶gap⟶ `📖 Recipes` ⟶⟶ `⚙ Settings` — a 40 px gap on the **Recipes** button and a further **200 px** on **Settings** (both inline `margin-left` styles). ⚠ `.k-tabs` is `display:flex` with **no wrap**, so a narrow browser window will push the row past the edge; switch Settings to `margin-left:auto` if that ever matters. Form + table with ▲▼ reorder and delete — a
  copy of the 🏷 Categories tab, `rc-` element ids, functions `loadRecipeCats` / `renderRecipeCats` /
  `kSaveRecipeCat` / `kResetRecipeCatForm` / `delRecipeCat` / `moveRecipeCat` in `js/kitchen.js`.
  No "Recipes" count column yet — there are no recipes, so it could only print 0.
- **⚙ Settings → "Recipe Settings"** sub-tab (`#sub-recipe`, `kSub('recipe')`) — **wired and empty on
  purpose**: its contents aren't decided yet. **Tech Settings stays shared** and governs the recipe
  screens too, so there are **no new settings keys** — the later tablet step must reuse
  `idle_return_sec` / `panel_return_sec` / `blink_count`.

⚠ **Deploy gotchas (both caught by re-auditing the plan, both real):** `kitchen.html` loads
`js/kitchen.js?v=N` — **bump it** (45→46 here) or the browser serves the old JS; and because this
touches `server.js`, the dashboard needs **`pm2 delete boiler-dashboard && pm2 start ecosystem.config.js`**
(never `pm2 restart`).

**Not built yet:** the מתכונים circle + flying recipe categories on the tablet, the recipes themselves,
products inside a recipe, amounts and unit conversion. **Open question for the next step:** can one
recipe belong to more than one category (a column vs a join table)?

## Recipes — STEP 2: the מתכונים circle on the tablet (BUILT 2026-09-03)

The recipe categories from step 1 now appear on the fridge. **Tablet-only — no backend work at all**
(step 1's `GET /api/kitchen/recipe-categories` already served everything needed).

- **`#recipebtn`** — a second floating circle, an exact copy of `#listbtn` at `top:222px`
  (74 + 132 + 16 gap), label **מתכונים** only (**no count** — never asked for; a category count
  isn't actionable the way the list's item count is).
- **`buildBobGrid(items, onPick, emptyMsg)`** — the bob-in-place grid **extracted from `buildHome`**
  and now shared by the food home and the מתכונים screen, so the two move identically **by
  construction** rather than by copy-paste. ⚠ Verified behaviour-preserving by rendering `buildHome`
  before and after the extraction: **HTML byte-identical**. (Circle positions differ between any two
  renders because the bob phase is `Math.random()` by design — `kitchen.js:91-92` — so compare the
  HTML, not the coordinates.)
- **`mode`** gains `recipes` + `recipe-cat`; `rebuild()` (rotate/resize), `goIdleHome()` and the 30 s
  poll all handle them. The poll re-fetches the recipe categories only while those screens are open,
  and redraws only when the set actually changed (same signature trick the home screen uses).
- **`goBack()`** replaces `showHome()` on `#backbtn`: recipe-category → מתכונים → food home,
  one level at a time (a product category still goes straight home, unchanged).
- Recipe categories are fetched **lazily on open**, never at boot — the fridge home must not wait.
- Tapping a category shows the category circle + "no recipes in this category" — recipes are step 3.

⚠ **Deploy: `scp` the `kitchen/` folder only — NO `systemctl restart`.** Those files are read from
disk per request (`send_from_directory` + `_nocache`, `kitchen_service.py:107`); the browser cache is
defeated by the bumps `kitchen.css?v=50` / `kitchen.js?v=34` in `index.html`.

## Recipes — STEP 3: import a recipe from a site, by name (BUILT 2026-09-03)

Pick a site → type a recipe name → a window shows **every ingredient in a table** → the ones missing
from your products are flagged with a **product dropdown** → save it under a recipe category.

- **Tables** (migration `010_recipes.sql`, all forever + 🔒): `kitchen_recipes` (category FK, name,
  instructions, **`source_url` UNIQUE** — what stops a recipe being imported twice),
  `kitchen_recipe_items` (**`raw_line` kept** so a bad parse is fixable without re-fetching, plus
  qty / unit / parsed_name / product FK), and **`kitchen_ingredient_aliases`** (learned
  ingredient→product mappings, so a manual choice is **never asked twice**).
- **All the import logic is on LXC 113** (`kitchen_service.py`), never in `server.js`:
  `/recipe-sites` (GET/POST) · `/recipe-search` · `/recipe-parse` · `/recipes` (GET/POST/`/delete`,
  **409 `already_imported`** on a duplicate URL) · `/ingredient-aliases`. Site **adapters** — a second
  site is a new adapter, not a rewrite.
- **nikib.co.il adapter:** it is WordPress, so **search-by-name is its own REST API**
  (`/wp-json/wp/v2/posts?search=`) — no scraping of search pages. There is **no schema.org Recipe**
  data, so ingredients come from the theme markup: `#ingredients` → `<p>` blocks with `<br>`-separated
  lines and `<strong>` sub-groups; steps are the numbered `<p>`s after the ad slot. Verified by walking
  the div to its matching close: **1 title + 2 groups + 21 ingredients, nothing missed**.
- **Hebrew normaliser** turns `2 תפוחי אדמה בינוניים מגורדים וסחוטים` into qty **2** + product
  **תפוחי אדמה**: leading number or Hebrew fraction (חצי/שליש/רבע), unit list, then drop-words and
  preparation clauses. ⚠ A leading **vav** (ורכות = "and soft") hides a word from the drop list — it is
  stripped before matching.
- **Matching order:** exact product name → learned alias → normalised contains → unmatched. Every row
  reports **how** it matched, and the UI gives a dropdown to **both** `none` **and** `fuzzy` rows — a
  wrong guess must be as easy to fix as a blank (live: עגבניות fuzzy-matched עגבניות שרי).
- ⚠ **`requests` decoded the page as ISO-8859-1** because it sends no charset header — every Hebrew word
  came back mojibake, which ALSO broke unit-stripping and made all 21 rows look unmatched.
  `_recipe_fetch` now decodes explicitly: header charset → `<meta charset>` → UTF-8.
  **Never use `r.text` on these pages.**
- **Politeness, in code:** one page per explicit user action (never a crawl), honest `User-Agent`, a
  2 s per-site gap. The site's `robots.txt` allows ordinary clients but sets `ai-train=no`,
  `use=reference`, blocks every named AI crawler (ClaudeBot included) and reserves EU copyright —
  imports stay private, are never republished, and are never used for training.
- **UI:** ⬇ Import from site on the 📖 Recipes tab (search → hits → ingredient table → steps →
  category → Save) plus the recipes list; **⚙ Settings → Recipe Settings** now holds the **site list**
  (that tab was wired-and-empty since step 1). Cache-bust `js/kitchen.js?v=47`.

Verified live end-to-end: search → 8 hits; parse → 21 items / 8 steps; matching → 4 exact + 1 fuzzy +
16 missing; alias learned → the same row re-parsed as `alias`; saved under דגים with 21 items and
1899 chars of instructions; **re-saving the same URL returned 409**; deleting the recipe cascaded its
21 items away. Test rows then removed — the tables are empty and the tablet is unchanged.

**Not built yet:** recipes on the tablet (category screens still say "no recipes yet"), the **+**
button, and recipe-unit → purchase-unit conversion. This step stores כף/כפית/צרור as parsed, which is
exactly what that conversion will consume.
