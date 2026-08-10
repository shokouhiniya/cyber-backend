/**
 * Quick test: batch_sentiment (Gemini) with 25 posts.
 */
const { Client } = require('pg');

const PROMTIC_BASE_URL = 'https://papi.cyber.pish.run';
const PROMTIC_API_KEY = 'pk_ef39b96c1e37d9fb3488680c84dba67d7a9f9f210af8f5d36971e8a60c5203cc';

async function callPromtic(body) {
  const res = await fetch(`${PROMTIC_BASE_URL}/invocations/execute`, {
    method: 'POST',
    headers: { 'x-api-key': PROMTIC_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  const data = json.data || json;
  if (data.status === 'completed') return data;
  if (data.status === 'error') throw new Error(data.error_message || JSON.stringify(data).slice(0, 300));
  const uid = data.uid;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const p = await (await fetch(`${PROMTIC_BASE_URL}/invocations/${uid}`, { headers: { 'x-api-key': PROMTIC_API_KEY } })).json();
    const d = p.data || p;
    if (d.status === 'completed') return d;
    if (d.status === 'error') throw new Error(d.error_message);
    process.stdout.write('.');
  }
  throw new Error('Timeout');
}

async function main() {
  const db = new Client({ host: 'localhost', port: 5432, database: 'cyber', user: 'postgres', password: 'B0b_Dylan' });
  await db.connect();
  const { rows: [profile] } = await db.query(`SELECT p.id, p.name, p.promtic_identifier, p.profile_contexts FROM profiles p JOIN selected_posts sp ON sp.profile_id = p.id AND sp.canonical_id IS NULL AND LENGTH(sp.text) > 20 GROUP BY p.id, p.name, p.promtic_identifier, p.profile_contexts ORDER BY COUNT(sp.id) DESC LIMIT 1`);
  const { rows: posts } = await db.query(`SELECT id, text FROM selected_posts WHERE profile_id = $1 AND canonical_id IS NULL AND LENGTH(text) > 20 AND (selection_reason IS NULL OR (selection_reason NOT LIKE 'official_page_%' AND selection_reason NOT LIKE 'display_%')) ORDER BY view_count DESC LIMIT 25`, [profile.id]);
  const { rows: ctxRows } = await db.query(`SELECT key, value FROM global_context WHERE key = 'macro_political_context'`);
  await db.end();

  const postsBatch = posts.map((p, i) => `[${i + 1}] ${p.text.replace(/\n+/g, ' ').slice(0, 500)}`).join('\n\n');

  for (const promptName of ['batch_sentiment', 'batch_sentiment_ds']) {
    console.log(`\n--- ${promptName} (25 posts) ---`);
    const t = Date.now();
    try {
      const result = await callPromtic({
        prompt_name: promptName,
        input_vars: {
          profile_context: profile.profile_contexts?.default || '',
          global_macro_political_context: ctxRows[0]?.value || '',
          global_macro_political_context_7d: '',
          posts_batch: postsBatch,
        },
        identifier: { external_id: profile.promtic_identifier?.external_id || profile.id, name: profile.name, type: 'political_figure' },
        params: { temperature: 0.2, max_tokens: 16384, ...(promptName.endsWith('_ds') ? { response_format: { type: 'json_object' } } : {}) },
      });
      console.log(`Model: ${result.model_name} | ${((Date.now()-t)/1000).toFixed(1)}s | tokens: ${result.token_usage?.prompt}+${result.token_usage?.completion}`);
      const clean = (result.result||'').replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
      const parsed = JSON.parse(clean);
      const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.results) ? parsed.results : []);
      const sentDist = {}, outlookDist = {};
      for (const item of items) { sentDist[item.sentiment]=(sentDist[item.sentiment]||0)+1; outlookDist[item.outlook]=(outlookDist[item.outlook]||0)+1; }
      console.log(`Coverage: ${items.length}/25 | Sentiment: ${JSON.stringify(sentDist)} | Outlook: ${JSON.stringify(outlookDist)}`);
    } catch(e) { console.log(`FAILED: ${e.message}`); }
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
