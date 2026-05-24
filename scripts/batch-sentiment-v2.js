/**
 * batch-sentiment-v2.js
 *
 * Batch sentiment analysis using the `batch_sentiment` prompt (gemini-2.5-flash-lite).
 * Sends posts in batches of N per API call instead of one-by-one — much cheaper.
 *
 * Usage:
 *   node scripts/batch-sentiment-v2.js                        # next 5 profiles (6-10)
 *   node scripts/batch-sentiment-v2.js --profiles "احمد وحیدی,صادق زیباکلام"
 *   node scripts/batch-sentiment-v2.js --all                  # all profiles
 *   node scripts/batch-sentiment-v2.js --dry-run              # plan only
 *   node scripts/batch-sentiment-v2.js --overwrite            # re-classify existing
 *   node scripts/batch-sentiment-v2.js --batch-size 30        # posts per API call (default 25)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const https = require('https');
const { Client } = require('pg');

// ── Config ────────────────────────────────────────────────────────────────────

const PROMTIC_HOST = new URL(process.env.PROMTIC_BASE_URL || 'https://papi.cyber.pish.run').hostname;
const API_KEY      = process.env.PROMTIC_API_KEY;
const PROMPT_NAME  = 'batch_sentiment';

const args         = process.argv.slice(2);
const DRY_RUN      = args.includes('--dry-run');
const OVERWRITE    = args.includes('--overwrite');
const ALL_PROFILES = args.includes('--all');

const BATCH_SIZE   = (() => { const i = args.indexOf('--batch-size'); return i >= 0 ? parseInt(args[i+1], 10) : 25; })();
const CONCURRENCY  = (() => { const i = args.indexOf('--concurrency'); return i >= 0 ? parseInt(args[i+1], 10) : 2; })();
const DELAY_MS     = (() => { const i = args.indexOf('--delay'); return i >= 0 ? parseInt(args[i+1], 10) : 500; })();

const PROFILE_NAMES_ARG = (() => {
  const i = args.indexOf('--profiles');
  return i >= 0 ? args[i+1].split(',').map(s => s.trim()) : null;
})();

// Default: all profiles already classified — re-run to backfill relevance_score
const DEFAULT_PROFILES = [
  'امیر حیدری', 'مهدی کروبی', 'احمد زیدآبادی', 'حسین افشین', 'اسماعیل قاآنی',
  'احمد وحیدی', 'صادق زیباکلام', 'احمدرضا رادان', 'سیدمجید موسوی', 'امیرحسین ثابتی',
  'امیر قلعه‌نویی', 'سید عباس عراقچی', 'محمدباقر قالیباف', 'ابراهیم حاتمی‌کیا', 'سید مجتبی خامنه‌ای',
  'مسعود پزشکیان', 'اسکندر مومنی',
];

// ── Promtic API ───────────────────────────────────────────────────────────────

function promticRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: PROMTIC_HOST, path, method,
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

async function pollInvocation(uid, maxAttempts = 60, intervalMs = 2000) {
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

/**
 * Format a batch of posts as a numbered list for the prompt.
 * Each post gets a sequential 1-based id that matches the response array.
 */
function formatBatch(posts) {
  return posts
    .map((p, i) => `[${i + 1}] ${p.text.replace(/\n+/g, ' ').slice(0, 500)}`)
    .join('\n\n');
}

/**
 * Send one batch to Promtic and return parsed results array.
 */
