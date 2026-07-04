-- Personal Health — water: switch from "one +1 row per cup, summed" to
-- ONE ROW PER (profile, local-day) = that day's cup count (2026-07-04).
--
-- The old model stored each cup as a separate row and showed today = SUM(cups).
-- The history modal then exposed each increment as an editable "1 cup" row, so
-- editing a row to the day's total (e.g. 8) inflated the SUM (a day became 24-56).
-- New model: a single row per day holds the total; +1 and the reminder Clear
-- increment it (upsert), and editing a day sets that day's total directly.
--
-- Idempotent (IF NOT EXISTS guards); the collapse is safe to re-run.

ALTER TABLE ph_water ADD COLUMN IF NOT EXISTS day DATE;

-- Stamp the local (Asia/Jerusalem) day on every existing row.
UPDATE ph_water SET day = (measured_at AT TIME ZONE 'Asia/Jerusalem')::date WHERE day IS NULL;

-- Collapse to one row per (profile, day). Target daily total:
--   all rows == 1  → SUM  (a normal day of +1 increments — correct count)
--   any row  > 1   → MAX  (the value the user set while "correcting" that day)
WITH agg AS (
  SELECT profile_id, day,
         MIN(id) AS keep_id,
         CASE WHEN MAX(cups) > 1 THEN MAX(cups) ELSE SUM(cups) END AS total
  FROM ph_water GROUP BY profile_id, day
)
-- Keep measured_at ALIGNED with the row's day (noon local) — the reminder eval +
-- history list read the day, and measured_at must land on the same local date.
-- (Do NOT use now(): it stamps every historical row with today, breaking both.)
UPDATE ph_water w SET cups = a.total,
       measured_at = timezone('Asia/Jerusalem', w.day + interval '12 hours')
FROM agg a WHERE w.id = a.keep_id;

-- Repair rows already collapsed by an earlier apply that used now() (idempotent):
UPDATE ph_water SET measured_at = timezone('Asia/Jerusalem', day + interval '12 hours')
WHERE (measured_at AT TIME ZONE 'Asia/Jerusalem')::date <> day;

DELETE FROM ph_water w USING (
  SELECT profile_id, day, MIN(id) AS keep_id FROM ph_water GROUP BY profile_id, day
) k
WHERE w.profile_id = k.profile_id AND w.day = k.day AND w.id <> k.keep_id;

-- Going forward: default day = today (local); enforce one row per profday.
ALTER TABLE ph_water ALTER COLUMN day SET DEFAULT (now() AT TIME ZONE 'Asia/Jerusalem')::date;
ALTER TABLE ph_water ALTER COLUMN day SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ph_water_profile_day ON ph_water(profile_id, day);
