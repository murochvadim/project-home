-- KITCHEN_SMART_TABLET v1 — managed Hebrew categories (drive tablet page/section order).
-- Applied: scp to LXC 104 -> psql -h 192.168.1.219 -U postgres -d home_data (trust auth).
-- Re-runnable (IF NOT EXISTS / WHERE NOT EXISTS / idempotent UPDATEs).

-- ── Category set: Hebrew name + emoji + sort_order (= tablet page order) ──────
CREATE TABLE IF NOT EXISTS kitchen_categories (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,               -- Hebrew display name
    emoji       TEXT,
    sort_order  INTEGER DEFAULT 0,           -- order on the fridge tablet (pages/sections)
    active      BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kitchen_categories_active ON kitchen_categories(active, sort_order);

-- ── Products point at a category by id (rename-safe; grouping on the tablet) ──
ALTER TABLE kitchen_products ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES kitchen_categories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_kitchen_products_category_id ON kitchen_products(category_id);

-- ── Seed the Hebrew categories (map of the English seed classes) ─────────────
INSERT INTO kitchen_categories (name, emoji, sort_order)
SELECT v.name, v.emoji, v.so FROM (VALUES
  ('פירות וירקות', '🥦', 1),
  ('מוצרי חלב',    '🧀', 2),
  ('מאפים',        '🍞', 3),
  ('בשר ודגים',    '🥩', 4),
  ('מזווה',        '🥫', 5),
  ('משקאות',       '🥤', 6),
  ('קפואים',       '🧊', 7),
  ('חטיפים',       '🍫', 8)
) AS v(name, emoji, so)
WHERE NOT EXISTS (SELECT 1 FROM kitchen_categories c WHERE c.name = v.name);

-- ── Migrate each product's English category text -> the Hebrew category id ───
UPDATE kitchen_products p SET category_id = c.id
FROM kitchen_categories c
WHERE c.name = CASE p.category
    WHEN 'produce'  THEN 'פירות וירקות'
    WHEN 'dairy'    THEN 'מוצרי חלב'
    WHEN 'bakery'   THEN 'מאפים'
    WHEN 'meat'     THEN 'בשר ודגים'
    WHEN 'pantry'   THEN 'מזווה'
    WHEN 'beverage' THEN 'משקאות'
    WHEN 'frozen'   THEN 'קפואים'
    WHEN 'snack'    THEN 'חטיפים'
    ELSE NULL END
  AND p.category_id IS DISTINCT FROM c.id;

-- Backfill the legacy text column to Hebrew so nothing shows English (UI uses category_id).
UPDATE kitchen_products p SET category = c.name
FROM kitchen_categories c WHERE p.category_id = c.id AND p.category <> c.name;

-- ── Retention (forever + protected, like the catalog) ───────────────────────
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected) VALUES
  ('kitchen_categories', NULL, false, 24, 'Kitchen categories — keep forever', true)
ON CONFLICT (table_name) DO NOTHING;
