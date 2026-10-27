/**
 * dev-seed-demo.js — fills the LOCAL database with synthetic demo data so the
 * dashboard can be exercised without running real ingest / LLM jobs.
 *
 * Usage:
 *   node scripts/dev-seed-demo.js                 # first active profile
 *   node scripts/dev-seed-demo.js --profile <uuid>
 *   node scripts/dev-seed-demo.js --clean         # remove demo data only
 *
 * Idempotent: every demo row is tagged (external_id 'demo-…', ingest_runs
 * stats.demo = true) and removed before re-inserting. Data is generated from
 * a fixed PRNG seed, so re-runs produce a near-identical set (dates are
 * relative to now, which shifts a few random draws).
 * No external API calls are made.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('pg');

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: NODE_ENV=production. This script is for local development only.');
  process.exit(1);
}

const args = process.argv.slice(2);
const argProfile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : null;
const cleanOnly = args.includes('--clean');

const db = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: +process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
});

// ── Deterministic PRNG (mulberry32) ───────────────────────────────────────────
let seed = 0x5adeba;
function rand() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => Math.floor(a + rand() * (b - a + 1));
/** log-uniform integer in [a, b] — engagement is long-tailed */
const logBetween = (a, b) => Math.round(Math.exp(Math.log(a) + rand() * (Math.log(b) - Math.log(a))));
function pickSome(arr, min, max) {
  const n = between(min, max);
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
}
function weighted(entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of entries) { if ((r -= w) <= 0) return v; }
  return entries[entries.length - 1][0];
}

// ── Vocabulary ────────────────────────────────────────────────────────────────
const TOPICS = [
  { topic: 'بودجه', tag: 'بودجه_۱۴۰۶', subject: 'لایحه بودجه سال آینده' },
  { topic: 'تورم', tag: 'تورم', subject: 'مهار تورم و گرانی کالاهای اساسی' },
  { topic: 'مسکن', tag: 'مسکن', subject: 'طرح ساماندهی بازار مسکن و اجاره‌بها' },
  { topic: 'یارانه', tag: 'یارانه', subject: 'پرداخت یارانه و کالابرگ الکترونیک' },
  { topic: 'حقوق کارکنان', tag: 'افزایش_حقوق', subject: 'افزایش حقوق کارکنان و بازنشستگان' },
  { topic: 'فیلترینگ', tag: 'فیلترینگ', subject: 'طرح ساماندهی فضای مجازی' },
  { topic: 'بنزین', tag: 'بنزین', subject: 'قیمت و سهمیه بنزین' },
  { topic: 'خودرو', tag: 'واردات_خودرو', subject: 'واردات خودرو و قیمت بازار' },
  { topic: 'نظارت مجلس', tag: 'استیضاح', subject: 'استیضاح و نظارت بر وزرا' },
  { topic: 'شفافیت', tag: 'شفافیت_آرا', subject: 'شفافیت آرای نمایندگان' },
  { topic: 'سیاست خارجی', tag: 'مذاکرات', subject: 'مذاکرات هسته‌ای و تحریم‌ها' },
  { topic: 'انرژی', tag: 'ناترازی_برق', subject: 'ناترازی برق و خاموشی‌ها' },
  { topic: 'آب', tag: 'بحران_آب', subject: 'بحران آب و مدیریت منابع' },
  { topic: 'اشتغال', tag: 'اشتغال_جوانان', subject: 'اشتغال جوانان و فارغ‌التحصیلان' },
];

const OPENERS = {
  Positive: [
    'اقدام رئیس مجلس در خصوص {s} قابل تقدیر است.',
    'قالیباف امروز در صحن علنی از {s} دفاع کرد و این گام مثبتی است.',
    'خبر خوب: مجلس با پیگیری قالیباف {s} را تصویب کرد.',
    'پیگیری‌های رئیس مجلس درباره {s} بالاخره نتیجه داد.',
    'سخنان قالیباف درباره {s} امیدوارکننده بود.',
  ],
  Negative: [
    'وعده‌های رئیس مجلس درباره {s} هنوز عملی نشده است.',
    'انتقاد شدید کاربران از عملکرد مجلس در موضوع {s}.',
    'چرا قالیباف درباره {s} سکوت کرده است؟',
    'تصمیم اخیر مجلس درباره {s} نگرانی‌های زیادی ایجاد کرده.',
    'عملکرد مجلس در {s} ناامیدکننده بوده و مردم نتیجه‌ای ندیده‌اند.',
  ],
  Neutral: [
    'جلسه کمیسیون تلفیق با حضور قالیباف درباره {s} برگزار شد.',
    'گزارش خبرنگار ما از نشست امروز مجلس درباره {s}.',
    'رئیس مجلس در دیدار با نمایندگان به {s} اشاره کرد.',
    'جزئیات طرح جدید مجلس درباره {s} منتشر شد.',
    'نظرسنجی: دیدگاه شما درباره {s} چیست؟',
  ],
};
const CLOSERS = {
  Positive: ['امیدواریم این روند ادامه پیدا کند.', 'این همان چیزی است که مردم انتظار داشتند.', 'دست مریزاد.', ''],
  Negative: ['مردم منتظر اقدام عملی هستند.', 'این وضعیت قابل قبول نیست.', 'پاسخگویی لازم است.', ''],
  Neutral: ['جزئیات بیشتر به‌زودی اعلام می‌شود.', 'ادامه خبر را در لینک زیر بخوانید.', '', ''],
};

