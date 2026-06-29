-- Privacy → Budget spreadsheet: server-blind encrypted workbook storage.
-- Singleton row. The browser does all AES-GCM (same Documents password +
-- privacy_doc_crypto salt/verifier as Privacy → Documents); this table only
-- ever holds opaque ciphertext + the per-save IV. The server never sees the
-- plaintext workbook, key, or password.
CREATE TABLE IF NOT EXISTS privacy_sheets (
  id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enc_data   text,                                   -- base64 AES-GCM ciphertext of the workbook JSON
  enc_iv     text,                                   -- base64 per-save random 12-byte IV
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Protected / forever — never auto-cleaned (like the other privacy_* tables).
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected)
VALUES ('privacy_sheets', NULL, false, 24, 'Privacy → Budget encrypted spreadsheet (server-blind, singleton)', true)
ON CONFLICT (table_name) DO NOTHING;
