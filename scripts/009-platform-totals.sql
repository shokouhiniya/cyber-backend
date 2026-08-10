-- 009-platform-totals.sql
-- Stores the 8tag total post count per (profile, source, timeframe) so the
-- platform summary widget can render instantly without live API calls.

CREATE TABLE IF NOT EXISTS platform_totals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_type   VARCHAR(30) NOT NULL,
  timeframe     VARCHAR(20) NOT NULL,   -- 'day' | 'week' | 'month' | 'quarter'
  total         BIGINT NOT NULL DEFAULT 0,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_platform_totals UNIQUE (profile_id, source_type, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_platform_totals_profile
  ON platform_totals (profile_id, fetched_at DESC);
