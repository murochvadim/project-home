-- 021_bp_context_note.sql — Personal Health blood pressure: capture measurement context
-- context: 'rest' (At rest) | 'exertion' (After exertion); note: free-text how-measured
-- (arm, posture, device, minutes rested, etc.). Both nullable; existing rows stay NULL.
ALTER TABLE ph_bp ADD COLUMN IF NOT EXISTS context TEXT;
ALTER TABLE ph_bp ADD COLUMN IF NOT EXISTS note    TEXT;
