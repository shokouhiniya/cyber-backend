-- Migration: ingest pipeline tables
-- Run once against the database.

-- ── ingest_runs ──────────────────────────────────────────────────────────────
-- One row per ingest execution per profile.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  status        VARCHAR(20) NOT NULL DEFAULT 'running',  -- running | completed | failed
  posts_fetched INTEGER NOT NULL DEFAULT 0,
  posts_after_dedup INTEGER NOT NULL DEFAULT 0,
  posts_selected INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  stats         JSONB,   -- fetchedPerSource, quotaPerSource, etc.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingest_runs_profile ON ingest_runs(profile_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_status  ON ingest_runs(status);

-- ── selected_posts ────────────────────────────────────────────────────────────
-- Posts chosen by the sample selector for a given ingest run.
-- These are the posts sent to LLMs and used for dashboard analytics.
CREATE TABLE IF NOT EXISTS selected_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingest_run_id   UUID NOT NULL REFERENCES ingest_runs(id) ON DELETE CASCADE,
  profile_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Source platform identity
  external_id     TEXT NOT NULL,   -- stable ID from the source platform
  source_type     VARCHAR(30) NOT NULL,
  screen_name     TEXT,
  display_name    TEXT,
  profile_image_url TEXT,

  -- Content
  text            TEXT,
  published_at    TIMESTAMPTZ,
  post_url        TEXT,
  media_url       TEXT,

  -- Engagement at time of ingest
  view_count      INTEGER NOT NULL DEFAULT 0,
  like_count      INTEGER NOT NULL DEFAULT 0,
  retweet_count   INTEGER NOT NULL DEFAULT 0,
  reply_count     INTEGER NOT NULL DEFAULT 0,

  -- Classification (filled by sentiment_analysis prompt)
  sentiment       VARCHAR(20),     -- Positive | Negative | Neutral
  political_spectrum VARCHAR(30),  -- Reformist | Conservative | Moderate | Opposition | Unknown
  relevance_score SMALLINT,        -- 1-5
  bot_probability SMALLINT,        -- 0-100
  reasoning_brief TEXT,

  -- Dedup
  simhash         VARCHAR(8),      -- 32-bit hex
  canonical_id    UUID,            -- references another selected_posts.id if near-duplicate

  -- Selector metadata
  selection_reason TEXT,
  hashtags        TEXT[],

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_selected_posts_profile   ON selected_posts(profile_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_selected_posts_run       ON selected_posts(ingest_run_id);
CREATE INDEX IF NOT EXISTS idx_selected_posts_sentiment ON selected_posts(profile_id, sentiment);
CREATE INDEX IF NOT EXISTS idx_selected_posts_source    ON selected_posts(profile_id, source_type);
CREATE INDEX IF NOT EXISTS idx_selected_posts_extid     ON selected_posts(external_id, source_type);

-- ── hourly_aggregates ─────────────────────────────────────────────────────────
-- Pre-computed hourly rollups for trend/spike detection.
-- One row per (profile, source, sentiment, hour).
CREATE TABLE IF NOT EXISTS hourly_aggregates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  hour          TIMESTAMPTZ NOT NULL,   -- truncated to the hour
  source_type   VARCHAR(30) NOT NULL,
  sentiment     VARCHAR(20) NOT NULL,   -- Positive | Negative | Neutral | all
  post_count    INTEGER NOT NULL DEFAULT 0,
  total_views   BIGINT NOT NULL DEFAULT 0,
  total_likes   INTEGER NOT NULL DEFAULT 0,
  total_replies INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, hour, source_type, sentiment)
);

CREATE INDEX IF NOT EXISTS idx_hourly_agg_profile ON hourly_aggregates(profile_id, hour DESC);

-- Done.
SELECT 'ingest_runs' AS tbl, COUNT(*) FROM ingest_runs
UNION ALL
SELECT 'selected_posts', COUNT(*) FROM selected_posts
UNION ALL
SELECT 'hourly_aggregates', COUNT(*) FROM hourly_aggregates;
