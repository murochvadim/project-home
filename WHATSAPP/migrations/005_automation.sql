-- WhatsApp automation log — one row per rule match (both dry-run and live), mirror
-- of email_automation_log. Rules themselves live in dashboard_settings.whatsapp.rules.
-- wa_id (the message id) is required so run-now dedupes against already-processed msgs.
-- Idempotent.
CREATE TABLE IF NOT EXISTS whatsapp_automation_log (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  rule_id      TEXT,
  rule_name    TEXT,
  wa_id        TEXT,               -- whatsapp_messages.wa_id (dedupe key for run-now)
  chat_jid     TEXT,
  from_jid     TEXT,
  from_name    TEXT,
  matched_text TEXT,               -- the inbound message body (preview)
  action       TEXT,               -- reply | popup | both
  mode         TEXT,               -- dryrun | live
  applied      BOOLEAN NOT NULL DEFAULT false,   -- false on dry-run
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_autolog_ts  ON whatsapp_automation_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_wa_autolog_wa  ON whatsapp_automation_log (wa_id) WHERE applied = true;

INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description) VALUES
  ('whatsapp_automation_log', 90, true, 24, 'WhatsApp automation match/action log')
ON CONFLICT (table_name) DO NOTHING;
