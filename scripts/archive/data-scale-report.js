/**
 * data-scale-report.js
 *
 * For each of the 25 target profiles, queries the API for 100 random posts
 * from each source over the past year, then records:
 *   - total: total results the API says exist
 *   - shown: how many pass our internal filters (language, hashtag spam, STT)
 *
 * Writes each row immediately so progress is saved even if interrupted.
 * Re-running skips profiles already in the output file.
 *
 * Output: extra_files/data-scale-report.csv
 * Usage:  node scripts/data-scale-report.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── Internal filters ──────────────────────────────────────────────────────────

function isKurdish(t) {
  if (!t || t.length < 5) return false;
  if (/[\u06A4\u06CE\u06C6]/.test(t)) return true;
  return (t.match(/[\u06B5\u0695\u06D5]/g) || []).length >= 2;
}
function isUrdu(t) { return t && t.length >= 5 && /[\u06D2\u06BA\u0679\u0688\u0691]/.test(t); }
function isArabic(t) {
  if (!t || t.length < 10 || isKurdish(t) || isUrdu(t)) return false;
  const fa = (t.match(/[\u06A9\u06AF\u0686\u067E\u0698\u06CC\u06F0-\u06F9]/g) || []).length;
  const ar = (t.match(/[\u0643\u064A\u0629\u0649\u0626\u0624]/g) || []).length;
  if (!ar) return false;
  if (!fa) return true;
  return ar / fa >= 3;
}
function isNonPersian(t) { return isKurdish(t) || isUrdu(t) || isArabic(t); }
function isGarbledStt(t) {
  if (!t) return false;
  const w = t.trim().split(/\s+/).filter(Boolean);
  if (w.length < 10) return false;
  const avg = w.reduce((s, x) => s + x.length, 0) / w.length;
  const short = w.filter(x => x.length <= 3).length / w.length;
  return avg < 3.5 && short > 0.60;
}
function passes(item, source) {
  const t = item.text || '';
  if (isNonPersian(t)) return false;
  const s = Array.isArray(item.hashtags) ? item.hashtags.length : 0;
  const i = (t.match(/#[\u0600-\u06FF\w]+/g) || []).length;
  if (Math.max(s, i) > 10) return false;
  if (source === 'media' && isGarbledStt(t)) return false;
  return true;
}

// ── Profiles ──────────────────────────────────────────────────────────────────

const PROFILES = [
  {name:'ابراهیم حاتمی\u200Cکیا',or:'حاتمی\u200Cکیا|ابراهیم حاتمی کیا|ابراهیم حاتمی',not:'علی حاتمی|لیلا حاتمی'},
  {name:'احمد جنتی',or:'جنتی',not:'رضا جنتی|جنتی عطایی|دکتر جنتی|ایرج جنتی|علی جنتی|حسین جنتی|محمد جنتی|بنیاد مسکن|جلال جنتی|سرای جنتی|کوثر جنتی|پاساژ جنتی'},
  {name:'احمد زیدآبادی',or:'زیدآبادی|احمد زیدآبادی|زیدابادی',not:'دکتر زیدآبادی|حسن اسدی زیدآبادی|اسدی زیدآبادی'},
  {name:'احمد وحیدی',or:'وحیدی|احمد وحیدی|سردار وحیدی|وحیدی سپاه|فرمانده کل سپاه',not:'دکتر وحیدی|مهسا وحیدی|محمد وحیدی|امیر وحیدی|میثم وحیدی|جواد وحیدی|پاکپور|جعفری'},
  {name:'احمدرضا رادان',or:'رادان|احمدرضا رادان|فرمانده انتظامی|سردار رادان|رادان سردار|احمد رادان|احمد رضا رادان',not:'بهرام رادان|آهنگ رادان|امیر رادان|شهید رادان'},
  {name:'اسحاق جهانگیری',or:'جهانگیری|اسحاق جهانگیری|جهان گیری|اسحق جهانگیری',not:'مهدی جهانگیری|فرهاد جهانگیری|آهنگ جهانگیری|برادر جهانگیری|فرهاد|محمد جهانگیری|آهنگ|اهنگ|اصغر جهانگیری|پوریا جهانگیری|خیابان جهانگیری|اکبر جهانگیری|مرتضی جهانگیری|حیدر جهانگیری|شهین جهانگیری|کانی جهانگیری|حسین جهانگیری|بیماری|باغات جهانگیری'},
  {name:'اسکندر مومنی',or:'اسکندر مومنی|وزیر کشور جمهوری اسلامی|وزارت کشور جمهوری اسلامی|اسکندر مؤمنی',not:'دکتر مومنی|مزدافر|علی مومنی|حسین مومنی|محمد مومنی|مریم مومنی|حسن مومنی|مهدی مومنی|رضا مومنی|مدرسه مومنی|سعید مومنی|امیرالمومنین|نخست وزیر|فرشاد مومنی|امیرعباس مومنی|خانم مومنی|مردم مومن|آدم مومن'},
  {name:'اسماعیل قاآنی',or:'قاآنی|اسماعیل قاآنی|فرمانده نیروی قدس',not:'بلوار قاآنی|خیابان قاآنی|قاآنی شمالی|قاآنی جنوبی|قاآنی شیرازی|شعر قاآنی|غزلیات قاآنی'},
  {name:'الیاس حضرتی',or:'الیاس حضرتی',not:'مداحی|غذای|دکتر حضرتی|آهنگ|بازار حضرتی'},
  {name:'امیر حاتمی',or:'امیر حاتمی|سرلشکر حاتمی|حاتمی ارتش|فرمانده کل ارتش|امیر_حاتمی',not:'لیلا حاتمی|دکتر حاتمی|علی حاتمی|حاتمی کیا|آهنگ حاتمی|کیوان حاتمی|مجید حاتمی|محمد حاتمی|ارتش پاکستان|حسین حاتمی|امیرحسین_حاتمی|مردعلی_حاتمی'},
  {name:'امیر حیدری',or:'امیر حیدری|سردار حیدری|فرمانده نیروی زمینی ارتش',not:'جهانشاهی|آهنگ|ترکی|آذری'},
  {name:'امیر قلعه\u200Cنویی',or:'قلعه نویی|امیر قلعه نویی|قلعه نوئی|قلعه نوعی',not:'علی قلعه نویی|اردشیر قلعه نویی'},
  {name:'امیرحسین ثابتی',or:'ثابتی|امیرحسین ثابتی|امیر ثابتی|حسین ثابتی|ثابتی مجلس|ثابتی نماینده',not:'دکتر ثابتی|علی ثابتی|صادق ثابتی|عرفان ثابتی|پرویز ثابتی|فرزیا ثابتی|جایگاه ثابتی|مسیر ثابتی|قیمت ثابتی|جریان ثابتی|شرایط ثابتی|روند ثابتی|وضعیت ثابتی|مقدار ثابتی|عدد ثابتی|سرعت ثابتی|فرکانس ثابتی|نرخ ثابتی|موقعیت ثابتی|الگوی ثابتی|برنامه ثابتی|ذهنیت ثابتی|جای ثابتی'},
  {name:'پیمان جبلی',or:'پیمان جبلی|رئیس سازمان صدا و سیما|رئیس صدا و سیما|جبلی صدا|رییس صدا و سیما|رئیس صدا سیما|رییس صدا سیما|رئیس رسانه ملی|جبلی گفت|جبلی اعلام کرد|جبلی در صدا و سیما|جبلی در رسانه ملی',not:'حمید جبلی|قاسم جبلی|آهنگ جبلی|دکتر جبلی|محمد جبلی|خواننده|آهنگ|ریمیکس |آلبوم |کلاه قرمزی|پسرخاله|صداپیشه|لاریجانی|ضرغامی'},
  {name:'حسام\u200Cالدین آشنا',or:'حسام الدین آشنا|حسام آشنا|آشنا مشاور روحانی|آشنا دولت روحانی|رئیس مرکز استراتژیک دولت روحانی',not:''},
  {name:'حسن روحانی',or:'روحانی|حسن روحانی|روحانی حسن|rouhani',not:'محمد روحانی|انوشیروان روحانی|سنگ روحانی|شهرداد روحانی|رضا روحانی|بیمارستان روحانی|روحانی برجسته|مهدی روحانی|حسین روحانی|دکتر روحانی|استاد روحانی|مهندس روحانی|فرد روحانی|شخصیت روحانی|رهبر روحانی|مرد روحانی|خانم روحانی|چهره روحانی|حالت روحانی|مفهوم روحانی|فضای روحانی|روحانیون|روحانی مسجد|روحانی کاروان|روحانی حوزه|روحانی شیعه|روحانی اهل سنت|روحانیت|یک روحانی|مجتبی روحانی|روحانی مبارز|این روحانی|روحانی نما|لباس روحانی|عالم روحانی'},
  {name:'حسین افشین',or:'حسین افشین|افشین معاون علمی|افشین معاونت علمی|معاون علمی رئیس جمهور|معاونت علمی ریاست جمهوری|افشین در معاونت|افشین گفت',not:'آهنگ|افشین آذری|سیدناصر افشین|افشین مقدم|خواننده|کنسرت|موزیک|ترانه'},
  {name:'حمیدرضا حاجی\u200Cبابایی',or:'حاجی بابایی|حمیدرضا حاجی بابایی|حمیدرضا حاجی بابائی',not:'دکتر حاجی بابایی|محمد حاجی بابایی|آهنگ|خواننده|موزیک|کنسرت'},
  {name:'ستار هاشمی',or:'ستار هاشمی|وزیر ارتباطات|هاشمی وزیر',not:'دکتر هاشمی|بهداشت|برنج|علی هاشمی|بیمارستان|رفسنجانی|سیامک هاشمی|هاشمی نژاد|جواد هاشمی|محمد هاشمی|شهید هاشمی|فائزه|مهدی هاشمی|ناصر هاشمی|قاضی زاده|بازیگر|جراحی|چشم پزشکی|مربی|فوتبال'},
  {name:'سعید جلیلی',or:'جلیلی|سعید جلیلی',not:'سامان جلیلی|آهنگ|مسعود جلیلی|کنسرت|موزیک|ریمیکس|ترانه|تیزر|دانلود|ابوالفضل جلیلی|سیامک جلیلی|محمد جلیلی|جلال جلیلی|مجتبی جلیلی|امیرحسین جلیلی|علی جلیلی|وحید جلیلی|لیگ|باشگاه|بیمارستان|جراحی'},
  {name:'سید احمد خاتمی',or:'سید احمد خاتمی|احمد خاتمی|سیداحمد خاتمی|خاتمی امام|آیت الله خاتمی',not:'محمد خاتمی|اصلاحات|اصلاح طلب|تکرار می کنم|عبای شکلاتی|گفتگوی تمدن ها|ممنوع التصویر|دولت هفتم|دولت هشتم|مرتضی خاتمی|حسن خاتمی|خاتمی یزدی|اردکان|والیبال|دکتر خاتمی|خاتمی نژاد|خانم خاتمی|دولت خاتمی'},
  {name:'سید عباس عراقچی',or:'عراقچی|سید عباس عراقچی|عراغچی|اراقچی|وزیر خارجه ایران|وزیر امور خارجه ایران',not:'احمد عراقچی|مرتضی عراقچی|بانک مرکزی|بازار ارز'},
  {name:'سید عزت\u200Cالله ضرغامی',or:'ضرغامی|سید عزت الله ضرغامی|عزت ضرغامی|عزتالله ضرغامی',not:'دکتر ضرغامی|محمد ضرغامی|شهید ضرغامی|رضا ضرغامی|شاهرخ ضرغامی|سردار ضرغامی|رادیو فردا|خبرنگار|گزارشگر|امیر ضرغامی|خانه تاریخی|مرمت|میراث آریا|شرکت ضرغام'},
  {name:'سید مجتبی خامنه\u200Cای',or:'مجتبی خامنه ای|مجتبی خامنه\u200Cای|مجتبی خامنه|سید مجتبی|مجتبا خامنه ای',not:'حسن مجتبی|آهنگ|ملیس|مجتبی شکوری|مجتبی بدری|مجتبی رمضانی|مجتبی دربیدی|مجتبی ترکاشوند|مجتبی پورمحسن|مجتبی حسینی|مجتبی شفیعی|مجتبی زمانی|مجتبی واحدی|مجتبی جباری|شاهروبندی|مجتبی فخریان|موزیک|ریمیکس|ترانه|کنسرت|آلبوم|دانلود|پاپ|بازیگر|سکانس|فیلم|سریال|مجتبی محرمی|مجتبی عابدینی|فوتبال|سرمربی|ذوب آهن|پرسپولیس|باشگاه|هافبک|لیگ برتر|داور|فدراسیون|تشک|کشتی|شمشیربازی|امام حسن|کریم اهل بیت|ذوالنور|امانی|ابطحی|رحماندوست|رحمان دوست|شکوری|مجتبی زمانی|کتاب باز|پادکست|رشد فردی|اپیزود|کاپیتال|مجتبی روستایی|مجتبی زارعی'},
  {name:'سید محمد خاتمی',or:'سید محمد خاتمی|محمد خاتمی|دولت خاتمی|خاتمی رئیس جمهور',not:'احمد خاتمی|آهنگ خاتمی|لیلا خاتمی|دکتر خاتمی|علی خاتمی|امام جمعه موقت|خطیب|نماز جمعه تهران|امیر خاتمی|پدافند هوایی|ارتش|سردار خاتمی|فوتبال|بازیکن|لیگ|بیمارستان|دانشگاه علوم پزشکی|جراحی|رضا خاتمی|سید حسن|مرتضی خاتمی|کمیسیون بهداشت|حاتمی|آهنگ|موزیک|فیلم|سینما|جشنواره'},
];

const SOURCES = ['telegram','bale','rubika','eitaa','twitter','instagram','news','newspaper','media','forum','aparat'];
const DOMAIN = 'https://d1.8tag.ir';
const OUT = path.join(__dirname, '../../extra_files/data-scale-report.csv');

// ── API ───────────────────────────────────────────────────────────────────────

let token = null;
async function getToken() {
  if (token) return token;
  const r = await axios.post(`${DOMAIN}/api/v4/login`,
    { username: process.env.HASHTAG_USERNAME, password: process.env.HASHTAG_PASSWORD },
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (r.data.status !== 200) throw new Error('Login failed: ' + r.data.error);
  token = r.data.result;
  return token;
}

async function query(source, or_, not_) {
  const tok = await getToken();
  const payload = { token: tok, source, sort: 'random', range: 'year', size: 100, lang: 'fa', forward: 'false', retweet: 'false' };
  if (or_) payload.or = or_;
  if (not_) payload.not = not_;
  const r = await axios.post(`${DOMAIN}/api/v4/search`, payload,
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  return { total: r.data.total || 0, items: r.data.result || [] };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load already-completed profiles from existing file
  const done = new Set();
  const header = ['پروفایل', ...SOURCES.flatMap(s => [`${s}_total`, `${s}_shown`]), 'grand_total', 'grand_shown'];

  if (fs.existsSync(OUT)) {
    const lines = fs.readFileSync(OUT, 'utf8').replace(/^\uFEFF/, '').split('\n').filter(Boolean);
    for (let i = 1; i < lines.length; i++) {
      const name = lines[i].split(',')[0].replace(/^"|"$/g, '');
      if (name) done.add(name);
    }
    console.log(`Resuming — ${done.size} profiles already done: ${[...done].join(', ')}`);
  } else {
    fs.writeFileSync(OUT, '\uFEFF' + header.join(',') + '\n', 'utf8');
  }

  await getToken();
  console.log('Token acquired.\n');

  for (const profile of PROFILES) {
    if (done.has(profile.name)) {
      console.log(`SKIP ${profile.name}`);
      continue;
    }

    process.stdout.write(`${profile.name} ... `);
    const row = [`"${profile.name}"`];
    let grandTotal = 0, grandShown = 0;

    for (const source of SOURCES) {
      try {
        const { total, items } = await query(source, profile.or, profile.not || undefined);
        const shown = items.filter(item => passes(item, source)).length;
        row.push(total, shown);
        grandTotal += total;
        grandShown += shown;
        process.stdout.write(`${source}(${shown}/${total}) `);
      } catch (e) {
        row.push('ERR', 'ERR');
        process.stdout.write(`${source}(ERR) `);
      }
      await new Promise(r => setTimeout(r, 400));
    }

    row.push(grandTotal, grandShown);
    fs.appendFileSync(OUT, row.join(',') + '\n', 'utf8');
    console.log('✓');
  }

  console.log(`\nDone. Report: ${OUT}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
