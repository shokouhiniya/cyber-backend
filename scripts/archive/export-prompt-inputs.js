const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const client = new Client({
    host: 'localhost', port: 5432, user: 'postgres',
    password: 'B0b_Dylan', database: 'cyber',
  });
  await client.connect();

  const statsResult = await client.query(`
    SELECT count(*) as total,
      count(*) FILTER (WHERE sentiment = 'positive') as positive,
      count(*) FILTER (WHERE sentiment = 'negative') as negative,
      count(*) FILTER (WHERE sentiment = 'neutral') as neutral_count
    FROM content
  `);
  const row = statsResult.rows[0];
  const stats = `Total posts: ${row.total}, Positive: ${row.positive}, Negative: ${row.negative}, Neutral: ${row.neutral_count}`;

  const platformResult = await client.query(`
    SELECT source_type, count(*) as cnt,
      count(*) FILTER (WHERE sentiment='positive') as pos,
      count(*) FILTER (WHERE sentiment='negative') as neg,
      sum(view_count) as views
    FROM content GROUP BY source_type ORDER BY cnt DESC
  `);
  const platformBreakdown = platformResult.rows
    .map(r => `${r.source_type}: ${r.cnt} پست (${r.pos} مثبت / ${r.neg} منفی / ${Number(r.views).toLocaleString()} بازدید)`)
    .join('\n');

  const hashtagResult = await client.query(`
    SELECT tag, COUNT(*) as cnt
    FROM content, unnest(hashtags) AS tag
    WHERE hashtags IS NOT NULL
    GROUP BY tag ORDER BY cnt DESC LIMIT 15
  `);
  const topHashtags = hashtagResult.rows.map(r => `#${r.tag} (${r.cnt})`).join('  ');

  const negResult = await client.query(`
    SELECT text, screen_name, source_type, view_count, reply_count
    FROM content WHERE sentiment = 'negative'
    ORDER BY view_count + reply_count * 5 DESC LIMIT 10
  `);
  const topNegative = negResult.rows
    .map((p, i) => `[${i+1}] @${p.screen_name} (${p.source_type}|${p.view_count} بازدید|${p.reply_count} کامنت): ${(p.text||'').slice(0,150)}`)
    .join('\n');

  const postsResult = await client.query(`
    SELECT text, sentiment, emotion, source_type, view_count, screen_name
    FROM content ORDER BY view_count DESC LIMIT 80
  `);
  const postsSample = postsResult.rows
    .map((p, i) => `[${i+1}] (${p.source_type}|${p.sentiment}|${p.emotion}|views:${p.view_count}) @${p.screen_name}: ${(p.text||'').slice(0,200)}`)
    .join('\n');

  let md = `# Prompt Test Inputs — Enhanced\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `Use these values to test the \`smart_recommendations\` prompt in the Promtic panel.\n\n---\n\n`;
  md += `## Variable: \`stats\`\n\`\`\`\n${stats}\n\`\`\`\n\n---\n\n`;
  md += `## Variable: \`platform_breakdown\`\n\`\`\`\n${platformBreakdown}\n\`\`\`\n\n---\n\n`;
  md += `## Variable: \`top_hashtags\`\n\`\`\`\n${topHashtags}\n\`\`\`\n\n---\n\n`;
  md += `## Variable: \`top_negative_posts\`\n\`\`\`\n${topNegative}\n\`\`\`\n\n---\n\n`;
  md += `## Variable: \`posts_sample\` (80 posts)\n\`\`\`\n${postsSample}\n\`\`\`\n`;

  const outPath = path.join(__dirname, '..', '..', 'extra_files', 'prompt-test-inputs.md');
  fs.writeFileSync(outPath, md, 'utf-8');
  console.log(`Written to: ${outPath}`);
  console.log(`Stats: ${stats}`);
  await client.end();
}

main().catch(console.error);
