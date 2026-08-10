// seed-profiles.js — run with: node scripts/seed-profiles.js
// Reads DB credentials from ../.env (or process.env)

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('pg');

const profiles = [
  { name: 'سید مجتبی خامنه‌ای', role: 'رهبر معظم انقلاب', org: 'دفتر مقام معظم رهبری', kw: ['خامنه‌ای', 'رهبر انقلاب', 'رهبری'], plan: 'enterprise', color: '#8B0000', ext: 'khamenei' },
  { name: 'مسعود پزشکیان', role: 'رئیس جمهور', org: 'ریاست جمهوری', kw: ['پزشکیان', 'رئیس جمهور', 'دولت'], plan: 'enterprise', color: '#1565C0', ext: 'pezeshkian' },
  { name: 'محمدباقر قالیباف', role: 'رئیس مجلس شورای اسلامی', org: 'مجلس شورای اسلامی', kw: ['قالیباف', 'رئیس مجلس', 'مجلس'], plan: 'enterprise', color: '#1e6091', ext: 'ghalibaf' },
  { name: 'غلامحسین محسنی اژه‌ای', role: 'رئیس قوه قضائیه', org: 'قوه قضائیه', kw: ['اژه‌ای', 'قوه قضائیه', 'قضا'], plan: 'enterprise', color: '#4A148C', ext: 'ejei' },
  { name: 'احمد جنتی', role: 'دبیر شورای نگهبان', org: 'شورای نگهبان', kw: ['جنتی', 'شورای نگهبان'], plan: 'standard', color: '#37474F', ext: 'jannati' },
  { name: 'صادق لاریجانی', role: 'رئیس مجمع تشخیص مصلحت نظام', org: 'مجمع تشخیص مصلحت نظام', kw: ['لاریجانی', 'مجمع تشخیص', 'صادق لاریجانی'], plan: 'enterprise', color: '#1B5E20', ext: 'sadegh_larijani' },
  { name: 'سعید جلیلی', role: 'عضو مجمع تشخیص و دبیر پیشین شورای عالی امنیت ملی', org: 'مجمع تشخیص مصلحت نظام', kw: ['جلیلی', 'سعید جلیلی', 'امنیت ملی'], plan: 'standard', color: '#BF360C', ext: 'jalili' },
  { name: 'محمدرضا عارف', role: 'معاون اول رئیس‌جمهور', org: 'ریاست جمهوری', kw: ['عارف', 'محمدرضا عارف', 'معاون اول'], plan: 'standard', color: '#006064', ext: 'aref' },
  { name: 'اسحاق جهانگیری', role: 'معاون پیشین رئیس جمهور', org: 'دولت', kw: ['جهانگیری', 'اسحاق جهانگیری'], plan: 'standard', color: '#33691E', ext: 'jahangiri' },
  { name: 'غلامعلی حداد عادل', role: 'رئیس مجلس پیشین', org: 'مجلس شورای اسلامی', kw: ['حداد عادل', 'غلامعلی حداد'], plan: 'standard', color: '#4E342E', ext: 'haddad_adel' },
  { name: 'حسن روحانی', role: 'رئیس جمهور پیشین', org: 'دولت', kw: ['روحانی', 'حسن روحانی'], plan: 'standard', color: '#0277BD', ext: 'rouhani' },
  { name: 'محمود احمدی‌نژاد', role: 'رئیس جمهور پیشین', org: 'دولت', kw: ['احمدی‌نژاد', 'محمود احمدی نژاد'], plan: 'standard', color: '#E65100', ext: 'ahmadinejad' },
  { name: 'سید محمد خاتمی', role: 'رئیس جمهور پیشین', org: 'دولت', kw: ['خاتمی', 'سید محمد خاتمی'], plan: 'standard', color: '#00695C', ext: 'khatami' },
  { name: 'محسن رضایی', role: 'مشاور رهبری', org: 'دفتر مقام معظم رهبری', kw: ['محسن رضایی', 'رضایی'], plan: 'standard', color: '#558B2F', ext: 'rezaei' },
  { name: 'احمد وحیدی', role: 'فرمانده کل سپاه پاسداران', org: 'سپاه پاسداران', kw: ['وحیدی', 'احمد وحیدی', 'سپاه'], plan: 'standard', color: '#212121', ext: 'vahidi' },
  { name: 'امیر حاتمی', role: 'فرمانده کل ارتش', org: 'ارتش جمهوری اسلامی ایران', kw: ['امیر حاتمی', 'حاتمی', 'ارتش'], plan: 'standard', color: '#263238', ext: 'hatami_army' },
  { name: 'اسماعیل قاآنی', role: 'فرمانده نیروی قدس سپاه', org: 'سپاه پاسداران', kw: ['قاآنی', 'اسماعیل قاآنی', 'نیروی قدس'], plan: 'standard', color: '#1A237E', ext: 'qaani' },
  { name: 'اسکندر مومنی', role: 'وزیر کشور', org: 'وزارت کشور', kw: ['مومنی', 'اسکندر مومنی', 'وزیر کشور'], plan: 'standard', color: '#37474F', ext: 'momeni' },
  { name: 'سیدمجید موسوی', role: 'فرمانده نیروی هوافضای سپاه', org: 'سپاه پاسداران', kw: ['سیدمجید موسوی', 'موسوی', 'هوافضای سپاه'], plan: 'standard', color: '#0D47A1', ext: 'mousavi_aerospace' },
  { name: 'امیر حیدری', role: 'فرمانده نیروی زمینی ارتش', org: 'ارتش جمهوری اسلامی ایران', kw: ['امیر حیدری', 'حیدری', 'نیروی زمینی'], plan: 'standard', color: '#1B5E20', ext: 'heydari_army' },
  { name: 'محمد اسلامی', role: 'رئیس سازمان انرژی اتمی', org: 'سازمان انرژی اتمی ایران', kw: ['محمد اسلامی', 'اسلامی', 'انرژی اتمی', 'هسته‌ای'], plan: 'standard', color: '#4A148C', ext: 'eslami_atomic' },
  { name: 'عبدالناصر همتی', role: 'رئیس کل بانک مرکزی', org: 'بانک مرکزی', kw: ['همتی', 'عبدالناصر همتی', 'بانک مرکزی'], plan: 'standard', color: '#006064', ext: 'hemmati' },
  { name: 'محمدجواد ظریف', role: 'وزیر خارجه پیشین', org: 'وزارت امور خارجه', kw: ['ظریف', 'محمدجواد ظریف', 'وزیر خارجه'], plan: 'standard', color: '#1565C0', ext: 'zarif' },
  { name: 'فاطمه مهاجرانی', role: 'سخنگوی دولت', org: 'ریاست جمهوری', kw: ['مهاجرانی', 'فاطمه مهاجرانی', 'سخنگوی دولت'], plan: 'standard', color: '#880E4F', ext: 'mohajerani' },
  { name: 'پیمان جبلی', role: 'رئیس سازمان صداوسیما', org: 'سازمان صداوسیما', kw: ['جبلی', 'پیمان جبلی', 'صداوسیما'], plan: 'standard', color: '#E65100', ext: 'jabali' },
  { name: 'احمدرضا رادان', role: 'فرمانده انتظامی', org: 'نیروی انتظامی', kw: ['رادان', 'احمدرضا رادان', 'نیروی انتظامی', 'پلیس'], plan: 'standard', color: '#212121', ext: 'radan' },
  { name: 'ستار هاشمی', role: 'وزیر ارتباطات و فناوری اطلاعات', org: 'وزارت ارتباطات', kw: ['ستار هاشمی', 'هاشمی', 'وزیر ارتباطات', 'فناوری اطلاعات'], plan: 'standard', color: '#00838F', ext: 'hashemi_ict' },
  { name: 'سید عباس عراقچی', role: 'وزیر خارجه', org: 'وزارت امور خارجه', kw: ['عراقچی', 'سید عباس عراقچی', 'وزیر خارجه', 'دیپلماسی'], plan: 'enterprise', color: '#1565C0', ext: 'araghchi' },
  { name: 'سیدعلی مدنی‌زاده', role: 'وزیر اقتصاد', org: 'وزارت اقتصاد', kw: ['مدنی‌زاده', 'سیدعلی مدنی زاده', 'وزیر اقتصاد', 'اقتصاد'], plan: 'standard', color: '#2E7D32', ext: 'madanizadeh' },
  { name: 'ابراهیم حاتمی‌کیا', role: 'کارگردان سینما', org: 'سینمای ایران', kw: ['حاتمی‌کیا', 'ابراهیم حاتمی کیا', 'سینما', 'فیلم'], plan: 'standard', color: '#6A1B9A', ext: 'hatamikia' },
  { name: 'الیاس حضرتی', role: 'معاون اطلاع‌رسانی دولت', org: 'ریاست جمهوری', kw: ['حضرتی', 'الیاس حضرتی', 'اطلاع رسانی دولت'], plan: 'standard', color: '#37474F', ext: 'hazrati' },
  { name: 'محمدباقر ذوالقدر', role: 'دبیر شورای امنیت ملی', org: 'شورای عالی امنیت ملی', kw: ['ذوالقدر', 'محمدباقر ذوالقدر', 'شورای امنیت ملی'], plan: 'standard', color: '#1A237E', ext: 'zolqadr' },
  { name: 'حمیدرضا حاجی‌بابایی', role: 'نماینده مجلس', org: 'مجلس شورای اسلامی', kw: ['حاجی بابایی', 'حمیدرضا حاجی بابایی', 'نماینده مجلس'], plan: 'standard', color: '#4E342E', ext: 'hajibabai' },
  { name: 'علیرضا دبیر', role: 'رئیس فدراسیون کشتی', org: 'فدراسیون کشتی', kw: ['علیرضا دبیر', 'دبیر', 'فدراسیون کشتی', 'کشتی'], plan: 'standard', color: '#BF360C', ext: 'dabir' },
  { name: 'محمدرضا صباغیان', role: 'نماینده یزد', org: 'مجلس شورای اسلامی', kw: ['صباغیان', 'محمدرضا صباغیان', 'نماینده یزد'], plan: 'standard', color: '#558B2F', ext: 'sabbagian' },
  { name: 'سید عزت‌الله ضرغامی', role: 'وزیر پیشین فرهنگ و ارشاد', org: 'وزارت فرهنگ و ارشاد اسلامی', kw: ['ضرغامی', 'سید عزت الله ضرغامی', 'فرهنگ و ارشاد'], plan: 'standard', color: '#E65100', ext: 'zarghami' },
  { name: 'امیر قلعه‌نویی', role: 'سرمربی تیم ملی', org: 'فدراسیون فوتبال', kw: ['قلعه نویی', 'امیر قلعه نویی', 'تیم ملی', 'فوتبال'], plan: 'standard', color: '#1B5E20', ext: 'ghalenoi' },
  { name: 'امیرحسین ثابتی', role: 'فعال سیاسی', org: 'مستقل', kw: ['ثابتی', 'امیرحسین ثابتی'], plan: 'standard', color: '#37474F', ext: 'sabeti' },
  { name: 'علیرضا زاکانی', role: 'شهردار تهران', org: 'شهرداری تهران', kw: ['زاکانی', 'علیرضا زاکانی', 'شهردار تهران', 'شهرداری'], plan: 'standard', color: '#C62828', ext: 'zakani' },
  { name: 'مصطفی تاجزاده', role: 'فعال سیاسی', org: 'مستقل', kw: ['تاجزاده', 'مصطفی تاجزاده'], plan: 'standard', color: '#00695C', ext: 'tajzadeh' },
  { name: 'محمدرضا باهنر', role: 'فعال سیاسی اصولگرا', org: 'مستقل', kw: ['باهنر', 'محمدرضا باهنر', 'اصولگرا'], plan: 'standard', color: '#4E342E', ext: 'bahonar' },
  { name: 'علی نیکزاد', role: 'فعال سیاسی', org: 'مستقل', kw: ['نیکزاد', 'علی نیکزاد'], plan: 'standard', color: '#37474F', ext: 'nikzad' },
  { name: 'مهدی کروبی', role: 'فعال سیاسی', org: 'مستقل', kw: ['کروبی', 'مهدی کروبی'], plan: 'standard', color: '#0277BD', ext: 'karroubi' },
  { name: 'مهدی رسولی', role: 'مداح', org: 'مستقل', kw: ['مهدی رسولی', 'رسولی', 'مداح'], plan: 'standard', color: '#880E4F', ext: 'rasouli' },
  { name: 'حسام‌الدین آشنا', role: 'مشاور پیشین رئیس جمهور', org: 'دولت', kw: ['آشنا', 'حسام الدین آشنا', 'مشاور رئیس جمهور'], plan: 'standard', color: '#006064', ext: 'ashna' },
  { name: 'علیرضا قاسمیان', role: 'روحانی و فعال مذهبی', org: 'مستقل', kw: ['قاسمیان', 'علیرضا قاسمیان', 'روحانی', 'مذهبی'], plan: 'standard', color: '#4A148C', ext: 'ghasemian' },
  { name: 'احمد زیدآبادی', role: 'تحلیلگر سیاسی', org: 'مستقل', kw: ['زیدآبادی', 'احمد زیدآبادی', 'تحلیلگر سیاسی'], plan: 'standard', color: '#33691E', ext: 'zeidabadi' },
  { name: 'صادق زیباکلام', role: 'استاد دانشگاه', org: 'دانشگاه تهران', kw: ['زیباکلام', 'صادق زیباکلام', 'استاد دانشگاه'], plan: 'standard', color: '#1565C0', ext: 'zibakalam' },
  { name: 'حسین افشین', role: 'معاون علم و فناوری رئیس جمهور', org: 'ریاست جمهوری', kw: ['افشین', 'حسین افشین', 'علم و فناوری'], plan: 'standard', color: '#00838F', ext: 'afshin' },
  { name: 'سید احمد خاتمی', role: 'عضو خبرگان و امام جمعه موقت', org: 'مجلس خبرگان رهبری', kw: ['سید احمد خاتمی', 'احمد خاتمی', 'امام جمعه', 'خبرگان'], plan: 'standard', color: '#BF360C', ext: 'ahmad_khatami' },
];

