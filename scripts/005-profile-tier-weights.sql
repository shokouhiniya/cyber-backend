-- Migration: add tier, daily_avg_posts, source_weights to profiles
-- Run once against the database.

-- 1. Add new columns
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS tier VARCHAR(10) NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS daily_avg_posts FLOAT,
  ADD COLUMN IF NOT EXISTS source_weights JSONB NOT NULL DEFAULT '{}';

-- 2. Seed tier + daily_avg_posts from observed quarterly stats (total/90 days)
--    Heavy  : >10k/day  (پزشکیان, خامنه‌ای, قالیباف, عراقچی)
--    Light  : <500/day  (all others below threshold)
--    Medium : everything else

UPDATE profiles SET tier = 'heavy', daily_avg_posts = ROUND((
  CASE promtic_identifier->>'external_id'
    WHEN 'pezeshkian'  THEN 2011230.0 / 90
    WHEN 'khamenei'    THEN  906494.0 / 90
    WHEN 'ghalibaf'    THEN 1110414.0 / 90
    WHEN 'araghchi'    THEN 1141217.0 / 90
    ELSE NULL
  END
)::numeric, 0)
WHERE promtic_identifier->>'external_id' IN ('pezeshkian','khamenei','ghalibaf','araghchi');

UPDATE profiles SET tier = 'light', daily_avg_posts = ROUND((
  CASE promtic_identifier->>'external_id'
    WHEN 'sabbagian'       THEN  1398.0 / 90
    WHEN 'jabali'          THEN  4612.0 / 90
    WHEN 'afshin'          THEN  8175.0 / 90
    WHEN 'hajibabai'       THEN 14981.0 / 90
    WHEN 'ashna'           THEN  8957.0 / 90
    WHEN 'madanizadeh'     THEN 42684.0 / 90
    WHEN 'tajzadeh'        THEN  5549.0 / 90
    WHEN 'karroubi'        THEN  8892.0 / 90
    WHEN 'ghasemian'       THEN 11236.0 / 90
    WHEN 'zarghami'        THEN 13490.0 / 90
    WHEN 'heydari_army'    THEN 10587.0 / 90
    WHEN 'zeidabadi'       THEN 13082.0 / 90
    WHEN 'bahonar'         THEN 14228.0 / 90
    WHEN 'dabir'           THEN 11576.0 / 90
    WHEN 'nikzad'          THEN 26632.0 / 90
    WHEN 'ahmad_khatami'   THEN 13681.0 / 90
    WHEN 'khatami'         THEN 12632.0 / 90
    WHEN 'hatamikia'       THEN  6790.0 / 90
    ELSE NULL
  END
)::numeric, 0)
WHERE promtic_identifier->>'external_id' IN (
  'sabbagian','jabali','afshin','hajibabai','ashna','madanizadeh',
  'tajzadeh','karroubi','ghasemian','zarghami','heydari_army',
  'zeidabadi','bahonar','dabir','nikzad','ahmad_khatami','khatami','hatamikia'
);

-- 3. Fill daily_avg_posts for remaining medium profiles
UPDATE profiles SET daily_avg_posts = ROUND((
  CASE promtic_identifier->>'external_id'
    WHEN 'sabeti'          THEN  42357.0 / 90
    WHEN 'rouhani'         THEN 167906.0 / 90
    WHEN 'zarif'           THEN 232255.0 / 90
    WHEN 'zakani'          THEN  72742.0 / 90
    WHEN 'jalili'          THEN  65147.0 / 90
    WHEN 'mousavi_aerospace' THEN 385958.0 / 90
    WHEN 'ejei'            THEN 203955.0 / 90
    WHEN 'radan'           THEN  56813.0 / 90
    WHEN 'vahidi'          THEN  62911.0 / 90
    WHEN 'mohajerani'      THEN 158558.0 / 90
    WHEN 'aref'            THEN 265732.0 / 90
    WHEN 'ahmadinejad'     THEN  40347.0 / 90
    WHEN 'hemmati'         THEN  84562.0 / 90
    WHEN 'sadegh_larijani' THEN  32545.0 / 90
    WHEN 'zibakalam'       THEN  13806.0 / 90
    WHEN 'rezaei'          THEN 111424.0 / 90
    WHEN 'hashemi_ict'     THEN  67436.0 / 90
    WHEN 'qaani'           THEN  60412.0 / 90
    WHEN 'hatami_army'     THEN  54743.0 / 90
    WHEN 'ghalenoi'        THEN  60594.0 / 90
    WHEN 'hazrati'         THEN  47098.0 / 90
    WHEN 'momeni'          THEN  81742.0 / 90
    WHEN 'jahangiri'       THEN   7530.0 / 90
    WHEN 'jannati'         THEN  52141.0 / 90
    WHEN 'jabali'          THEN   4612.0 / 90
    WHEN 'zarghami'        THEN  13490.0 / 90
    WHEN 'haddad_adel'     THEN  34271.0 / 90
    WHEN 'eslami_atomic'   THEN  19080.0 / 90
    WHEN 'zolqadr'         THEN  32271.0 / 90
    WHEN 'rasouli'         THEN  73728.0 / 90
    WHEN 'nikzad'          THEN  26632.0 / 90
    WHEN 'khamenei_s'      THEN  12632.0 / 90
    ELSE NULL
  END
)::numeric, 0)
WHERE tier = 'medium' AND daily_avg_posts IS NULL;

-- Done.
SELECT tier, COUNT(*) FROM profiles GROUP BY tier ORDER BY tier;
