-- KITCHEN_SMART_TABLET — per-product on-shelf SEASON (setting only, no display yet).
-- season_all_year=true (default) → product is available all year ("always").
-- Otherwise season_start_month..season_end_month (1–12) define the on-shelf window;
-- start>end wraps across year-end (e.g. Nov→Feb = 11..2). Re-runnable.
-- Applied via LXC 104 → psql 102 (trust auth).

ALTER TABLE kitchen_products ADD COLUMN IF NOT EXISTS season_all_year    BOOLEAN DEFAULT true;
ALTER TABLE kitchen_products ADD COLUMN IF NOT EXISTS season_start_month SMALLINT;
ALTER TABLE kitchen_products ADD COLUMN IF NOT EXISTS season_end_month   SMALLINT;
