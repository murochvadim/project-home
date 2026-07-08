-- 002_people_positions.sql — free-canvas layout. Each person can be dragged to a
-- saved (pos_x, pos_y) on the People canvas (foundation for the Phase-2 graph).
-- NULL = not placed yet → the UI auto-grids it until first drag.
BEGIN;
ALTER TABLE people ADD COLUMN IF NOT EXISTS pos_x DOUBLE PRECISION;
ALTER TABLE people ADD COLUMN IF NOT EXISTS pos_y DOUBLE PRECISION;
COMMIT;
