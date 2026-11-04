-- Migration 022: «کارشناس» role + per-user login sessions
--
-- 1. users.role accepts 'client_expert' (کارشناس): edits the data of the
--    profiles assigned to it in user_profiles and views their dashboard.
-- 2. user_sessions: one row per login session, for the «آمار استفاده» panel.
--    - opened on sign-in (start_reason 'login'), or by the first request after
--      the previous session timed out (start_reason 'resume');
--    - last_activity_at is bumped by authenticated requests, about once a minute;
--    - closed on sign-out (end_reason 'logout'), on a new sign-in ('replaced'),
--      or after 30 idle minutes ('timeout', ended_at = last_activity_at).
--    Duration = COALESCE(ended_at, last_activity_at) - started_at.
--
-- Idempotent: safe to run more than once.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'users' AND constraint_name = 'users_role_check'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
  END IF;
END$$;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'client_admin', 'client_expert', 'client_viewer',
                  'admin', 'official', 'consultant'));

CREATE TABLE IF NOT EXISTS user_sessions (
  id                BIGSERIAL PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,
  start_reason      VARCHAR(16) NOT NULL DEFAULT 'login',
  end_reason        VARCHAR(16),
  ip                VARCHAR(64),
  user_agent        TEXT,
  CONSTRAINT user_sessions_start_reason_chk CHECK (start_reason IN ('login', 'resume')),
  CONSTRAINT user_sessions_end_reason_chk CHECK (end_reason IS NULL OR end_reason IN ('logout', 'timeout', 'replaced'))
);

-- At most one open session per user
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_sessions_open
  ON user_sessions (user_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_started
  ON user_sessions (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_sessions_started
  ON user_sessions (started_at DESC);
