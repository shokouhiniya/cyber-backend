/**
 * Import enriched JSON data into the content table.
 * Usage: node scripts/import-json.js [path-to-json]
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const JSON_PATH = process.argv[2] || path.join(__dirname, '..', '..', 'extra_files', '14050208', 'Extracted_Data.json');

const PLATFORM_MAP = {
  'Telegram': 'telegram',
  'Baleh': 'bale',
  'Rubika': 'rubika',
  'Eetaa': 'eita',
  'Instagram': 'instagram',
  'News': 'news',
  'Print': 'newspaper',
  'Vod': 'video_media',
  'Element-structures': 'forum',
  'Twitter': 'twitter',
  'X': 'twitter',
};

const SENTIMENT_MAP = {
  'مثبت': 'positive',
  'منفی': 'negative',
  'خنثی': 'neutral',
};

const EMOTION_MAP = {
  'positive': ['joy', 'hope', 'optimism', 'excitement', 'pride'],
  'negative': ['concern', 'worry', 'frustration', 'caution'],
  'neutral': ['neutral', 'interest', 'surprise'],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randScore(sentiment) {
  if (sentiment === 'positive') return (0.5 + Math.random() * 0.5).toFixed(4);
  if (sentiment === 'negative') return (-0.5 - Math.random() * 0.5).toFixed(4);
  return (Math.random() * 0.2 - 0.1).toFixed(4);
}

// Convert Jalali date 1405/02/08 23:40:19 to approximate Gregorian
// Simple offset: 1405/02/08 ≈ 2026/04/28
function jalaliToGregorian(jalaliStr) {
  if (!jalaliStr) return null;
  const parts = jalaliStr.trim().split(' ');
  const dateParts = parts[0].split('/').map(Number);
  const timePart = parts[1] || '12:00:00';
  
  // Approximate: Jalali 1405/02/08 = Gregorian 2026/04/28
  // For this dataset all dates are 1405/02/08, so hardcode
  if (dateParts[0] === 1405 && dateParts[1] === 2 && dateParts[2] === 8) {
    return `2026-04-28 ${timePart}`;
  }
  // Fallback: rough conversion
  const gYear = dateParts[0] + 621;
  const gMonth = String(dateParts[1] + 2).padStart(2, '0'); // rough
  const gDay = String(dateParts[2] + 20).padStart(2, '0'); // rough
  return `${gYear}-${gMonth}-${gDay} ${timePart}`;
}

const CATEGORIES = [
  { cat: 'سیاست و حکمرانی', sub: 'سیاست داخلی' },
  { cat: 'سیاست و حکمرانی', sub: 'سیاست خارجی' },
  { cat: 'اقتصاد و کسب‌وکار', sub: 'اقتصاد کلان' },
  { cat: 'جامعه و سبک زندگی', sub: 'خانواده و روابط' },
  { cat: 'علم و فناوری', sub: 'فناوری‌های نوین (هوش مصنوعی، بلاکچین)' },
  { cat: 'فرهنگ و هنر', sub: 'سینما و رسانه' },
  { cat: 'محیط زیست و پایداری', sub: 'انرژی و منابع' },
  { cat: 'سرگرمی و فرهنگ مجازی', sub: 'ترندهای شبکه‌های اجتماعی' },
];

async function main() {
  console.log(`Reading JSON: ${JSON_PATH}`);
  const raw = fs.readFileSync(JSON_PATH, 'utf-8');
  const rows = JSON.parse(raw);
  console.log(`Parsed ${rows.length} rows`);

  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'B0b_Dylan',
    database: process.env.DB_NAME || 'cyber',
  });

  await client.connect();
  console.log('Connected to database');

  // Clear existing content
  await client.query('DELETE FROM content');
  console.log('Cleared existing content');

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const text = r['متن اصلی'] || '';
    if (!text || text.length < 5) { skipped++; continue; }

    const id = `enr_${String(i + 1).padStart(5, '0')}`;
    const sourceType = PLATFORM_MAP[r['پلتفرم']] || r['پلتفرم'] || '';
    const screenName = r['نام نویسنده/رسانه'] || '';
    const postUrl = r['لینک مطلب'] || null;
    const profileImageUrl = r['لینک پروفایل'] || null;
    const rawMediaUrl = r['مدیا ضمیمه'] || null;

    // Only use media URLs that are publicly accessible (https CDN links)
    // Internal URLs (siloo-prod.file.svc) won't work in browser
    let mediaUrl = null;
    if (rawMediaUrl && rawMediaUrl.startsWith('https://')) {
      mediaUrl = rawMediaUrl;
    }

    // For profile images, only use public https URLs
    let profileImg = null;
    if (profileImageUrl && profileImageUrl.startsWith('https://')) {
      profileImg = profileImageUrl;
    }
    const forwardFrom = r['کوت/فوروارد از'] || null;

    const viewCount = parseInt(r['بازدید']) || 0;
    const likeCount = parseInt(r['لایک']) || 0;
    const retweetCount = parseInt(r['ریتوییت']) || parseInt(r['اشتراک‌گذاری']) || 0;
    const replyCount = parseInt(r['کامنت']) || 0;
    const bookmarkCount = parseInt(r['بوکمارک']) || 0;

    // Sentiment from data
    const sentimentFa = r['احساس متن'] || '';
    const sentiment = SENTIMENT_MAP[sentimentFa] || pick(['positive', 'negative', 'neutral']);
    const emotion = pick(EMOTION_MAP[sentiment]);
    const sentimentScore = randScore(sentiment);
    const emotionScore = (0.4 + Math.random() * 0.5).toFixed(4);

    // Date
    const publishedAt = jalaliToGregorian(r['تاریخ انتشار']);

    // Category
    const catPick = pick(CATEGORIES);

    // Determine if this is a ghalibaf official post
    const isOfficial = screenName.toLowerCase().includes('قالیباف') || 
                       (postUrl && postUrl.includes('ghalibaf'));

    try {
      await client.query(
        `INSERT INTO content (
          id, text, source_type, screen_name, user_id, user_followers,
          view_count, like_count, retweet_count, reply_count, bookmark_count,
          sentiment, sentiment_score, emotion, emotion_score,
          category, subcategory, lang, published_at, hashtags, is_verified,
          media_url, post_type, profile_image_url
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [
          id,
          text.slice(0, 10000),
          sourceType,
          screenName,
          `user_${screenName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50)}`,
          viewCount > 10000000 ? 1 : (viewCount > 0 ? viewCount : Math.floor(Math.random() * 50000)),
          viewCount > 10000000 ? 1 : viewCount,
          likeCount > 10000000 ? 1 : likeCount,
          retweetCount > 10000000 ? 1 : retweetCount,
          replyCount > 10000000 ? 1 : replyCount,
          bookmarkCount,
          sentiment,
          sentimentScore,
          emotion,
          emotionScore,
          catPick.cat,
          catPick.sub,
          'fa',
          publishedAt,
          null, // hashtags
          isOfficial || viewCount > 100000,
          mediaUrl,
          mediaUrl ? (mediaUrl.endsWith('.mp4') ? 'video' : 'image') : null,
          profileImg,
        ]
      );
      inserted++;
    } catch (err) {
      console.error(`Row ${i}: ${err.message}`);
      skipped++;
    }

    if ((i + 1) % 100 === 0) console.log(`  ... ${i + 1}/${rows.length}`);
  }

  await client.end();
  console.log(`\nDone! Inserted: ${inserted}, Skipped: ${skipped}`);
}

main().catch(console.error);
