-- Per-person measure schedule for Weight + BP (drives a FUTURE reminder watcher).
-- Same shape as the medications schedule but no weekday / day-of-month / time:
-- just {freq, interval_n}. freq ∈ daily | weekly | every_n_days | every_n_months
-- (NULL column = Off). interval_n only meaningful for the every_n_* freqs.
ALTER TABLE ph_profiles
  ADD COLUMN IF NOT EXISTS weight_sched jsonb,
  ADD COLUMN IF NOT EXISTS bp_sched     jsonb;
