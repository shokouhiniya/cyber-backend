-- 002-admin-migration.sql
-- Multi-tenant admin panel foundation: extends profiles, data_sources, content
-- and adds user_profiles, global_context, admin_audit_log, usage_event.
--
-- Safe to run multiple times (idempotent).

BEGIN;

-- ----------------------------------------------------------
-- 1. Loosen users.role check and broaden the vocabulary
-- ----------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'users' AND constraint_name = 'users_role_check'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
  END IF;
END$$;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'client_admin', 'client_viewer',
                  'admin', 'official', 'consultant'));

-- Promote existing default admin user to super_admin
UPDATE users SET role = 'super_admin'
  WHERE email = 'admin@cyberspace.ir' AND role = 'admin';

-- ----------------------------------------------------------
-- 2. Extend profiles (tenancy settings + ingestion config)
-- ----------------------------------------------------------
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan              VARCHAR(50);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS expires_at        TIMESTAMP;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS primary_color     VARCHAR(32);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS logo_url          TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS excluded_keywords TEXT[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS sort_criteria     VARCHAR(50);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS promtic_identifier JSONB;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS official_channels  JSONB;

-- ----------------------------------------------------------
-- 3. Extend data_sources (per-profile + pipeline params)
-- ----------------------------------------------------------
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS profile_id       UUID REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS params           JSONB;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS schedule_cron    VARCHAR(100);
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS last_run_status  VARCHAR(50);
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS last_error       TEXT;

CREATE INDEX IF NOT EXISTS idx_data_sources_profile_id ON data_sources(profile_id);

-- ----------------------------------------------------------
-- 4. Extend content (per-profile attribution)
-- ----------------------------------------------------------
ALTER TABLE content ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_content_profile_id ON content(profile_id);

-- ----------------------------------------------------------
-- 5. user_profiles (M:N: users ↔ profiles)
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id    UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id    ON user_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_profile_id ON user_profiles(profile_id);

-- ----------------------------------------------------------
-- 6. global_context (shared variables injected into prompts)
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS global_context (
  id         SERIAL PRIMARY KEY,
  key        VARCHAR(100) UNIQUE NOT NULL,
  value      TEXT,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------
-- 7. admin_audit_log (distinct from legacy audit_logs)
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id)    ON DELETE SET NULL,
  profile_id  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100),
  entity_id   VARCHAR(255),
  diff        JSONB,
  ip          VARCHAR(64),
  user_agent  TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_user_id    ON admin_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_profile_id ON admin_audit_log(profile_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log(created_at DESC);

-- ----------------------------------------------------------
-- 8. usage_event (feature analytics)
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_event (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id)    ON DELETE SET NULL,
  profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  event_type VARCHAR(50) NOT NULL,
  event_name VARCHAR(100) NOT NULL,
  metadata   JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_usage_event_profile_id ON usage_event(profile_id);
CREATE INDEX IF NOT EXISTS idx_usage_event_event_name ON usage_event(event_name);
CREATE INDEX IF NOT EXISTS idx_usage_event_created_at ON usage_event(created_at DESC);

COMMIT;
