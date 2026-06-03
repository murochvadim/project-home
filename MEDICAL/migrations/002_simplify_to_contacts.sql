-- ════════════════════════════════════════════════════════════
-- Medical Agent — simplification migration (2026-06-02)
-- Decision: drop visits / appointments / medications / schedules /
-- log / documents / conclusions tables and tabs. Keep ONLY the
-- contacts table (renamed from medical_providers) — a flat
-- address book of doctors / clinics / hospitals + health fund.
-- ════════════════════════════════════════════════════════════

BEGIN;

-- ─── Drop the 7 unused tables ─────────────────────────────────
-- Order matters: medication_log + medication_schedules FK medications
-- (CASCADE in their original DDL so DROP medications cascades), but
-- the inverse FK from medical_documents → medical_visits is ON DELETE
-- SET NULL so order is flexible. Drop in dependency order anyway.
DROP TABLE IF EXISTS medication_log;
DROP TABLE IF EXISTS medication_schedules;
DROP TABLE IF EXISTS medications;
DROP TABLE IF EXISTS medical_documents;
DROP TABLE IF EXISTS medical_conclusions;
DROP TABLE IF EXISTS medical_appointments;
DROP TABLE IF EXISTS medical_visits;

-- ─── Rename medical_providers → medical_contacts ──────────────
-- Single flat address book. No FK to other medical_* tables.
ALTER TABLE medical_providers RENAME TO medical_contacts;

-- ─── Adjust the kind CHECK constraint: drop 'lab', keep 3 ─────
-- The PG-generated constraint name from the original CREATE was
-- `medical_providers_kind_check`. Renaming the table doesn't
-- rename the constraint. Find + drop + recreate with the new set.
ALTER TABLE medical_contacts
  DROP CONSTRAINT IF EXISTS medical_providers_kind_check;
ALTER TABLE medical_contacts
  ADD CONSTRAINT medical_contacts_kind_check
  CHECK (kind IN ('doctor', 'clinic', 'hospital'));

-- ─── Drop parent_id self-FK ───────────────────────────────────
-- The doctor↔clinic relationship is now folded into free-text
-- "specialty / clinic name" per row.
ALTER TABLE medical_contacts
  DROP COLUMN IF EXISTS parent_id;

-- ─── Drop the patient_portal_url column ───────────────────────
-- User-explicit field trimming. The user's 9-field shape lists:
-- kind, name, specialty, health_fund, address, phone, email,
-- website_url, notes. The original 11-column shape had parent_id
-- (dropped above) AND patient_portal_url (dropped here).
ALTER TABLE medical_contacts
  DROP COLUMN IF EXISTS patient_portal_url;

-- ─── Add health_fund column ───────────────────────────────────
-- Free TEXT so the user can put anything (Clalit / Maccabi /
-- Meuhedet / Leumit / private / abroad / —). UI provides a
-- dropdown with the 4 common values + free-text fallback.
ALTER TABLE medical_contacts
  ADD COLUMN IF NOT EXISTS health_fund TEXT;

-- ─── Retention policy cleanup ─────────────────────────────────
-- Drop the 8 old policies, add the single new one.
DELETE FROM retention_policies WHERE table_name IN (
  'medical_providers', 'medical_visits', 'medical_appointments',
  'medical_documents', 'medications', 'medication_schedules',
  'medication_log', 'medical_conclusions'
);
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description) VALUES
  ('medical_contacts', NULL, FALSE, 24, 'Flat address book: doctors / clinics / hospitals. Forever.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