async function classifyBatch(posts, identifier) {
  const postsBatch = formatBatch(posts);

  const r = await promticRequest('POST', '/invocations/execute', {
    prompt_name: PROMPT_NAME,
    input_vars: { posts_batch: postsBatch },
    identifier,
    params: { temperature: 0.2, max_tokens: 4096 },
  });

  let inv = r.body?.data || r.body;
  if (!inv?.uid) throw new Error(`No uid in response: ${JSON.stringify(r.body).slice(0, 200)}`);

  if (inv.status !== 'completed') {
    inv = await pollInvocation(inv.uid);
  }

  // Parse JSON array result
  let parsed;
  try {
    const raw = inv.result || '';
    const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) throw new Error('Result is not an array');
  } catch (e) {
    throw new Error(`JSON parse failed: ${e.message} | raw: ${inv.result?.slice(0, 200)}`);
  }

  return {
    results: parsed,
    tokenUsage: inv.token_usage || null,
    costUsd:    inv.cost_usd    ?? null,
    latencyMs:  inv.latency_ms  ?? null,
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function updatePosts(db, updates) {
  if (updates.length === 0) return;
  const ids              = updates.map(u => u.id);
  const sentiments       = updates.map(u => u.sentiment);
  const spectrums        = updates.map(u => u.politicalSpectrum);
  const relevanceScores  = updates.map(u => u.relevanceScore?.toString() ?? null);
  const botProbabilities = updates.map(u => u.botProbability?.toString() ?? null);
  const reasonings       = updates.map(u => u.reasoningBrief);
  const topics           = updates.map(u => {
    if (!u.keywords || !Array.isArray(u.keywords) || u.keywords.length === 0) return null;
    return `{${u.keywords.map(t => `"${t.replace(/"/g, '\\"')}"`).join(',')}}`;
  });

  await db.query(
    `UPDATE selected_posts AS sp
     SET sentiment          = u.sentiment,
         political_spectrum = u.spectrum,
         relevance_score    = u.relevance::smallint,
         bot_probability    = u.bot::smallint,
         reasoning_brief    = u.reasoning,
         ai_topics          = u.topics::text[]
     FROM unnest(
       $1::uuid[],
       $2::text[],
       $3::text[],
       $4::text[],
       $5::text[],
       $6::text[],
       $7::text[]
     ) AS u(id, sentiment, spectrum, relevance, bot, reasoning, topics)
     WHERE sp.id = u.id::uuid`,
    [ids, sentiments, spectrums, relevanceScores, botProbabilities, reasonings, topics],
  );
}

// ── Worker pool ───────────────────────────────────────────────────────────────

