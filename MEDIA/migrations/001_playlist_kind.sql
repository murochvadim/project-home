-- 001_playlist_kind.sql — separate Audio vs Video playlists (2026-07-27)
-- Adds a `kind` tag to media_playlists so the Media → Player tab can show two
-- separate cards (Audio Playlists / Video Playlists), each with its own
-- "+ New Playlist" button. Existing playlists default to 'audio' (unchanged).
-- Applied on LXC 102 (home_data). Idempotent.
ALTER TABLE media_playlists ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'audio';
