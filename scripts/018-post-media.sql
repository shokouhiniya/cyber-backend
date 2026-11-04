-- Migration 018: post media flag + forum media_url fix
--
-- 1. Forum posts stored the thread URL (item.link) as media_url, so the UI
--    tried to render a web page as an image. Clear media_url where it is just
--    the post URL.
-- 2. selected_posts.has_media: the post has a photo / video even when the
--    platform serves no media URL (Telegram). Backfilled from media_url; the
--    Telegram photo/video flag was never stored, so older Telegram rows stay
--    false until they are re-ingested.
--
-- Idempotent: safe to run more than once.

UPDATE selected_posts
   SET media_url = NULL
 WHERE source_type = 'forum'
   AND media_url IS NOT NULL
   AND media_url = post_url;

ALTER TABLE selected_posts ADD COLUMN IF NOT EXISTS has_media boolean NOT NULL DEFAULT false;

UPDATE selected_posts
   SET has_media = true
 WHERE has_media = false
   AND media_url IS NOT NULL;
