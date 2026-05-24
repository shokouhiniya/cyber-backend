/**
 * batch-sentiment.js
 *
 * Runs the `sentiment_analysis` Promtic prompt on selected_posts for a set of
 * low-volume profiles and writes the results back to the DB.
 *
 * Purpose: cost/quality calibration before rolling out to all profiles.
 *
 * Usage:
 *   node scripts/batch-sentiment.js                  # default: 5 smallest profiles
 *   node scripts/batch-sentiment.js --profiles "امیر حیدری,مهدی کروبی"
 *   node scripts/batch-sentiment.js --all            # all profiles with posts
 *   node scripts/batch-sentiment.js --dry-run        # print plan, no API calls
 *
 * Flags:
 *   --concurrency N   parallel Promtic calls (default: 3)
 *   --delay N         ms between calls per worker (default: 300)
 *   --overwrite       re-classify posts that already have sentiment
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const https = require('https');
const { Client } = require('pg');

// ── Config ────────────────────────────────────────────────────────────────────

const PROMTIC_HOST = new URL(process.env.PROMTIC_BASE_URL || 'https://papi.cyber.pish.run').hostname;
const API_KEY      = process.env.PROMTIC_API_KEY;
const PROMPT_NAME  = 'sentiment_analysis';

const args         = process.argv.slice(2);
const DRY_RUN      = args.includes('--dry-run');
const OVERWRITE    = args.includes('--overwrite');
const ALL_PROFILES = args.includes('--all');
const CONCURRENCY  = (() => { const i = args.indexOf('--concurrency'); return i >= 0 ? parseInt(args[i + 1], 10) : 3; })();
const DELAY_MS     = (() => { const i = args.indexOf('--delay');       return i >= 0 ? parseInt(args[i + 1], 10) : 300; })();

const PROFILE_NAMES_ARG = (() => {
  const i = args.indexOf('--profiles');
  return i >= 0 ? args[i + 1].split(',').map(s => s.trim()) : null;
})();

// Default: 5 smallest profiles by post count
const DEFAULT_PROFILES = [
  'امیر حیدری',
  'مهدی کروبی',
  'احمد زیدآبادی',
  'حسین افشین',
  'اسماعیل قاآنی',
];

// ── Promtic API ───────────────────────────────────────────────────────────────

function promticRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: PROMTIC_HOST,
      path,
      method,
      headers: {
        'x-api-key': API_KEY,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollInvocation(uid, maxAttempts = 30, intervalMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(intervalMs);
    const r = await promticRequest('GET', `/invocations/${uid}`);
    const inv = r.body?.data || r.body;
    if (inv.status === 'completed') return inv;
    if (inv.status === 'error')     throw new Error(`Promtic error: ${inv.error_message}`);
    if (inv.status === 'timeout')   throw new Error('Promtic timeout');
  }
  throw new Error('Polling max attempts reached');
}

async function classifyPost(postText, identifier) {
  const r = await promticRequest('POST', '/invocations/execute', {
    prompt_name: PROMPT_NAME,
    input_vars: { post: postText.slice(0, 800) }, // cap at 800 chars
    identifier,
    params: { temperature: 0.3, max_tokens: 300 },
  });

  let inv = r.body?.data || r.body;
  if (!inv?.uid) throw new Error(`No uid in response: ${JSON.stringify(r.body).slice(0, 200)}`);

  if (inv.status !== 'completed') {
    inv = await pollInvocation(inv.uid);
  }

  // Parse JSON result
  let parsed;
  try {
    const raw = inv.result || '';
    // Strip markdown code fences if present
    const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`JSON parse failed: ${inv.result?.slice(0, 100)}`);
  }

  return {
    sentiment:        parsed.sentiment        || null,
    politicalSpectrum: parsed.political_spectrum || null,
    relevanceScore:   parsed.relevance_score  ?? null,
    botProbability:   parsed.bot_probability  ?? null,
    reasoningBrief:   parsed.reasoning_brief  || null,
    tokenUsage:       inv.token_usage         || null,
    costUsd:          inv.cost_usd            ?? null,
    latencyMs:        inv.latency_ms          ?? null,
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function updatePost(db, postId, result) {
  await db.query(
    `UPDATE selected_posts
     SET sentiment          = $2,
         political_spectrum = $3
     WHERE id = $1`,
    [postId, result.sentiment, result.politicalSpectrum],
  );
}

// ── Worker pool ───────────────────────────────────────────────────────────────

async function runWithConcurrency(tasks, concurrency, delayMs) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        results[i] = { error: e.message };
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const db = new Client({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user:     process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  });
  await db.connect();

  // ── Resolve target profiles ──────────────────────────────────────────────

  let profileFilter;
  if (ALL_PROFILES) {
    profileFilter = '';
  } else {
    const names = PROFILE_NAMES_ARG || DEFAULT_PROFILES;
    const placeholders = names.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: found } = await db.query(
      `SELECT id, name, promtic_identifier FROM profiles WHERE name = ANY(ARRAY[${placeholders}])`,
      names,
    );
    if (found.length === 0) {
      console.error('No matching profiles found.');
      await db.end();
      process.exit(1);
    }
    profileFilter = `AND sp.profile_id IN (${found.map(p => `'${p.id}'`).join(', ')})`;
    console.log(`\nTarget profiles (${found.length}):`);
    found.forEach(p => console.log(`  • ${p.name} (${p.promtic_identifier?.external_id || 'no-slug'})`));
  }

  // ── Load posts ───────────────────────────────────────────────────────────

  const sentimentFilter = OVERWRITE ? '' : 'AND sp.sentiment IS NULL';

  const { rows: posts } = await db.query(
    `SELECT
       sp.id,
       sp.text,
       sp.source_type,
       sp.sentiment,
       p.name        AS profile_name,
       p.promtic_identifier AS promtic_id
     FROM selected_posts sp
     JOIN profiles p ON p.id = sp.profile_id
     WHERE sp.selection_reason NOT LIKE 'official_page_%'
       AND sp.canonical_id IS NULL
       AND sp.text IS NOT NULL
       AND LENGTH(sp.text) > 10
       ${sentimentFilter}
       ${profileFilter}
     ORDER BY p.name, sp.published_at DESC`,
  );

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Posts to classify: ${posts.length}`);
  console.log(`Concurrency: ${CONCURRENCY} | Delay: ${DELAY_MS}ms | Dry-run: ${DRY_RUN}`);
  console.log(`${'─'.repeat(60)}\n`);

  if (posts.length === 0) {
    console.log('Nothing to do. All posts already have sentiment. Use --overwrite to re-classify.');
    await db.end();
    return;
  }

  if (DRY_RUN) {
    // Group by profile for the plan
    const byProfile = {};
    for (const p of posts) {
      byProfile[p.profile_name] = (byProfile[p.profile_name] || 0) + 1;
    }
    console.log('DRY RUN — would classify:');
    for (const [name, count] of Object.entries(byProfile)) {
      console.log(`  ${name}: ${count} posts`);
    }
    await db.end();
    return;
  }

  // ── Run classification ───────────────────────────────────────────────────

  const stats = {
    success: 0,
    errors:  0,
    totalTokens: 0,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    sentimentCounts: { Positive: 0, Negative: 0, Neutral: 0, unknown: 0 },
  };

  const startTime = Date.now();
  let processed = 0;

  const tasks = posts.map((post) => async () => {
    const identifier = post.promtic_id?.external_id
      ? { external_id: post.promtic_id.external_id, name: post.profile_name, type: 'political_figure' }
      : null;

    if (!identifier) {
      console.log(`  SKIP [no identifier] ${post.profile_name}`);
      return;
    }

    try {
      const result = await classifyPost(post.text, identifier);
      await updatePost(db, post.id, result);

      processed++;
      stats.success++;
      stats.totalTokens    += result.tokenUsage?.total || 0;
      stats.totalCostUsd   += result.costUsd || 0;
      stats.totalLatencyMs += result.latencyMs || 0;

      const sent = result.sentiment || 'unknown';
      stats.sentimentCounts[sent] = (stats.sentimentCounts[sent] || 0) + 1;

      const pct = Math.round((processed / posts.length) * 100);
      const cost = result.costUsd != null ? `$${result.costUsd.toFixed(5)}` : '?';
      const tokens = result.tokenUsage?.total ?? '?';
      process.stdout.write(
        `\r  [${pct}%] ${processed}/${posts.length} | ${sent.padEnd(8)} | ${tokens} tok | ${cost}  `,
      );
    } catch (e) {
      stats.errors++;
      console.error(`\n  ERR [${post.profile_name}] ${post.id.slice(0, 8)}: ${e.message}`);
    }
  });

  await runWithConcurrency(tasks, CONCURRENCY, DELAY_MS);

  // ── Summary ──────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const avgLatency = stats.success > 0 ? Math.round(stats.totalLatencyMs / stats.success) : 0;

  console.log(`\n\n${'═'.repeat(60)}`);
  console.log('BATCH SENTIMENT ANALYSIS — RESULTS');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Posts processed : ${stats.success} / ${posts.length}`);
  console.log(`  Errors          : ${stats.errors}`);
  console.log(`  Elapsed         : ${elapsed}s`);
  console.log(`  Avg latency     : ${avgLatency}ms`);
  console.log(`  Total tokens    : ${stats.totalTokens.toLocaleString()}`);
  console.log(`  Total cost      : $${stats.totalCostUsd.toFixed(4)}`);
  console.log(`  Cost per post   : $${stats.success > 0 ? (stats.totalCostUsd / stats.success).toFixed(5) : '0'}`);
  console.log(`\n  Sentiment breakdown:`);
  for (const [s, n] of Object.entries(stats.sentimentCounts)) {
    if (n > 0) console.log(`    ${s.padEnd(10)}: ${n}`);
  }
  console.log(`${'═'.repeat(60)}\n`);

  await db.end();
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
