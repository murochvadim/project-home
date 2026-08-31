-- WhatsApp agent (LXC 114) — Baileys-backed personal-account cache.
-- The agent persists WhatsApp events here; the dashboard reads from these tables
-- (Baileys 7 has no in-memory store). Mirrors the Email agent's DB-cache shape.
-- Idempotent.

-- Chats (DMs + groups), one row per jid.
CREATE TABLE IF NOT EXISTS whatsapp_chats (
  jid         TEXT PRIMARY KEY,
  name        TEXT,
  is_group    BOOLEAN NOT NULL DEFAULT false,
  last_ts     TIMESTAMPTZ,
  unread      INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_chats_last ON whatsapp_chats (last_ts DESC);

-- Messages — metadata + text cache (bodies bleach/stripped by the agent; no raw HTML).
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id          BIGSERIAL PRIMARY KEY,
  wa_id       TEXT,               -- WhatsApp message id (key.id)
  chat_jid    TEXT NOT NULL,      -- key.remoteJid
  sender_jid  TEXT,               -- key.participant (groups) or chat_jid (DMs)
  sender_name TEXT,               -- pushName
  from_me     BOOLEAN NOT NULL DEFAULT false,
  direction   TEXT NOT NULL DEFAULT 'in',   -- 'in' | 'out'
  type        TEXT,               -- conversation / extendedText / image / ...
  body        TEXT,
  ts          TIMESTAMPTZ,
  status      TEXT,               -- delivery/read status
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wa_id, chat_jid)
);
CREATE INDEX IF NOT EXISTS idx_wa_msgs_chat_ts ON whatsapp_messages (chat_jid, ts DESC);
CREATE INDEX IF NOT EXISTS idx_wa_msgs_sender  ON whatsapp_messages (chat_jid, sender_jid);

-- Contacts — jid → name map.
CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  jid         TEXT PRIMARY KEY,
  name        TEXT,
  notify      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Singleton state — connection status + settings (incl. the send-guard limits).
CREATE TABLE IF NOT EXISTS whatsapp_state (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  connection  TEXT,               -- connecting | open | logged-out
  me_jid      TEXT,
  last_sync   TIMESTAMPTZ,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);
INSERT INTO whatsapp_state (id, connection, settings)
VALUES (1, 'connecting',
        '{"min_gap_sec":4,"hourly_cap":20,"daily_cap":100,"contact_only":true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Retention (Project Health → Retention Policies). Messages 180 d auto-clean; the
-- rest forever (chats/contacts/state are the live cache + config).
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description) VALUES
  ('whatsapp_messages', 180,  true,  24, 'WhatsApp message metadata + text cache'),
  ('whatsapp_chats',    NULL, false, 24, 'WhatsApp chats (DMs + groups)'),
  ('whatsapp_contacts', NULL, false, 24, 'WhatsApp contacts (jid to name)'),
  ('whatsapp_state',    NULL, false, 24, 'WhatsApp agent singleton state/settings')
ON CONFLICT (table_name) DO NOTHING;