// Accounts per source: [screen_name, display_name, reach multiplier, stance bias, bot profile?]
// Bot profile drives the per-post bot_probability: 'bot' (high), 'sus' (mid),
// 'unscored' (LLM never scored it); omitted = mostly human.
const ACCOUNTS = {
  twitter: [
    ['akhbar_lahze_24', 'اخبار لحظه‌ای ۲۴', 1, 'Positive', 'bot'],
    ['haghighat_iran_1403', 'حقیقت ایران', 1, 'Negative', 'bot'],
    ['user83920471', 'کاربر ۸۳۹', 1, 'Negative', 'sus'],
    ['hamed_tahlil', 'حامد | تحلیلگر سیاسی', 3, 'Negative'],
    ['majles_watch', 'دیده‌بان مجلس', 4, 'Neutral'],
    ['sara_eghtesad', 'سارا اقتصاد', 2, 'Negative'],
    ['enghelabi_313', 'جوان انقلابی', 2, 'Positive'],
    ['reza_news_fa', 'رضا خبر', 1, 'Neutral'],
    ['mardom_saheb', 'مردم صاحب کشورند', 1, 'Negative'],
    ['nima_policy', 'نیما سیاستگذاری', 1, 'Neutral'],
    ['jebhe_paydari', 'هوادار جبهه', 2, 'Positive'],
  ],
  telegram: [
    ['akhbar_fori', 'اخبار فوری', 5, 'Neutral'],
    ['kanal_hamayat_313', 'کانال حمایت ۳۱۳', 1, 'Positive', 'bot'],
    ['khabar_hamrah', 'خبر همراه', 1, 'Neutral', 'sus'],
    ['majlis_news', 'خبرگزاری خانه ملت', 4, 'Positive'],
    ['eghtesad_online', 'اقتصاد آنلاین', 3, 'Negative'],
    ['tahlil_rooz', 'تحلیل روز', 2, 'Negative'],
    ['siasat_fa', 'سیاست فارسی', 2, 'Neutral'],
    ['nasle_enghelab', 'نسل انقلاب', 2, 'Positive'],
  ],
  instagram: [
    ['khabar.fori', 'خبر فوری', 5, 'Neutral'],
    ['new.page.2026', 'صفحه تازه', 1, 'Neutral', 'unscored'],
    ['iran.eghtesad', 'ایران اقتصاد', 2, 'Negative'],
    ['javan.online', 'جوان آنلاین', 2, 'Positive'],
    ['siasat.daily', 'سیاست روز', 1, 'Neutral'],
  ],
  news: [
    ['tasnimnews.ir', 'تسنیم', 4, 'Positive'],
    ['isna.ir', 'ایسنا', 4, 'Neutral'],
    ['entekhab.ir', 'انتخاب', 3, 'Negative'],
    ['khabaronline.ir', 'خبرآنلاین', 3, 'Neutral'],
    ['farsnews.ir', 'فارس', 4, 'Positive'],
  ],
  newspaper: [
    ['hamshahri', 'روزنامه همشهری', 2, 'Neutral'],
    ['shargh', 'روزنامه شرق', 2, 'Negative'],
    ['javan', 'روزنامه جوان', 2, 'Positive'],
    ['donya-e-eqtesad', 'دنیای اقتصاد', 2, 'Neutral'],
  ],
  media: [
    ['irib_news', 'خبرگزاری صداوسیما', 4, 'Positive'],
    ['ofogh_tv', 'شبکه افق', 2, 'Positive'],
    ['radio_goftogoo', 'رادیو گفتگو', 1, 'Neutral'],
  ],
  bale: [
    ['bale_khabar', 'بله خبر', 2, 'Neutral'],
    ['majles_bale', 'مجلس در بله', 1, 'Positive'],
  ],
  rubika: [
    ['rubika_akhbar', 'روبیکا اخبار', 2, 'Neutral'],
    ['khabar_dagh', 'خبر داغ', 2, 'Negative'],
  ],
  aparat: [
    ['aparat_siasi', 'آپارات سیاسی', 2, 'Neutral'],
    ['film_majles', 'فیلم مجلس', 1, 'Positive'],
  ],
  forum: [
    ['ninisite_user', 'کاربر نی‌نی‌سایت', 1, 'Negative'],
    ['forum_siasi', 'انجمن سیاسی', 1, 'Neutral'],
  ],
  eitaa: [
    ['eitaa_enghelabi', 'ایتا انقلابی', 2, 'Positive'],
    ['eitaa_khabar', 'خبر ایتا', 2, 'Neutral'],
  ],
};

