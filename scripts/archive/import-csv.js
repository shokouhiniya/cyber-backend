/**
 * Import CSV data into the content table.
 * Usage: node scripts/import-csv.js <path-to-csv>
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const CSV_PATH = process.argv[2] || path.join(__dirname, '..', '..', 'extra_files', '14050208.csv');

const EMOTIONS = ['joy', 'hope', 'optimism', 'excitement', 'pride', 'interest', 'concern', 'worry', 'frustration', 'caution', 'surprise', 'neutral'];
const SENTIMENTS = ['positive', 'negative', 'neutral'];
const CATEGORIES_LIST = [
  { cat: 'سیاست و حکمرانی', sub: 'سیاست داخلی' },
  { cat: 'سیاست و حکمرانی', sub: 'سیاست خارجی' },
  { cat: 'اقتصاد و کسب‌وکار', sub: 'اقتصاد کلان' },
  { cat: 'جامعه و سبک زندگی', sub: 'خانواده و روابط' },
  { cat: 'علم و فناوری', sub: 'فناوری‌های نوین (هوش مصنوعی، بلاکچین)' },
  { cat: 'فرهنگ و هنر', sub: 'سینما و رسانه' },
  { cat: 'محیط زیست و پایداری', sub: 'انرژی و منابع' },
  { cat: 'ورزش و تناسب‌اندام', sub: 'ورزش‌های حرفه‌ای' },
  { cat: 'آموزش و توسعه فردی', sub: 'آموزش آنلاین' },
  { cat: 'سرگرمی و فرهنگ مجازی', sub: 'ترندهای شبکه‌های اجتماعی' },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randScore(sentiment) {
  if (sentiment === 'positive') return (0.5 + Math.random() * 0.5).toFixed(4);
  if (sentiment === 'negative') return (-0.5 - Math.random() * 0.5).toFixed(4);
  return (Math.random() * 0.2 - 0.1).toFixed(4);
}

// Simple CSV parser that handles quoted fields with commas
function parseCSV(text) {
  const lines = text.split('\n');
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, idx) => { row[h.trim()] = (values[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// Map source type names
function mapSourceType(type) {
  const map = {
    'تلگرام': 'telegram',
    'توئیتر': 'twitter',
    'اینستاگرام': 'instagram',
    'روبیکا': 'rubika',
    'بله': 'bale',
    'فروم': 'forum',
    'ایتا': 'eita',
    'تلویزیون': 'tv',
    'خبر': 'news',
    'رسانه تصویری': 'video_media',
    'روزنامه': 'newspaper',
  };
  return map[type] || type;
}

async function main() {
  console.log(`Reading CSV: ${CSV_PATH}`);
  const raw = fs.readFileSync(CSV_PATH, 'utf-8');
  const rows = parseCSV(raw);
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
    const text = r['متن مطلب'] || r['عنوان مطلب'] || '';
    if (!text || text.length < 5) { skipped++; continue; }

    const id = `csv_${String(i + 1).padStart(5, '0')}`;
    const sourceType = mapSourceType(r['نوع'] || '');
    const screenName = r['نام کاربری منبع'] || r['منبع مطلب'] || '';
    const userFollowers = parseInt(r['تعداد اعضا']) || 0;
    const viewCount = parseInt(r['مشاهده مطلب']) || parseInt(r['بازدید']) || 0;
    const likeCount = parseInt(r['تعداد لایک']) || 0;
    const retweetCount = parseInt(r['تعداد ریتوییت']) || 0;
    const replyCount = parseInt(r['ریپلای']) || parseInt(r['تعداد کامنت']) || 0;
    const bookmarkCount = parseInt(r['بوکمارک']) || 0;
    const quoteCount = parseInt(r['تعداد نقل قول']) || 0;

    // Date: use Gregorian column directly (already has full timestamp)
    let publishedAt = null;
    const gregDate = (r['زمان ایجاد میلادی'] || '').trim();
    if (gregDate) {
      publishedAt = gregDate.replace(/\//g, '-');
    }

    // Tags and hashtags
    const tags = (r['تگ ها'] || '').split('،').map(t => t.trim()).filter(Boolean);
    const hashtags = (r['هشتگ ها'] || '').split('،').map(t => t.trim()).filter(Boolean);
    const allTags = [...new Set([...tags, ...hashtags])].slice(0, 10);

    // Random sentiment/emotion
    const sentiment = pick(SENTIMENTS);
    const emotion = sentiment === 'positive' ? pick(['joy', 'hope', 'optimism', 'excitement', 'pride'])
      : sentiment === 'negative' ? pick(['concern', 'worry', 'frustration', 'caution'])
      : pick(['neutral', 'interest', 'surprise']);
    const sentimentScore = randScore(sentiment);
    const emotionScore = (0.4 + Math.random() * 0.5).toFixed(4);

    // Random category
    const catPick = pick(CATEGORIES_LIST);

    try {
      await client.query(
        `INSERT INTO content (
          id, text, source_type, screen_name, user_id, user_followers,
          view_count, like_count, retweet_count, reply_count, bookmark_count, quote_count,
          sentiment, sentiment_score, emotion, emotion_score,
          category, subcategory, lang, published_at, hashtags, is_verified
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          id, text.slice(0, 10000), sourceType, screenName, `user_${screenName}`, userFollowers,
          viewCount, likeCount, retweetCount, replyCount, bookmarkCount, quoteCount,
          sentiment, sentimentScore, emotion, emotionScore,
          catPick.cat, catPick.sub, 'fa', publishedAt, allTags.length > 0 ? allTags : null, userFollowers > 10000,
        ]
      );
      inserted++;
    } catch (err) {
      console.error(`Row ${i}: ${err.message}`);
      skipped++;
    }

    if ((i + 1) % 500 === 0) console.log(`  ... ${i + 1}/${rows.length}`);
  }

  await client.end();
  console.log(`\nDone! Inserted: ${inserted}, Skipped: ${skipped}`);
}

main().catch(console.error);
