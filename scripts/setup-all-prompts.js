/**
 * setup-all-prompts.js
 *
 * Creates base + per-profile customized versions for all 5 dashboard prompts:
 *   dashboard_ai_summary, macro_context_analysis,
 *   smart_recommendations, narrative_gap_analysis, political_spectrum
 *
 * Base versions are generic (no person named).
 * Customized versions inject the profile's identity, role, political position,
 * and sensitive topics extracted from profile_contexts.md.
 *
 * Usage:  node scripts/setup-all-prompts.js
 * Safe to re-run — skips already-completed steps.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const { Client } = require('pg');
const path = require('path');
const fs = require('fs');

const API_KEY = process.env.PROMTIC_API_KEY;
const HOST = 'papi.cyber.pish.run';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function apiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: HOST, path: apiPath, method,
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getOrCreatePrompt(name, description) {
  const r = await apiRequest('GET', `/prompts/${name}`);
  if (r.status === 200) return r.body;
  const cr = await apiRequest('POST', '/prompts', { name, description, output_type: 'json', status: 'active' });
  if (cr.status !== 201) throw new Error(`Create prompt "${name}" failed: ${JSON.stringify(cr.body)}`);
  await sleep(1500);
  return cr.body;
}

async function createVersion(promptId, version, systemPrompt, userPrompt, identifierId) {
  const body = { version, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    model_name: 'gpt-4o-mini', params: { temperature: 0.4, max_tokens: 800 } };
  if (identifierId) body.identifier_id = identifierId;
  const r = await apiRequest('POST', `/prompts/${promptId}/versions`, body);
  if (r.status !== 201 && r.status !== 200) throw new Error(`Version failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function getIdentifiers() {
  const r = await apiRequest('GET', '/identifiers?limit=200');
  return r.body;
}

async function ensureIdentifier(promptName, slug, name) {
  const r = await apiRequest('POST', '/invocations/execute', {
    prompt_name: promptName, input_vars: { stats: 'init', posts_sample: 'init', platform_breakdown: 'init', top_hashtags: 'init', top_negative_posts: 'init' },
    identifier: { external_id: slug, name, type: 'political_figure' },
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`Init failed: ${JSON.stringify(r.body)}`);
  return r.body.identifier_id;
}

function loadContexts() {
  const md = fs.readFileSync(path.join(__dirname, '../../extra_files/profile_contexts.md'), 'utf8');
  const sections = md.split(/\n## /);
  const globalCtx = sections[0].trim();
  const profileCtx = {};
  for (const s of sections.slice(1)) {
    const m = s.split('\n')[0].trim().match(/\.\s+([\u0600-\u06FF\s\u200C\u200D\u200c]+?)\s*\(/);
    if (m) profileCtx[m[1].trim()] = s.slice(0, 1800).trim();
  }
  return { globalCtx, profileCtx };
}

// ── Extract key profile facts from context block ──────────────────────────────
// Pulls: name, role/identity line, political position, sensitive topics
function extractProfileFacts(profileName, ctxBlock) {
  const lines = ctxBlock.split('\n');
  const identity = lines.find(l => l.includes('هویت و نقش')) || '';
  const identityText = identity.replace(/\*\*/g, '').replace('هویت و نقش:', '').trim();

  // Extract political position from the dual-lens section
  const posLine = lines.find(l => l.includes('اصولگرا') || l.includes('اصلاح‌طلب') || l.includes('تکنوکرات') || l.includes('نظامی') || l.includes('روحانی')) || '';

  // Extract sensitive topics (دایره موضوعی)
  const topicsLine = lines.find(l => l.includes('دایره موضوعی') || l.includes('Semantic Core')) || '';
  const topics = topicsLine.replace(/\*\*/g, '').replace(/دایره موضوعی.*?:/, '').trim();

  return { identityText, topics, posLine };
}

// ── PROMPT DEFINITIONS ────────────────────────────────────────────────────────

