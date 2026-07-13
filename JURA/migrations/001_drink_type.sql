-- Jura per-drink logging (2026-07-13)
-- Adds drink-type to the per-event log + per-type daily rollup.
-- "All drinks except Hot Water and Flat White" (Flat White is unreadable on this
-- board; Hot Water excluded per user). Milk Portion IS a drink (included).
--
-- Apply on LXC 102:  psql -d home_data -f 001_drink_type.sql   (idempotent)

-- 1) per-coffee event log -> per-drink. Existing rows are all coffee.
ALTER TABLE jura_drinks
  ADD COLUMN IF NOT EXISTS drink_type TEXT NOT NULL DEFAULT 'coffee';

-- 2) daily rollup: per-type cumulative high-water + per-type made-today.
--    Legacy `coffee`/`made` columns are kept (coffee-only, backward compat).
ALTER TABLE jura_daily
  ADD COLUMN IF NOT EXISTS cum_by_type  JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS made_by_type JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 3) seed existing daily rows' cum_by_type with their coffee cumulative so the
--    coffee series stays continuous into the new per-type long-range graph.
UPDATE jura_daily
   SET cum_by_type = jsonb_build_object('coffee', coffee)
 WHERE coffee IS NOT NULL AND cum_by_type = '{}'::jsonb;
