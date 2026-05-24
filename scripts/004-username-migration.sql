-- Migration: replace email-based login with username
-- Run this ONCE against the existing database.

-- 1. Add username column (nullable first so existing rows don't break)
ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR UNIQUE;

-- 2. Make email nullable (it's now optional)
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- 3. Back-fill username from email for any existing users
--    (strips the domain part so admin@cyberspace.ir → admin)
UPDATE users
SET username = split_part(email, '@', 1)
WHERE username IS NULL AND email IS NOT NULL;

-- 4. For any rows still missing a username, use their id prefix
UPDATE users
SET username = 'user_' || substring(id::text, 1, 8)
WHERE username IS NULL;

-- 5. Now enforce NOT NULL
ALTER TABLE users ALTER COLUMN username SET NOT NULL;

-- Done. Existing users can now log in with their username (email prefix).
