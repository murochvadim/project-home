-- The popup sentence a rule showed, stored ON the log row.
-- Why: the reminders card used to look the sentence up in dashboard_settings.whatsapp.rules
-- by rule_id, so a rule that was edited (or previewed with ▶ Test before Save) showed the
-- wrong sentence or none. The row now carries what actually fired.
ALTER TABLE whatsapp_automation_log ADD COLUMN IF NOT EXISTS popup_text TEXT;