// Share of posts per source (roughly mirrors the real 8tag mix)
const SOURCE_MIX = [
  ['twitter', 26], ['telegram', 22], ['instagram', 9], ['news', 14], ['newspaper', 5],
  ['media', 4], ['bale', 4], ['rubika', 4], ['aparat', 4], ['forum', 3], ['eitaa', 5],
];

// [min, max] of view_count per source (log-uniform), plus like ratio
const ENGAGEMENT = {
  twitter:   { views: [300, 250000], like: 0.03, reply: 0.006, rt: 0.008 },
  telegram:  { views: [800, 600000], like: 0.004, reply: 0.0006, rt: 0.002 },
  instagram: { views: [1000, 400000], like: 0.05, reply: 0.004, rt: 0.001 },
  news:      { views: [200, 90000], like: 0.002, reply: 0.0008, rt: 0.0004 },
  newspaper: { views: [150, 40000], like: 0.001, reply: 0.0002, rt: 0.0002 },
  media:     { views: [2000, 800000], like: 0.002, reply: 0.0003, rt: 0.0005 },
  bale:      { views: [200, 60000], like: 0.004, reply: 0.0004, rt: 0.002 },
  rubika:    { views: [300, 120000], like: 0.006, reply: 0.0008, rt: 0.002 },
  aparat:    { views: [500, 200000], like: 0.02, reply: 0.003, rt: 0.0005 },
  forum:     { views: [50, 8000], like: 0.01, reply: 0.02, rt: 0 },
  eitaa:     { views: [400, 150000], like: 0.003, reply: 0.0003, rt: 0.003 },
};

const OUTLOOK = {
  Positive: [['Optimistic', 3], ['Confident', 2], ['Neutral', 1]],
  Negative: [['Anxious', 3], ['Apprehensive', 2], ['Neutral', 1]],
  Neutral: [['Neutral', 4], ['Apprehensive', 1], ['Optimistic', 1]],
};
const SPECTRUM = {
  Positive: [['Conservative', 5], ['Moderate', 2], ['Independent', 1], ['Unknown', 1]],
  Negative: [['Reformist', 4], ['Opposition', 2], ['Moderate', 2], ['Independent', 1], ['Conservative', 1], ['Unknown', 1]],
  Neutral: [['Moderate', 3], ['Unknown', 3], ['Conservative', 2], ['Reformist', 2], ['Independent', 1]],
};

const DEMO_PROMISES = [
  'کاهش تورم به زیر ۳۰ درصد تا پایان سال',
  'تصویب قانون ساماندهی بازار اجاره مسکن',
  'شفاف‌سازی آرای نمایندگان در صحن علنی',
  'افزایش حقوق کارکنان متناسب با تورم',
];
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
// Position + validity per demo promise (index-aligned with DEMO_PROMISES)
const DEMO_PROMISE_META = [
  (t) => ({ position: 'رئیس مجلس', validFrom: ymd(t - 400 * DAY) }),
  (t) => ({ position: 'رئیس مجلس', validFrom: ymd(t - 120 * DAY), validUntil: ymd(t + 200 * DAY) }),
  (t) => ({ position: 'نماینده مجلس', validFrom: ymd(t - 900 * DAY), validUntil: ymd(t - 20 * DAY) }),
  null,
];
const DEMO_CHANNELS = [
  { platform: 'telegram', handle: 'mbghalibaf', url: 'https://t.me/mbghalibaf', followers: 182000, verified: true, active: true },
  { platform: 'x', handle: 'mb_ghalibaf', url: 'https://x.com/mb_ghalibaf', followers: 96000, verified: true, active: true },
];
const OFFICIAL_TEXTS = [
  'امروز در جلسه علنی مجلس، لایحه بودجه با رویکرد حمایت از معیشت مردم بررسی شد.',
  'ملاقات با جمعی از فعالان اقتصادی؛ رفع موانع تولید اولویت مجلس است.',
  'مجلس با تمام توان از طرح ساماندهی بازار مسکن پشتیبانی می‌کند.',
  'پیام تبریک به مناسبت روز مجلس؛ نمایندگان خادم مردم هستند.',
  'گزارش عملکرد شش‌ماهه مجلس دوازدهم منتشر شد.',
  'در دیدار با کارگران تأکید کردم که افزایش دستمزد باید با تورم متناسب باشد.',
  'شفافیت آرای نمایندگان گامی برای اعتماد بیشتر مردم است.',
  'پیگیری مشکلات کشاورزان خسارت‌دیده از خشکسالی در دستور کار است.',
];