const PROMPTS = {

  dashboard_ai_summary: {
    description: 'خلاصه تحلیلی داشبورد — وضعیت کلی احساسات و رویدادهای غالب',
    temp: 0.5, tokens: 400,
    baseSystem: `تو یک تحلیلگر ارشد رصد رسانه‌ای هستی.

بر اساس داده‌های ارائه‌شده، یک خلاصه تحلیلی ۳-۴ جمله‌ای به فارسی بنویس که شامل:
- توزیع احساسات (مثبت/منفی/خنثی) با درصد دقیق
- موضوع یا رویداد غالب در بحث‌ها
- پرترافیک‌ترین پلتفرم و حجم بازدید
- مهم‌ترین هشدار یا فرصت

قوانین:
- فقط JSON برگردان: {"summary": "متن فارسی"}
- از اعداد واقعی از داده‌ها استفاده کن
- لحن تحلیلی و حرفه‌ای داشته باش`,
    userPrompt: `آمار: {{stats}}\nپلتفرم‌ها: {{platform_breakdown}}\nهشتگ‌ها: {{top_hashtags}}\nپست‌ها: {{posts_sample}}`,
    customSystem: (name, ctx) => {
      const { identityText, topics } = extractProfileFacts(name, ctx);
      return `تو یک تحلیلگر ارشد رصد رسانه‌ای هستی. موکل تو ${name} است.
${identityText ? `\nهویت: ${identityText}` : ''}
${topics ? `\nموضوعات کلیدی: ${topics}` : ''}

بر اساس داده‌های ارائه‌شده، یک خلاصه تحلیلی ۳-۴ جمله‌ای به فارسی بنویس که شامل:
- توزیع احساسات (مثبت/منفی/خنثی) با درصد دقیق
- موضوع یا رویداد غالب در بحث‌ها
- پرترافیک‌ترین پلتفرم و حجم بازدید
- مهم‌ترین هشدار یا فرصت برای ${name}

قوانین:
- فقط JSON برگردان: {"summary": "متن فارسی"}
- از اعداد واقعی از داده‌ها استفاده کن
- لحن تحلیلی و حرفه‌ای داشته باش`;
    },
  },

  macro_context_analysis: {
    description: 'تحلیل زمینه کلان سیاسی-اجتماعی — نکات کلیدی از فضای رسانه‌ای',
    temp: 0.4, tokens: 600,
    baseSystem: `تو یک تحلیلگر سیاسی-اجتماعی هستی.

بر اساس پست‌ها، ۵-۶ نکته کلیدی درباره فضای سیاسی-اجتماعی استخراج کن.

قوانین:
- فقط JSON array برگردان: [{"text": "...", "severity": "high|medium|low"}, ...]
- severity: high=بحرانی، medium=قابل توجه، low=فرصت
- هر نکته باید مستقیماً از داده‌های واقعی استخراج شده باشد`,
    userPrompt: `آمار: {{stats}}\nهشتگ‌ها: {{top_hashtags}}\nپست‌های منفی برتر: {{top_negative_posts}}\nنمونه پست‌ها: {{posts_sample}}`,
    customSystem: (name, ctx) => {
      const { identityText, topics } = extractProfileFacts(name, ctx);
      // Extract the full context block for richer political background
      const contextSummary = ctx.slice(0, 800);
      return `تو یک تحلیلگر سیاسی-اجتماعی هستی. موکل تو ${name} است.

زمینه شناختی:
${contextSummary}

بر اساس پست‌ها، ۵-۶ نکته کلیدی درباره فضای سیاسی-اجتماعی پیرامون ${name} استخراج کن.

قوانین:
- فقط JSON array برگردان: [{"text": "...", "severity": "high|medium|low"}, ...]
- severity: high=بحرانی، medium=قابل توجه، low=فرصت
- هر نکته باید مستقیماً از داده‌های واقعی استخراج شده باشد
- از اعداد و نام‌های واقعی استفاده کن`;
    },
  },

  smart_recommendations: {
    description: 'پیشنهادات هوشمند ارتباطی — اقدامات عملیاتی برای مدیریت فضای رسانه‌ای',
    temp: 0.6, tokens: 1200,
    baseSystem: `تو یک مشاور ارشد ارتباطات سیاسی و مدیریت بحران رسانه‌ای هستی.

بر اساس داده‌های رسانه‌ای ارائه‌شده، ۴ پیشنهاد عملیاتی ارائه بده.

قوانین:
1. دقیقاً ۴ پیشنهاد: ۱ urgent، ۱ important، ۲ normal
2. از اعداد و درصدهای واقعی از داده‌ها استفاده کن
3. پیشنهادات باید مشخص و عملیاتی باشند
4. فقط JSON array خالص برگردان:
[{"title": "...", "description": "...", "type": "urgent|important|normal", "reason": "...", "platform": "...", "suggestedTime": "..."}]`,
    userPrompt: `آمار: {{stats}}\nپلتفرم‌ها: {{platform_breakdown}}\nهشتگ‌ها: {{top_hashtags}}\nپست‌های منفی برتر: {{top_negative_posts}}\nنمونه پست‌ها (۸۰ پست): {{posts_sample}}`,
    customSystem: (name, ctx) => {
      const { identityText, topics } = extractProfileFacts(name, ctx);
      const contextSummary = ctx.slice(0, 600);
      return `تو یک مشاور ارشد ارتباطات سیاسی و مدیریت بحران رسانه‌ای هستی. موکل تو ${name} است.

${identityText ? `هویت موکل: ${identityText}\n` : ''}
زمینه سیاسی:
${contextSummary}

بر اساس داده‌های رسانه‌ای ارائه‌شده، ۴ پیشنهاد عملیاتی مرتبط با ${name} ارائه بده.

قوانین:
1. دقیقاً ۴ پیشنهاد: ۱ urgent، ۱ important، ۲ normal
2. از اعداد و درصدهای واقعی از داده‌ها استفاده کن
3. پیشنهادات باید مشخص، عملیاتی و مرتبط با ${name} باشند
4. فقط JSON array خالص برگردان:
[{"title": "...", "description": "...", "type": "urgent|important|normal", "reason": "...", "platform": "...", "suggestedTime": "..."}]`;
    },
  },

  narrative_gap_analysis: {
    description: 'تحلیل شکاف روایی — فاصله بین پیام رسمی و بحث عمومی',
    temp: 0.4, tokens: 700,
    baseSystem: `تو یک تحلیلگر روایت رسانه‌ای هستی.

بر اساس پست‌ها، شکاف بین پیام رسمی و بحث عمومی را تحلیل کن.

قوانین:
- فقط JSON برگردان:
{
  "official": "موضوع اصلی پیام رسمی",
  "officialPercent": عدد,
  "gapLevel": "high|medium|low",
  "public": [{"topic": "موضوع بحث مردم", "percent": عدد, "sentiment": "positive|negative|neutral"}],
  "insight": "یک جمله فارسی خلاصه تحلیل"
}
- حداکثر ۳ موضوع در public
- درصدها باید جمعاً ۱۰۰ شوند`,
    userPrompt: `آمار: {{stats}}\nپست‌های منفی برتر: {{top_negative_posts}}\nنمونه پست‌ها: {{posts_sample}}`,
    customSystem: (name, ctx) => {
      // Extract official message and sensitive topics from context
      const officialMatch = ctx.match(/پیام رسمی[^:]*:(.*?)(?:\n|$)/);
      const official = officialMatch ? officialMatch[1].trim() : `مواضع رسمی ${name}`;
      const sensitiveMatch = ctx.match(/موضوعات حساس[^:]*:(.*?)(?:\n|$)/);
      const sensitive = sensitiveMatch ? sensitiveMatch[1].trim() : '';
      return `تو یک تحلیلگر روایت رسانه‌ای برای تیم ${name} هستی.

پیام رسمی ${name}: ${official}
${sensitive ? `موضوعات حساس: ${sensitive}` : ''}

بر اساس پست‌ها، شکاف بین پیام رسمی و بحث عمومی را تحلیل کن.

قوانین:
- فقط JSON برگردان:
{
  "official": "موضوع اصلی پیام رسمی",
  "officialPercent": عدد,
  "gapLevel": "high|medium|low",
  "public": [{"topic": "موضوع بحث مردم", "percent": عدد, "sentiment": "positive|negative|neutral"}],
  "insight": "یک جمله فارسی خلاصه تحلیل"
}
- حداکثر ۳ موضوع در public
- درصدها باید جمعاً ۱۰۰ شوند
- از اعداد واقعی استفاده کن`;
    },
  },

  political_spectrum: {
    description: 'تحلیل طیف سیاسی — توزیع احساسات در جریان‌های سیاسی',
    temp: 0.3, tokens: 400,
    baseSystem: `تو یک تحلیلگر سیاسی هستی. بر اساس پست‌های شبکه‌های اجتماعی، توزیع احساسات را در ۴ طیف سیاسی ایران تخمین بزن.

طیف‌ها (از چپ به راست):
1. برانداز سخت — مخالفان کامل نظام
2. برانداز نرم — منتقدان شدید اما غیرخشونت‌آمیز
3. اصلاح‌طلب — طرفداران اصلاحات درون‌سیستمی
4. اصولگرا — حامیان وضع موجود

قوانین:
- فقط JSON array برگردان (دقیقاً ۴ آیتم):
[{"label": "برانداز سخت", "positive": عدد, "negative": عدد}, ...]
- اعداد تخمینی تعداد پست هستند (نه درصد)`,
    userPrompt: `آمار: {{stats}}\nهشتگ‌ها: {{top_hashtags}}\nنمونه پست‌ها (۷۰ پست): {{posts_sample}}`,
    customSystem: (name, ctx) => {
      // Determine political position from context
      const isReformist = ctx.includes('اصلاح‌طلب') && !ctx.includes('اصولگرا');
      const isConservative = ctx.includes('اصولگرا') || ctx.includes('انقلابی') || ctx.includes('ارزشی');
      const isMilitary = ctx.includes('سپاه') || ctx.includes('ارتش') || ctx.includes('نظامی');
      const isTechnocrat = ctx.includes('تکنوکرات') || ctx.includes('دانشگاه') || ctx.includes('اقتصاددان');

      let spectrumNote = '';
      if (isConservative && !isReformist) {
        spectrumNote = `نکته: ${name} اصولگرا است، پس اصولگرایان معتدل از او حمایت می‌کنند اما تندروها ممکن است منتقد باشند.`;
      } else if (isReformist) {
        spectrumNote = `نکته: ${name} اصلاح‌طلب است، پس اصلاح‌طلبان از او حمایت می‌کنند اما اصولگرایان و براندازان منتقد هستند.`;
      } else if (isMilitary) {
        spectrumNote = `نکته: ${name} چهره نظامی-امنیتی است، پس جریان انقلابی از او حمایت می‌کند اما اپوزیسیون به شدت منتقد است.`;
      } else if (isTechnocrat) {
        spectrumNote = `نکته: ${name} تکنوکرات است، پس بدنه میانه‌رو از او حمایت می‌کند اما هر دو طیف تندرو منتقد هستند.`;
      }

      return `تو یک تحلیلگر سیاسی هستی. بر اساس پست‌های شبکه‌های اجتماعی درباره ${name}، توزیع احساسات را در ۴ طیف سیاسی ایران تخمین بزن.

طیف‌ها (از چپ به راست):
1. برانداز سخت — مخالفان کامل نظام (معمولاً خارج از کشور یا ناشناس)
2. برانداز نرم — منتقدان شدید اما غیرخشونت‌آمیز
3. اصلاح‌طلب — طرفداران اصلاحات درون‌سیستمی
4. اصولگرا — حامیان وضع موجود

${spectrumNote}

قوانین:
- فقط JSON array برگردان (دقیقاً ۴ آیتم):
[{"label": "برانداز سخت", "positive": عدد, "negative": عدد}, ...]
- اعداد تخمینی تعداد پست هستند (نه درصد)
- مجموع positive+negative هر طیف باید با حجم تخمینی آن طیف متناسب باشد`;
    },
  },

}; // end PROMPTS

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { globalCtx, profileCtx } = loadContexts();
  console.log(`Loaded ${Object.keys(profileCtx).length} profile contexts.\n`);

  const db = new Client({ host: process.env.DB_HOST, port: +process.env.DB_PORT || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD });
  await db.connect();
  const { rows: profiles } = await db.query('SELECT name, promtic_identifier FROM profiles WHERE is_active=true ORDER BY name');
  await db.end();
  console.log(`Loaded ${profiles.length} profiles.\n`);

  // Get all identifiers once
  let identifiers = await getIdentifiers();
  const bySlug = new Map(identifiers.map(i => [i.external_id, i]));

  let totalCreated = 0, totalSkipped = 0, totalErrors = 0;

  for (const [promptName, def] of Object.entries(PROMPTS)) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`PROMPT: ${promptName}`);
    console.log('='.repeat(60));

    // Get or create the prompt
    const prompt = await getOrCreatePrompt(promptName, def.description);
    const promptId = prompt.id;

    // Get current versions
    const detail = await apiRequest('GET', `/prompts/${promptName}`);
    const versions = detail.body.versions || [];
    const hasBase = versions.some(v => !v.identifier_id && v.version === 'v1.0');
    const doneIds = new Set(versions.filter(v => v.identifier_id).map(v => v.identifier_id));
    console.log(`  Existing: ${versions.length} versions (base:${hasBase}, custom:${doneIds.size})`);

    // Create base version
    if (!hasBase) {
      process.stdout.write('  Creating base v1.0 ... ');
      await createVersion(promptId, 'v1.0', def.baseSystem, def.userPrompt, null);
      console.log('✓');
      await sleep(500);
    } else {
      console.log('  Base v1.0 already exists.');
    }

    // Create per-profile customized versions
    let created = 0, skipped = 0, errors = 0;
    for (const profile of profiles) {
      const slug = profile.promtic_identifier?.external_id;
      if (!slug) { skipped++; continue; }

      // Find context
      let ctx = profileCtx[profile.name];
      if (!ctx) {
        const key = Object.keys(profileCtx).find(k => k.includes(profile.name.split(' ')[0]) || profile.name.includes(k.split(' ')[0]));
        ctx = key ? profileCtx[key] : `${profile.name}: چهره سیاسی ایران.`;
      }

      // Ensure identifier exists
      if (!bySlug.has(slug)) {
        process.stdout.write(`  INIT ${slug} ... `);
        await ensureIdentifier(promptName, slug, profile.name);
        await sleep(800);
        identifiers = await getIdentifiers();
        identifiers.forEach(i => bySlug.set(i.external_id, i));
        console.log(`id=${bySlug.get(slug)?.id}`);
      }

      const identifier = bySlug.get(slug);
      if (!identifier) { console.log(`  ERR ${slug} — no identifier`); errors++; continue; }
      if (doneIds.has(identifier.id)) { skipped++; continue; }

      process.stdout.write(`  ${profile.name} (${slug}) ... `);
      try {
        const sys = def.customSystem(profile.name, ctx);
        await createVersion(promptId, `v1.0-${slug}`, sys, def.userPrompt, identifier.id);
        console.log('✓');
        created++;
        doneIds.add(identifier.id);
      } catch (e) {
        console.log(`ERR: ${e.message}`);
        errors++;
      }
      await sleep(500);
    }

    console.log(`  → Created: ${created} | Skipped: ${skipped} | Errors: ${errors}`);
    totalCreated += created; totalSkipped += skipped; totalErrors += errors;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TOTAL — Created: ${totalCreated} | Skipped: ${totalSkipped} | Errors: ${totalErrors}`);
  console.log('\nAll 6 prompts now have base + per-profile customized versions.');
  console.log('Promtic auto-routes to the right version based on identifier.external_id.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
