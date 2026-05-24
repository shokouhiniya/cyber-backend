CREATE TABLE IF NOT EXISTS ai_result_cache (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  ingest_run_id UUID REFERENCES ingest_runs(id) ON DELETE SET NULL,
  prompt_name   VARCHAR(60) NOT NULL,
  result        TEXT NOT NULL,
  token_usage   JSONB,
  model_name    VARCHAR(60),
  latency_ms    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, ingest_run_id, prompt_name)
);
CREATE INDEX IF NOT EXISTS idx_ai_cache_profile ON ai_result_cache(profile_id, prompt_name, created_at DESC);
SELECT 'ai_result_cache OK' AS msg;
