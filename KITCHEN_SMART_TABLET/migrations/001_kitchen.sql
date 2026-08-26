-- KITCHEN_SMART_TABLET v1 — Core buy-list tables (LXC 102 home_data)
-- Applied: scp to LXC 104 -> psql -h 192.168.1.219 -U postgres -d home_data (trust auth, no password)
-- Retention: catalog = forever + protected; lists/items = forever (unprotected).

-- ── Catalog: one row per food product (tiles on the fridge PWA) ──────────────
CREATE TABLE IF NOT EXISTS kitchen_products (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,                 -- Hebrew display name (RTL tile)
    name_en             TEXT,
    category            TEXT,                          -- dairy/produce/meat/bakery/pantry/frozen/beverage
    emoji               TEXT,                          -- v1 tile art (no photos)
    photo_path          TEXT,                          -- later: cached-local path, never a live OFF URL
    unit                TEXT DEFAULT 'piece',          -- piece/kg/L/pack
    price               NUMERIC(10,2),
    calories_per_unit   NUMERIC(10,1),
    nutri_score         TEXT,                          -- A–E from Open Food Facts (nullable)
    health_score        SMALLINT,                      -- manual 1–5 override (nullable)
    daily_serving       TEXT,
    allergens           JSONB DEFAULT '[]'::jsonb,
    barcode             TEXT,
    qty_on_hand         NUMERIC(10,2) DEFAULT 0,
    low_stock_threshold NUMERIC(10,2),
    expiry_at           DATE,
    notes               TEXT,
    active              BOOLEAN DEFAULT true,
    sort_order          INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kitchen_products_active   ON kitchen_products(active, sort_order);
CREATE INDEX IF NOT EXISTS idx_kitchen_products_barcode  ON kitchen_products(barcode);
CREATE INDEX IF NOT EXISTS idx_kitchen_products_category ON kitchen_products(category);

-- ── Shopping lists (one active list is the shared buy-target) ────────────────
CREATE TABLE IF NOT EXISTS kitchen_shopping_lists (
    id          SERIAL PRIMARY KEY,
    name        TEXT DEFAULT 'Shopping',
    store       TEXT,
    active      BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT now(),
    closed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_kitchen_lists_active ON kitchen_shopping_lists(active);

-- ── Items on a list (append-based; fridge + phone edit concurrently) ─────────
CREATE TABLE IF NOT EXISTS kitchen_shopping_items (
    id          SERIAL PRIMARY KEY,
    list_id     INTEGER NOT NULL REFERENCES kitchen_shopping_lists(id) ON DELETE CASCADE,
    product_id  INTEGER REFERENCES kitchen_products(id) ON DELETE SET NULL,
    free_text   TEXT,                                  -- manual add without a catalog product
    qty         NUMERIC(10,2) DEFAULT 1,
    checked     BOOLEAN DEFAULT false,
    added_at    TIMESTAMPTZ DEFAULT now(),
    checked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_kitchen_items_list ON kitchen_shopping_items(list_id, checked);

-- ── Retention (catalog forever+protected; lists/items forever) ──────────────
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected) VALUES
  ('kitchen_products',       NULL, false, 24, 'Kitchen catalog — keep forever',       true),
  ('kitchen_shopping_lists', NULL, false, 24, 'Kitchen shopping lists — keep forever', false),
  ('kitchen_shopping_items', NULL, false, 24, 'Kitchen shopping items — keep forever', false)
ON CONFLICT (table_name) DO NOTHING;
