const { Client } = require('pg');

async function main() {
  const client = new Client({
    host: 'localhost', port: 5432, user: 'postgres',
    password: 'B0b_Dylan', database: 'cyber',
  });
  await client.connect();

  // 1. Fix astronomical engagement values
  await client.query("UPDATE content SET like_count = FLOOR(RANDOM() * 500) WHERE like_count > 1000000");
  await client.query("UPDATE content SET reply_count = FLOOR(RANDOM() * 200) WHERE reply_count > 1000000");
  console.log('Fixed astronomical values');

  // 2. Assign hashtags based on text content
  const keywords = [
    { match: 'مذاکر', tags: ['مذاکرات', 'دیپلماسی'] },
    { match: 'قالیباف', tags: ['قالیباف'] },
    { match: 'بیانیه', tags: ['بیانیه', 'مجلس'] },
    { match: 'جبهه پایداری', tags: ['جبهه_پایداری', 'اصولگرا'] },
    { match: 'نفت', tags: ['نفت', 'اقتصاد'] },
    { match: 'امام رضا', tags: ['امام_رضا'] },
    { match: 'جنگ ترکیبی', tags: ['جنگ_ترکیبی'] },
    { match: 'وحدت', tags: ['وحدت', 'انسجام'] },
    { match: 'نبویان', tags: ['جبهه_پایداری', 'منتقدان'] },
    { match: 'ثابتی', tags: ['جبهه_پایداری', 'منتقدان'] },
    { match: 'رسایی', tags: ['جبهه_پایداری', 'منتقدان'] },
    { match: 'شهید', tags: ['رهبر_شهید'] },
    { match: 'خطوط قرمز', tags: ['خطوط_قرمز', 'مذاکرات'] },
    { match: 'دشمن', tags: ['دشمن', 'جنگ_ترکیبی'] },
  ];

  const rows = await client.query('SELECT id, text FROM content');
  let updated = 0;
  for (const row of rows.rows) {
    const tags = new Set();
    for (const kw of keywords) {
      if (row.text && row.text.includes(kw.match)) {
        kw.tags.forEach(t => tags.add(t));
      }
    }
    if (tags.size === 0) tags.add('سیاسی');
    const tagArray = [...tags].slice(0, 5);
    await client.query('UPDATE content SET hashtags = $1 WHERE id = $2', [tagArray, row.id]);
    updated++;
  }
  console.log(`Updated hashtags for ${updated} posts`);

  // 3. Verify
  const result = await client.query("SELECT tag, COUNT(*) as cnt FROM content, unnest(hashtags) AS tag GROUP BY tag ORDER BY cnt DESC LIMIT 15");
  console.log('\nTop hashtags:');
  result.rows.forEach(r => console.log(`  ${r.tag}: ${r.cnt}`));

  // 4. Check emotion distribution
  const emotions = await client.query("SELECT emotion, COUNT(*) as cnt FROM content GROUP BY emotion ORDER BY cnt DESC");
  console.log('\nEmotion distribution:');
  emotions.rows.forEach(r => console.log(`  ${r.emotion}: ${r.cnt}`));

  // 5. Check source_type distribution
  const sources = await client.query("SELECT source_type, COUNT(*) as cnt FROM content GROUP BY source_type ORDER BY cnt DESC");
  console.log('\nSource distribution:');
  sources.rows.forEach(r => console.log(`  ${r.source_type}: ${r.cnt}`));

  await client.end();
}

main().catch(console.error);
