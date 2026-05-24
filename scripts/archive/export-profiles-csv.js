// export-profiles-csv.js
// Run: node scripts/export-profiles-csv.js
// Outputs: extra_files/profiles.csv

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'cyber',
});

async function run() {
  await client.connect();

  const res = await client.query(`
    SELECT
      name,
      role,
      organization,
      array_to_string(keywords, '|') AS keywords,
      array_to_string(excluded_keywords, '|') AS excluded_keywords,
      promtic_identifier->>'external_id' AS promtic_id,
      primary_color,
      plan,
      is_active
    FROM profiles
    ORDER BY created_at
  `);

  await client.end();

  const headers = [
    'نام',
    'سمت / نقش',
    'سازمان',
    'کلیدواژه‌های جستجو (با | جدا)',
    'کلیدواژه‌های حذف (با | جدا)',
    'شناسه Promtic',
    'رنگ اصلی',
    'پلن',
    'فعال',
    // Social channels — fill manually
    'کانال تلگرام',
    'کانال ایتا',
    'کانال روبیکا',
    'کانال بله',
    'کانال ایکس (X)',
    'کانال اینستاگرام',
    'وب‌سایت',
    // Extra info — fill manually
    'تاریخ تولد',
    'حوزه فعالیت',
    'توضیحات',
  ];

  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const lines = [headers.map(escape).join(',')];

  for (const row of res.rows) {
    const cols = [
      row.name,
      row.role,
      row.organization,
      row.keywords || '',
      row.excluded_keywords || '',
      row.promtic_id || '',
      row.primary_color || '',
      row.plan || '',
      row.is_active ? 'بله' : 'خیر',
      // Social channels — blank for manual fill
      '', '', '', '', '', '', '',
      // Extra — blank for manual fill
      '', '', '',
    ];
    lines.push(cols.map(escape).join(','));
  }

  // UTF-8 BOM so Excel opens it correctly
  const csv = '\uFEFF' + lines.join('\n');
  const outPath = path.join(__dirname, '../../extra_files/profiles.csv');
  fs.writeFileSync(outPath, csv, 'utf8');
  console.log(`✅ Exported ${res.rows.length} profiles to ${outPath}`);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
