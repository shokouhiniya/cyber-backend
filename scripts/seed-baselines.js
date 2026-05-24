/**
 * seed-baselines.js
 *
 * Reads extra_files/profile-stats.csv and populates profiles.baseline_stats
 * with quarterly averages for the crisis radar.
 *
 * Usage: node scripts/seed-baselines.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST, port: 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
});

const SOURCES = ['telegram', 'instagram', 'twitter', 'media', 'newspaper', 'news', 'bale', 'rubika', 'aparat', 'forum'];
const QUARTER_DAYS = 90;

async function main() {
  // Apply migration
  const migrationSql = fs.readFileSync(path.join(__dirname, '010-profile-baselines.sql'), 'utf8');
  await pool.query(migrationSql);
  console.log('Migration 010 applied.');

  // Read CSV
  const csvPath = path.join(__dirname, '../../extra_files/profile-stats.csv');
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  const header = lines[0].split(',');

  let updated = 0;

  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const name = cols[0];

    // Build per-source stats
    const perSource = {};
    let totalPosts = 0;
    let totalViews = 0;
    let totalInteractions = 0;

    for (const src of SOURCES) {
      const totalIdx = header.indexOf(`${src}_total`);
      const avgViewsIdx = header.indexOf(`${src}_avg_views`);
      const topViewsIdx = header.indexOf(`${src}_top_views`);

      if (totalIdx < 0) continue;

      const srcTotal = parseInt(cols[totalIdx]) || 0;
      const srcAvgViews = parseInt(cols[avgViewsIdx]) || 0;
      const srcTopViews = parseInt(cols[topViewsIdx]) || 0;

      perSource[src] = {
        total: srcTotal,
        avgViews: srcAvgViews,
        topViews: srcTopViews,
      };

      totalPosts += srcTotal;
      totalViews += srcTotal * srcAvgViews; // estimated total views
    }

    const avgDailyPosts = Math.round(totalPosts / QUARTER_DAYS);
    const avgViews = totalPosts > 0 ? Math.round(totalViews / totalPosts) : 0;

    const baselineStats = {
      totalPosts,
      avgDailyPosts,
      avgViews,
      quarterDays: QUARTER_DAYS,
      perSource,
    };

    // Update profile
    const result = await pool.query(
      `UPDATE profiles SET baseline_stats = $1 WHERE name = $2`,
      [JSON.stringify(baselineStats), name],
    );

    if (result.rowCount > 0) {
      console.log(`  ✓ ${name}: ${avgDailyPosts} posts/day, avg views ${avgViews}`);
      updated++;
    } else {
      console.log(`  ✗ ${name}: not found in DB`);
    }
  }

  console.log(`\nDone. Updated ${updated} profiles.`);
  await pool.end();
}

main().catch(e => { console.error(e.message); pool.end(); });
