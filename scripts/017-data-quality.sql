-- Migration 017: data quality (phase 2)
--
-- 1. global_context.blocked_accounts — admin-editable blocklist of account
--    handles hidden from every user-facing list / stat / influencer map.
--    Format: JSON array of handles, lowercase, without "@":
--      ["some_proxy_channel", "vpn_ads"]
--    Seeded with handles already stored that look like proxy / VPN ad channels.
--    (Those are also excluded by pattern at query time; listing them here just
--    makes them visible / editable in the admin global-context page.)
-- 2. Partial index for the official-channel status query (MAX(published_at)
--    per official_page_<source>_<handle>).
--
-- Idempotent: safe to run more than once.

INSERT INTO global_context (key, value)
SELECT 'blocked_accounts', COALESCE(json_agg(DISTINCT LOWER(screen_name))::text, '[]')
FROM selected_posts
WHERE screen_name ~* '(proxy|vpn|v2ray|فیلتر ?شکن|پروکسی|پراکسی)'
   OR display_name ~* '(proxy|vpn|v2ray|فیلتر ?شکن|پروکسی|پراکسی)'
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_selected_posts_official
  ON selected_posts (profile_id, selection_reason, published_at DESC)
  WHERE selection_reason LIKE 'official_page_%';
