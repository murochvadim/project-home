-- 008_journal_categories.sql — Daily Journal gains user-defined CATEGORIES
-- ("gloomys", e.g. Politics / Weather / Special things). Each (user, day, slot)
-- capture is now DIVIDED into one row per category. The mood rating is dropped
-- (categories-only, per user request 2026-07-08).
--
-- The category list lives in dashboard_settings.journal.categories (managed in
-- Privacy → Settings). Old rows fold into a 'general' category so history stays
-- readable; the frontend seeds a "General" category when cfg.categories is empty.

BEGIN;

ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS category_id   TEXT;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS category_name TEXT;

-- fold every pre-existing entry into the default category
UPDATE journal_entries SET category_id = 'general', category_name = 'General'
 WHERE category_id IS NULL;

ALTER TABLE journal_entries ALTER COLUMN category_id SET DEFAULT 'general';
ALTER TABLE journal_entries ALTER COLUMN category_id SET NOT NULL;

-- mood is gone (categories-only)
ALTER TABLE journal_entries DROP COLUMN IF EXISTS mood;

-- the old (user,date,slot) unique index would reject a 2nd category in the same
-- slot — replace it with the 4-column key so each category gets its own row.
DROP INDEX IF EXISTS uq_journal_user_date_slot;
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_user_date_slot_cat
  ON journal_entries(user_id, entry_date, slot_id, category_id);
CREATE INDEX IF NOT EXISTS ix_journal_category ON journal_entries(category_id);

COMMIT;
