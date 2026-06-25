-- Attribute each medical test result to a household member (Tests tab person selector).
-- ON DELETE SET NULL so test history survives if the member is later removed.
ALTER TABLE medical_test_results
  ADD COLUMN IF NOT EXISTS user_id integer REFERENCES household_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_med_test_user ON medical_test_results(user_id);
