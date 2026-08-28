-- KITCHEN_SMART_TABLET — Common list (weekly staples): a per-product weekly quantity.
-- Products with common_qty > 0 are the recurring staples. Like stock, but no low threshold.
-- Applied via LXC 104 → psql 102 (trust auth). Re-runnable.

ALTER TABLE kitchen_products ADD COLUMN IF NOT EXISTS common_qty NUMERIC(10,2) DEFAULT 0;
