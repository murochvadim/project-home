-- KITCHEN_SMART_TABLET — recipes put onto the shopping list (step 6 of the Recipes feature).
-- Applied: scp to LXC 104 -> psql -h 192.168.1.219 -U postgres -d home_data (trust auth).
-- Re-runnable (IF NOT EXISTS / ON CONFLICT DO NOTHING).
--
-- WHY these tables exist: tapping ברשימה on a recipe adds its products to the shared shopping list,
-- and the 🗑 next to that recipe has to undo EXACTLY what it added — not "everything that looks like
-- it came from a recipe". So every line the add touched is recorded with the amount it contributed.

-- ── one row per recipe currently on the list ──
CREATE TABLE IF NOT EXISTS kitchen_list_recipes (
    id           SERIAL PRIMARY KEY,
    list_id      INTEGER NOT NULL REFERENCES kitchen_shopping_lists(id) ON DELETE CASCADE,
    -- ON DELETE SET NULL + the name/emoji snapshots below: recipe deletes are HARD (see
    -- recipe_delete in kitchen_service.py), so the list must still read correctly after one.
    recipe_id    INTEGER REFERENCES kitchen_recipes(id) ON DELETE SET NULL,
    recipe_name  TEXT NOT NULL,
    recipe_emoji TEXT,
    added_at     TIMESTAMPTZ DEFAULT now()
);
-- one entry per recipe per list: adding the same recipe twice must not stack up rows
CREATE UNIQUE INDEX IF NOT EXISTS uq_kitchen_list_recipes
    ON kitchen_list_recipes(list_id, recipe_id) WHERE recipe_id IS NOT NULL;

-- ── one row per shopping-list line that recipe touched ──
CREATE TABLE IF NOT EXISTS kitchen_list_recipe_items (
    id             SERIAL PRIMARY KEY,
    list_recipe_id INTEGER NOT NULL REFERENCES kitchen_list_recipes(id) ON DELETE CASCADE,
    -- CASCADE: if the shopping item goes (row 🗑 / qty 0 / clear / clear-checked) its line goes too.
    -- A 'skipped' line has no item at all, which is why this is nullable.
    item_id        INTEGER REFERENCES kitchen_shopping_items(id) ON DELETE CASCADE,
    -- how much THIS recipe contributed, so removal subtracts its share and leaves yours alone
    qty_added      NUMERIC(10,3) NOT NULL DEFAULT 0,
    -- product = a real product line | missing = a "חסר:" free-text line | skipped = already enough
    kind           TEXT NOT NULL DEFAULT 'product',
    created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kitchen_list_recipe_items_parent
    ON kitchen_list_recipe_items(list_recipe_id);

-- ── Retention: shopping data, not catalog — cleaned with the list, not kept forever ──
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected) VALUES
  ('kitchen_list_recipes',      180, true, 24, 'Recipes added to a shopping list',        false),
  ('kitchen_list_recipe_items', 180, true, 24, 'What each of those recipes contributed',  false)
ON CONFLICT (table_name) DO NOTHING;
