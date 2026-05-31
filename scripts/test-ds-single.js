/**
 * Single batch test for batch_sentiment_ds (DeepSeek V4 Flash).
 * Sends 25 real posts from the DB and prints the full parsed result.
 * Usage: node scripts/test-ds-single.js
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const PROMTIC_BASE_URL = 'https://papi.cyber.pish.run';
const PROMTIC_API_KEY = 'pk_ef39b96c1e37d9fb3488680c84dba67d7a9f9f210af8f5d36971e8a60c5203cc';

async function callPromtic(body) {
  const res = await fetch(`${PROMTIC_BASE_URL}/invocations/execute`, {
    method: 'POST',
    headers: { 'x-api-key': PROMTIC_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  const data = json.data || json;

  if (data.status === 'completed') return data;
  if (data.status === 'error') throw new Error(`Promtic error: ${data.error_message || JSON.stringify(data).slice(0, 400)}`);

  // Poll
  const uid = data.uid;
  console.log(`Polling uid=${uid}...`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await fetch(`${PROMTIC_BASE_URL}/invocations/${uid}`, {
      headers: { 'x-api-key': PROMTIC_API_KEY },
    });
    const pollJson = await pollRes.json();
    const d = pollJson.data || pollJson;
    if (d.status === 'completed') return d;
    if (d.status === 'error') throw new Error(`Promtic error: ${d.error_message || JSON.stringify(d).slice(0, 400)}`);
    process.stdout.write('.');
  }
  throw new Error('Timeout');
}

async function main() {
  const db = new Client({ host: 'localhost', port: 5432, database: 'cyber', user: 'postgres', password: 'B0b_Dylan' });
  await db.connect();

  // Get profile with most posts
  const { rows: [profile] } = await db.query(`
    SELECT p.id, p.name, p.promtic_identifier, p.profile_contexts
    FROM profiles p
    JOIN selected_posts sp ON sp.profile_id = p.id AND sp.canonical_id IS NULL AND LENGTH(sp.text) > 20
    GROUP BY p.id, p.name, p.promtic_identifier, p.profile_contexts
    ORDER BY COUNT(sp.id) DESC LIMIT 1
  `);
  console.log(`Profile: ${profile.name}`);

  // Get 25 posts
  const { rows: posts } = await db.query(`
    SELECT id, text FROM selected_posts
    WHERE profile_id = $1 AND canonical_id IS NULL AND LENGTH(text) > 20
      AND (selection_reason IS NULL OR (selection_reason NOT LIKE 'official_page_%' AND selection_reason NOT LIKE 'display_%'))
    ORDER BY view_count DESC LIMIT 25
  `, [profile.id]);

  // Get global context
  const { rows: ctxRows } = await db.query(`SELECT key, value FROM global_context WHERE key = 'macro_political_context'`);
  const macroCtx = ctxRows[0]?.value || '';

  await db.end();

  const postsBatch = posts.map((p, i) => `[${i + 1}] ${p.text.replace(/\n+/g, ' ').slice(0, 500)}`).join('\n\n');
  const profileContext = profile.profile_contexts?.default || '';

  console.log(`\nSending ${posts.length} posts to batch_sentiment_ds...`);
  console.log(`Profile context length: ${profileContext.length} chars`);
  console.log(`Posts batch length: ${postsBatch.length} chars`);
  console.log(`\nFirst post (first 100 chars): ${postsBatch.slice(0, 100)}\n`);

  const startMs = Date.now();
  const result = await callPromtic({
    prompt_name: 'batch_sentiment',
    input_vars: {
      profile_context: profileContext,
      global_macro_political_context: macroCtx,
      global_macro_political_context_7d: '',
      posts_batch: postsBatch,
    },
    identifier: {
      external_id: profile.promtic_identifier?.external_id || profile.id,
      name: profile.name,
      type: 'political_figure',
    },
    params: {
      temperature: 0.2,
      max_tokens: 16384,
    },
  });

  console.log(`\n✓ Done in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
  console.log(`  Model: ${result.model_name}`);
  console.log(`  Tokens: prompt=${result.token_usage?.prompt}, completion=${result.token_usage?.completion}`);
  console.log(`  Latency: ${result.latency_ms}ms`);
  console.log(`  Prompt version: ${result.prompt_version_id}`);
  // Show what input_vars Promtic received (confirms variable substitution)
  if (result.input_vars) {
    const vars = result.input_vars;
    console.log(`  Input vars keys: ${Object.keys(vars).join(', ')}`);
    console.log(`  posts_batch length in Promtic: ${(vars.posts_batch || '').length} chars`);
    console.log(`  posts_batch first 100: ${(vars.posts_batch || '').slice(0, 100)}`);
  }

  // Save raw
  const rawPath = path.join(__dirname, 'test-results', 'ds-single-raw.txt');
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  fs.writeFileSync(rawPath, result.result || '', 'utf-8');
  console.log(`\n  Raw saved to: scripts/test-results/ds-single-raw.txt`);

  // Parse
  console.log('\n=== RAW (first 500 chars) ===');
  console.log((result.result || '').slice(0, 500));

  try {
    const clean = (result.result || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(clean);

    let items;
    if (Array.isArray(parsed)) {
      items = parsed;
      console.log('\n✓ Response is a bare array');
    } else if (Array.isArray(parsed.results)) {
      items = parsed.results;
      console.log('\n✓ Response is {"results": [...]} — unwrapped');
    } else if (parsed.id !== undefined) {
      items = [parsed];
      console.log('\n⚠ Response is a single object — wrapped in array');
    } else {
      console.log('\n✗ Unexpected structure:', Object.keys(parsed));
      return;
    }

    console.log(`\n=== RESULTS: ${items.length}/${posts.length} posts classified ===`);
    const sentDist = {}, outlookDist = {};
    for (const item of items) {
      sentDist[item.sentiment] = (sentDist[item.sentiment] || 0) + 1;
      outlookDist[item.outlook] = (outlookDist[item.outlook] || 0) + 1;
    }
    console.log(`Sentiment: ${JSON.stringify(sentDist)}`);
    console.log(`Outlook:   ${JSON.stringify(outlookDist)}`);
    console.log(`\nFirst 3 results:`);
    for (const item of items.slice(0, 3)) {
      console.log(`  [${item.id}] sentiment=${item.sentiment} outlook=${item.outlook} spectrum=${item.political_spectrum} relevance=${item.relevance_score} bot=${item.bot_probability}`);
      console.log(`       reasoning: ${item.reasoning_brief}`);
    }
  } catch (e) {
    console.log(`\n✗ Parse error: ${e.message}`);
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
