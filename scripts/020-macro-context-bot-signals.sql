-- Migration 020: macro briefing history + author follower count
--
-- 1. macro_context_snapshots: one row per «وضعیت کلان کشور» generation
--    attempt (cron or manual). status 'ok' rows hold the parsed briefing
--    (four sections, today's and yesterday's events only); 'failed' rows hold
--    the error. The API serves the newest 'ok' row and marks it stale when a
--    later attempt failed or it is older than 14 hours. The previous days'
--    'ok' rows are the 7-day trend and the de-duplication base.
--    global_context.macro_political_context stays the copy injected into the
--    other prompts.
-- 2. selected_posts.author_followers: the author's follower count when the
--    platform reports it (X, Instagram, forums; Telegram = channel members).
--    NULL = unknown. Used as one signal of the bot score.
--
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS macro_context_snapshots (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      VARCHAR(16) NOT NULL,
  trigger     VARCHAR(16) NOT NULL DEFAULT 'cron',
  briefing    JSONB,
  stats       JSONB,
  error       TEXT,
  model_name  VARCHAR(120),
  CONSTRAINT macro_context_snapshots_status_chk CHECK (status IN ('ok', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_macro_context_snapshots_status_created
  ON macro_context_snapshots (status, created_at DESC);

ALTER TABLE selected_posts ADD COLUMN IF NOT EXISTS author_followers INTEGER;
