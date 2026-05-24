/**
 * backfill-promise-feed.js
 *
 * Fetches posts related to each promise for all profiles that have promises.
 * Uses 'year' range to get historical coverage.
 *
 * Usage: node scripts/backfill-promise-feed.js
 *        node scripts/backfill-promise-feed.js --profile "مسعود پزشکیان"
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const { Pool } = require('pg');

const DOMAIN = 'https://d1.8tag.ir';
const USERNAME = process.env.HASHTAG_USERNAME;
const PASSWORD = process.env.HASHTAG_PASSWORD;
const PROFILE_ARG = process.argv.includes('--profile')
  ? process.argv[process.argv.indexOf('--profile') + 1]
  : null;

const STOP_WORDS = new Set([
  'اگر', 'که', 'را', 'در', 'به', 'از', 'با', 'این', 'آن', 'برای', 'تا', 'یک',
  'می', 'است', 'و', 'یا', 'هم', 'هر', 'ما', 'شما', 'آنها', 'خود', 'نیز',
  'بر', 'پس', 'اما', 'ولی', 'چون', 'زیرا', 'تمام', 'همه', 'بین', 'طی',
  'طبق', 'جهت', 'نسبت', 'مورد', 'باید', 'خواهد', 'شد', 'شده', 'کرد',
]);

function extractKeywords(text) {
  return text
    .split(/[\s،,،.؟?!:؛;()\[\]]+/)
    .map(w => w.trim())
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 4);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const res = await apiPost(`${DOMAIN}/api/v4/login`, { username: USERNAME, password: PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  cachedToken = res.body.result;
  try {
    const payload = JSON.parse(Buffer.from(cachedToken.split('.')[1], 'base64').toString());
    tokenExpiry = payload.exp * 1000;
  } catch { tokenExpiry = Date.now() + 6 * 86400_000; }
  return cachedToken;
}

function apiPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function searchPosts(token, or, not, size = 30) {
  const payload = {
    token, source: 'telegram', or, range: 'year',
    sort: 'reactions', size, lang: 'fa',
    forward: 'false', retweet: 'false', maxHashtags: 10,
  };
  if (not) payload.not = not;
  const res = await apiPost(`${DOMAIN}/api/v4/search`, payload);
  return res.body?.result || [];
}

async function main() {
  const pool = new Pool({ host: process.env.DB_HOST, port: 5432, database: process.env.DB_NAME, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD });

  let query = "SELECT id, name, keywords, excluded_keywords, promises FROM profiles WHERE promises IS NOT NULL AND promises != '[]' AND is_active = true";
  const params = [];
  if (PROFILE_ARG) { query += ' AND name = $1'; params.push(PROFILE_ARG); }
  query += ' ORDER BY name';

  const { rows: profiles } = await pool.query(query, params);
  console.log(`Profiles to process: ${profiles.length}\n`);

  const token = await getToken();
  console.log('8tag token acquired.\n');

  let totalStored = 0;

  for (const profile of profiles) {
    const promises = profile.promises || [];
    if (promises.length === 0) continue;

    console.log(`\n▶ ${profile.name} (${promises.length} promises)`);

    // Create a dummy ingest run for this backfill
    const { rows: [run] } = await pool.query(
      `INSERT INTO ingest_runs (profile_id, status, started_at) VALUES ($1, 'running', NOW()) RETURNING id`,
      [profile.id]
    );
    const runId = run.id;
    let profileStored = 0;

    for (let idx = 0; idx < promises.length; idx++) {
      const promise = promises[idx];
      if (!promise.text?.trim()) continue;

      const keywords = extractKeywords(promise.text);
      if (keywords.length === 0) continue;

      const profileKw = (profile.keywords || []).slice(0, 2);
      const or = [...profileKw, ...keywords].join('|');
      const not = (profile.excluded_keywords || []).join('|') || undefined;
      const selectionReason = `promise_${idx}`;

      process.stdout.write(`  [${idx}] "${promise.text.slice(0, 40)}..." → `);

      try {
        const items = await searchPosts(token, or, not, 30);
        let stored = 0;

        for (const item of items) {
          const sentiment = item.sentiment !== null && item.sentiment !== undefined
            ? (item.sentiment === 1 ? 'Positive' : item.sentiment === -1 ? 'Negative' : 'Neutral')
            : null;

          try {
            await pool.query(
              `INSERT INTO selected_posts (
                ingest_run_id, profile_id, external_id, source_type, screen_name, display_name,
                profile_image_url, text, published_at, post_url, media_url,
                view_count, like_count, retweet_count, reply_count,
                sentiment, simhash, canonical_id, selection_reason, hashtags
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
              ON CONFLICT DO NOTHING`,
              [
                runId, profile.id, String(item.id || Math.random()),
                'telegram',
                item.peer_username || null,
                item.peer_title || null,
                null,
                item.text || '',
                item.timestamp ? new Date(item.timestamp * 1000).toISOString() : null,
                item.record_index || null,
                null,
                item.views || 0,
                item.total_reactions || 0,
                item.forwards || 0,
                item.comments_count || 0,
                sentiment, null, null,
                selectionReason,
                Array.isArray(item.hashtags) ? item.hashtags : [],
              ]
            );
            stored++;
            profileStored++;
            totalStored++;
          } catch { /* skip duplicates */ }
        }

        console.log(`${items.length} fetched, ${stored} stored`);
      } catch (e) {
        console.log(`ERR: ${e.message}`);
      }

      await sleep(500);
    }

    await pool.query(
      `UPDATE ingest_runs SET status='completed', finished_at=NOW(), posts_selected=$1 WHERE id=$2`,
      [profileStored, runId]
    );
    console.log(`  → ${profileStored} total posts stored`);
  }

  console.log(`\n✓ Done. Total stored: ${totalStored}`);
  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
