/**
 * setup-promtic-prompts.js
 *
 * Creates per-profile sentiment analysis prompts in Promtic for all 50 profiles.
 * Each prompt is named after the profile's promtic_identifier (slug).
 *
 * The prompt uses the profile's context from profile_contexts.md embedded
 * directly in the system message so the LLM understands the political landscape
 * around each figure.
 *
 * Usage:  node scripts/setup-promtic-prompts.js
 * Safe to re-run — skips prompts that already exist.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const { Client } = require('pg');
const path = require('path');
const fs = require('fs');

const API_KEY = process.env.PROMTIC_API_KEY;
const HOST = 'papi.cyber.pish.run';

// ── Promtic API helpers ───────────────────────────────────────────────────────

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

async function listPrompts() {
  const r = await apiRequest('GET', '/prompts?limit=200');
  return r.body.items || [];
}

async function createPrompt(name, description) {
  const r = await apiRequest('POST', '/prompts', {
    name, description, output_type: 'json', status: 'active',
  });
  if (r.status !== 201) throw new Error(`Create prompt failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function createVersion(promptId, systemPrompt, userPrompt) {
  // promptId must be the numeric id, not the uid
  const r = await apiRequest('POST', `/prompts/${promptId}/versions`, {
    version: 'v1.0',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    model_name: 'gpt-4o-mini',
    params: { temperature: 0.3, max_tokens: 300 },
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`Create version failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

// ── Profile context extraction ────────────────────────────────────────────────
// Reads profile_contexts.md and extracts the context block for each profile slug.

function loadProfileContexts() {
  const mdPath = path.join(__dirname, '../../extra_files/profile_contexts.md');
  const md = fs.readFileSync(mdPath, 'utf8');

  // Split on ## headings (profile sections)
  const sections = md.split(/\n## /);
  const contexts = {};

  for (const section of sections.slice(1)) {
    const lines = section.split('\n');
    const heading = lines[0].trim(); // e.g. "۱. ابراهیم حاتمی‌کیا (کارگردان سینما)"
    // Extract name: between ". " and " (" — handles Persian numbering
    const nameMatch = heading.match(/\.\s+([\u0600-\u06FF\s\u200C\u200D‌]+?)\s*\(/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    // Take the full section as context (first 1500 chars)
    contexts[name] = section.slice(0, 1500).trim();
  }

  return contexts;
}

// ── System prompt template ────────────────────────────────────────────────────

function buildSystemPrompt(profileName, profileContext, globalContext) {
  return `${globalContext}

---

## پروفایل مورد تحلیل: ${profileName}

${profileContext}

---

متنی که به تو داده می‌شود را به دقت بررسی کن و خروجی را دقیقاً و صرفاً در قالب JSON زیر بازگردان. هیچ متن اضافی، مقدمه، مؤخره یا قالب‌بندی لنگر (مانند \`\`\`json) در خروجی قرار نده.

ساختار JSON خروجی:
{
  "sentiment": "Positive" | "Negative" | "Neutral",
  "political_spectrum": "Reformist" | "Conservative" | "Moderate" | "Opposition" | "Unknown",
  "relevance_score": 1-5,
  "bot_probability": 0-100,
  "reasoning_brief": "یک توضیح بسیار کوتاه به فارسی (حداکثر ۱۵ کلمه) درباره علت انتخاب احساس و طیف سیاسی."
}

راهنمای تحلیل متغیرها:
1. sentiment: لحن عاطفی متن نسبت به ${profileName} (مثبت، منفی، یا خنثی/خبری).
2. political_spectrum: گرایش سیاسی احتمالی نویسنده پست.
3. relevance_score: میزان ارتباط مستقیم متن به ${profileName} (۱=بی‌ربط، ۵=کاملاً مرتبط).
4. bot_probability: احتمال ماشینی/هماهنگ بودن پست (۰=انسانی، ۱۰۰=بات).
5. reasoning_brief: توضیح کوتاه فارسی.`;
}

const USER_PROMPT = `متن پست:
{{post}}`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load global context (first section of profile_contexts.md before first ##)
  const mdPath = path.join(__dirname, '../../extra_files/profile_contexts.md');
  const md = fs.readFileSync(mdPath, 'utf8');
  const globalContext = md.split(/\n## /)[0].trim();

  // Load per-profile contexts
  const profileContexts = loadProfileContexts();
  console.log(`Loaded ${Object.keys(profileContexts).length} profile contexts from markdown.\n`);

  // Load profiles from DB
  const db = new Client({
    host: process.env.DB_HOST, port: +process.env.DB_PORT || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
  });
  await db.connect();
  const { rows: profiles } = await db.query(
    'SELECT name, promtic_identifier FROM profiles WHERE is_active=true ORDER BY name'
  );
  await db.end();
  console.log(`Loaded ${profiles.length} profiles from database.\n`);

  // Get existing prompts — build a map by name for quick lookup
  const existing = await listPrompts();
  const existingByName = new Map(existing.map(p => [p.name, p]));
  console.log(`Existing prompts in Promtic: ${existing.length}\n`);

  let created = 0, versioned = 0, skipped = 0, errors = 0;

  for (const profile of profiles) {
    const slug = profile.promtic_identifier?.external_id;
    if (!slug) {
      console.log(`SKIP ${profile.name} — no promtic identifier`);
      skipped++;
      continue;
    }

    // Find the matching context block
    let contextBlock = profileContexts[profile.name];
    if (!contextBlock) {
      const key = Object.keys(profileContexts).find(k =>
        k.includes(profile.name.split(' ')[0]) || profile.name.includes(k.split(' ')[0])
      );
      contextBlock = key ? profileContexts[key] : '';
    }
    if (!contextBlock) {
      contextBlock = `${profile.name}: چهره سیاسی ایران. تحلیل احساسات پست‌های مرتبط با این شخص را انجام دهید.`;
    }

    const systemPrompt = buildSystemPrompt(profile.name, contextBlock, globalContext);
    const existing_ = existingByName.get(slug);

    try {
      if (existing_ && existing_.version_count > 0) {
        // Fully set up — skip
        console.log(`SKIP ${profile.name} (${slug}) — already has ${existing_.version_count} version(s)`);
        skipped++;
        continue;
      }

      if (existing_ && existing_.version_count === 0) {
        // Prompt exists but no version — just add the version
        process.stdout.write(`VERSION ${profile.name} (${slug}) ... `);
        await new Promise(r => setTimeout(r, 500));
        await createVersion(existing_.id, systemPrompt, USER_PROMPT);
        console.log('✓');
        versioned++;
      } else {
        // Create prompt + version
        process.stdout.write(`CREATE ${profile.name} (${slug}) ... `);
        const prompt = await createPrompt(slug, `تحلیل احساسات پست‌های مرتبط با ${profile.name}`);
        // Wait for persistence
        await new Promise(r => setTimeout(r, 2000));
        await createVersion(prompt.id, systemPrompt, USER_PROMPT);
        console.log('✓');
        created++;
      }

      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      console.log(`ERR: ${e.message}`);
      errors++;
    }
  }

  console.log(`\nDone. Created: ${created} | Versioned: ${versioned} | Skipped: ${skipped} | Errors: ${errors}`);
  console.log('\nTo use a profile prompt, call:');
  console.log('  promticService.invoke({ promptName: "<slug>", inputVars: { post: "متن پست" } })');
  console.log('\nExample: promptName: "ghalibaf", inputVars: { post: "قالیباف در مجلس گفت..." }');
}

main().catch(e => { console.error(e.message); process.exit(1); });
