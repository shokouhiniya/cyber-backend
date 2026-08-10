/**
 * backfill-platform-totals.js
 *
 * Re-fetches platform totals for profiles that have zero entries,
 * using the throttled approach (batches of 5, 600ms delay).
 *
 * Usage: node scripts/backfill-platform-totals.js
 *        node scripts/backfill-platform-totals.js --all   # re-fetch all profiles
 */

require('dotenv').config();
const https = require('https');
const { Pool } = require('pg');

const PROMTIC_HOST = new URL(process.env.HASHTAG_URL || 'https://d1.8tag.ir').hostname;
const USERNAME = process.env.HASHTAG_USERNAME;
const PASSWORD = process.env.HASHTAG_PASSWORD;
const ALL = process.argv.includes('--all');

const COUNT_SOURCES = [
  'telegram', 'twitter', 'instagram',
  'news', 'newspaper', 'media',
  'rubika', 'bale', 'forum', 'aparat',
];

const TIMEFRAMES = [
  { key: 'day',     range: 'day' },
  { key: 'week',    range: 'week' },
  { key: 'month',   range: 'month' },
  { key: 'quarter', range: 'custom',
    since: () => Math.floor((Date.now() - 90 * 86400_000) / 1000),
    max:   () => Math.floor(Date.now() / 1000),
  },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 8tag API ──────────────────────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const res = await apiPost('https://d1.8tag.ir/api/v4/login', { username: USERNAME, password: PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  cachedToken = res.body.result;
  // Decode exp from JWT
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

async function fetchTotal(source, tf, or, not) {
  const token = await getToken();
  const payload = {
    token, source, or, range: tf.range, sort: 'recent', size: 1,
    lang: 'fa', forward: 'false', retweet: 'false', maxHashtags: 10,
  };
  if (not) payload.not = not;
  if (tf.since) { payload.since = tf.since(); payload.max = tf.max(); }
  const res = await apiPost('https://d1.8tag.ir/api/v4/search', payload);
  return res.body?.total || 0;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ host: process.env.DB_HOST, port: 5432, database: process.env.DB_NAME, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD });

  // Get profiles that have platform_totals with zeros (or all if --all)
  let profileQuery;
  if (ALL) {
    profileQuery = `SELECT DISTINCT p.id, p.name, p.keywords, p.excluded_keywords
                    FROM profiles p
                    JOIN platform_totals pt ON pt.profile_id = p.id
                    WHERE p.is_active = true`;
  } else {
    profileQuery = `SELECT DISTINCT p.id, p.name, p.keywords, p.excluded_keywords
                    FROM profiles p
                    JOIN platform_totals pt ON pt.profile_id = p.id
                    WHERE p.is_active = true AND pt.total = 0`;
  }

  const { rows: profiles } = await pool.query(profileQuery);
  const uniqueProfiles = [...new Map(profiles.map(p => [p.id, p])).values()];

  console.log(`Profiles to backfill: ${uniqueProfiles.length}`);

  for (const profile of uniqueProfiles) {
    const or = (profile.keywords || []).join('|');
    const not = (profile.excluded_keywords || []).join('|') || undefined;
    if (!or) { console.log(`SKIP ${profile.name} — no keywords`); continue; }

    console.log(`\nProcessing: ${profile.name}`);
    let saved = 0;

    const tasks = [];
    for (const tf of TIMEFRAMES) {
      for (const source of COUNT_SOURCES) {
        tasks.push({ source, tf });
      }
    }

    const BATCH = 5;
    for (let i = 0; i < tasks.length; i += BATCH) {
      const batch = tasks.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(({ source, tf }) => fetchTotal(source, tf, or, not).then(total => ({ source, tf, total })))
      );

      for (const r of results) {
        if (r.status !== 'fulfilled' || r.value.total <= 0) continue;
        const { source, tf, total } = r.value;
        await pool.query(
          `INSERT INTO platform_totals (profile_id, source_type, timeframe, total, fetched_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (profile_id, source_type, timeframe)
           DO UPDATE SET total = EXCLUDED.total, fetched_at = EXCLUDED.fetched_at`,
          [profile.id, source, tf.key, total]
        );
        process.stdout.write(`  ${tf.key}/${source}: ${total}\n`);
        saved++;
      }

      if (i + BATCH < tasks.length) await sleep(600);
    }

    console.log(`  → saved ${saved} entries`);
  }

  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
