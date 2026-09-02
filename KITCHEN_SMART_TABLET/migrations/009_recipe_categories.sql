-- KITCHEN_SMART_TABLET — recipe categories (מרקים / סלטים / בשרים …), step 1 of the Recipes feature.
-- Applied: scp to LXC 104 -> psql -h 192.168.1.219 -U postgres -d home_data (trust auth).
-- Re-runnable (IF NOT EXISTS / ON CONFLICT DO NOTHING).
--
-- ⚠ Deliberately a SEPARATE table, not a `kind` column on kitchen_categories: the fridge home screen
--   builds its flying circles from EVERY row of kitchen_categories (circleList() in kitchen/kitchen.js),
--   so recipe categories living there would appear among the food circles on the tablet.

CREATE TABLE IF NOT EXISTS kitchen_recipe_categories (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,               -- Hebrew display name
    emoji       TEXT,
    sort_order  INTEGER DEFAULT 0,           -- order the recipe categories fly in on the tablet
    active      BOOLEAN DEFAULT true,        -- soft-delete, like kitchen_categories
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kitchen_recipe_cats_active ON kitchen_recipe_categories(active, sort_order);

-- ── Retention (forever + protected, exactly like kitchen_categories) ─────────
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected) VALUES
  ('kitchen_recipe_categories', NULL, false, 24, 'Kitchen recipe categories — keep forever', true)
ON CONFLICT (table_name) DO NOTHING;
