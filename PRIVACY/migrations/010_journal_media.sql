-- 010_journal_media.sql — attach photos/videos to a Daily Journal capture (2026-08-05).
-- Capture-level link table (one row per attached file, keyed by user+day+slot — NOT
-- per category, like mood conceptually but its own rows). The bytes live ONLY on the
-- QNAP NAS media library (/mnt/media, ingested via the media agent); this table stores
-- just the QNAP path + type so the journal can show it and detach it. Deleting a row
-- detaches from the journal but KEEPS the file in the media library (analyzer/faces).

CREATE TABLE IF NOT EXISTS journal_media (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES household_users(id) ON DELETE CASCADE,
  entry_date  DATE NOT NULL,              -- local Asia/Jerusalem day of the capture
  slot_id     TEXT NOT NULL,              -- the config slot the media is attached to
  media_path  TEXT NOT NULL,              -- full QNAP path, e.g. /mnt/media/Journal/2026-08-05/<file>
  media_type  TEXT NOT NULL,              -- 'image' | 'video'
  orig_name   TEXT,                       -- original filename (display only)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_journal_media_lookup ON journal_media(user_id, entry_date, slot_id);

-- Retention: forever + protected (personal data), never auto-cleaned — matches journal_entries.
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, protected, description)
VALUES ('journal_media', NULL, false, 24, true, 'Daily Journal media attachments (QNAP path links) — keep forever')
ON CONFLICT (table_name) DO NOTHING;
