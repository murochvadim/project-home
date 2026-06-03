-- ════════════════════════════════════════════════════════════
-- Medical Agent — split `phone` into 4 labeled phone slots
-- (2026-06-03). Migrates the existing single `phone` value into
-- the new `phone_main` column so historical data is preserved.
-- The other 3 columns start NULL — user can fill them per-contact.
--
-- 4 phone kinds: Main / Privet / Zimun Tor / Fax
-- ════════════════════════════════════════════════════════════

BEGIN;

-- Rename the existing single `phone` column → `phone_main`.
-- Any previously-entered phone number stays with the contact under Main.
ALTER TABLE medical_contacts RENAME COLUMN phone TO phone_main;

-- Add the 3 new phone slots.
ALTER TABLE medical_contacts ADD COLUMN IF NOT EXISTS phone_private   TEXT;
ALTER TABLE medical_contacts ADD COLUMN IF NOT EXISTS phone_zimun_tor TEXT;
ALTER TABLE medical_contacts ADD COLUMN IF NOT EXISTS phone_fax       TEXT;

COMMIT;
