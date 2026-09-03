-- KITCHEN_SMART_TABLET — recipes imported from recipe sites (step 3 of the Recipes feature).
-- Applied: scp to LXC 104 -> psql -h 192.168.1.219 -U postgres -d home_data (trust auth).
-- Re-runnable (IF NOT EXISTS / ON CONFLICT DO NOTHING).

-- ── A recipe: belongs to exactly ONE category (user's decision, 2026-09-03) ──
CREATE TABLE IF NOT EXISTS kitchen_recipes (
    id           SERIAL PRIMARY KEY,
    category_id  INTEGER REFERENCES kitchen_recipe_categories(id) ON DELETE SET NULL,
    name         TEXT NOT NULL,               -- Hebrew display name
    emoji        TEXT,
    servings     TEXT,                        -- free text ("4 מנות") — sites are inconsistent
    instructions TEXT,                        -- the preparation steps, one per line
    -- ⚠ UNIQUE is the whole point: it is what stops the same recipe being imported twice.
    -- NULL is allowed and never collides (Postgres treats NULLs as distinct), so hand-typed
    -- recipes with no source are unaffected.
    source_url   TEXT UNIQUE,
    source_site  TEXT,                        -- which configured site it came from
    notes        TEXT,
    active       BOOLEAN DEFAULT true,        -- soft-delete, like every other kitchen table
    sort_order   INTEGER DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT now(),
    updated_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kitchen_recipes_cat ON kitchen_recipes(category_id, sort_order);

-- ── One ingredient line. raw_line is KEPT so a bad parse is fixable without re-fetching. ──
CREATE TABLE IF NOT EXISTS kitchen_recipe_items (
    id          SERIAL PRIMARY KEY,
    recipe_id   INTEGER NOT NULL REFERENCES kitchen_recipes(id) ON DELETE CASCADE,
    sort_order  INTEGER DEFAULT 0,
    group_label TEXT,                         -- the recipe's own sub-heading (רוטב: / תבלינים:)
    raw_line    TEXT NOT NULL,                -- exactly as the site wrote it
    qty         NUMERIC(10,3),                -- parsed amount (NULL = the site gave none => 1)
    unit        TEXT,                         -- the RECIPE's unit (ג' / כף / כפית / קופסאות …)
    parsed_name TEXT,                         -- product name extracted from raw_line
    product_id  INTEGER REFERENCES kitchen_products(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kitchen_recipe_items_recipe ON kitchen_recipe_items(recipe_id, sort_order);

-- ── Learned ingredient->product mappings, so a manual choice is NEVER asked twice. ──
-- e.g. alias 'א. מרק' -> the אבקת מרק product. Written whenever the user maps an unmatched row.
CREATE TABLE IF NOT EXISTS kitchen_ingredient_aliases (
    id         SERIAL PRIMARY KEY,
    alias      TEXT NOT NULL UNIQUE,          -- the parsed name as the site writes it
    product_id INTEGER NOT NULL REFERENCES kitchen_products(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── Retention (forever + protected, like the rest of the kitchen catalog) ────
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected) VALUES
  ('kitchen_recipes',            NULL, false, 24, 'Kitchen recipes — keep forever',            true),
  ('kitchen_recipe_items',       NULL, false, 24, 'Kitchen recipe ingredients — keep forever', true),
  ('kitchen_ingredient_aliases', NULL, false, 24, 'Learned ingredient→product mappings',       true)
ON CONFLICT (table_name) DO NOTHING;
