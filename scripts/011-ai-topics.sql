-- 011-ai-topics.sql
-- Adds ai_topics column to selected_posts for LLM-generated keywords/topics.

ALTER TABLE selected_posts
  ADD COLUMN IF NOT EXISTS ai_topics TEXT[] DEFAULT NULL;