// Cached LLM outputs, in the shapes the dashboard widgets parse
const DEMO_AI_CACHE = {
  dashboard_ai_summary: {
    summary: '[داده نمایشی] در هفته گذشته حجم گفتگو درباره رئیس مجلس حدود ۱۸٪ افزایش یافته است. '
      + 'محور اصلی بحث‌ها لایحه بودجه و مهار تورم بوده و فضای توییتر عمدتاً انتقادی است، '
      + 'در حالی که کانال‌های تلگرامی و خبرگزاری‌ها روایت خنثی تا مثبت دارند. '
      + 'موضوع مسکن و اجاره‌بها بیشترین بازنشر را داشته و می‌تواند به کانون انتقاد تبدیل شود.',
  },
  smart_recommendations: [
    { id: 1, type: 'urgent', title: 'پاسخ شفاف درباره بودجه', description: 'انتشار گزارش کوتاه از تغییرات لایحه بودجه با تمرکز بر معیشت', reason: 'افزایش ۳۰٪ پست‌های منفی درباره بودجه', suggestedTime: 'امروز', platform: 'تلگرام', icon: 'solar:danger-triangle-bold-duotone' },
    { id: 2, type: 'important', title: 'روایت‌سازی درباره طرح مسکن', description: 'ویدئوی کوتاه از مراحل اجرای طرح ساماندهی اجاره', reason: 'بیشترین بازنشر هفته', suggestedTime: 'این هفته', platform: 'اینستاگرام', icon: 'solar:home-bold-duotone' },
    { id: 3, type: 'normal', title: 'تعامل با منتقدان اقتصادی', description: 'پاسخ مستند به سه پرسش پرتکرار کاربران توییتر', reason: 'حساب‌های پربازدید منتقد', suggestedTime: 'این هفته', platform: 'توییتر', icon: 'solar:chat-round-dots-bold-duotone' },
  ],
  narrative_gap_analysis: {
    official: 'مجلس در حال تصویب بسته حمایت از معیشت است',
    officialPercent: 34,
    gapLevel: 'medium',
    public: [
      { topic: 'گرانی و تورم ادامه دارد', percent: 41, sentiment: 'negative' },
      { topic: 'وعده‌های مسکن عملی نشده', percent: 17, sentiment: 'negative' },
      { topic: 'اقدامات نظارتی مثبت بوده', percent: 8, sentiment: 'positive' },
    ],
  },
  macro_context_analysis: {
    summary: '[داده نمایشی] فضای کلان سیاسی تحت تأثیر مذاکرات هسته‌ای و تصمیمات اقتصادی مجلس است.',
  },
};

const DEMO_MACRO = {
  macro_political_context: JSON.stringify({
    events: [
      { title: '[نمایشی] بررسی لایحه بودجه در کمیسیون تلفیق', summary: 'جلسات فشرده برای نهایی‌سازی سقف درآمدها', actor: 'مجلس', severity: 'high' },
      { title: '[نمایشی] دور جدید مذاکرات', summary: 'گمانه‌زنی درباره کاهش تحریم‌ها', actor: 'وزارت خارجه', severity: 'medium' },
    ],
    tensions: { domestic: 'متوسط', foreign: 'بالا', economic: 'بالا' },
    media_atmosphere: 'رسانه‌ها بر معیشت و تورم تمرکز دارند.',
    forecast: 'احتمال افزایش انتقادها در صورت تأخیر بسته معیشتی.',
  }),
};

const DAY = 86400_000;
const HOUR = 3600_000;

function postUrl(source, sn, ext) {
  switch (source) {
    case 'twitter': return `https://x.com/${sn}/status/${ext}`;
    case 'telegram': case 'eitaa': case 'bale': case 'rubika':
      return `https://${source === 'telegram' ? 't.me' : source + '.ir'}/${sn}/${ext.slice(-5)}`;
    case 'instagram': return `https://www.instagram.com/p/${ext.slice(-11)}/`;
    case 'aparat': return `https://www.aparat.com/v/${ext.slice(-8)}`;
    case 'news': return `https://www.${sn}/news/${ext.slice(-7)}`;
    default: return null;
  }
}

