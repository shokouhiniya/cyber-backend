-- Migration 019: profile importance order, honorific, context keywords.
-- Idempotent; runs on every container start (see run-migrations.js).

-- ── profiles.honorific ────────────────────────────────────────────────────────
-- Customary title shown before the name, e.g. «حضرت آیت‌الله», «جناب آقای دکتر».
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS honorific VARCHAR(100) DEFAULT NULL;

-- ── profiles.context_keywords ─────────────────────────────────────────────────
-- Role / position terms («رئیس مجلس», «سردار»…). When the list is not empty a
-- collected post must mention at least one of them; this keeps namesakes and
-- unrelated people with the same name out. excluded_keywords (002) is the
-- opposite list: a post mentioning any of them is dropped.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS context_keywords TEXT[] NOT NULL DEFAULT '{}';

-- ── profiles.priority → importance of the position ───────────────────────────
-- 016 added priority with three presets (100 ویژه / 50 بالا / 0 عادی). It is now
-- the rank of the person's position; higher first in every profile list:
--   100 رهبری
--    90 سران قوا
--    85 رؤسای نهادهای حاکمیتی (مجمع تشخیص، شورای نگهبان، خبرگان، شورای عالی امنیت ملی)
--    80 معاونان رئیس‌جمهور، وزیران و رؤسای سازمان‌های ملی
--    70 فرماندهان ارشد نظامی و انتظامی
--    60 نمایندگان مجلس، استانداران، شهرداران، ائمه جمعه و اعضای نهادهای حاکمیتی
--    40 مقامات پیشین
--    20 فعالان سیاسی، رسانه‌ای، فرهنگی و ورزشی
--     0 تعیین‌نشده
-- The defaults below are derived from the role text once (recorded in
-- deploy_jobs) so later edits by the admin are never overwritten.
CREATE TABLE IF NOT EXISTS deploy_jobs (key VARCHAR(100) PRIMARY KEY, done_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM deploy_jobs WHERE key = 'm019_priority_from_role') THEN
    UPDATE profiles p SET priority = r.level
    FROM (
      SELECT id,
        CASE
          WHEN role IS NULL OR btrim(role) = '' THEN
            CASE WHEN priority >= 100 THEN 60 WHEN priority >= 50 THEN 40 ELSE 0 END
          WHEN role ~ '(پیشین|سابق|اسبق)' THEN 40
          WHEN role ~ '^(رهبر|مقام معظم رهبری|ولی ?فقیه)' THEN 100
          WHEN role ~ '^ر[ئي]یس[ ‌]?(جمهور|مجلس شورای|قوه قضا)' THEN 90
          WHEN role ~ '(ر[ئي]یس مجمع تشخیص|دبیر شورای نگهبان|ر[ئي]یس مجلس خبرگان|دبیر شورای (عالی )?امنیت ملی)' THEN 85
          WHEN role ~ '(معاون.*ر[ئي]یس[ ‌]?جمهور|^وزیر|سخنگوی دولت|معاون اطلاع|^ر[ئي]یس (کل بانک مرکزی|سازمان|دیوان))' THEN 80
          WHEN role ~ '^(فرمانده|ر[ئي]یس ستاد کل)' THEN 70
          WHEN role ~ '(نماینده|استاندار|شهردار|امام جمعه|عضو (مجمع|خبرگان|شورای نگهبان)|مشاور (عالی )?رهبر)' THEN 60
          ELSE 20
        END AS level
      FROM profiles
    ) r
    WHERE p.id = r.id;

    INSERT INTO deploy_jobs (key) VALUES ('m019_priority_from_role') ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;
