-- Migration 014: Add content columns that were created by synchronize:true
-- before it was disabled. These exist on live DBs but have no formal migration.

ALTER TABLE content ADD COLUMN IF NOT EXISTS type VARCHAR;
ALTER TABLE content ADD COLUMN IF NOT EXISTS category VARCHAR;
ALTER TABLE content ADD COLUMN IF NOT EXISTS subcategory VARCHAR;
ALTER TABLE content ADD COLUMN IF NOT EXISTS media_url VARCHAR;
ALTER TABLE content ADD COLUMN IF NOT EXISTS post_type VARCHAR;
ALTER TABLE content ADD COLUMN IF NOT EXISTS profile_image_url VARCHAR;
