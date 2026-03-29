/**
 * Import raymon.json into PostgreSQL content table
 *
 * Usage: node scripts/import-raymon.js <path-to-raymon.json>
 *
 * Reads the JSON file, normalizes emotion/sentiment labels,
 * and batch-inserts into the content table.
 */

const fs = require('fs');
const { Client } = require('pg');

// --------------- config ---------------

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'cyberspace_monitoring',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || '123',
};

const BATCH_SIZE = 500;

// --------------- helpers ---------------

/** Normalize emotion labels to uppercase standard */
function normalizeEmotion(label) {
  if (!label || label === 'invalid') return null;
  return label.toUpperCase();
}

/** Normalize sentiment labels to lowercase standard */
function normalizeSentiment(label) {
  if (!label || label === 'invalid') return null;
  const lower = label.toLowerCase();
  if (['positive', 'negative', 'neutral'].includes(lower)) return lower;
  return null;
}

/** Parse a date safely */
function parseDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Convert a document to a row tuple */
function docToRow(doc) {
  return {
    id: String(doc.id || doc._id),
    text: doc.text || '',
    source_type: doc.source || null,
    type: doc.type || null,
    screen_name: doc.screen_name || null,
    user_id: doc.user_id ? String(doc.user_id) : null,
    user_followers: parseInt(doc['user.followers']) || 0,
    user_following: parseInt(doc['user.following']) || 0,
    user_post_count: parseInt(doc['user.post']) || 0,
    view_count: parseInt(doc.view_count) || 0,
    like_count: parseInt(doc.like_count) || 0,
    retweet_count: parseInt(doc.retweet_count) || 0,
    reply_count: parseInt(doc.reply_count) || 0,
    quote_count: parseInt(doc.quote_count) || 0,
    bookmark_count: parseInt(doc.bookmark_count) || 0,
    sentiment: normalizeSentiment(doc.Sentiment?.label),
    sentiment_score: doc.Sentiment?.score || null,
    emotion: normalizeEmotion(doc.Emotion?.label),
    emotion_score: doc.Emotion?.score || null,
    lang: doc.lang || null,
    published_at: parseDate(doc.published_at),
    conversation_id: doc.conversation_id ? String(doc.conversation_id) : null,
    in_reply_to_id: doc.in_reply_to_id ? String(doc.in_reply_to_id) : null,
    hashtags: doc.hashtags && doc.hashtags.length > 0 ? doc.hashtags : null,
    user_mentions: doc.user_mentions && doc.user_mentions.length > 0 ? doc.user_mentions : null,
  };
}

// --------------- main ---------------

async function main() {
  const filePath = process.argv[2] || 'raymon (1)/raymon.json';

  console.log(`📖 Reading ${filePath}...`);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const docs = raw.documents;
  console.log(`📊 Total documents: ${docs.length}`);

  const client = new Client(DB_CONFIG);
  await client.connect();
  console.log('✅ Connected to PostgreSQL');

  // Ensure table exists (TypeORM synchronize should handle this, but just in case)
  await client.query(`
    CREATE TABLE IF NOT EXISTS content (
      id VARCHAR(255) PRIMARY KEY,
      text TEXT NOT NULL,
      source_type VARCHAR(50),
      type VARCHAR(50),
      screen_name VARCHAR(255),
      user_id VARCHAR(255),
      user_followers INTEGER DEFAULT 0,
      user_following INTEGER DEFAULT 0,
      user_post_count INTEGER DEFAULT 0,
      view_count INTEGER DEFAULT 0,
      like_count INTEGER DEFAULT 0,
      retweet_count INTEGER DEFAULT 0,
      reply_count INTEGER DEFAULT 0,
      quote_count INTEGER DEFAULT 0,
      bookmark_count INTEGER DEFAULT 0,
      sentiment VARCHAR(50),
      sentiment_score DECIMAL(5,4),
      emotion VARCHAR(50),
      emotion_score DECIMAL(5,4),
      lang VARCHAR(10),
      published_at TIMESTAMP,
      conversation_id VARCHAR(255),
      in_reply_to_id VARCHAR(255),
      hashtags TEXT[],
      user_mentions TEXT[],
      is_verified BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create indexes
  await client.query(`CREATE INDEX IF NOT EXISTS idx_content_published_at ON content(published_at DESC);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_content_emotion ON content(emotion);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_content_sentiment ON content(sentiment);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_content_screen_name ON content(screen_name);`);

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const rows = batch.map(docToRow);

    // Build batch INSERT with ON CONFLICT DO NOTHING
    const columns = Object.keys(rows[0]);
    const valuePlaceholders = [];
    const values = [];
    let paramIdx = 1;

    for (const row of rows) {
      const placeholders = [];
      for (const col of columns) {
        const val = row[col];
        if (Array.isArray(val)) {
          placeholders.push(`$${paramIdx}::text[]`);
        } else {
          placeholders.push(`$${paramIdx}`);
        }
        values.push(val);
        paramIdx++;
      }
      valuePlaceholders.push(`(${placeholders.join(', ')})`);
    }

    const sql = `
      INSERT INTO content (${columns.join(', ')})
      VALUES ${valuePlaceholders.join(',\n')}
      ON CONFLICT (id) DO NOTHING
    `;

    try {
      const result = await client.query(sql, values);
      inserted += result.rowCount || 0;
      skipped += batch.length - (result.rowCount || 0);
    } catch (err) {
      console.error(`❌ Error at batch ${i}-${i + batch.length}:`, err.message);
      // Try one by one for this batch
      for (const row of rows) {
        try {
          const cols = Object.keys(row);
          const vals = cols.map((_, idx) => `$${idx + 1}`);
          const colTypes = cols.map((c, idx) => {
            if (Array.isArray(row[c])) return `$${idx + 1}::text[]`;
            return `$${idx + 1}`;
          });
          await client.query(
            `INSERT INTO content (${cols.join(', ')}) VALUES (${colTypes.join(', ')}) ON CONFLICT (id) DO NOTHING`,
            cols.map((c) => row[c])
          );
          inserted++;
        } catch (e) {
          skipped+