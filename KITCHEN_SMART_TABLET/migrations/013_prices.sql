-- KITCHEN_SMART_TABLET — real shelf prices from חצי חינם, branch הוד השרון (store 206).
-- Applied: scp to LXC 104 -> psql -h 192.168.1.219 -U postgres -d home_data (trust auth).
-- Re-runnable (IF NOT EXISTS / ON CONFLICT DO NOTHING).
--
-- WHY: kitchen_products.price is typed by hand. The chain must publish its shelf prices by law, so the
-- price can come from the branch instead. But a product here is a GENERIC word (חלב, קפה) while the
-- price file lists SPECIFIC items - measured: 'חלב' matches 282 items, led by soy milk and face cream.
-- So the machine never chooses: the user pins the item(s) they actually buy, ONCE, and the price then
-- refreshes by item_code forever.
--
-- WHY A TABLE and not columns on kitchen_products: the user buys different brands at different times
-- ("once coffee from X and once from Y"), so a product needs SEVERAL items, each with its own barcode
-- and its own live price. The shopping list totals with the CHEAPEST of them.

CREATE TABLE IF NOT EXISTS kitchen_product_items (
    id           SERIAL PRIMARY KEY,
    product_id   INTEGER NOT NULL REFERENCES kitchen_products(id) ON DELETE CASCADE,

    -- identity at the chain. item_code IS the barcode for normal goods; for loose produce it is the
    -- store's internal weighted code, which is why it is TEXT and never parsed as a number.
    chain_id     TEXT NOT NULL DEFAULT '7290700100008',
    store_id     TEXT NOT NULL DEFAULT '206',            -- הרקון 2, הוד השרון (15,419 items)
    item_code    TEXT NOT NULL,
    item_name    TEXT NOT NULL,                          -- the branch's OWN name, snapshotted so the
                                                         -- row still reads sensibly if it leaves the file
    manufacturer TEXT,

    price        NUMERIC(10,2),                          -- shelf price
    unit_price   NUMERIC(10,2),                          -- price per kg/litre, for loose goods
    unit_measure TEXT,
    is_weighted  BOOLEAN NOT NULL DEFAULT false,         -- bIsWeighted=1 -> sold by weight

    -- true = the user typed this price. The refresh must never overwrite it (it is a correction).
    price_manual BOOLEAN NOT NULL DEFAULT false,

    -- two DIFFERENT dates, deliberately kept apart:
    shop_changed_at TIMESTAMPTZ,   -- the shop's own PriceUpdateTime: when the SHOP last moved this price
    last_checked_at TIMESTAMPTZ,   -- when WE last looked. Stops advancing if fetching breaks, so a
                                   -- stale price is visible on screen instead of silently pretending.

    sort_order   INTEGER NOT NULL DEFAULT 0,             -- 0 = item 1, 1 = item 2, ...
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- the same item cannot be pinned twice to one product
CREATE UNIQUE INDEX IF NOT EXISTS uq_kitchen_product_items
    ON kitchen_product_items(product_id, store_id, item_code);
CREATE INDEX IF NOT EXISTS idx_kitchen_product_items_product
    ON kitchen_product_items(product_id, sort_order);

-- Retention: FOREVER + protected. A pinned item is a decision the user made by hand; ageing it out
-- would silently un-pin products. Same treatment as kitchen_products itself.
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected) VALUES
  ('kitchen_product_items', NULL, false, 24, 'Chain items pinned to my products (shelf prices) - keep forever', true)
ON CONFLICT (table_name) DO NOTHING;
