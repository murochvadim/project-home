-- Project-wide reminders: per-instance snooze/clear state for the reminders badge.
-- A reminder "instance" has a deterministic rkey (e.g. med:<id>:<date>:<slot>,
-- weight:<profile>:<window>, bp:<profile>:<window>). The evaluator
-- (routes-reminders.js) suppresses an rkey when cleared_at is set OR snoozed_until
-- is still in the future. Generic — future non-medical sources reuse the table.
CREATE TABLE IF NOT EXISTS reminder_state (
  rkey          text PRIMARY KEY,
  snoozed_until timestamptz,
  cleared_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
VALUES ('reminder_state', 30, true, 24, 'Per-instance reminder snooze/clear state (project-wide reminders badge)')
ON CONFLICT (table_name) DO NOTHING;
