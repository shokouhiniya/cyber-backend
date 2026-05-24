-- 012-sort-name.sql
-- Adds sort_name column for family-name-based sorting.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS sort_name VARCHAR(100) DEFAULT NULL;

COMMENT ON COLUMN profiles.sort_name IS
  'Family name used for alphabetical sorting. Populated by seed-sort-names.js.';
