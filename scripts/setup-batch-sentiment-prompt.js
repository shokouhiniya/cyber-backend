/**
 * setup-batch-sentiment-prompt.js
 *
 * Creates the `batch_sentiment` prompt in Promtic:
 *   - One base version (no identifier) using gemini-2.5-flash-lite
 *   - 50 per-profile customized versions with identifier_id
 *
 * The prompt receives a numbered list of posts and returns a JSON array
 * of results — one entry per post — so a single API call classifies
 * many posts at once, dramatically reducing per-post cost and latency.
 *
 * Input variable:  {{posts_batch}}  — numbered list, one post per line
 * Output: JSON array [ { "id": 1, "sentiment": "...", "political_spectrum": "...",
 *                        "relevance_score": N, "bot_probability": N,
 *                        "reasoning_brief": "..." }, ... ]
 *
 * Usage:  node scripts/setup-batch-sentiment-prompt.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const { Client } = require('pg');
const path = require('path');
const fs = require('fs');

const API_KEY    = process.env.PROMTIC_API_KEY;
const HOST       = 'papi.cyber.pish.run';
const PROMPT_NAME = 'batch_sentiment';
const MODEL_NAME  = 'gemini-2.5-flash-lite';   // cheapest capable model

// ── Promtic helpers ───────────────────────────────────────────────────────────

function apiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: HOST, path: apiPath, method,
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

async function getOrCreatePrompt() {
  const r = await apiRequest('GET', `/prompts/${PROMPT_NAME}`);
  if (r.status === 200) {
    console.log(`Prompt "${PROMPT_NAME}" already exists (id=${r.body.id})`);
    return r.body;
  }
  const cr = await apiRequest('POST', '/prompts', {
    name: PROMPT_NAME,
    description: 'تحلیل احساسات دسته‌ای پست‌های شبکه‌های اجتماعی — یک فراخوانی برای چندین پست',
    output_type: 'json',
    status: 'active',
  });
  if (cr.status !== 201) throw new Error(`Create prompt failed: ${JSON.stringify(cr.body)}`);
  console.log(`Created prompt "${PROMPT_NAME}" (id=${cr.body.id})`);
  await sleep(1000);
  return cr.body;
}

async function createVersion(promptId, version, systemPrompt, userPrompt, identifierId) {
  const body = {
    version,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    model_name: MODEL_NAME,
    params: { temperature: 0.2, max_tokens: 4096 },
  };
  if (identifierId) body.identifier_id = identifierId;
  const r = await apiRequest('POST', `/prompts/${promptId}/versions`, body);
  if (r.status !== 201 && r.status !== 200)
    throw new Error(`Create version failed (${r.status}): ${JSON.stringify(r.body)}`);
  return r.body;
}

async function getIdentifiers() {
  const r = await apiRequest('GET', '/identifiers?limit=200');
  if (r.status !== 200) throw new Error('Failed to list identifiers');
  return r.body;
}

async function ensureIdentifier(slug, name) {
  // Trigger a dummy invocation so Promtic auto-creates the identifier record
  const r = await apiRequest('POST', '/invocations/execute', {
    prompt_name: 'sentiment_analysis',   // use existing prompt — just to seed the identifier
    input_vars: { post: 'init' },
    identifier: { external_id: slug, name, type: 'political_figure' },
  });
  if (r.status !== 201 && r.status !== 200)
    throw new Error(`Init invocation failed: ${JSON.stringify(r.body)}`);
  return r.body.identifier_id;
}

// ── Prompt content ────────────────────────────────────────────────────────────

const BASE_SYSTEM = `شما یک سیستم تحلیل احساسات تخصصی برای پست‌های شبکه‌های اجتماعی فارسی هستید.

فضای سیاسی ایران به شدت دوقطبی، آمیخته با کنایه (Sarcasm) و دارای کلیدواژه‌های پنهان (Dog whistles) است.

قوانین کلی:
۱. تشخیص طنز و کنایه: عبارات تحسین‌آمیز از سوی مخالفان باید «سنتیمنت منفی/تمسخر» برچسب بخورد.
۲. اخبار خنثی: انتصابات اداری، بخشنامه‌ها و مصوبات مجلس پیش‌فرض Neutral هستند.
۳. زمینه زمانی: شرایط منطقه‌ای و تغییرات ساختاری در تحلیل لحاظ شود.
۴. ربط‌سنجی: اگر پست مستقیماً به شخصیت مورد نظر مربوط نباشد، relevance_score را ۱ یا ۲ بگذارید.

یک لیست شماره‌گذاری‌شده از پست‌ها دریافت می‌کنید.
برای هر پست دقیقاً یک آبجکت JSON برگردانید.

خروجی را دقیقاً در قالب JSON array زیر بازگردان — بدون هیچ متن اضافی، بدون markdown:
[
  {
    "id": <شماره پست>,
    "sentiment": "Positive" | "Negative" | "Neutral",
    "political_spectrum": "Reformist" | "Conservative" | "Moderate" | "Opposition" | "Unknown",
    "relevance_score": 1-5,
    "bot_probability": 0-100,
    "reasoning_brief": "توضیح کوتاه فارسی (حداکثر ۱۵ کلمه)"
  },
  ...
]`;

const USER_PROMPT = `پست‌های زیر را تحلیل کن:

{{posts_batch}}`;

function buildCustomSystem(profileName, profileContext, globalContext) {
  return `${globalContext}

---

## پروفایل مورد تحلیل: ${profileName}

${profileContext}

---

یک لیست شماره‌گذاری‌شده از پست‌ها دریافت می‌کنید.
برای هر پست دقیقاً یک آبجکت JSON برگردانید.

خروجی را دقیقاً در قالب JSON array زیر بازگردان — بدون هیچ متن اضافی، بدون markdown:
[
  {
    "id": <شماره پست>,
    "sentiment": "Positive" | "Negative" | "Neutral",
    "political_spectrum": "Reformist" | "Conservative" | "Moderate" | "Opposition" | "Unknown",
    "relevance_score": 1-5,
    "bot_probability": 0-100,
    "reasoning_brief": "توضیح کوتاه فارسی (حداکثر ۱۵ کلمه) درباره علت انتخاب احساس و طیف سیاسی"
  },
  ...
]`;
}

// ── Context loading ───────────────────────────────────────────────────────────

function loadProfileContexts() {
  const mdPath = path.join(__dirname, '../../extra_files/profile_contexts.md');
  const md = fs.readFileSync(mdPath, 'utf8');
  const sections = md.split(/\n## /);
  const globalContext = sections[0].trim();
  const profileContexts = {};
  for (const section of sections.slice(1)) {
    const heading = section.split('\n')[0].trim();
    const m = heading.match(/\.\s+([\u0600-\u06FF\s\u200C\u200D\u200c]+?)\s*\(/);
    if (!m) continue;
    profileContexts[m[1].trim()] = section.slice(0, 1800).trim();
  }
  return { globalContext, profileContexts };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { globalContext, profileContexts } = loadProfileContexts();
  console.log(`Loaded ${Object.keys(profileContexts).length} profile contexts.\n`);

  const db = new Client({
    host: process.env.DB_HOST, port: +process.env.DB_PORT || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
  });
  await db.connect();
  const { rows: profiles } = await db.query(
    'SELECT name, promtic_identifier FROM profiles WHERE is_active=true ORDER BY name'
  );
  await db.end();
  console.log(`Loaded ${profiles.length} profiles from DB.\n`);

  // Step 1: Get or create prompt
  const prompt = await getOrCreatePrompt();
  const promptId = prompt.id;

  // Step 2: Check existing versions
  const detail = await apiRequest('GET', `/prompts/${PROMPT_NAME}`);
  const existingVersions = detail.body.versions || [];
  const hasBase = existingVersions.some(v => !v.identifier_id && v.version === 'v1.0');
  const doneIdentifierIds = new Set(
    existingVersions.filter(v => v.identifier_id).map(v => v.identifier_id)
  );
  console.log(`Existing versions: ${existingVersions.length} (base: ${hasBase}, customized: ${doneIdentifierIds.size})\n`);

  // Step 3: Create base version
  if (!hasBase) {
    process.stdout.write('Creating base version (v1.0) ... ');
    await createVersion(promptId, 'v1.0', BASE_SYSTEM, USER_PROMPT, null);
    console.log('✓');
    await sleep(500);
  } else {
    console.log('Base version already exists.\n');
  }

  // Step 4: Get identifiers
  let identifiers = await getIdentifiers();
  const bySlug = new Map(identifiers.map(i => [i.external_id, i]));

  // Step 5: Per-profile customized versions
  let created = 0, skipped = 0, errors = 0;

  for (const profile of profiles) {
    const slug = profile.promtic_identifier?.external_id;
    if (!slug) { console.log(`SKIP ${profile.name} — no slug`); skipped++; continue; }

    // Find context block
    let ctx = profileContexts[profile.name];
    if (!ctx) {
      const key = Object.keys(profileContexts).find(k =>
        k.includes(profile.name.split(' ')[0]) || profile.name.includes(k.split(' ')[0])
      );
      ctx = key ? profileContexts[key] : `${profile.name}: چهره سیاسی ایران.`;
    }

    // Ensure identifier exists
    if (!bySlug.has(slug)) {
      process.stdout.write(`  INIT ${slug} ... `);
      await ensureIdentifier(slug, profile.name);
      await sleep(800);
      identifiers = await getIdentifiers();
      identifiers.forEach(i => bySlug.set(i.external_id, i));
      console.log(`id=${bySlug.get(slug)?.id}`);
    }

    const identifier = bySlug.get(slug);
    if (!identifier) { console.log(`ERR ${profile.name} — identifier missing`); errors++; continue; }

    if (doneIdentifierIds.has(identifier.id)) {
      console.log(`SKIP ${profile.name} (${slug}) — already customized`);
      skipped++;
      continue;
    }

    process.stdout.write(`CREATE ${profile.name} (${slug}) ... `);
    try {
      const sys = buildCustomSystem(profile.name, ctx, globalContext);
      await createVersion(promptId, `v1.0-${slug}`, sys, USER_PROMPT, identifier.id);
      console.log('✓');
      created++;
      doneIdentifierIds.add(identifier.id);
    } catch (e) {
      console.log(`ERR: ${e.message}`);
      errors++;
    }
    await sleep(400);
  }

  console.log(`\nDone. Created: ${created} | Skipped: ${skipped} | Errors: ${errors}`);
  console.log(`\nModel: ${MODEL_NAME}`);
  console.log(`Input variable: {{posts_batch}}`);
  console.log(`Output: JSON array, one object per post with id, sentiment, political_spectrum, relevance_score, bot_probability, reasoning_brief`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
