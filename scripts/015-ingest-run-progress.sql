-- Migration 015: progress tracking for asynchronous ingest runs.
-- POST /api/ingest/run-now now returns { runId } immediately and the worker
-- reports its pipeline step in `stage` and a 0–100 `progress` value, which
-- GET /api/ingest/latest-run exposes to the dashboard refresh button.
--
-- Stages: queued → fetch → dedup → store → totals → feeds → sentiment → ai → done
-- (failed runs keep the stage they failed in).

ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS stage VARCHAR(20);
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS progress SMALLINT NOT NULL DEFAULT 0;

-- Runs that finished before this migration count as done.
UPDATE ingest_runs SET stage = 'done', progress = 100
 WHERE status = 'completed' AND stage IS NULL;

-- Hourly aggregates are now keyed by the posts' published hour and rebuilt from
-- selected_posts after LLM sentiment; the trend queries filter by hour range.
CREATE INDEX IF NOT EXISTS idx_hourly_agg_profile_src_sent_hour
  ON hourly_aggregates (profile_id, source_type, sentiment, hour);
