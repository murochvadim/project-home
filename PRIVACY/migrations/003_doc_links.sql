-- Privacy Docs window: allow plain LINKS (e.g. a Google Drive URL) alongside
-- files. A link is a kind='link' row with the URL in `url`, no file, no crypto.
-- file_path stays NOT NULL (links store '') so no constraint change is needed.
ALTER TABLE privacy_site_docs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'file';
ALTER TABLE privacy_site_docs ADD COLUMN IF NOT EXISTS url  TEXT;
