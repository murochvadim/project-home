-- Medical contacts: per-contact appointment slot (added 2026-06-03).
-- One appointment per contact at a time. Rendered as a red middle line on the
-- contact card in the list; edited inside the same Edit form as the rest of
-- the contact fields. Cleared = both columns NULL.

BEGIN;

ALTER TABLE medical_contacts
  ADD COLUMN IF NOT EXISTS next_appointment_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_appointment_note TEXT;

COMMIT;
