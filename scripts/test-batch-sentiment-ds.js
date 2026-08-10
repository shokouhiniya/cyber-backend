/**
 * Isolated test: batch_sentiment_ds prompt with batches of 25, 50, 100, 200 posts.
 * Uses real posts + profile context from the DB.
 * Saves results as CSV files in /scripts/test-results/
 *
 * Usage: node scripts/test-batch-sentiment-ds.js
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const PROMTIC_BASE_URL = 'https://papi.cyber.pish.run';
const PROMTIC_API_KEY = 'pk_ef39b96c1e37d9fb3488680c84dba67d7a9f9f210af8f5d36971e8a60c5203cc';
const PROMPT_NAME = 'batch_sentiment_ds';
const PROMPT_NAME_ORIGINAL = 'batch_sentiment';
const OUTPUT_DIR = path.join(__dirname, 'test-results');

const BATCH_SIZES = [25, 50, 100, 200];

// ── Promtic helpers ──────────────────────────────────────────────────────────

async function callPromtic(promptName, inputVars, identifier) {
  const isDeepSeek = promptName.includes('_ds');
  const body = {
    prompt_name: promptName,
    input_vars: inputVars,
    identifier,
    params: {
      temperature: 0.2,
      max_tokens: 16384,
      // DeepSeek V4 Flash requires response_format to reliably output JSON
      ...(isDeepSeek ? { response_format: { type: 'json_object' } } : {}),
    },
  };

  const res = await fetch(`${PROMTIC_BASE_URL}/invocations/execute`, {
    method: 'POST',
    headers: { 'x-api-key': PROMTIC_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  const data = json.data || json;

  if (data.status === 'completed') return data;
  if (data.status === 'error') throw new Error(`Promtic error: ${data.error_message || JSON.stringify(data).slice(0, 500)}`);

  if (data.status === 'pending' || data.status === 'processing') {
    const uid = data.uid;
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      const pollRes = await fetch(`${PROMTIC_BASE_URL}/invocations/${uid}`, {
        headers: { 'x-api-key': PROMTIC_API_KEY },
      });
      const pollJson = await pollRes.json();
      const pollData = pollJson.data || pollJson;
      if (pollData.status === 'completed') return pollData;
      if (pollData.status === 'error') throw new Error(`Promtic error: ${pollData.error_message}`);
      process.stdout.write('.');
    }
    throw new Error('Timeout waiting for Promtic result');
  }

  throw new Error(`Unexpected status: ${data.status} — ${JSON.stringify(data).slice(0, 200)}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── CSV helpers ──────────────────────────────────────────────────────────────

function esc(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
}

function toCsv(rows, headers) {
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

// ── Format posts for prompt ──────────────────────────────────────────────────

function formatBatch(posts) {
  return posts.map((p, i) => `[${i + 1}] ${(p.text || '').replace(/\n+/g, ' ').slice(0, 500)}`).join('\n\n');
}

// ── Parse LLM response ───────────────────────────────────────────────────────

function parseResponse(raw) {
  const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  return JSON.parse(clean);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const db = new Client({ host: 'localhost', port: 5432, database: 'cyber', user: 'postgres', password: 'B0b_Dylan' });
  await db.connect();

  // Pick the profile with the most posts
  const { rows: profileRows } = await db.query(`
    SELECT p.id, p.name, p.promtic_identifier, p.profile_contexts,
           COUNT(sp.id) as post_count
    FROM profiles p
    JOIN selected_posts sp ON sp.profile_id = p.id
      AND sp.canonical_id IS NULL AND sp.text IS NOT NULL AND LENGTH(sp.text) > 20
    GROUP BY p.id, p.name, p.promtic_identifier, p.profile_contexts
    ORDER BY post_count DESC
    LIMIT 1
  `);

  const profile = profileRows[0];
  console.log(`\nUsing profile: ${profile.name} (${profile.post_count} posts available)`);

  const profileContext = profile.profile_contexts?.default || '';
  const identifier = {
    external_id: profile.promtic_identifier?.external_id || profile.id,
    name: profile.name,
    type: 'political_figure',
  };

  // Get global context
  const { rows: ctxRows } = await db.query(`SELECT key, value FROM global_context WHERE key IN ('macro_political_context', 'macro_political_context_7d')`);
  const globalCtx = Object.fromEntries(ctxRows.map(r => [r.key, r.value]));

  // Fetch up to 200 posts (most recent from latest run)
  const { rows: posts } = await db.query(`
    SELECT sp.id, sp.text, sp.source_type, sp.screen_name, sp.view_count, sp.sentiment
    FROM selected_posts sp
    WHERE sp.profile_id = $1
      AND sp.canonical_id IS NULL
      AND sp.text IS NOT NULL
      AND LENGTH(sp.text) > 20
      AND (sp.selection_reason IS NULL OR (sp.selection_reason NOT LIKE 'official_page_%' AND sp.selection_reason NOT LIKE 'display_%'))
    ORDER BY sp.view_count + sp.like_count * 2 + sp.reply_count * 3 DESC
    LIMIT 200
  `, [profile.id]);

  console.log(`Fetched ${posts.length} posts for testing\n`);
  await db.end();

  const inputVars = {
    profile_context: profileContext,
    global_macro_political_context: globalCtx.macro_political_context || '',
    global_macro_political_context_7d: globalCtx.macro_political_context_7d || '',
  };

  // Run tests for each batch size — both prompts
  for (const promptName of [PROMPT_NAME, PROMPT_NAME_ORIGINAL]) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`PROMPT: ${promptName}`);
    console.log(`${'═'.repeat(60)}`);

    for (const batchSize of BATCH_SIZES) {
    const batch = posts.slice(0, batchSize);
    if (batch.length < batchSize) {
      console.log(`⚠ Skipping batch size ${batchSize} — only ${batch.length} posts available`);
      continue;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Testing batch size: ${batchSize} posts`);
    console.log(`${'─'.repeat(60)}`);

    const postsBatch = formatBatch(batch);
    const startMs = Date.now();

    let result;
    try {
      result = await callPromtic(promptName, { ...inputVars, posts_batch: postsBatch }, identifier);
      console.log(`\n✓ Completed in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
      console.log(`  Tokens: prompt=${result.token_usage?.prompt}, completion=${result.token_usage?.completion}`);
      console.log(`  Latency: ${result.latency_ms}ms`);
    } catch (err) {
      console.log(`\n✗ Failed: ${err.message}`);
      continue;
    }

    // Always save raw response for inspection
    fs.writeFileSync(path.join(OUTPUT_DIR, `${promptName}-batch${batchSize}-raw.txt`), result?.result || '', 'utf-8');

    // Parse response
    let parsed;
    try {
      parsed = parseResponse(result.result);
      // Handle case where model wraps array in an object
      if (!Array.isArray(parsed)) {
        // DeepSeek json_object mode: look for {"results": [...]} wrapper
        const candidate = parsed.results || parsed.classifications || parsed.posts || parsed.data
          || Object.values(parsed).find(v => Array.isArray(v));
        if (Array.isArray(candidate)) {
          console.log(`  Note: LLM wrapped array in object key — unwrapped`);
          parsed = candidate;
        } else if (parsed.id !== undefined) {
          // Single object response — wrap in array
          console.log(`  Note: LLM returned single object instead of array — wrapping`);
          parsed = [parsed];
        } else {
          throw new Error(`Expected array, got ${typeof parsed}: ${JSON.stringify(parsed).slice(0, 200)}`);
        }
      }
      console.log(`  LLM returned ${parsed.length}/${batchSize} results (${Math.round(parsed.length / batchSize * 100)}% coverage)`);
    } catch (err) {
      console.log(`  Parse error: ${err.message}`);
      console.log(`  Raw (first 500 chars): ${result.result?.slice(0, 500)}`);
      // Save raw response for debugging
      fs.writeFileSync(path.join(OUTPUT_DIR, `batch${batchSize}-raw.txt`), result.result || '');
      continue;
    }

    // Build CSV rows — merge LLM results with original post data
    const resultMap = new Map(parsed.map(r => [r.id, r]));
    const csvRows = batch.map((post, idx) => {
      const llm = resultMap.get(idx + 1) || {};
      return {
        post_index: idx + 1,
        post_id: post.id,
        source: post.source_type,
        screen_name: post.screen_name,
        view_count: post.view_count,
        original_sentiment: post.sentiment,
        // LLM outputs
        sentiment: llm.sentiment || '',
        outlook: llm.outlook || '',
        political_spectrum: llm.political_spectrum || '',
        relevance_score: llm.relevance_score ?? '',
        bot_probability: llm.bot_probability ?? '',
        reasoning_brief: llm.reasoning_brief || '',
        keywords: Array.isArray(llm.keywords) ? llm.keywords.join('|') : '',
        classified: resultMap.has(idx + 1) ? 'yes' : 'no',
        text: post.text,
      };
    });

    const headers = ['post_index', 'post_id', 'source', 'screen_name', 'view_count',
      'original_sentiment', 'sentiment', 'outlook', 'political_spectrum',
      'relevance_score', 'bot_probability', 'reasoning_brief', 'keywords', 'classified', 'text'];

    const csv = '\uFEFF' + toCsv(csvRows, headers);
    const filename = `${promptName}-batch${batchSize}.csv`;
    const filepath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filepath, csv, 'utf-8');
    console.log(`  Saved: scripts/test-results/${filename}`);

    // Summary stats
    const classified = csvRows.filter(r => r.classified === 'yes');
    const withSpectrum = classified.filter(r => r.political_spectrum);
    const withOutlook = classified.filter(r => r.outlook);
    const sentimentDist = {};
    const outlookDist = {};
    for (const r of classified) {
      sentimentDist[r.sentiment] = (sentimentDist[r.sentiment] || 0) + 1;
      outlookDist[r.outlook] = (outlookDist[r.outlook] || 0) + 1;
    }
    console.log(`  Coverage: ${classified.length}/${batchSize} classified`);
    console.log(`  With political_spectrum: ${withSpectrum.length}`);
    console.log(`  With outlook: ${withOutlook.length}`);
    console.log(`  Sentiment: ${JSON.stringify(sentimentDist)}`);
    console.log(`  Outlook: ${JSON.stringify(outlookDist)}`);

    // Small delay between calls
    if (batchSize < BATCH_SIZES[BATCH_SIZES.length - 1]) {
      console.log('\n  Waiting 3s before next batch...');
      await sleep(3000);
    }
  } // end batchSize loop
  } // end promptName loop

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Results saved to: ${OUTPUT_DIR}`);
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