function buildText(sentiment, t) {
  const opener = pick(OPENERS[sentiment]).replace('{s}', t.subject);
  const closer = pick(CLOSERS[sentiment]);
  const tags = ['#قالیباف', `#${t.tag}`];
  if (rand() < 0.4) tags.push('#مجلس');
  return [opener, closer, tags.join(' ')].filter(Boolean).join(' ');
}

function engagement(source, mult) {
  const e = ENGAGEMENT[source];
  const views = Math.min(2_000_000, Math.round(logBetween(e.views[0], e.views[1]) * (0.5 + mult * 0.35)));
  const jitter = () => 0.5 + rand();
  return {
    views,
    likes: Math.round(views * e.like * jitter()),
    replies: Math.round(views * e.reply * jitter()),
    retweets: Math.round(views * e.rt * jitter()),
  };
}

/** Published time: ~40% within the last 3 days, rest spread over 45 days. */
function publishedAt(now) {
  const ageMs = rand() < 0.4 ? HOUR + rand() * 3 * DAY : HOUR + rand() * 45 * DAY;
  const d = new Date(now - ageMs);
  // Bias toward daytime Tehran hours (UTC 04:00–19:00)
  if (d.getUTCHours() < 4 && rand() < 0.7) d.setUTCHours(d.getUTCHours() + 8);
  return d.getTime() > now - HOUR ? new Date(now - HOUR) : d;
}

