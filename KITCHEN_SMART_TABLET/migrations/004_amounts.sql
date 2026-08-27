-- KITCHEN_SMART_TABLET — per-product buy amounts (קצת / בינוני / הרבה), in the product's unit.
-- Drives the fridge product panel's 3 amount circles. Applied via LXC 104 → psql 102 (trust auth).
-- Re-runnable (IF NOT EXISTS + COALESCE seeds only NULLs).

ALTER TABLE kitchen_products ADD COLUMN IF NOT EXISTS amount_little NUMERIC(10,2);
ALTER TABLE kitchen_products ADD COLUMN IF NOT EXISTS amount_medium NUMERIC(10,2);
ALTER TABLE kitchen_products ADD COLUMN IF NOT EXISTS amount_lots   NUMERIC(10,2);

-- sensible defaults by unit: kg/L → 0.5 / 1 / 2 · piece → 1 / 3 / 6 · other → 1 / 2 / 4
UPDATE kitchen_products SET
  amount_little = COALESCE(amount_little, CASE WHEN lower(unit) IN ('kg','l') THEN 0.5 WHEN lower(unit) = 'piece' THEN 1 ELSE 1 END),
  amount_medium = COALESCE(amount_medium, CASE WHEN lower(unit) IN ('kg','l') THEN 1   WHEN lower(unit) = 'piece' THEN 3 ELSE 2 END),
  amount_lots   = COALESCE(amount_lots,   CASE WHEN lower(unit) IN ('kg','l') THEN 2   WHEN lower(unit) = 'piece' THEN 6 ELSE 4 END);
