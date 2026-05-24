/**
 * generate-macro-context.js
 *
 * Manually triggers the macro political context generation.
 * Calls the Promtic `macro_political` prompt and stores the result.
 *
 * Usage: node scripts/generate-macro-context.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const { Pool } = require('pg');

const PROMTIC_HOST = 'papi.cyber.pish.run';
const API_KEY = process.env.PROMTIC_API_KEY;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function pollInvocation(uid) {
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const r = await promticRequest('GET', `/invocations/${uid}`);
    const inv = r.body?.data || r.body;
    if (inv.status === 'completed') return inv;
    if (inv.status === 'error') throw new Error(`Promtic error: ${inv.error_message}`);
    if (inv.status === 'timeout') throw new Error('Promtic timeout');
    process.stdout.write('.');
  }
  throw new Error('Polling max attempts reached');
}

async function main() {
  const today = new Date().toLocaleDateString('fa-IR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  });

  console.log(`Generating macro political context for ${today}...`);

  // Call Promtic
  const r = await promticRequest('POST', '/invocations/execute', {
    prompt_name: 'macro_politics',
    input_vars: { date: today },
    params: { temperature: 0.2, max_tokens: 600 },
  });

  let inv = r.body?.data || r.body;
  if (!inv?.uid) {
    console.error('No uid in response:', JSON.stringify(r.body).slice(0, 300));
    process.exit(1);
  }

  if (inv.status !== 'completed') {
    process.stdout.write('Polling');
    inv = await pollInvocation(inv.uid);
    console.log(' done');
  }

  const raw = inv.result || '';
  // Strip reference brackets and parse JSON
  const stripped = raw.replace(/\[\d+\]/g, '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Fallback: store as plain text if JSON parse fails
    console.warn('JSON parse failed, storing as plain text');
    parsed = null;
  }

  const cleaned = parsed ? JSON.stringify(parsed) : stripped;

  console.log(`\nResult (${cleaned.length} chars):\n`);
  console.log(cleaned);

  // Store in global_context
  const pool = new Pool({
    host: process.env.DB_HOST, port: 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  });

  // Upsert today's context
  await pool.query(
    `INSERT INTO global_context (key, value)
     VALUES ('macro_political_context', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [cleaned],
  );

  // Upsert rolling 7-day
  const entry = `--- ${today} ---\n${cleaned}`;
  const { rows } = await pool.query(
    "SELECT value FROM global_context WHERE key = 'macro_political_context_7d'"
  );
  let rolling;
  if (rows.length > 0 && rows[0].value) {
    const parts = rows[0].value.split(/(?=--- \d{4}\/\d{2}\/\d{2} ---)/).filter(Boolean).slice(-6);
    parts.push(entry);
    rolling = parts.join('\n');
  } else {
    rolling = entry;
  }
  await pool.query(
    `INSERT INTO global_context (key, value)
     VALUES ('macro_political_context_7d', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [rolling],
  );

  console.log('\n✓ Stored in global_context (macro_political_context + 7d rolling)');
  await pool.end();
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
