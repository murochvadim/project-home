-- 019_bobo_sched.sql — per-person "play Bobo" reminder schedule.
-- Same {freq, interval_n} JSONB shape as weight_sched / bp_sched / body_sched.
-- Drives the reminders badge (routes-reminders.js): overdue = no balance game
-- (medical_test_results test_type='balance') within the schedule window.
ALTER TABLE ph_profiles ADD COLUMN IF NOT EXISTS bobo_sched jsonb;
