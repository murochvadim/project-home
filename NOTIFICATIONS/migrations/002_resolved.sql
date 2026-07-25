-- 002_resolved.sql — sticky interactive notifications.
-- An interactive notification (data.action set, e.g. the main-door-close
-- "set people at home" popup) stays PENDING until the user actually resolves
-- it (Save). resolved_at IS NULL = still pending → the feed resurfaces it on
-- every poll, independent of the per-browser cursor and of expires_at, so it
-- can never be missed just because the laptop was closed.
ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_notification_events_pending
  ON notification_events (id) WHERE resolved_at IS NULL;