async function run() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'cyber',
  });

  await client.connect();
  console.log('Connected to DB');

  // Create the unique index OUTSIDE the transaction so it's visible immediately
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_promtic_ext_id
      ON profiles ((promtic_identifier->>'external_id'))
      WHERE promtic_identifier IS NOT NULL
  `);
  console.log('Unique index ready');

  try {
    await client.query('BEGIN');

    let inserted = 0;
    let skipped = 0;

    for (const p of profiles) {
      const identifier = JSON.stringify({
        external_id: p.ext,
        name: p.name,
        type: 'political_figure',
      });

      const res = await client.query(
        `INSERT INTO profiles
           (id, name, role, organization, keywords, excluded_keywords,
            sort_criteria, plan, primary_color, promtic_identifier,
            is_active, created_at, updated_at)
         SELECT
           gen_random_uuid(), $1, $2, $3, $4, ARRAY[]::text[],
           'recent', $5, $6, $7::jsonb, true, NOW(), NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM profiles
           WHERE promtic_identifier->>'external_id' = $8
         )`,
        [p.name, p.role, p.org, p.kw, p.plan, p.color, identifier, p.ext]
      );

      if (res.rowCount > 0) {
        inserted++;
        console.log(`  ✓ ${p.name}`);
      } else {
        skipped++;
        console.log(`  – ${p.name} (already exists)`);
      }
    }

    await client.query('COMMIT');
    console.log(`\nDone: ${inserted} inserted, ${skipped} skipped`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error — rolled back:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
