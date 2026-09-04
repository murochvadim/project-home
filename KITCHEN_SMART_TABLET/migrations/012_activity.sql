-- KITCHEN_SMART_TABLET — what changed on the shopping list, and when (the 🧊 מקרר bar line).
-- Applied: scp to LXC 104 -> psql -h 192.168.1.219 -U postgres -d home_data (trust auth).
-- Re-runnable (IF NOT EXISTS / ON CONFLICT DO NOTHING).
--
-- WHY: "last added" is derivable (kitchen_shopping_items.added_at), but "last REMOVED" is not -
-- removals are hard DELETEs in four places, so once a row is gone nothing about it survives.
-- The event has to be recorded as it happens, with the NAME snapshotted, so the bar can still say
-- "הוסר מתכון: פריקסה" after that recipe row is deleted.

CREATE TABLE IF NOT EXISTS kitchen_activity (
    id      SERIAL PRIMARY KEY,
    ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- recipe_added | recipe_removed | product_added | product_removed | list_cleared
    kind    TEXT NOT NULL,
    name    TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
-- the bar only ever asks for the newest row
CREATE INDEX IF NOT EXISTS idx_kitchen_activity_ts ON kitchen_activity(ts DESC);

-- Retention: an activity trail, not catalog - cleaned, unlike the products/recipes tables.
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected) VALUES
  ('kitchen_activity', 90, true, 24, 'Kitchen shopping-list activity (the fridge bar line)', false)
ON CONFLICT (table_name) DO NOTHING;
