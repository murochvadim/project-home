-- Medical contacts: standalone reminder text per contact (added 2026-06-03).
-- Pure text, no date — for things like "renew prescription", "ask about
-- new medication", "bring last X-ray".  Independent of the appointment
-- slot (005); rendered as a blue nested card beside the red appointment
-- card on the contact row in the list.

BEGIN;

ALTER TABLE medical_contacts
  ADD COLUMN IF NOT EXISTS reminder_text TEXT;

COMMIT;
