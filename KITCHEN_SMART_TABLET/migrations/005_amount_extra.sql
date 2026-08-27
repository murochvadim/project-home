-- KITCHEN_SMART_TABLET — 4th buy-amount level "הרבה מעוד" (extra), per product, in its unit.
-- Applied via LXC 104 → psql 102 (trust auth). Re-runnable.

ALTER TABLE kitchen_products ADD COLUMN IF NOT EXISTS amount_extra NUMERIC(10,2);

-- defaults by unit: kg/L → 3 · piece/tray → 10 · other → 6
UPDATE kitchen_products SET amount_extra = COALESCE(amount_extra,
  CASE WHEN lower(unit) IN ('kg','l') THEN 3 WHEN lower(unit) IN ('piece','tray') THEN 10 ELSE 6 END);
