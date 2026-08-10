/**
 * update-batch-sentiment-prompt.js
 *
 * Updates all versions of the `batch_sentiment` prompt to include
 * a `keywords` field in the output JSON schema.
 *
 * This adds 1-3 topic keywords per post to the LLM output, which are
 * stored in selected_posts.ai_topics for the word cloud widget.
 *
 * Usage: node scripts/update-batch-sentiment-prompt.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const { Client } = require('pg');
const path = require('path');
const fs = require('fs');

const API_KEY    = process.env.PROMTIC_API_KEY;
const HOST       = 'papi.cyber.pish.run';
const PROMPT_NAME = 'batch_sentiment';
const MODEL_NAME  = 'gemini-2.5-flash-lite';

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

// ── Prompt content (v2 with keywords) ─────────────────────────────────────────

const BASE_SYSTEM_V2 = `شما یک سیستم تحلیل احساسات تخصصی برای پست‌های شبکه‌های اجتماعی فارسی هستید.

فضای سیاسی ایران به شدت دوقطبی، آمیخته با کنایه (Sarcasm) و دارای کلیدواژه‌های پنهان (Dog whistles) است.

قوانین کلی:
۱. تشخیص طنز و کنایه: عبارات تحسین‌آمیز از سوی مخالفان باید «سنتیمنت منفی/تمسخر» برچسب بخورد.
۲. اخبار خنثی: انتصابات اداری، بخشنامه‌ها و مصوبات مجلس پیش‌فرض Neutral هستند.
۳. زمینه زمانی: شرایط منطقه‌ای و تغییرات ساختاری در تحلیل لحاظ شود.
۴. ربط‌سنجی: اگر پست مستقیماً به شخصیت مورد نظر مربوط نباشد، relevance_score را ۱ یا ۲ بگذارید.
۵. کلیدواژه‌ها: ۱ تا ۳ کلیدواژه فارسی که موضوع اصلی پست را خلاصه می‌کنند (مثل: جنگ تجاری، تحریم، مذاکره هسته‌ای).

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
    "reasoning_brief": "توضیح کوتاه فارسی (حداکثر ۱۵ کلمه)",
    "keywords": ["کلیدواژه۱", "کلیدواژه۲"]
  },
  ...
]`;

const USER_PROMPT = `پست‌های زیر را تحلیل کن:

{{posts_batch}}`;

function buildCustomSystemV2(profileName, profileContext, globalContext) {
  return `${globalContext}

---

## پروفایل مورد تحلیل: ${profileName}

${profileContext}

---

یک لیست شماره‌گذاری‌شده از پست‌ها دریافت می‌کنید.
برای هر پست دقیقاً یک آبجکت JSON برگردانید.
کلیدواژه‌ها باید ۱ تا ۳ عبارت فارسی باشند که موضوع اصلی پست را خلاصه می‌کنند.

خروجی را دقیقاً در قالب JSON array زیر بازگردان — بدون هیچ متن اضافی، بدون markdown:
[
  {
    "id": <شماره پست>,
    "sentiment": "Positive" | "Negative" | "Neutral",
    "political_spectrum": "Reformist" | "Conservative" | "Moderate" | "Opposition" | "Unknown",
    "relevance_score": 1-5,
    "bot_probability": 0-100,
    "reasoning_brief": "توضیح کوتاه فارسی (حداکثر ۱۵ کلمه) درباره علت انتخاب احساس و طیف سیاسی",
    "keywords": ["کلیدواژه۱", "کلیدواژه۲"]
  },
  ...
]`;
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

  // Get prompt details
  const detail = await apiRequest('GET', `/prompts/${PROMPT_NAME}`);
  if (detail.status !== 200) { console.error('Prompt not found'); return; }
  const promptId = detail.body.id;
  const existingVersions = detail.body.versions || [];
  console.log(`Prompt: ${PROMPT_NAME} (id=${promptId}), ${existingVersions.length} existing versions`);

  // Get identifiers
  const idResp = await apiRequest('GET', '/identifiers?limit=200');
  const identifiers = idResp.body || [];
  const bySlug = new Map(identifiers.map(i => [i.external_id, i]));

  // Delete all existing versions and recreate with v2 schema
  console.log('\nDeleting old versions...');
  for (const v of existingVersions) {
    await apiRequest('DELETE', `/prompts/${promptId}/versions/${v.id}`);
    await sleep(200);
  }
  console.log(`Deleted ${existingVersions.length} versions.`);

  // Create new base version
  process.stdout.write('\nCreating base v2.0 ... ');
  const baseResp = await apiRequest('POST', `/prompts/${promptId}/versions`, {
    version: 'v2.0',
    messages: [
      { role: 'system', content: BASE_SYSTEM_V2 },
      { role: 'user', content: USER_PROMPT },
    ],
    model_name: MODEL_NAME,
    params: { temperature: 0.2, max_tokens: 4096 },
  });
  if (baseResp.status !== 201 && baseResp.status !== 200) {
    console.log(`ERR: ${JSON.stringify(baseResp.body)}`);
    return;
  }
  console.log('✓');
  await sleep(500);

  // Create per-profile versions
  let created = 0, skipped = 0;
  for (const profile of profiles) {
    const slug = profile.promtic_identifier?.external_id;
    if (!slug) { skipped++; continue; }

    const identifier = bySlug.get(slug);
    if (!identifier) { console.log(`SKIP ${profile.name} — no identifier`); skipped++; continue; }

    let ctx = profileContexts[profile.name];
    if (!ctx) {
      const key = Object.keys(profileContexts).find(k =>
        k.includes(profile.name.split(' ')[0]) || profile.name.includes(k.split(' ')[0])
      );
      ctx = key ? profileContexts[key] : `${profile.name}: چهره سیاسی ایران.`;
    }

    process.stdout.write(`  ${profile.name} (${slug}) ... `);
    const sys = buildCustomSystemV2(profile.name, ctx, globalContext);
    const resp = await apiRequest('POST', `/prompts/${promptId}/versions`, {
      version: `v2.0-${slug}`,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: USER_PROMPT },
      ],
      model_name: MODEL_NAME,
      params: { temperature: 0.2, max_tokens: 4096 },
      identifier_id: identifier.id,
    });
    if (resp.status === 201 || resp.status === 200) {
      console.log('✓');
      created++;
    } else {
      console.log(`ERR: ${resp.status}`);
    }
    await sleep(300);
  }

  console.log(`\nDone. Created: ${created + 1} (base + ${created} profiles) | Skipped: ${skipped}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
