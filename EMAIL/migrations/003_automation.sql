-- Email Automation (phase 1) — sender-rule engine tables.
-- Rules themselves live in dashboard_settings.email.rules (JSON, edited on the
-- Email → Automation tab, read by the agent). These two tables hold the OUTPUT:
--   * email_extractions   — data pulled out of matched emails and KEPT (buckets 2 & 3)
--   * email_automation_log — audit trail of every rule match incl. dry-run (what
--     WOULD happen), so a rule can be trusted before it goes live. Added 2026-07-01.

CREATE TABLE IF NOT EXISTS email_extractions (
  id           SERIAL PRIMARY KEY,
  rule_id      TEXT,
  rule_name    TEXT,
  gmail_id     TEXT,
  from_addr    TEXT,
  subject      TEXT,
  data         JSONB,               -- {field: value, ...} pulled by the rule's regexes
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_email_extractions_ts ON email_extractions(extracted_at DESC);

CREATE TABLE IF NOT EXISTS email_automation_log (
  id          SERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  rule_id     TEXT,
  rule_name   TEXT,
  gmail_id    TEXT,
  from_addr   TEXT,
  subject     TEXT,
  disposition TEXT,                 -- spam | trash | keep | archive (what the rule dictates)
  mode        TEXT,                 -- dryrun | live
  applied     BOOLEAN NOT NULL DEFAULT false,  -- false for dry-run (nothing changed)
  extracted   JSONB,               -- preview of what was/would-be pulled
  note        TEXT
);
CREATE INDEX IF NOT EXISTS ix_email_automation_log_ts ON email_automation_log(ts DESC);

-- Retention: kept data forever; audit log 90 d auto-clean.
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected) VALUES
  ('email_extractions',    NULL, false, 24, 'Email automation — extracted data (kept)',        false),
  ('email_automation_log', 90,   true,  24, 'Email automation — action/dry-run audit log',     false)
ON CONFLICT (table_name) DO NOTHING;
