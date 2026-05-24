-- 008-dedup-selected-posts.sql
-- Removes exact duplicate posts (same external_id + source_type + profile_id)
-- keeping the row with the most complete data (has sentiment/relevance, then newest).
-- Then adds a unique constraint so orIgnore() works correctly going forward.

BEGIN;

-- Step 1: For each duplicate group, keep the best row (most fields filled),
-- delete the rest.
DELETE FROM selected_posts
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY external_id, source_type, profile_id
        ORDER BY
          -- prefer rows that have been sentiment-classified
          (CASE WHEN sentiment IS NOT NULL THEN 0 ELSE 1 END),
          (CASE WHEN relevance_score IS NOT NULL THEN 0 ELSE 1 END),
          -- then prefer the most recently inserted (latest ingest run)
          created_at DESC
      ) AS rn
    FROM selected_posts
  ) ranked
  WHERE rn > 1
);

-- Step 2: Drop the old non-unique index (will be replaced by the constraint)
DROP INDEX IF EXISTS idx_selected_posts_extid;

-- Step 3: Add the unique constraint that orIgnore() needs
ALTER TABLE selected_posts
  ADD CONSTRAINT uq_selected_posts_extid_source_profile
  UNIQUE (external_id, source_type, profile_id);

COMMIT;
