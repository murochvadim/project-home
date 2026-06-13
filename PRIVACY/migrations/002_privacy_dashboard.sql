-- Privacy dashboard page — Sites CRM + per-site encrypted/plain documents.
-- Run on LXC 102 (home_data). Idempotent.

-- Sites CRM (kind/name/tels/fax/email/website + optional Vaultwarden item ref).
-- Plaintext data (LAN-only, like medical_contacts) — NOT the encrypted docs.
CREATE TABLE IF NOT EXISTS privacy_sites (
  id         SERIAL PRIMARY KEY,
  kind       TEXT,
  name       TEXT NOT NULL,
  main_tel   TEXT,
  add_tels   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ "person": "...", "tel": "..." }]
  fax        TEXT,
  email      TEXT,
  website    TEXT,
  vault_item TEXT,                                 -- optional: name of the Vaultwarden login (for the 🔑 link)
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Singleton: the KDF salt + a verifier blob for the ONE Documents password.
-- The password itself is NEVER stored or sent — the browser derives the AES key
-- (PBKDF2-SHA256, kdf_iters) from password+salt, and "verifier" is a known token
-- encrypted with that key so we can detect a wrong password without decrypting
-- any document. All crypto is client-side; the server only holds these blobs.
CREATE TABLE IF NOT EXISTS privacy_doc_crypto (
  id          INT PRIMARY KEY DEFAULT 1,
  salt        TEXT NOT NULL,                       -- base64, 16 random bytes
  verifier    TEXT NOT NULL,                       -- base64, AES-256-GCM ciphertext of a fixed token
  verifier_iv TEXT NOT NULL,                       -- base64, 12 random bytes
  kdf_iters   INT  NOT NULL DEFAULT 600000,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT privacy_doc_crypto_one_row CHECK (id = 1)
);

-- Per-site documents. File bytes live on QNAP (Claude_Data\Privacy_Site_Docs);
-- only metadata here. For ENCRYPTED docs the real filename is in enc_name
-- (ciphertext) and the file bytes are AES-GCM ciphertext (file_iv); mime is
-- derived client-side from the decrypted filename's extension (so even the file
-- TYPE isn't leaked). For PLAIN docs, doc_name + mime_type are plaintext.
CREATE TABLE IF NOT EXISTS privacy_site_docs (
  id         SERIAL PRIMARY KEY,
  site_id    INT NOT NULL REFERENCES privacy_sites(id) ON DELETE CASCADE,
  encrypted  BOOLEAN NOT NULL DEFAULT false,
  doc_name   TEXT,                                 -- plaintext filename (PLAIN docs)
  enc_name   TEXT,                                 -- base64 ciphertext filename (ENCRYPTED docs)
  name_iv    TEXT,                                 -- base64 IV for enc_name
  file_path  TEXT NOT NULL,                        -- basename on QNAP
  file_iv    TEXT,                                 -- base64 IV for the file (ENCRYPTED docs)
  mime_type  TEXT,                                 -- plaintext mime (PLAIN docs only)
  file_size  BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_privacy_site_docs_site ON privacy_site_docs(site_id);

-- Retention: forever (config/personal data).
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
VALUES
  ('privacy_sites',       NULL, false, 168, 'Privacy page — Sites CRM'),
  ('privacy_site_docs',   NULL, false, 168, 'Privacy page — per-site document metadata'),
  ('privacy_doc_crypto',  NULL, false, 168, 'Privacy page — Documents-password KDF salt + verifier')
ON CONFLICT (table_name) DO NOTHING;

-- Appointment + reminder per site (mirrors medical_contacts; added 2026-06-13).
ALTER TABLE privacy_sites ADD COLUMN IF NOT EXISTS next_appointment_at   TIMESTAMPTZ;
ALTER TABLE privacy_sites ADD COLUMN IF NOT EXISTS next_appointment_note TEXT;
ALTER TABLE privacy_sites ADD COLUMN IF NOT EXISTS reminder_text         TEXT;
