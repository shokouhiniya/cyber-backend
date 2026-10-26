/**
 * Rebuilds hourly_aggregates from selected_posts, bucketed by the posts'
 * published hour (UTC) with their final (LLM) sentiment.
 *
 * Before migration 015 the worker wrote aggregates keyed by the *ingest* hour
 * and before batch sentiment ran, so most rows were 'Neutral'/8tag sentiment.
 * The worker now rebuilds the touched hours after every run; this script does
 * the same for all existing data once (local DB, then production).
 *
 * Mirrors src/modules/ingest/hourly-aggregate.builder.ts — keep the post filter
 * and grouping in sync with it.
 *
 * Per profile, in one transaction: delete ALL of the profile's aggregate rows,
 * then insert the rebuilt ones. Rows for hours whose posts were already removed
 * by retention cleanup are dropped too (they were ingest-hour based anyway).
 *
 * Usage (from dashboard-backend/, reads DB_* from .env or the environment):
 *   node scripts/backfill-hourly-aggregates.js                 # all profiles
 *   node scripts/backfill-hourly-aggregates.js --profile <uuid>
 *   node scripts/backfill-hourly-aggregates.js --dry-run       # report only
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('pg');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const profileArg = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : null;

const db = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: +process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
});

// Same as AGGREGATE_POST_FILTER / HOUR_BUCKET_SQL in hourly-aggregate.builder.ts
const POST_FILTER = `published_at IS NOT NULL
  AND canonical_id IS NULL
  AND (relevance_score IS NULL OR relevance_score >= 3)
  AND (selection_reason IS NULL OR (selection_reason NOT LIKE 'official_page_%' AND selection_reason NOT LIKE 'display_%'))`;
const HOUR_BUCKET = `(date_trunc('hour', published_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

const REBUILD_SQL = `
  INSERT INTO hourly_aggregates
    (profile_id, hour, source_type, sentiment, post_count, total_views, total_likes, total_replies)
  SELECT profile_id, hr, COALESCE(src, 'all'), COALESCE(sent, 'all'),
         COUNT(*), COALESCE(SUM(view_count), 0), COALESCE(SUM(like_count), 0), COALESCE(SUM(reply_count), 0)
  FROM (
    SELECT profile_id,
           ${HOUR_BUCKET} AS hr,
           COALESCE(source_type, 'unknown') AS src,
           CASE LOWER(COALESCE(sentiment, ''))
             WHEN 'positive' THEN 'Positive'
             WHEN 'negative' THEN 'Negative'
             ELSE 'Neutral'
           END AS sent,
           view_count, like_count, reply_count
    FROM selected_posts
    WHERE profile_id = $1 AND ${POST_FILTER}
  ) p
  GROUP BY profile_id, hr, GROUPING SETS ((src, sent), (src), (sent), ())`;

async function main() {
  await db.connect();
  const profiles = profileArg
    ? (await db.query(`SELECT id, name FROM profiles WHERE id = $1`, [profileArg])).rows
    : (await db.query(`SELECT DISTINCT p.id, p.name FROM profiles p
                        WHERE EXISTS (SELECT 1 FROM selected_posts s WHERE s.profile_id = p.id)
                           OR EXISTS (SELECT 1 FROM hourly_aggregates h WHERE h.profile_id = p.id)
                        ORDER BY p.name`)).rows;
  if (profiles.length === 0) {
    console.log(profileArg ? `Profile ${profileArg} not found` : 'No profiles with posts or aggregates');
    return;
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}Rebuilding hourly_aggregates for ${profiles.length} profile(s)`);
  for (const p of profiles) {
    const before = await db.query(
      `SELECT COUNT(*)::int AS rows, COALESCE(SUM(post_count) FILTER (WHERE source_type = 'all' AND sentiment = 'all'), 0)::int AS posts
         FROM hourly_aggregates WHERE profile_id = $1`,
      [p.id],
    );
    const eligible = await db.query(
      `SELECT COUNT(*)::int AS n FROM selected_posts WHERE profile_id = $1 AND ${POST_FILTER}`,
      [p.id],
    );

    let inserted = 0;
    if (!dryRun) {
      await db.query('BEGIN');
      await db.query(`DELETE FROM hourly_aggregates WHERE profile_id = $1`, [p.id]);
      inserted = (await db.query(REBUILD_SQL, [p.id])).rowCount;
      await db.query('COMMIT');
    }
    console.log(
      `  ${p.name}: before ${before.rows[0].rows} rows / ${before.rows[0].posts} posts → ` +
      `${dryRun ? 'would rebuild from' : `${inserted} rows from`} ${eligible.rows[0].n} posts`,
    );
  }
}

main()
  .catch(async (e) => {
    console.error(e.message);
    try { await db.query('ROLLBACK'); } catch { /* ignore */ }
    process.exitCode = 1;
  })
  .finally(() => db.end());
