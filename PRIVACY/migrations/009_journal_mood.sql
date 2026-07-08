-- 009_journal_mood.sql — re-add the mood rating to the Daily Journal.
-- Mood was dropped in 008 (categories-only) but the user wants the 😞→😄 (1–5)
-- back as ONE mood PER CAPTURE (per user/day/slot). Because rows are keyed per
-- category, the same mood value is stored on every category row of that capture
-- (read back from any of them). Old pre-008 mood values are gone — nullable, so
-- existing rows just get NULL.

BEGIN;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS mood SMALLINT;   -- 1..5, nullable
COMMIT;
