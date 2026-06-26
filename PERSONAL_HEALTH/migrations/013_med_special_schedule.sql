-- Optional "Special Schedule" on a medication — a dated logistical task
-- (order refill, arrange pre-injection authorisation doc, etc.). Surfaced as a
-- "Special Schedule" column in the meds table, colored by proximity using the
-- shared project-wide Schedule & appointment color bands (dashboard_settings
-- privacy.settings). NULL special_date = no special schedule.
ALTER TABLE ph_medications
  ADD COLUMN IF NOT EXISTS special_date date,
  ADD COLUMN IF NOT EXISTS special_note text;
