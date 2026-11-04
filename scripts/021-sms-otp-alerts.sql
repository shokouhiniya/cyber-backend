-- Migration 021: phone login (SMS OTP), password reset, remember-me, out-of-band alerts
--
-- 1. users.phone: normalised Iranian mobile `09xxxxxxxxx`, unique when set.
--    users.phone_verified_at: set the first time an OTP to that phone is used.
--    users.password_changed_at: kept current by a trigger whenever
--    password_hash changes (self-service, reset, admin reset). Remember-me
--    refresh tokens and password-reset tokens issued before it are rejected.
-- 2. auth_otp_codes: one row per code sent. Only an HMAC of the code is
--    stored; codes expire after 2 minutes and lock after 5 wrong attempts.
-- 3. alert_settings: single-row JSON config for out-of-band alerts
--    (recipients, which events go to which channel, thresholds).
-- 4. alert_deliveries: every alert raised (sent, skipped or failed) — used
--    for de-duplication / cooldown and shown on the admin alerts page.
--
-- Idempotent: safe to run more than once.

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(11);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_format_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_phone_format_chk CHECK (phone IS NULL OR phone ~ '^09[0-9]{9}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users (phone) WHERE phone IS NOT NULL;

CREATE OR REPLACE FUNCTION users_touch_password_changed_at() RETURNS trigger AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    NEW.password_changed_at := NOW();
  END IF;
  -- A changed phone is no longer verified
  IF NEW.phone IS DISTINCT FROM OLD.phone AND NEW.phone_verified_at IS NOT DISTINCT FROM OLD.phone_verified_at THEN
    NEW.phone_verified_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_password_changed_at ON users;
CREATE TRIGGER trg_users_password_changed_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_touch_password_changed_at();

CREATE TABLE IF NOT EXISTS auth_otp_codes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone        VARCHAR(11) NOT NULL,
  purpose      VARCHAR(16) NOT NULL,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  code_hash    VARCHAR(64) NOT NULL,
  attempts     SMALLINT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  ip           VARCHAR(64),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_otp_codes_purpose_chk CHECK (purpose IN ('login', 'reset'))
);

CREATE INDEX IF NOT EXISTS idx_auth_otp_codes_phone_purpose
  ON auth_otp_codes (phone, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_settings (
  id          SMALLINT PRIMARY KEY DEFAULT 1,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT alert_settings_singleton_chk CHECK (id = 1)
);

INSERT INTO alert_settings (id, config) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS alert_deliveries (
  id          BIGSERIAL PRIMARY KEY,
  event       VARCHAR(32) NOT NULL,
  dedup_key   VARCHAR(200) NOT NULL,
  profile_id  UUID,
  title       TEXT NOT NULL,
  body        TEXT,
  channels    JSONB,
  status      VARCHAR(16) NOT NULL,
  error       TEXT,
  is_test     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT alert_deliveries_status_chk CHECK (status IN ('sent', 'partial', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_key_created
  ON alert_deliveries (dedup_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_created
  ON alert_deliveries (created_at DESC);
