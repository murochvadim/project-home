-- Email automation — "move spammed emails to Trash after N days" cleanup support.
-- The agent periodically moves emails it earlier moved to SPAM into Trash once they're
-- older than the configured N days (Gmail then purges Trash ~30d later; still recoverable
-- meanwhile — no permanent delete, works with the gmail.modify scope). trashed_at marks
-- rows already swept so the cleanup never re-processes them. Setting lives in
-- dashboard_settings.email.settings {trash_spam_after_days:N}. Added 2026-07-01.
ALTER TABLE email_automation_log ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ;
