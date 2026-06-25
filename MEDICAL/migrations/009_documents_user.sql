-- Attribute each medical document to a household member (Documents tab Person field).
-- ON DELETE SET NULL so documents survive if the member is later removed.
ALTER TABLE medical_documents
  ADD COLUMN IF NOT EXISTS user_id integer REFERENCES household_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_med_docs_user ON medical_documents(user_id);
-- Backfill: set all existing documents to Vadim (per user request 2026-06-25).
UPDATE medical_documents SET user_id = (SELECT id FROM household_users WHERE name = 'Vadim')
 WHERE user_id IS NULL;
