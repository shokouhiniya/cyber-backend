-- Migration 016: in-app notifications + profile priority.
-- Idempotent; safe to re-run.

-- ── profiles.priority ─────────────────────────────────────────────────────────
-- Higher = more important. Lists sort by priority DESC, then sort_name.
-- UI presets: 100 = ویژه, 50 = بالا, 0 = عادی.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_profiles_priority ON profiles (priority DESC, sort_name);

-- ── notifications ─────────────────────────────────────────────────────────────
-- Targeting:
--   user_id set                → only that user
--   user_id NULL, profile_id   → every user who can access that profile
--   both NULL                  → broadcast to everyone
-- audience = 'admin' limits a row to super_admin users (ops alerts).
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id  UUID NULL REFERENCES profiles(id) ON DELETE CASCADE,
  audience    VARCHAR(16) NOT NULL DEFAULT 'all',
  type        VARCHAR(64) NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NULL,
  link        TEXT NULL,
  meta        JSONB NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at     TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_profile ON notifications (profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_type_profile ON notifications (type, profile_id, created_at DESC);

-- Per-user read state. read_at on notifications only covers single-user rows;
-- shared rows (profile-scoped / broadcast) are marked read per user here.
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (notification_id, user_id)
);
