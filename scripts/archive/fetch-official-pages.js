/**
 * fetch-official-pages.js
 *
 * Fetches posts FROM official pages of all profiles (last quarter).
 *
 * Only keeps posts where the author handle is verified to match the official account.
 * This is only reliably possible for Telegram (peer_username identifies the channel).
 * Twitter and Instagram are skipped — 8tag's search is keyword-based and cannot
 * filter by author for those platforms.
 *
 * Usage: node scripts/fetch-official-pages.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');
const { Client } = require('pg');

const DOMAIN = 'https://d1.8tag.ir';
const SINCE_TS = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
const MAX_TS = Math.floor(Date.now() / 1000);
const SIZE = 100;

// Only sources where we can verify authorship
const VERIFIABLE_SOURCES = {
  telegram: 'telegram',
};

function getAuthorHandle(item, source) {
  if (source === 'telegram') return (item.peer_username || '').toLowerCase();
  return '';
}

function mapItem(item, source, profileId, runId, handle) {
  const sentiment = item.sentiment !== null && item.sentiment !== undefined
    ? (item.sentiment === 1 ? 'Positive' : item.sentiment === -1 ? 'Negative' : 'Neutral')
    : null;

  return {
    ingest_run_id: runId,
    profile_id: profileId,
    external_id: String(item.id || item.record_index || Math.random()),
    source_type: source,
    screen_name: getAuthorHandle(item, source) || null,
    display_name: item.channel?.title || item.peer?.title || null,
    profile_image_url: item.channel?.profile || item.peer?.avatar || null,
    text: item.text || '',
    published_at: item.timestamp ? new Date(item.timestamp * 1000).toISOString() : null,
    post_url: item.record_index || null,
    media_url: null,
    view_count: item.views || item.impression || 0,
    like_count: item.total_reactions || 0,
    retweet_count: item.forwards || 0,
    reply_count: item.comments_count || 0,
    sentiment,
    simhash: null,
    canonical_id: null,
    selection_reason: `official_page_${source}_${handle}`,
    hashtags: Array.isArray(item.hashtags) ? item.hashtags : [],
  };
}

async function main() {
  const loginRes = await axios.post(`${DOMAIN}/api/v4/login`,
    { username: process.env.HASHTAG_USERNAME, password: process.env.HASHTAG_PASSWORD },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const token = loginRes.data.result;
  console.log('8tag token acquired.\n');

  const db = new Client({
    host: process.env.DB_HOST, port: +process.env.DB_PORT || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
  });
  await db.connect();
  console.log('DB connected.\n');

  const { rows: profiles } = await db.query(
    `SELECT id, name, official_channels FROM profiles
     WHERE is_active = true AND official_channels IS NOT NULL AND jsonb_array_length(official_channels) > 0
     ORDER BY name`
  );
  console.log(`Found ${profiles.length} profiles with official channels.\n`);

  let totalInserted = 0;

  for (const profile of profiles) {
    // Only process channels where we can verify authorship
    const channels = (profile.official_channels || []).filter(
      ch => VERIFIABLE_SOURCES[ch.platform] && ch.active !== false && ch.handle
    );
    if (channels.length === 0) continue;

    console.log(`\n▶ ${profile.name}`);

    const runRes = await db.query(
      `INSERT INTO ingest_runs (profile_id, status, started_at) VALUES ($1, 'running', NOW()) RETURNING id`,
      [profile.id]
    );
    const runId = runRes.rows[0].id;
    let profileInserted = 0;

    for (const channel of channels) {
      const source = VERIFIABLE_SOURCES[channel.platform];
      const handle = channel.handle.replace(/^@/, '');

      process.stdout.write(`  ${channel.platform}:${handle} ... `);

      let fetched = 0, kept = 0, page = 0, lastTimestamp = null;

      while (page < 10) {
        const payload = {
          token, source,
          sort: 'recent',
          range: 'custom',
          size: SIZE,
          lang: 'fa',
          forward: 'false',
          or: handle,
          since: SINCE_TS,
          max: page === 0 ? MAX_TS : (lastTimestamp - 1),
        };

        try {
          const res = await axios.post(`${DOMAIN}/api/v4/search`, payload,
            { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
          );
          const items = res.data.result || [];
          if (!items.length) break;

          // Only keep posts FROM this handle
          const fromHandle = items.filter(item =>
            getAuthorHandle(item, source) === handle.toLowerCase()
          );
          fetched += items.length;

          for (const item of fromHandle) {
            const row = mapItem(item, source, profile.id, runId, handle);
            try {
              await db.query(
                `INSERT INTO selected_posts (
                  ingest_run_id, profile_id, external_id, source_type, screen_name, display_name,
                  profile_image_url, text, published_at, post_url, media_url,
                  view_count, like_count, retweet_count, reply_count,
                  sentiment, simhash, canonical_id, selection_reason, hashtags
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
                ON CONFLICT DO NOTHING`,
                [
                  row.ingest_run_id, row.profile_id, row.external_id, row.source_type,
                  row.screen_name, row.display_name, row.profile_image_url, row.text,
                  row.published_at, row.post_url, row.media_url,
                  row.view_count, row.like_count, row.retweet_count, row.reply_count,
                  row.sentiment, row.simhash, row.canonical_id, row.selection_reason,
                  row.hashtags,
                ]
              );
              kept++;
              profileInserted++;
              totalInserted++;
            } catch { /* skip duplicates */ }
          }

          const lastItem = items[items.length - 1];
          lastTimestamp = lastItem?.timestamp || null;

          // Stop if no matches from this handle — we've gone past their posts
          if (fromHandle.length === 0 && page > 0) break;
          if (items.length < SIZE || !lastTimestamp) break;
          page++;
          await new Promise(r => setTimeout(r, 400));
        } catch (e) {
          process.stdout.write(`ERR:${e.message} `);
          break;
        }
      }

      process.stdout.write(`fetched=${fetched} from_handle=${kept}\n`);
      await new Promise(r => setTimeout(r, 500));
    }

    await db.query(
      `UPDATE ingest_runs SET status='completed', finished_at=NOW(), posts_selected=$1 WHERE id=$2`,
      [profileInserted, runId]
    );
    if (profileInserted > 0) console.log(`  → ${profileInserted} posts stored`);
  }

  console.log(`\n✓ Done. Total: ${totalInserted} posts from official Telegram channels`);
  await db.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