async function runWithConcurrency(tasks, concurrency, delayMs) {
  let idx = 0;
  const results = new Array(tasks.length);

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try { results[i] = await tasks[i](); }
      catch (e) { results[i] = { error: e.message }; }
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

  let profileRows;
  if (ALL_PROFILES) {
    const { rows } = await db.query(
      'SELECT id, name, promtic_identifier FROM profiles WHERE is_active = true ORDER BY name'
    );
    profileRows = rows;
  } else {
    const names = PROFILE_NAMES_ARG || DEFAULT_PROFILES;
    const placeholders = names.map((_, i) => `$${i+1}`).join(', ');
    const { rows } = await db.query(
      `SELECT id, name, promtic_identifier FROM profiles WHERE name = ANY(ARRAY[${placeholders}])`,
      names,
    );
    profileRows = rows;
  }

  if (profileRows.length === 0) {
    console.error('No matching profiles found.');
    await db.end();
    process.exit(1);
  }

  console.log(`\nTarget profiles (${profileRows.length}):`);
  profileRows.forEach(p => console.log(`  • ${p.name} (${p.promtic_identifier?.external_id || 'no-slug'})`));

  // ── Load posts ───────────────────────────────────────────────────────────

  const profileIds = profileRows.map(p => `'${p.id}'`).join(', ');
  const sentimentFilter = OVERWRITE ? '' : 'AND sp.sentiment IS NULL';

  const { rows: posts } = await db.query(
    `SELECT
       sp.id,
       sp.text,
       sp.source_type,
       p.id            AS profile_id,
       p.name          AS profile_name,
       p.promtic_identifier AS promtic_id
     FROM selected_posts sp
     JOIN profiles p ON p.id = sp.profile_id
     WHERE sp.profile_id IN (${profileIds})
       AND sp.selection_reason NOT LIKE 'official_page_%'
       AND sp.canonical_id IS NULL
       AND sp.text IS NOT NULL
       AND LENGTH(sp.text) > 10
       ${sentimentFilter}
     ORDER BY p.name, sp.published_at DESC`,
  );

  // Group by profile
  const byProfile = new Map();
  for (const post of posts) {
    if (!byProfile.has(post.profile_id)) {
      byProfile.set(post.profile_id, {
        name: post.profile_name,
        slug: post.promtic_id?.external_id,
        posts: [],
      });
    }
    byProfile.get(post.profile_id).posts.push(post);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Posts to classify : ${posts.length}`);
  console.log(`Batch size        : ${BATCH_SIZE} posts/call`);
  console.log(`Concurrency       : ${CONCURRENCY} | Delay: ${DELAY_MS}ms`);
  console.log(`Dry-run           : ${DRY_RUN} | Overwrite: ${OVERWRITE}`);
  console.log(`${'─'.repeat(60)}\n`);

  if (posts.length === 0) {
    console.log('Nothing to do. Use --overwrite to re-classify existing sentiment.');
    await db.end();
    return;
  }

  if (DRY_RUN) {
    console.log('DRY RUN — would classify:');
    for (const [, g] of byProfile) {
      const batches = Math.ceil(g.posts.length / BATCH_SIZE);
      console.log(`  ${g.name}: ${g.posts.length} posts → ${batches} batch call(s)`);
    }
    const totalBatches = Array.from(byProfile.values()).reduce((s, g) => s + Math.ceil(g.posts.length / BATCH_SIZE), 0);
    console.log(`\n  Total API calls: ${totalBatches} (vs ${posts.length} for one-by-one)`);
    await db.end();
    return;
  }

  // ── Build batch tasks ────────────────────────────────────────────────────

  const stats = {
    success: 0, errors: 0,
    totalTokens: 0, totalCostUsd: 0, totalLatencyMs: 0,
    sentimentCounts: { Positive: 0, Negative: 0, Neutral: 0, unknown: 0 },
    batchCalls: 0,
  };

  const startTime = Date.now();
  let processedPosts = 0;

  // Flatten into batch tasks, one task per batch
  const tasks = [];
  for (const [, group] of byProfile) {
    if (!group.slug) {
      console.log(`  SKIP ${group.name} — no Promtic identifier`);
      continue;
    }
    const identifier = { external_id: group.slug, name: group.name, type: 'political_figure' };

    for (let i = 0; i < group.posts.length; i += BATCH_SIZE) {
      const batch = group.posts.slice(i, i + BATCH_SIZE);
      tasks.push(async () => {
        const { results, tokenUsage, costUsd, latencyMs } = await classifyBatch(batch, identifier);

        // Map results back to post IDs by 1-based index
        const updates = [];
        for (const item of results) {
          const postIdx = item.id - 1;
          if (postIdx < 0 || postIdx >= batch.length) continue;
          updates.push({
            id:                batch[postIdx].id,
            sentiment:         item.sentiment          || null,
            politicalSpectrum: item.political_spectrum || null,
            relevanceScore:    item.relevance_score    ?? null,
            botProbability:    item.bot_probability    ?? null,
            reasoningBrief:    item.reasoning_brief    || null,
            keywords:          Array.isArray(item.keywords) ? item.keywords : null,
          });
          const sent = item.sentiment || 'unknown';
          stats.sentimentCounts[sent] = (stats.sentimentCounts[sent] || 0) + 1;
        }

        await updatePosts(db, updates);

        stats.success      += updates.length;
        stats.batchCalls   += 1;
        stats.totalTokens  += tokenUsage?.total || 0;
        stats.totalCostUsd += costUsd || 0;
        stats.totalLatencyMs += latencyMs || 0;
        processedPosts     += batch.length;

        const pct  = Math.round((processedPosts / posts.length) * 100);
        const cost = costUsd != null ? `$${costUsd.toFixed(5)}` : '?';
        const tok  = tokenUsage?.total ?? '?';
        process.stdout.write(
          `\r  [${pct}%] ${processedPosts}/${posts.length} posts | batch ${stats.batchCalls} | ${tok} tok | ${cost}  `,
        );
      });
    }
  }

  await runWithConcurrency(tasks, CONCURRENCY, DELAY_MS);

  // ── Summary ──────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const avgBatchLatency = stats.batchCalls > 0 ? Math.round(stats.totalLatencyMs / stats.batchCalls) : 0;
  const costPerPost = stats.success > 0 ? stats.totalCostUsd / stats.success : 0;

  console.log(`\n\n${'═'.repeat(60)}`);
  console.log('BATCH SENTIMENT v2 (gemini-2.5-flash-lite) — RESULTS');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Posts classified  : ${stats.success} / ${posts.length}`);
  console.log(`  API calls made    : ${stats.batchCalls} (batch size: ${BATCH_SIZE})`);
  console.log(`  Errors            : ${stats.errors}`);
  console.log(`  Elapsed           : ${elapsed}s`);
  console.log(`  Avg batch latency : ${avgBatchLatency}ms`);
  console.log(`  Total tokens      : ${stats.totalTokens.toLocaleString()}`);
  console.log(`  Total cost        : $${stats.totalCostUsd.toFixed(5)}`);
  console.log(`  Cost per post     : $${costPerPost.toFixed(6)}`);
  console.log(`  vs gpt-4o-mini    : $0.00019/post — savings: ${costPerPost > 0 ? Math.round((1 - costPerPost/0.00019)*100) : '?'}%`);
  console.log(`\n  Sentiment breakdown:`);
  for (const [s, n] of Object.entries(stats.sentimentCounts)) {
    if (n > 0) console.log(`    ${s.padEnd(10)}: ${n}`);
  }
  console.log(`${'═'.repeat(60)}\n`);

  await db.end();
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