async function main() {
  await db.connect();

  const profile = argProfile
    ? (await db.query('SELECT id, name, promises, official_channels FROM profiles WHERE id = $1', [argProfile])).rows[0]
    : (await db.query('SELECT id, name, promises, official_channels FROM profiles WHERE is_active = true ORDER BY created_at LIMIT 1')).rows[0];
  if (!profile) throw new Error('No profile found (pass --profile <uuid>).');
  const profileId = profile.id;
  console.log(`Profile: ${profile.name} (${profileId})`);

  await db.query('BEGIN');

  // ── Clean previous demo data ────────────────────────────────────────────────
  const delPosts = await db.query(`DELETE FROM selected_posts WHERE profile_id = $1 AND external_id LIKE 'demo-%'`, [profileId]);
  const delRuns = await db.query(`DELETE FROM ingest_runs WHERE profile_id = $1 AND stats->>'demo' = 'true'`, [profileId]);
  await db.query(`DELETE FROM hourly_aggregates WHERE profile_id = $1`, [profileId]);
  await db.query(`DELETE FROM platform_totals WHERE profile_id = $1`, [profileId]);
  console.log(`Removed previous demo data: ${delPosts.rowCount} posts, ${delRuns.rowCount} runs`);

  if (cleanOnly) {
    await rebuildAggregates(profileId);
    await db.query('COMMIT');
    console.log('Clean only — done.');
    await db.end();
    return;
  }

  // ── Profile promises + official channels (only if not set) ──────────────────
  const now0 = Date.now();
  let promises = profile.promises || [];
  if (promises.length === 0) {
    promises = DEMO_PROMISES.map((text) => ({ text, status: 'pending', addedAt: new Date(Date.now() - 60 * DAY).toISOString() }));
    await db.query('UPDATE profiles SET promises = $1::jsonb WHERE id = $2', [JSON.stringify(promises), profileId]);
    console.log(`Set ${promises.length} demo promises on profile`);
  }
  // Demo promises get a position and validity window (one already expired)
  // unless an admin has set them; other promises are left alone.
  let promisesChanged = false;
  promises = promises.map((p) => {
    const meta = DEMO_PROMISE_META[DEMO_PROMISES.indexOf(p.text)];
    if (!meta || p.position || p.validFrom || p.validUntil) return p;
    promisesChanged = true;
    return { ...p, ...meta(now0) };
  });
  if (promisesChanged) {
    await db.query('UPDATE profiles SET promises = $1::jsonb WHERE id = $2', [JSON.stringify(promises), profileId]);
    console.log('Added position / validity window to demo promises');
  }
  let channels = profile.official_channels || [];
  if (channels.length === 0) {
    channels = DEMO_CHANNELS;
    await db.query('UPDATE profiles SET official_channels = $1::jsonb WHERE id = $2', [JSON.stringify(channels), profileId]);
    console.log(`Set ${channels.length} demo official channels on profile`);
  }

  // ── Pause scheduled collection locally ──────────────────────────────────────
  // .env carries real 8tag/Promtic credentials; a dev server left running must
  // not fire cron ingests. Manual "run now" still works (it bypasses this flag).
  const { rows: [settingsRow] } = await db.query(`SELECT value FROM global_context WHERE key = 'ingest_settings'`);
  let ingestSettings = {};
  try { ingestSettings = JSON.parse(settingsRow?.value || '{}'); } catch { /* keep {} */ }
  if (ingestSettings.automaticCollectionEnabled !== false) {
    ingestSettings.automaticCollectionEnabled = false;
    await db.query(
      `INSERT INTO global_context (key, value) VALUES ('ingest_settings', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(ingestSettings)],
    );
    console.log('Disabled automatic (cron) collection in local ingest_settings');
  }

  const now = Date.now();

  // ── Ingest runs (oldest → newest) ───────────────────────────────────────────
  const runOffsets = [46 * DAY, 39 * DAY, 31 * DAY, 23 * DAY, 15 * DAY, 8 * DAY, 3 * DAY, 30 * 60_000];
  const runs = [];
  for (const off of runOffsets) {
    const startedAt = new Date(now - off);
    const finishedAt = new Date(startedAt.getTime() + between(90, 400) * 1000);
    const totalPerSource = {};
    const fetchedPerSource = {};
    const quotaPerSource = {};
    for (const [src, share] of SOURCE_MIX) {
      totalPerSource[src] = Math.round(share * between(120, 260) * (src === 'eitaa' ? 0.6 : 1));
      fetchedPerSource[src] = Math.min(totalPerSource[src], between(40, 200));
      quotaPerSource[src] = Math.max(2, Math.round(share / 2));
    }
    const { rows } = await db.query(
      `INSERT INTO ingest_runs (profile_id, started_at, finished_at, status, stats, created_at)
       VALUES ($1, $2, $3, 'completed', $4::jsonb, $2) RETURNING id`,
      [profileId, startedAt, finishedAt, JSON.stringify({ demo: true, totalPerSource, fetchedPerSource, quotaPerSource })],
    );
    runs.push({ id: rows[0].id, startedAt: startedAt.getTime(), finishedAt, fetched: Object.values(fetchedPerSource).reduce((a, b) => a + b, 0) });
  }
  // A post belongs to the first run that started after it was published
  const runFor = (ts) => (runs.find((r) => r.startedAt >= ts) || runs[runs.length - 1]).id;

  // ── Posts ───────────────────────────────────────────────────────────────────
  const posts = [];
  let seq = 0;
  const nextExt = (source) => `demo-${source}-${String(1_000_000_000 + (++seq) * 7919).padStart(12, '0')}`;

  function makePost({ source, account, sentiment, text, at, reason, topics, relevance }) {
    const [sn, dn, mult, , botProfile] = account;
    const ext = nextExt(source);
    const eng = engagement(source, mult);
    const hashtags = (text.match(/#[^\s#]+/g) || []).map((h) => h.slice(1));
    return {
      externalId: ext,
      source,
      screenName: sn,
      displayName: dn,
      text,
      publishedAt: at,
      postUrl: postUrl(source, sn, ext),
      ...eng,
      sentiment,
      outlook: weighted(OUTLOOK[sentiment]),
      spectrum: weighted(SPECTRUM[sentiment]),
      relevance: relevance ?? weighted([[5, 4], [4, 4], [3, 2], [2, 1], [1, 0.5]]),
      bot: botScore(botProfile),
      reasoning: sentiment === 'Positive' ? 'لحن حمایتی نسبت به عملکرد سوژه'
        : sentiment === 'Negative' ? 'انتقاد مستقیم از عملکرد سوژه' : 'گزارش خبری بدون موضع‌گیری',
      reason,
      hashtags: hashtags.length ? hashtags : null,
      topics,
      runId: runFor(at.getTime()),
    };
  }

  // Per-post bot_probability by account profile; ~5% of ordinary posts are unscored.
  function botScore(profile) {
    if (profile === 'unscored') return null;
    if (profile === 'bot') return between(55, 97);
    if (profile === 'sus') return between(25, 60);
    if (rand() < 0.05) return null;
    return weighted([[between(0, 15), 7], [between(15, 40), 3], [between(40, 70), 0.4]]);
  }

  const MAIN_COUNT = 380;
  for (let i = 0; i < MAIN_COUNT; i++) {
    const source = weighted(SOURCE_MIX);
    const account = pick(ACCOUNTS[source]);
    // Accounts lean toward their bias ~60% of the time
    const sentiment = rand() < 0.6 ? account[3]
      : weighted([['Positive', 3], ['Negative', 4], ['Neutral', 3]]);
    const t = weighted(TOPICS.map((x, idx) => [x, idx < 5 ? 3 : 1]));
    const extra = rand() < 0.35 ? [pick(TOPICS).topic] : [];
    const topics = [...new Set([t.topic, ...extra, ...(rand() < 0.3 ? ['مجلس'] : [])])];
    const isDisplay = rand() < 0.12;
    const reason = isDisplay
      ? `${pick(['display_top_views', 'display_top_comments', 'display_top_forwards'])}_${source}`
      : `${source}_top_${between(4, 14)}_by_${pick(['recent', 'view', 'like'])}`;
    posts.push(makePost({ source, account, sentiment, text: buildText(sentiment, t), at: publishedAt(now), reason, topics }));
  }

  // Official page posts (from the profile's own channels)
  // Official page posts span ~12 weeks with a quiet stretch (days 50–62) so the
  // weekly chart shows real zero weeks; denser in the last month.
  for (let i = 0; i < 40; i++) {
    const ch = channels[i % channels.length];
    const source = ch.platform === 'x' ? 'twitter' : ch.platform;
    let ageDays = i < 28 ? rand() * 30 : 30 + rand() * 52;
    if (ageDays > 50 && ageDays < 62) ageDays += 12;
    const at = new Date(now - HOUR - ageDays * DAY);
    posts.push(makePost({
      source,
      account: [ch.handle.replace(/^@/, ''), 'محمدباقر قالیباف', 4, 'Positive'],
      sentiment: weighted([['Positive', 3], ['Neutral', 2]]),
      text: pick(OFFICIAL_TEXTS),
      at,
      reason: `official_page_${source}_${ch.handle.replace(/^@/, '')}`,
      topics: [pick(TOPICS).topic],
      relevance: 5,
    }));
  }

  // Promise-tracking posts
  promises.forEach((p, idx) => {
    const n = between(8, 16);
    const lean = [['Positive', 2 + idx % 2], ['Negative', 3 - idx % 2], ['Neutral', 2]];
    for (let i = 0; i < n; i++) {
      const source = weighted(SOURCE_MIX.slice(0, 5));
      const account = pick(ACCOUNTS[source]);
      const sentiment = weighted(lean);
      const text = `${pick(OPENERS[sentiment]).replace('{s}', p.text)} #قالیباف #وعده`;
      posts.push(makePost({
        source, account, sentiment, text, at: publishedAt(now), reason: `promise_${idx}`,
        topics: ['وعده‌ها', TOPICS[idx % TOPICS.length].topic],
      }));
    }
  });

  // ── Insert ──────────────────────────────────────────────────────────────────
  const insertSql = `INSERT INTO selected_posts (
      ingest_run_id, profile_id, external_id, source_type, screen_name, display_name, text,
      published_at, post_url, view_count, like_count, retweet_count, reply_count,
      sentiment, political_spectrum, relevance_score, bot_probability, reasoning_brief,
      selection_reason, outlook, hashtags, ai_topics, canonical_id, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
    RETURNING id`;
  const insert = async (p, canonicalId = null) => {
    const run = runs.find((r) => r.id === p.runId);
    const { rows } = await db.query(insertSql, [
      p.runId, profileId, p.externalId, p.source, p.screenName, p.displayName, p.text,
      p.publishedAt, p.postUrl, p.views, p.likes, p.retweets, p.replies,
      p.sentiment, p.spectrum, p.relevance, p.bot, p.reasoning,
      p.reason, p.outlook, p.hashtags, p.topics, canonicalId, run.finishedAt,
    ]);
    return rows[0].id;
  };

  const ids = [];
  for (const p of posts) ids.push(await insert(p));

  // A handful of near-duplicates (canonical_id set) so dedup filters are exercised
  let dupes = 0;
  for (let i = 0; i < 10; i++) {
    const idx = Math.floor(rand() * MAIN_COUNT);
    const orig = posts[idx];
    await insert({ ...orig, externalId: nextExt(orig.source), screenName: pick(ACCOUNTS[orig.source])[0] }, ids[idx]);
    dupes++;
  }

  // Run counters
  for (const r of runs) {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM selected_posts WHERE ingest_run_id = $1', [r.id]);
    await db.query(
      `UPDATE ingest_runs SET posts_fetched = $2, posts_after_dedup = $3, posts_selected = $4,
         stats = stats || jsonb_build_object('afterFilter', $2::int, 'afterDedup', $3::int, 'selected', $4::int)
       WHERE id = $1`,
      [r.id, r.fetched, Math.round(r.fetched * 0.82), rows[0].n],
    );
  }

  await rebuildAggregates(profileId);

  // ── Platform totals (8tag total counts) per timeframe ───────────────────────
  const TF = { day: 1, week: 7, month: 30, quarter: 90 };
  for (const [tf, days] of Object.entries(TF)) {
    for (const [src, share] of SOURCE_MIX) {
      if (src === 'eitaa') continue; // not counted by PlatformTotalsService
      const total = Math.round(share * 38 * days * (0.8 + rand() * 0.4));
      await db.query(
        `INSERT INTO platform_totals (profile_id, source_type, timeframe, total, fetched_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (profile_id, source_type, timeframe) DO UPDATE SET total = EXCLUDED.total, fetched_at = EXCLUDED.fetched_at`,
        [profileId, src, tf, total],
      );
    }
  }

  await db.query(`UPDATE profiles SET daily_avg_posts = $2 WHERE id = $1`, [profileId, Math.round(posts.length / 45)]);

  // Other active profiles without any platform_totals get synthetic totals so
  // the tier suggestion can show heavy / light too (real totals are never touched).
  const { rows: others } = await db.query(
    `SELECT id, name FROM profiles p WHERE id <> $1 AND is_active = true
       AND NOT EXISTS (SELECT 1 FROM platform_totals t WHERE t.profile_id = p.id)
     ORDER BY created_at LIMIT 2`,
    [profileId],
  );
  const DAILY_FOR_OTHERS = [18_000, 220];
  for (const [i, o] of others.entries()) {
    for (const [tf, days] of Object.entries(TF)) {
      await db.query(
        `INSERT INTO platform_totals (profile_id, source_type, timeframe, total, fetched_at)
         VALUES ($1, 'telegram', $2, $3, NOW())
         ON CONFLICT (profile_id, source_type, timeframe) DO NOTHING`,
        [o.id, tf, DAILY_FOR_OTHERS[i] * days],
      );
    }
    console.log(`Synthetic platform totals for ${o.name}: ~${DAILY_FOR_OTHERS[i]}/day`);
  }

  // ── AI result cache ─────────────────────────────────────────────────────────
  // GET /ai-content/generate invokes Promtic on a cache miss, so without these
  // rows simply opening the dashboard would spend real LLM quota. Rows are
  // tagged model_name='demo-seed'; a real (non-demo) cached result is kept.
  const latestRunId = runs[runs.length - 1].id;
  for (const [promptName, result] of Object.entries(DEMO_AI_CACHE)) {
    const { rows: existing } = await db.query(
      `SELECT model_name FROM ai_result_cache WHERE profile_id = $1 AND prompt_name = $2`,
      [profileId, promptName],
    );
    if (existing.some((r) => r.model_name !== 'demo-seed')) continue;
    await db.query(`DELETE FROM ai_result_cache WHERE profile_id = $1 AND prompt_name = $2`, [profileId, promptName]);
    await db.query(
      `INSERT INTO ai_result_cache (profile_id, ingest_run_id, prompt_name, result, model_name, latency_ms)
       VALUES ($1, $2, $3, $4, 'demo-seed', 0)`,
      [profileId, latestRunId, promptName, JSON.stringify(result)],
    );
  }

  // ── Macro political context (global; only if never generated) ───────────────
  for (const [key, value] of Object.entries(DEMO_MACRO)) {
    await db.query(
      `INSERT INTO global_context (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value],
    );
  }

  await db.query('COMMIT');

  const summary = await db.query(
    `SELECT source_type, COUNT(*)::int AS n FROM selected_posts WHERE profile_id = $1 GROUP BY 1 ORDER BY 2 DESC`,
    [profileId],
  );
  console.log(`Inserted ${posts.length} posts (+${dupes} near-duplicates), ${runs.length} completed runs`);
  console.log(summary.rows.map((r) => `  ${r.source_type.padEnd(10)} ${r.n}`).join('\n'));
  await db.end();
}

/** Recompute hourly_aggregates for the profile from selected_posts (same keys as IngestWorker). */
async function rebuildAggregates(profileId) {
  await db.query(`DELETE FROM hourly_aggregates WHERE profile_id = $1`, [profileId]);
  const res = await db.query(
    `INSERT INTO hourly_aggregates (profile_id, hour, source_type, sentiment, post_count, total_views, total_likes, total_replies)
     SELECT profile_id, date_trunc('hour', published_at),
            COALESCE(src, 'all'), COALESCE(sent, 'all'),
            COUNT(*), SUM(view_count), SUM(like_count), SUM(reply_count)
     FROM (
       SELECT profile_id, published_at, source_type AS src, COALESCE(sentiment, 'Neutral') AS sent,
              view_count, like_count, reply_count
       FROM selected_posts
       WHERE profile_id = $1 AND published_at IS NOT NULL AND canonical_id IS NULL
     ) p
     GROUP BY profile_id, date_trunc('hour', published_at), GROUPING SETS ((src, sent), (src), (sent), ())`,
    [profileId],
  );
  console.log(`Rebuilt ${res.rowCount} hourly_aggregates rows`);
}

main().catch(async (e) => {
  console.error(e.message);
  try { await db.query('ROLLBACK'); } catch { /* ignore */ }
  process.exit(1);
});
