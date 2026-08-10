/**
 * seed-sort-names.js
 *
 * Populates profiles.sort_name with the correct family name for each profile.
 * Compound family names (e.g. حداد عادل, محسنی اژه‌ای) are handled explicitly.
 *
 * Usage: node scripts/seed-sort-names.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST, port: 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
});

// Explicit family name mapping — covers compound names and edge cases.
// For simple "FirstName FamilyName" cases, the last word is used automatically.
const EXPLICIT = {
  'غلامعلی حداد عادل':        'حداد عادل',
  'غلامحسین محسنی اژه‌ای':    'محسنی اژه‌ای',
  'حسام‌الدین آشنا':           'آشنا',
  'سید احمد خاتمی':            'خاتمی',
  'سید عباس عراقچی':           'عراقچی',
  'سید عزت‌الله ضرغامی':       'ضرغامی',
  'سید مجتبی خامنه‌ای':        'خامنه‌ای',
  'سید محمد خاتمی':            'خاتمی',
  'سیدعلی مدنی‌زاده':          'مدنی‌زاده',
  'سیدمجید موسوی':             'موسوی',
  'محمدباقر ذوالقدر':          'ذوالقدر',
  'محمدباقر قالیباف':          'قالیباف',
  'محمدجواد ظریف':             'ظریف',
  'محمدرضا باهنر':             'باهنر',
  'محمدرضا صباغیان':           'صباغیان',
  'محمدرضا عارف':              'عارف',
  'محمود احمدی‌نژاد':          'احمدی‌نژاد',
  'حمیدرضا حاجی‌بابایی':       'حاجی‌بابایی',
  'امیرحسین ثابتی':            'ثابتی',
  'احمدرضا رادان':             'رادان',
};

function deriveSortName(fullName) {
  if (EXPLICIT[fullName]) return EXPLICIT[fullName];
  // Default: last whitespace-separated word
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1];
}

async function main() {
  // Apply migration
  const sql = fs.readFileSync(path.join(__dirname, '012-sort-name.sql'), 'utf8');
  await pool.query(sql);
  console.log('Migration 012 applied.\n');

  const { rows: profiles } = await pool.query('SELECT id, name FROM profiles ORDER BY name');
  let updated = 0;

  for (const p of profiles) {
    const sortName = deriveSortName(p.name);
    await pool.query('UPDATE profiles SET sort_name = $1 WHERE id = $2', [sortName, p.id]);
    console.log(`  ${p.name.padEnd(30)} → ${sortName}`);
    updated++;
  }

  console.log(`\nDone. Updated ${updated} profiles.`);
  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
