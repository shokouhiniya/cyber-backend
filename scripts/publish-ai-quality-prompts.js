/**
 * publish-ai-quality-prompts.js
 *
 * Publishes the v1.2 versions of dashboard_ai_summary, narrative_gap_analysis
 * and macro_politics from scripts/prompts/ai-quality.v1.2.md to Promtic and
 * makes them current. Model and params are copied from each prompt's current
 * version, so this changes the text only.
 *
 *   node scripts/publish-ai-quality-prompts.js            # dry run: prints what would be sent
 *   node scripts/publish-ai-quality-prompts.js --publish  # really publishes
 *
 * Per-profile versions (identifier_id set, created by setup-all-prompts.js)
 * override the base version for that profile. With --publish this script also
 * publishes the same v1.2 text for every identifier that has its own version;
 * the per-profile context now reaches the prompt through {{profile_context}}.
 *
 * Rollback: PUT the previous version id as current_version_id (see README.md).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');

const PUBLISH = process.argv.includes('--publish');
const BASE = process.env.PROMTIC_ADMIN_BASE_URL || 'https://papi.cyber.pish.run';
const API_KEY = process.env.PROMTIC_API_KEY;
const VERSION = 'v1.2';
const NAMES = ['dashboard_ai_summary', 'narrative_gap_analysis', 'macro_politics'];

function loadPrompts() {
  const md = fs.readFileSync(path.join(__dirname, 'prompts/ai-quality.v1.2.md'), 'utf8').replace(/\r\n/g, '\n');
  const out = {};
  for (const name of NAMES) {
    const start = md.indexOf(`## ${name} — `);
    if (start < 0) throw new Error(`section for ${name} not found`);
    const next = md.indexOf('\n## ', start + 4);
    const block = md.slice(start, next < 0 ? undefined : next);
    const sys = block.split('### system\n')[1].split('\n### user\n')[0].trim();
    const user = block.split('### user\n')[1].trim();
    out[name] = { system: sys, user };
  }
  return out;
}

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${text.slice(0, 300)}`);
  return json?.data ?? json;
}

async function main() {
  const prompts = loadPrompts();
  if (!PUBLISH) {
    for (const [name, p] of Object.entries(prompts)) {
      const vars = [...new Set((p.system + p.user).match(/\{\{\w+\}\}/g))];
      console.log(`\n=== ${name} ${VERSION} — variables: ${vars.join(' ')}`);
      console.log(`--- system (${p.system.length} chars)\n${p.system.slice(0, 400)}…`);
      console.log(`--- user\n${p.user}`);
    }
    console.log('\nDry run. Re-run with --publish to send these versions to Promtic.');
    return;
  }
  if (!API_KEY) throw new Error('PROMTIC_API_KEY is not set');

  for (const [name, p] of Object.entries(prompts)) {
    const prompt = await api('GET', `/prompts/${name}`);
    const versions = prompt.versions || [];
    const current = versions.find((v) => v.id === prompt.current_version_id) || versions.find((v) => !v.identifier_id);
    const messages = [{ role: 'system', content: p.system }, { role: 'user', content: p.user }];
    const base = { version: VERSION, messages, model_name: current?.model_name, params: current?.params };

    const created = await api('POST', `/prompts/${prompt.id}/versions`, base);
    console.log(`${name}: base ${VERSION} = version ${created.id} (model ${base.model_name})`);
    await api('PUT', `/prompts/${prompt.id}`, {
      name: prompt.name, description: prompt.description, tags: prompt.tags, status: prompt.status,
      output_type: prompt.output_type, current_version_id: created.id,
    });

    const identifierIds = [...new Set(versions.filter((v) => v.identifier_id).map((v) => v.identifier_id))];
    for (const identifier_id of identifierIds) {
      const v = await api('POST', `/prompts/${prompt.id}/versions`, { ...base, identifier_id });
      console.log(`  identifier ${identifier_id}: version ${v.id}`);
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
