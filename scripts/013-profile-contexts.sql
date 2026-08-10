-- Migration 013: Add missing columns
-- Run against production to align DB schema with entity definitions.

-- ── profiles ───────────────────────────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_contexts JSONB DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hidden_widgets TEXT[] DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS promises JSONB DEFAULT '[]';

-- ── selected_posts ─────────────────────────────────────────────────────────────
ALTER TABLE selected_posts ADD COLUMN IF NOT EXISTS outlook VARCHAR(20) DEFAULT NULL;
