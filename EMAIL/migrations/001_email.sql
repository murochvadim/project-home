-- Email Agent — Gmail metadata cache + poller state.
-- The Email Agent (LXC 110) polls Gmail via the Gmail API and caches ONLY message
-- METADATA + snippet here (never full bodies — those are fetched on-demand from
-- Gmail and HTML-sanitized at read time). The dashboard email page reads these
-- rows via the agent's HTTP API; new mail also emits an MQTT event so the rule
-- engine can trigger on incoming mail. Added 2026-07-01.

-- Per-message metadata (no bodies). gmail_id = the Gmail message id (stable).
CREATE TABLE IF NOT EXISTS email_messages (
  gmail_id    TEXT PRIMARY KEY,
  thread_id   TEXT,
  from_addr   TEXT,
  to_addr     TEXT,
  subject     TEXT,
  snippet     TEXT,                 -- Gmail's short preview snippet (not the body)
  labels      JSONB,                -- Gmail label ids on the message
  msg_ts      TIMESTAMPTZ,          -- the message's own Date header
  seen        BOOLEAN NOT NULL DEFAULT false,  -- our "emitted to MQTT / shown" flag
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_email_messages_ts     ON email_messages(msg_ts DESC);
CREATE INDEX IF NOT EXISTS ix_email_messages_thread ON email_messages(thread_id);

-- Gmail label cache (id → name/type) for the UI's label filter + chips.
CREATE TABLE IF NOT EXISTS email_labels (
  label_id    TEXT PRIMARY KEY,
  name        TEXT,
  type        TEXT,                 -- 'system' | 'user'
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Singleton poller state: the Gmail History API watermark + agent settings.
CREATE TABLE IF NOT EXISTS email_state (
  id           INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  history_id   TEXT,                -- last processed Gmail historyId
  last_poll_ts TIMESTAMPTZ,
  settings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO email_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Retention: metadata kept 180 days + auto-cleaned; labels + state kept forever.
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected) VALUES
  ('email_messages', 180,  true,  24, 'Email metadata cache (no bodies) — 180d rolling', false),
  ('email_labels',   NULL, false, 24, 'Gmail label cache — keep forever',                 false),
  ('email_state',    NULL, false, 24, 'Email Agent poller watermark + settings',          false)
ON CONFLICT (table_name) DO NOTHING;
