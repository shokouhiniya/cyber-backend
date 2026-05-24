-- 010-profile-baselines.sql
-- Adds a baseline_stats JSONB column to profiles for storing quarterly averages
-- used by the crisis radar to compare current activity against expected levels.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS baseline_stats JSONB DEFAULT '{}';

COMMENT ON COLUMN profiles.baseline_stats IS
  'Quarterly baseline stats from profile-stats.csv: { totalPosts, avgDailyPosts, avgViews, avgInteractions, perSource: { telegram: { total, avgViews }, ... } }';
