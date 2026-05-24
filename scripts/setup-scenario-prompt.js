/**
 * setup-scenario-prompt.js
 *
 * Creates the `scenario_simulator` prompt in Promtic:
 *   - One base version (no identifier)
 *   - 50 per-profile customized versions
 *
 * Model: gpt-4o (best reasoning for scenario analysis)
 *
 * Input variables:
 *   {{scenario}}              — the user's "what if" question
 *   {{profile_context}}       — who this profile is (from profile_contexts.md)
 *   {{stats}}                 — current sentiment stats
 *   {{posts_sample}}          — top recent posts
 *   {{macro_context}}         — today's political macro context
 *   {{global_macro_political_context}} — injected automatically by GlobalContextService
 *
 * Output: JSON with structured analysis
 *
 * Usage: node scripts/setup-scenario-prompt.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const { Client } = require('pg');
const path = require('path');
const fs = require('fs');

const API_KEY    = process.env.PROMTIC_API_KEY;
const HOST       = 'papi.cyber.pish.run';
const PROMPT_NAME = 'scenario_simulator';
const MODEL_NAME  = 'gpt-4o';

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

// ── Prompt content ────────────────────────────────────────────────────────────

const BASE_SYSTEM = `شما یک مشاور ارشد رسانه‌ای و تحلیلگر سیاسی ایران هستید. وظیفه شما تحلیل سناریوهای فرضی و پیش‌بینی واکنش افکار عمومی است.

## زمینه کلان سیاسی امروز:
{{global_macro_political_context}}

## آمار جاری:
{{stats}}

## نمونه پست‌های اخیر:
{{posts_sample}}

---

یک سناریوی فرضی دریافت می‌کنید. تحلیل کنید که اگر این سناریو اتفاق بیفتد، واکنش افکار عمومی و فضای رسانه‌ای چه خواهد بود.

خروجی را دقیقاً در این قالب JSON برگردان — بدون markdown، بدون توضیح اضافه:

{
  "summary": "خلاصه تحلیل در ۲-۳ جمله",
  "risk_level": "low|medium|high|critical",
  "risk_label": "برچسب فارسی ریسک",
  "sentiment_shift": عدد بین -50 تا +50 (منفی = بدتر شدن، مثبت = بهتر شدن),
  "expected_volume": "کم|متوسط|زیاد|خیلی زیاد",
  "peak_time": "زمان اوج واکنش (مثلاً: ۲-۴ ساعت آینده)",
  "breakdown": { "positive": عدد, "neutral": عدد, "negative": عدد },
  "key_risks": ["ریسک ۱", "ریسک ۲"],
  "recommendations": ["توصیه ۱", "توصیه ۲", "توصیه ۳"],
  "suggested_response": "پیشنهاد واکنش مستقیم در یک پاراگراف"
}`;

const USER_PROMPT = `سناریو: {{scenario}}`;

function buildCustomSystem(profileName, profileContext, globalContext) {
  return `شما یک مشاور ارشد رسانه‌ای و تحلیلگر سیاسی ایران هستید. وظیفه شما تحلیل سناریوهای فرضی برای ${profileName} و پیش‌بینی واکنش افکار عمومی است.

## پروفایل مورد تحلیل: ${profileName}

${profileContext}

---

## زمینه کلان سیاسی امروز:
{{global_macro_political_context}}

## آمار جاری:
{{stats}}

## نمونه پست‌های اخیر:
{{posts_sample}}

---

یک سناریوی فرضی درباره ${profileName} دریافت می‌کنید. با توجه به شخصیت، موضع سیاسی، و فضای رسانه‌ای جاری، تحلیل کنید که اگر این سناریو اتفاق بیفتد، واکنش افکار عمومی چه خواهد بود.

خروجی را دقیقاً در این قالب JSON برگردان — بدون markdown، بدون توضیح اضافه:

{
  "summary": "خلاصه تحلیل در ۲-۳ جمله",
  "risk_level": "low|medium|high|critical",
  "risk_label": "برچسب فارسی ریسک",
  "sentiment_shift": عدد بین -50 تا +50,
  "expected_volume": "کم|متوسط|زیاد|خیلی زیاد",
  "peak_time": "زمان اوج واکنش",
  "breakdown": { "positive": عدد, "neutral": عدد, "negative": عدد },
  "key_risks": ["ریسک ۱", "ریسک ۲"],
  "recommendations": ["توصیه ۱", "توصیه ۲", "توصیه ۳"],
  "suggested_response": "پیشنهاد واکنش مستقیم در یک پاراگراف"
}`;
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

  // Get or create prompt
  let promptId;
  const existing = await apiRequest('GET', `/prompts/${PROMPT_NAME}`);
  if (existing.status === 200) {
    promptId = existing.body.id;
    console.log(`Prompt "${PROMPT_NAME}" already exists (id=${promptId})`);
  } else {
    const cr = await apiRequest('POST', '/prompts', {
      name: PROMPT_NAME,
      description: 'شبیه‌ساز سناریو — تحلیل واکنش افکار عمومی به سناریوهای فرضی',
      output_type: 'json',
      status: 'active',
    });
    if (cr.status !== 201) throw new Error(`Create failed: ${JSON.stringify(cr.body)}`);
    promptId = cr.body.id;
    console.log(`Created prompt "${PROMPT_NAME}" (id=${promptId})`);
    await sleep(1000);
  }

  // Check existing versions
  const detail = await apiRequest('GET', `/prompts/${PROMPT_NAME}`);
  const existingVersions = detail.body.versions || [];
  const hasBase = existingVersions.some(v => !v.identifier_id && v.version === 'v1.0');
  const doneIds = new Set(existingVersions.filter(v => v.identifier_id).map(v => v.identifier_id));
  console.log(`Existing: ${existingVersions.length} versions (base: ${hasBase}, profiles: ${doneIds.size})\n`);

  // Create base version
  if (!hasBase) {
    process.stdout.write('Creating base v1.0 ... ');
    const r = await apiRequest('POST', `/prompts/${promptId}/versions`, {
      version: 'v1.0',
      messages: [
        { role: 'system', content: BASE_SYSTEM },
        { role: 'user', content: USER_PROMPT },
      ],
      model_name: MODEL_NAME,
      params: { temperature: 0.5, max_tokens: 800 },
    });
    if (r.status !== 201 && r.status !== 200) throw new Error(`Base version failed: ${JSON.stringify(r.body)}`);
    console.log('✓');
    await sleep(500);
  }

  // Get identifiers
  const idResp = await apiRequest('GET', '/identifiers?limit=200');
  const identifiers = idResp.body || [];
  const bySlug = new Map(identifiers.map(i => [i.external_id, i]));

  // Per-profile versions
  let created = 0, skipped = 0;
  for (const profile of profiles) {
    const slug = profile.promtic_identifier?.external_id;
    if (!slug) { skipped++; continue; }

    const identifier = bySlug.get(slug);
    if (!identifier) { console.log(`SKIP ${profile.name} — no identifier`); skipped++; continue; }
    if (doneIds.has(identifier.id)) { console.log(`SKIP ${profile.name} — already done`); skipped++; continue; }

    let ctx = profileContexts[profile.name];
    if (!ctx) {
      const key = Object.keys(profileContexts).find(k =>
        k.includes(profile.name.split(' ')[0]) || profile.name.includes(k.split(' ')[0])
      );
      ctx = key ? profileContexts[key] : `${profile.name}: چهره سیاسی ایران.`;
    }

    process.stdout.write(`  ${profile.name} (${slug}) ... `);
    const sys = buildCustomSystem(profile.name, ctx, globalContext);
    const r = await apiRequest('POST', `/prompts/${promptId}/versions`, {
      version: `v1.0-${slug}`,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: USER_PROMPT },
      ],
      model_name: MODEL_NAME,
      params: { temperature: 0.5, max_tokens: 800 },
      identifier_id: identifier.id,
    });
    if (r.status === 201 || r.status === 200) {
      console.log('✓');
      created++;
    } else {
      console.log(`ERR: ${r.status}`);
    }
    await sleep(300);
  }

  console.log(`\nDone. Created: ${created + (hasBase ? 0 : 1)} | Skipped: ${skipped}`);
  console.log(`Model: ${MODEL_NAME}`);
  console.log(`Input vars: {{scenario}}, {{stats}}, {{posts_sample}}, {{global_macro_political_context}}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
