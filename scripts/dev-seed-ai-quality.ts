/**
 * dev-seed-ai-quality.ts — LOCAL demo data for the AI-quality widgets.
 * Makes NO LLM / provider calls.
 *
 *  - macro_context_snapshots: an «ok» briefing for today (from a canned v1.2
 *    reply run through the real parser) and for the 3 previous days (trend).
 *    With --stale, a newer «failed» attempt is added so the UI shows the
 *    stale hint.
 *  - ai_result_cache narrative_gap_analysis: computed by the real
 *    computeNarrativeGap over the profile's posts, keyword labels only.
 *
 *   npx ts-node -T scripts/dev-seed-ai-quality.ts [--stale] [--clean]
 */
import 'dotenv/config';
import { Client } from 'pg';

import { parseMacroReply, tehranDay } from '../src/modules/ingest/macro-events';
import { buildExcludeSet, computeNarrativeGap, mergeNarrativeGap } from '../src/modules/content/narrative-gap';

const DAY = 86400_000;

function cannedReply(now: Date, offsetDays: number) {
  const d = (back: number) => tehranDay(new Date(now.getTime() - (offsetDays + back) * DAY));
  const tag = offsetDays ? ` (${offsetDays} روز پیش)` : '';
  return JSON.stringify({
    sections: {
      cultural_social: [
        { title: `[نمایشی] آغاز ثبت‌نام آزمون سراسری${tag}`, summary: 'ثبت‌نام تا پایان هفته ادامه دارد.', date: d(0), actor: 'سازمان سنجش', severity: 'low' },
        { title: `[نمایشی] هشدار آلودگی هوای تهران${tag}`, summary: 'مدارس ابتدایی غیرحضوری شدند.', date: d(1), actor: 'ستاد اضطرار', severity: 'medium' },
      ],
      political_diplomatic: [
        { title: `[نمایشی] جلسه علنی مجلس درباره طرح ساماندهی مسکن${tag}`, summary: 'کلیات طرح تصویب شد.', date: d(0), actor: 'مجلس', severity: 'high' },
        { title: `[نمایشی] سفر وزیر خارجه به مسقط${tag}`, summary: 'رایزنی دربارهٔ تحولات منطقه.', date: d(1), actor: 'وزارت خارجه', severity: 'medium' },
        { title: `[نمایشی] نشست خبری سخنگوی دولت${tag}`, summary: 'تأکید بر بستهٔ معیشتی.', date: d(5), actor: 'دولت', severity: 'low' },
      ],
      security_military: [
        { title: `[نمایشی] رزمایش پدافند هوایی در جنوب کشور${tag}`, summary: 'رزمایش دو روزه آغاز شد.', date: d(0), actor: 'قرارگاه پدافند', severity: 'medium' },
      ],
      economic_livelihood: [
        { title: `[نمایشی] افزایش نرخ دلار در بازار آزاد${tag}`, summary: 'نرخ ارز به بالاترین سطح ماه رسید.', date: d(0), actor: 'بازار ارز', severity: 'high' },
        { title: `[نمایشی] بررسی لایحه بودجه در کمیسیون تلفیق${tag}`, summary: 'سقف درآمدهای نفتی بررسی شد.', date: d(1), actor: 'مجلس', severity: 'medium' },
        { title: 'بدون تاریخ', summary: 'باید حذف شود', severity: 'low' },
      ],
    },
  });
}

async function main() {
  const db = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
  });
  await db.connect();
  await db.query(`DELETE FROM macro_context_snapshots WHERE trigger = 'demo'`);
  if (process.argv.includes('--clean')) {
    await db.end();
    console.log('demo macro snapshots removed');
    return;
  }

  const now = new Date();
  for (const back of [3, 2, 1, 0]) {
    const at = new Date(now.getTime() - back * DAY - (back ? 0 : 2 * 3600_000));
    const { briefing, stats } = parseMacroReply(cannedReply(at, 0), at);
    await db.query(
      `INSERT INTO macro_context_snapshots (created_at, status, trigger, briefing, stats, model_name) VALUES ($1, 'ok', 'demo', $2, $3, 'demo-seed')`,
      [at, briefing, stats],
    );
    if (!back) console.log('today stats', stats);
  }
  if (process.argv.includes('--stale')) {
    await db.query(
      `INSERT INTO macro_context_snapshots (created_at, status, trigger, error, model_name) VALUES ($1, 'failed', 'demo', 'demo: provider timeout', 'demo-seed')`,
      [new Date(now.getTime() - 30 * 60_000)],
    );
  }

  const { rows: profiles } = await db.query(`SELECT id, name, keywords FROM profiles WHERE is_active = true`);
  for (const p of profiles) {
    const cols = `id, text, hashtags, ai_topics AS topics, sentiment, view_count AS "viewCount", published_at AS "publishedAt"`;
    const pub = `canonical_id IS NULL AND (relevance_score IS NULL OR relevance_score >= 3)
      AND (selection_reason IS NULL OR (selection_reason NOT LIKE 'official_page_%' AND selection_reason NOT LIKE 'display_%'))`;
    const to = now;
    const from = new Date(now.getTime() - 30 * DAY);
    const official = (await db.query(
      `SELECT ${cols} FROM selected_posts WHERE profile_id = $1 AND canonical_id IS NULL AND selection_reason LIKE 'official_page_%' AND published_at BETWEEN $2 AND $3`,
      [p.id, from, to],
    )).rows;
    const publicPosts = (await db.query(
      `SELECT ${cols} FROM selected_posts WHERE profile_id = $1 AND ${pub} AND published_at BETWEEN $2 AND $3`,
      [p.id, from, to],
    )).rows;
    const computed = computeNarrativeGap({ official, public: publicPosts, exclude: buildExcludeSet([p.name, ...(p.keywords || [])]) });
    const result = mergeNarrativeGap(computed, null, { from, to });
    await db.query(`DELETE FROM ai_result_cache WHERE profile_id = $1 AND prompt_name = 'narrative_gap_analysis'`, [p.id]);
    await db.query(
      `INSERT INTO ai_result_cache (profile_id, ingest_run_id, prompt_name, result, model_name) VALUES ($1, NULL, 'narrative_gap_analysis', $2, 'demo-seed')`,
      [p.id, JSON.stringify(result)],
    );
    console.log(`${p.name}: official=${official.length} public=${publicPosts.length} covered=${computed.totals.coveredPercent}%`,
      computed.narratives.map((n) => `${n.topic ?? n.terms.slice(0, 2).join('،')}:${n.publicPercent}%`).join(' | '));
  }
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
