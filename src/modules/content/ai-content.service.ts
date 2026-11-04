import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { Profile } from '../profile/profile.entity';
import { PromticService } from '../../libs/promtic';
import { GlobalContextService } from '../admin/global-context/global-context.service';
import { SelectedPost } from '../ingest/selected-post.entity';
import { IngestRun } from '../ingest/ingest-run.entity';
import { AiResultCache } from '../ingest/ai-result-cache.entity';
import {
  findUngroundedNumbers, normalizePersianDeep, normalizePersianText, parseLlmJson,
} from './persian-text';
import {
  AI_SUMMARY_OUTPUT_FORMAT, PERSIAN_WRITING_RULES, SOURCE_LABELS_FA, SummaryFactsInput, buildSummaryFacts,
} from './ai-prompt-inputs';
import {
  GapPost, NARRATIVE_GAP_OUTPUT_FORMAT, buildCoverageFacts, buildExcludeSet, buildLabellingInput,
  computeNarrativeGap, mergeNarrativeGap,
} from './narrative-gap';
import { PostFilter, hasPostFilter, postFilterSql } from './post-filter';
import { Bind, qbBinder, rawBinder } from './post-quality';

/** Public (non-official, non-display) posts that pass the relevance bar. */
const PUBLIC_POST_SQL = `canonical_id IS NULL
  AND (relevance_score IS NULL OR relevance_score >= 3)
  AND (selection_reason IS NULL OR (selection_reason NOT LIKE 'official_page_%' AND selection_reason NOT LIKE 'display_%'))`;

/** Narrative gap window: 7 days, widened to 30 when either side is too thin. */
const GAP_WINDOW_DAYS = [7, 30];
const GAP_MIN_PUBLIC = 30;
const GAP_MIN_OFFICIAL = 3;
const GAP_MAX_PUBLIC = 3000;

/**
 * LLM JSON output → the same JSON with every string run through the Persian
 * clean-up. Non-JSON replies are cleaned as plain text.
 */
export function cleanLlmOutput(raw: string): string {
  const parsed = parseLlmJson(raw);
  if (parsed && typeof parsed === 'object') return JSON.stringify(normalizePersianDeep(parsed));
  return normalizePersianText(raw);
}

/**
 * dashboard_ai_summary reply → {"summary": "..."} with clean Persian, the
 * paragraphs separated by a blank line. Accepts older reply shapes too.
 */
export function cleanSummaryOutput(raw: string): string {
  const parsed = parseLlmJson(raw);
  let text: string | null = null;
  if (typeof parsed === 'string') text = parsed;
  else if (parsed && typeof parsed === 'object') {
    for (const k of ['summary', 'analysis', 'text', 'result', 'content']) {
      if (typeof parsed[k] === 'string') { text = parsed[k]; break; }
      if (Array.isArray(parsed[k])) { text = parsed[k].filter((x: unknown) => typeof x === 'string').join('\n\n'); break; }
    }
  }
  if (text === null) text = parsed ? '' : raw;
  return JSON.stringify({ summary: normalizePersianText(text) });
}

// ── Sample customization options ────────────────────────────────────────────

export interface SampleOptions {
  /** Allowed source types. Empty/undefined = all sources */
  sources?: string[];
  /** Max posts to include. Defaults to the per-prompt limit */
  limit?: number;
  /** Sort order: 'engagement' (default) | 'recent' | 'negative_first' */
  sortBy?: 'engagement' | 'recent' | 'negative_first';
}

/**
 * Generates AI-powered dashboard content using Promtic.
 *
 * Data source: selected_posts (curated by the ingest worker) rather than
 * the raw content table. This ensures the LLM always receives a
 * representative, deduplicated, quality-filtered sample.
 *
 * Caching: results are stored in ai_result_cache keyed by
 * (profile_id, ingest_run_id, prompt_name). A cached result is served
 * until the next ingest run completes for that profile.
 */
@Injectable()
export class AiContentService {
  private readonly logger = new Logger(AiContentService.name);

  constructor(
    @InjectRepository(Profile)
    private readonly profileRepo: Repository<Profile>,
    @InjectRepository(SelectedPost)
    private readonly postRepo: Repository<SelectedPost>,
    @InjectRepository(IngestRun)
    private readonly runRepo: Repository<IngestRun>,
    @InjectRepository(AiResultCache)
    private readonly cacheRepo: Repository<AiResultCache>,
    private readonly promtic: PromticService,
    private readonly globalContext: GlobalContextService,
  ) {}

  // ── Cache helpers ───────────────────────────────────────────────────────────

  private async getLatestRun(profileId: string): Promise<IngestRun | null> {
    return this.runRepo.findOne({
      where: { profileId, status: 'completed' },
      order: { finishedAt: 'DESC' },
    });
  }

  private async getCached(
    profileId: string,
    runId: string | null,
    promptName: string,
    forceRefresh = false,
  ): Promise<AiResultCache | null> {
    if (forceRefresh) return null; // bypass cache entirely
    // Cache by profile + prompt only — not tied to a specific run.
    return this.cacheRepo.findOne({
      where: { profileId, promptName },
      order: { createdAt: 'DESC' },
    });
  }

  private async saveCache(
    profileId: string,
    runId: string | null,
    promptName: string,
    result: string,
    meta: any,
  ): Promise<void> {
    try {
      await this.replaceCache({
        profileId,
        ingestRunId: runId,
        promptName,
        result,
        tokenUsage: meta?.tokenUsage ?? null,
        modelName: meta?.modelName ?? null,
        latencyMs: meta?.latencyMs ?? null,
      });
    } catch (err) {
      // Cache write failure is non-fatal, but a silent failure means every
      // dashboard load re-invokes the LLM — so make it visible.
      this.logger.warn(`saveCache ${promptName} failed for ${profileId}: ${err?.message}`);
    }
  }

  /**
   * One cache row per (profile, prompt). The table's unique key is
   * (profile_id, ingest_run_id, prompt_name), so an ON CONFLICT on
   * (profile_id, prompt_name) is rejected by Postgres — replace instead.
   */
  private async replaceCache(values: Partial<AiResultCache>): Promise<void> {
    await this.cacheRepo.manager.transaction(async (m) => {
      await m.delete(AiResultCache, { profileId: values.profileId, promptName: values.promptName });
      await m.insert(AiResultCache, values);
    });
  }

  /**
   * LLM-written sections under a dashboard filter (platforms or a custom
   * range): never a new LLM call per filter. The unfiltered cached result is
   * served as is, flagged `unfiltered` so the UI can say it covers every
   * platform / the default period; without a cached result the section is empty.
   */
  private async unfilteredCachedResult(profileId: string, promptName: string, runId: string | null) {
    const cached = await this.getCached(profileId, runId, promptName);
    return cached
      ? { text: cached.result, meta: { cached: true, unfiltered: true, runId } }
      : { text: '', meta: { cached: false, unfiltered: true, empty: true, runId } };
  }

  // ── Data helpers (read from selected_posts) ─────────────────────────────────

  /**
   * `AND …` scope of the post set the AI sections read: the latest run by
   * default; under a dashboard filter its platforms, and — when it has a date
   * range — that period instead of the run (a period spans several runs).
   */
  private aiScopeSql(runId: string | null, filter: PostFilter | undefined, bind: Bind, alias?: string): string {
    const hasRange = !!(filter?.from || filter?.to);
    const runSql = runId && !hasRange ? ` AND ${alias ? `${alias}.` : ''}ingest_run_id = ${bind(runId)}` : '';
    return runSql + postFilterSql(filter, bind, alias);
  }

  /** aiScopeSql for a query builder aliased `p`. */
  private applyAiScope(qb: SelectQueryBuilder<SelectedPost>, runId: string | null, filter?: PostFilter): void {
    if (runId && !(filter?.from || filter?.to)) qb.andWhere('p.ingest_run_id = :runId', { runId });
    if (hasPostFilter(filter)) qb.andWhere(postFilterSql(filter, qbBinder(qb, 'ai'), 'p').replace(/^ AND /, ''));
  }

  /**
   * Selects the ordered set of sample posts for AI analysis.
   *
   * This is the SINGLE SOURCE OF TRUTH for which posts get sent to the prompts.
   * Both getPostsSample() (formatting for the LLM) and the CSV export
   * (via the persisted snapshot) derive from this exact selection so they can
   * never drift apart.
   */
  private async selectSamplePosts(
    profileId: string,
    runId: string | null,
    limit: number,
    opts?: SampleOptions,
    filter?: PostFilter,
  ): Promise<SelectedPost[]> {
    const effectiveLimit = opts?.limit ?? limit;
    const sortBy = opts?.sortBy ?? 'engagement';

    const qb = this.postRepo
      .createQueryBuilder('p')
      .select(['p.id', 'p.text', 'p.sentiment', 'p.sourceType', 'p.viewCount', 'p.screenName', 'p.politicalSpectrum', 'p.publishedAt'])
      .where('p.profile_id = :profileId', { profileId })
      .andWhere('p.canonical_id IS NULL')
      .andWhere('(p.relevance_score IS NULL OR p.relevance_score >= 3)')
      // Exclude official page posts — they are the profile's own voice, not public discourse
      .andWhere("(p.selection_reason IS NULL OR p.selection_reason NOT LIKE 'official_page_%')")
      // Exclude display feed posts — they are fetched for UI display, not AI analysis
      .andWhere("(p.selection_reason IS NULL OR p.selection_reason NOT LIKE 'display_%')")
      .take(effectiveLimit);

    // Source filter — honours manual source selection from the regenerate dialog
    if (opts?.sources && opts.sources.length > 0) {
      qb.andWhere('p.source_type IN (:...sources)', { sources: opts.sources });
    }

    // Sort order
    if (sortBy === 'recent') {
      qb.orderBy('p.published_at', 'DESC');
    } else if (sortBy === 'negative_first') {
      qb.orderBy("CASE WHEN LOWER(p.sentiment) = 'negative' THEN 0 ELSE 1 END", 'ASC')
        .addOrderBy('p.view_count + p.like_count * 2 + p.reply_count * 3', 'DESC');
    } else {
      // Default: engagement
      qb.orderBy('p.view_count + p.like_count * 2 + p.reply_count * 3', 'DESC');
    }

    // Scope to current run when available — this enforces the weight-change cutoff:
    // only posts (re)fetched into the latest run are eligible. A dashboard
    // filter with a date range replaces the run scope with that period.
    this.applyAiScope(qb, runId, filter);

    return qb.getMany();
  }

  private async getPostsSample(profileId: string, runId: string | null, limit: number, opts?: SampleOptions, filter?: PostFilter): Promise<string> {
    const posts = await this.selectSamplePosts(profileId, runId, limit, opts, filter);
    return posts
      .map((p, i) =>
        `[${i + 1}] (${p.publishedAt ? new Date(p.publishedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' }) : '?'}|${SOURCE_LABELS_FA[p.sourceType] || p.sourceType}|${p.sentiment || 'neutral'}|${p.politicalSpectrum || '?'}|views:${p.viewCount}) @${p.screenName || '?'}: ${p.text?.replace(/\s+/g, ' ').slice(0, 280)}`,
      )
      .join('\n');
  }

  /**
   * Records the EXACT posts (and the options used) that were sent to the
   * general AI prompts for this profile, into a reserved cache row.
   *
   * The CSV export reads this snapshot verbatim, so the downloaded file always
   * equals what was actually sent to the LLMs — regardless of any later ingest.
   *
   * Uses a cap equal to the largest per-prompt limit (80) when no explicit
   * limit is given, so the snapshot is a superset of every prompt's sample.
   */
  async recordSamplePostSnapshot(profileId: string | null, opts?: SampleOptions): Promise<number> {
    if (!profileId) return 0;
    try {
      const run = await this.getLatestRun(profileId);
      const runId = run?.id ?? null;
      const cap = opts?.limit ?? 80;
      const posts = await this.selectSamplePosts(profileId, runId, cap, opts);

      const snapshot = {
        runId,
        generatedAt: new Date().toISOString(),
        options: {
          sources: opts?.sources?.length ? opts.sources : null,
          limit: opts?.limit ?? null,
          sortBy: opts?.sortBy ?? 'engagement',
        },
        postIds: posts.map((p) => p.id),
      };

      await this.replaceCache({
        profileId: profileId!,
        ingestRunId: runId,
        promptName: '__sample_snapshot',
        result: JSON.stringify(snapshot),
      });

      return posts.length;
    } catch (err) {
      this.logger.warn(`recordSamplePostSnapshot failed for ${profileId}: ${err?.message}`);
      return 0;
    }
  }

  private async getStatsContext(profileId: string, runId: string | null, filter?: PostFilter): Promise<string> {
    const params: unknown[] = [profileId];
    const runFilter = this.aiScopeSql(runId, filter, rawBinder(params));
    const rows = await this.postRepo.query(
      `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE LOWER(sentiment) = 'positive') AS positive,
        COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS negative,
        COUNT(*) FILTER (WHERE LOWER(sentiment) = 'neutral' OR sentiment IS NULL) AS neutral_count
       FROM selected_posts
       WHERE profile_id = $1 AND canonical_id IS NULL
         AND (relevance_score IS NULL OR relevance_score >= 3)
         AND (selection_reason IS NULL OR (selection_reason NOT LIKE 'official_page_%' AND selection_reason NOT LIKE 'display_%'))
         ${runFilter}`,
      params,
    );
    const r = rows[0];
    const total = Number(r.total);
    const pos = Number(r.positive);
    const neg = Number(r.negative);
    const neu = Number(r.neutral_count);
    const pct = (n: number) => total > 0 ? `${Math.round(n / total * 100)}%` : '0%';
    return `Total posts: ${total}, Positive: ${pos} (${pct(pos)}), Negative: ${neg} (${pct(neg)}), Neutral: ${neu} (${pct(neu)})`;
  }

  private async getPlatformBreakdown(profileId: string, runId: string | null, filter?: PostFilter): Promise<string> {
    const params: unknown[] = [profileId];
    const runFilter = this.aiScopeSql(runId, filter, rawBinder(params));
    const rows = await this.postRepo.query(
      `SELECT source_type,
        COUNT(*) AS cnt,
        COUNT(*) FILTER (WHERE LOWER(sentiment) = 'positive') AS pos,
        COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS neg,
        SUM(view_count) AS views
       FROM selected_posts
       WHERE profile_id = $1 AND canonical_id IS NULL
         AND (relevance_score IS NULL OR relevance_score >= 3)
         AND (selection_reason IS NULL OR (selection_reason NOT LIKE 'official_page_%' AND selection_reason NOT LIKE 'display_%'))
         ${runFilter}
       GROUP BY source_type ORDER BY cnt DESC`,
      params,
    );
    return rows
      .map((r: any) =>
        `${r.source_type}: ${r.cnt} پست (${r.pos} مثبت / ${r.neg} منفی / ${Number(r.views || 0).toLocaleString()} بازدید)`,
      )
      .join('\n');
  }

  private async getTopHashtags(profileId: string, runId: string | null, limit = 15, filter?: PostFilter): Promise<string> {
    const params: unknown[] = [limit, profileId];
    const runFilter = this.aiScopeSql(runId, filter, rawBinder(params));
    const rows = await this.postRepo.query(
      `SELECT tag, COUNT(*) AS cnt
       FROM selected_posts, unnest(hashtags) AS tag
       WHERE hashtags IS NOT NULL AND profile_id = $2 AND canonical_id IS NULL
         AND (selection_reason IS NULL OR (selection_reason NOT LIKE 'official_page_%' AND selection_reason NOT LIKE 'display_%'))
         ${runFilter}
       GROUP BY tag ORDER BY cnt DESC LIMIT $1`,
      params,
    );
    return rows.map((r: any) => `#${r.tag} (${r.cnt})`).join('  ');
  }

  private async getTopNegativePosts(profileId: string, runId: string | null, limit = 10, filter?: PostFilter): Promise<string> {
    const qb = this.postRepo
      .createQueryBuilder('p')
      .select(['p.text', 'p.screenName', 'p.sourceType', 'p.viewCount', 'p.replyCount'])
      .where('p.profile_id = :profileId', { profileId })
      .andWhere("p.sentiment = 'Negative'")
      .andWhere('p.canonical_id IS NULL')
      .andWhere('(p.relevance_score IS NULL OR p.relevance_score >= 3)')
      .andWhere("(p.selection_reason IS NULL OR p.selection_reason NOT LIKE 'official_page_%')")
      .andWhere("(p.selection_reason IS NULL OR p.selection_reason NOT LIKE 'display_%')")
      .orderBy('p.view_count + p.reply_count * 5', 'DESC')
      .take(limit);
    this.applyAiScope(qb, runId, filter);
    const posts = await qb.getMany();
    return posts
      .map((p, i) =>
        `[${i + 1}] @${p.screenName || '?'} (${p.sourceType}|${p.viewCount} بازدید|${p.replyCount} کامنت): ${p.text?.slice(0, 150)}`,
      )
      .join('\n');
  }

  // ── Identifier resolution ───────────────────────────────────────────────────

  private async resolveIdentifier(
    orgId: string,
    profileId: string | null,
  ): Promise<{ external_id: string; name?: string; type?: string }> {
    if (profileId) {
      const profile = await this.profileRepo.findOne({ where: { id: profileId } });
      if (profile?.promticIdentifier?.external_id) return profile.promticIdentifier;
    }
    return { external_id: orgId };
  }

  private async invokePrompt(args: {
    promptName: string;
    inputVars: Record<string, any>;
    identifier: any;
    params: any;
    profileId?: string | null;
  }) {
    const globals = await this.globalContext.asInputVars();

    // Resolve profile_context: per-prompt override > default > empty
    let profileContext = '';
    if (args.profileId) {
      const profile = await this.profileRepo.findOne({ where: { id: args.profileId }, select: ['id', 'profileContexts'] });
      const contexts = profile?.profileContexts || {};
      profileContext = contexts[args.promptName] || contexts['default'] || '';
    }

    return this.promtic.invokeWithMeta({
      promptName: args.promptName,
      inputVars: { ...globals, profile_context: profileContext, ...args.inputVars },
      identifier: args.identifier,
      params: args.params,
    });
  }

  // ── Public generate methods ─────────────────────────────────────────────────

  /**
   * Every number the summary may quote, computed from the same post set the
   * sample is drawn from (latest run, public posts only).
   */
  private async getSummaryFactsInput(profileId: string, runId: string | null, filter?: PostFilter): Promise<SummaryFactsInput> {
    const params: unknown[] = [profileId];
    const runFilter = this.aiScopeSql(runId, filter, rawBinder(params));
    const where = `profile_id = $1 AND ${PUBLIC_POST_SQL} ${runFilter}`;
    const [totals, platforms, hashtags, topics] = await Promise.all([
      this.postRepo.query(
        `SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE LOWER(sentiment) = 'positive') AS positive,
           COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS negative,
           MIN(published_at) AS period_from, MAX(published_at) AS period_to
         FROM selected_posts WHERE ${where}`,
        params,
      ),
      this.postRepo.query(
        `SELECT LOWER(source_type) AS source_type, COUNT(*) AS cnt,
           COUNT(*) FILTER (WHERE LOWER(sentiment) = 'positive') AS pos,
           COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS neg,
           COALESCE(SUM(view_count), 0) AS views
         FROM selected_posts WHERE ${where}
         GROUP BY LOWER(source_type) ORDER BY cnt DESC`,
        params,
      ),
      this.postRepo.query(
        `SELECT tag, COUNT(*) AS cnt FROM selected_posts, unnest(hashtags) AS tag
         WHERE ${where} GROUP BY tag ORDER BY cnt DESC LIMIT 10`,
        params,
      ),
      this.postRepo.query(
        `SELECT topic, COUNT(*) AS cnt, COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS neg
         FROM selected_posts, unnest(ai_topics) AS topic
         WHERE ${where} GROUP BY topic ORDER BY cnt DESC LIMIT 8`,
        params,
      ),
    ]);
    const t = totals?.[0] || {};
    const total = Number(t.total) || 0;
    const positive = Number(t.positive) || 0;
    const negative = Number(t.negative) || 0;
    return {
      periodFrom: t.period_from ? new Date(t.period_from) : null,
      periodTo: t.period_to ? new Date(t.period_to) : null,
      total,
      positive,
      negative,
      neutral: Math.max(0, total - positive - negative),
      platforms: (platforms || []).filter((r: any) => r?.source_type).map((r: any) => ({
        source: r.source_type, count: Number(r.cnt) || 0, positive: Number(r.pos) || 0,
        negative: Number(r.neg) || 0, views: Number(r.views) || 0,
      })),
      hashtags: (hashtags || []).filter((r: any) => r?.tag).map((r: any) => ({ tag: r.tag, count: Number(r.cnt) || 0 })),
      topics: (topics || []).filter((r: any) => r?.topic).map((r: any) => ({
        topic: r.topic, count: Number(r.cnt) || 0, negative: Number(r.neg) || 0,
      })),
    };
  }

  /**
   * «خلاصه هوش مصنوعی». The model gets a computed facts block, the writing
   * rules and the output contract as input variables; its reply is cleaned
   * (Persian letters, spacing, half-spaces, markdown) before caching.
   * Output schema is unchanged: {"summary": "..."} — paragraphs split by \n\n.
   */
  async generateAiSummary(orgId: string, profileId: string | null = null, forceRefresh = false, sampleOpts?: SampleOptions, filter?: PostFilter): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cacheName = 'dashboard_ai_summary';
    if (hasPostFilter(filter)) return this.unfilteredCachedResult(profileId!, cacheName, runId);
    const cached = await this.getCached(profileId!, runId, cacheName, forceRefresh);
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const [stats, posts, platformBreakdown, topHashtags, topNegative, factsInput, profileName] = await Promise.all([
      this.getStatsContext(profileId!, runId, filter),
      this.getPostsSample(profileId!, runId, 60, sampleOpts, filter),
      this.getPlatformBreakdown(profileId!, runId, filter),
      this.getTopHashtags(profileId!, runId, 15, filter),
      this.getTopNegativePosts(profileId!, runId, 6, filter),
      this.getSummaryFactsInput(profileId!, runId, filter),
      this.getProfileName(profileId),
    ]);
    const facts = buildSummaryFacts(factsInput);
    const result = await this.invokePrompt({
      promptName: 'dashboard_ai_summary',
      inputVars: {
        // v1.2 variables
        facts: facts.text,
        writing_rules: PERSIAN_WRITING_RULES,
        output_format: AI_SUMMARY_OUTPUT_FORMAT,
        profile_name: profileName,
        top_negative_posts: topNegative,
        // shared with v1.1
        stats, posts_sample: posts, platform_breakdown: platformBreakdown, top_hashtags: topHashtags,
      },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.3, max_tokens: 700 },
      profileId,
    });
    const text = cleanSummaryOutput(result.result);
    const ungrounded = findUngroundedNumbers(JSON.parse(text).summary, facts.numbers);
    if (ungrounded.length) {
      this.logger.warn(`ai_summary for ${profileId}: numbers not in the facts block: ${ungrounded.join(', ')}`);
    }
    await this.saveCache(profileId!, runId, cacheName, text, result);
    return { text, meta: { ...result, ungroundedNumbers: ungrounded } };
  }

  private async getProfileName(profileId: string | null): Promise<string> {
    if (!profileId) return '';
    try {
      const p = await this.profileRepo.findOne({ where: { id: profileId }, select: ['id', 'name'] });
      return p?.name || '';
    } catch {
      return '';
    }
  }

  async generateMacroContext(orgId: string, profileId: string | null = null, forceRefresh = false, sampleOpts?: SampleOptions, filter?: PostFilter): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cacheName = 'macro_context_analysis';
    if (hasPostFilter(filter)) return this.unfilteredCachedResult(profileId!, cacheName, runId);
    const cached = await this.getCached(profileId!, runId, cacheName, forceRefresh);
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const [stats, posts, topHashtags, topNegative] = await Promise.all([
      this.getStatsContext(profileId!, runId, filter),
      this.getPostsSample(profileId!, runId, 60, sampleOpts, filter),
      this.getTopHashtags(profileId!, runId, 15, filter),
      this.getTopNegativePosts(profileId!, runId, 8, filter),
    ]);
    const result = await this.invokePrompt({
      promptName: 'macro_context_analysis',
      inputVars: { stats, posts_sample: posts, top_hashtags: topHashtags, top_negative_posts: topNegative },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.4, max_tokens: 600 },
      profileId,
    });
    const text = cleanLlmOutput(result.result);
    await this.saveCache(profileId!, runId, cacheName, text, result);
    return { text, meta: result };
  }

  async generateRecommendations(orgId: string, profileId: string | null = null, forceRefresh = false, sampleOpts?: SampleOptions, filter?: PostFilter): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cacheName = 'smart_recommendations';
    if (hasPostFilter(filter)) return this.unfilteredCachedResult(profileId!, cacheName, runId);
    const cached = await this.getCached(profileId!, runId, cacheName, forceRefresh);
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const [stats, posts, platformCtx, hashtagCtx, negCtx] = await Promise.all([
      this.getStatsContext(profileId!, runId, filter),
      this.getPostsSample(profileId!, runId, 80, sampleOpts, filter),
      this.getPlatformBreakdown(profileId!, runId, filter),
      this.getTopHashtags(profileId!, runId, 15, filter),
      this.getTopNegativePosts(profileId!, runId, 10, filter),
    ]);
    const result = await this.invokePrompt({
      promptName: 'smart_recommendations',
      inputVars: { stats, posts_sample: posts, platform_breakdown: platformCtx, top_hashtags: hashtagCtx, top_negative_posts: negCtx },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.6, max_tokens: 1200 },
      profileId,
    });
    const text = cleanLlmOutput(result.result);
    await this.saveCache(profileId!, runId, cacheName, text, result);
    return { text, meta: result };
  }

  /**
   * Official and public posts for the narrative gap, over the same window.
   * The window ends at the newest public post (≈ now in production) and spans
   * 7 days, widened to 30 when either side has too few posts. Under a
   * dashboard filter both sides are limited to its platforms, and a custom
   * range is used as the window as is (no widening).
   */
  private async getNarrativeGapPosts(profileId: string, sampleOpts?: SampleOptions, filter?: PostFilter) {
    const platforms = filter?.platforms?.length ? filter.platforms : null;
    const manual = sampleOpts?.sources?.length ? sampleOpts.sources : null;
    // Both the regenerate dialog's sources and the dashboard filter apply
    const sources = platforms && manual ? manual.filter((s) => platforms.includes(s)) : (platforms ?? manual);
    const officialPlatformSql = platforms ? 'AND LOWER(source_type) = ANY($4::text[])' : '';
    const rows = await this.postRepo.query(
      `SELECT MAX(published_at) AS newest FROM selected_posts
       WHERE profile_id = $1 AND ${PUBLIC_POST_SQL} AND ($2::text[] IS NULL OR source_type = ANY($2::text[]))`,
      [profileId, sources],
    );
    const newest = rows?.[0]?.newest;
    const to = filter?.to
      ? new Date(Math.min(filter.to.getTime(), Date.now()))
      : newest ? new Date(Math.min(new Date(newest).getTime(), Date.now())) : new Date();
    const windows = filter?.from ? [(to.getTime() - filter.from.getTime()) / 86400_000] : GAP_WINDOW_DAYS;
    const cols = `id, text, hashtags, ai_topics AS topics, sentiment, view_count AS "viewCount", published_at AS "publishedAt"`;
    let official: GapPost[] = [];
    let pub: GapPost[] = [];
    let from = to;
    for (const days of windows) {
      from = new Date(to.getTime() - days * 86400_000);
      [official, pub] = await Promise.all([
        this.postRepo.query(
          `SELECT ${cols} FROM selected_posts
           WHERE profile_id = $1 AND canonical_id IS NULL AND selection_reason LIKE 'official_page_%'
             AND published_at >= $2 AND published_at <= $3 ${officialPlatformSql}
           ORDER BY view_count DESC LIMIT 300`,
          platforms ? [profileId, from, to, platforms] : [profileId, from, to],
        ),
        this.postRepo.query(
          `SELECT ${cols} FROM selected_posts
           WHERE profile_id = $1 AND ${PUBLIC_POST_SQL}
             AND published_at >= $2 AND published_at <= $3
             AND ($4::text[] IS NULL OR source_type = ANY($4::text[]))
           ORDER BY published_at DESC LIMIT ${GAP_MAX_PUBLIC}`,
          [profileId, from, to, sources],
        ),
      ]);
      official = Array.isArray(official) ? official : [];
      pub = Array.isArray(pub) ? pub : [];
      if (official.length >= GAP_MIN_OFFICIAL && pub.length >= GAP_MIN_PUBLIC) break;
    }
    return { official, pub, from, to };
  }

  /**
   * «تحلیل شکاف روایت». Coverage numbers are computed from ALL official and
   * public posts in the window (see narrative-gap.ts); the LLM only labels
   * the clusters and writes a short insight from the computed figures.
   */
  async generateNarrativeGap(orgId: string, profileId: string | null = null, forceRefresh = false, sampleOpts?: SampleOptions, filter?: PostFilter): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    // Under a dashboard filter the coverage numbers are computed for that
    // filter, but the clusters keep their keyword labels: no LLM call and
    // nothing cached (the computation is a plain database read).
    const cacheName = 'narrative_gap_analysis';
    const filtered = hasPostFilter(filter);
    const cached = filtered ? null : await this.getCached(profileId!, runId, cacheName, forceRefresh);
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const profile = profileId
      ? await this.profileRepo.findOne({ where: { id: profileId }, select: ['id', 'name', 'keywords'] })
      : null;
    const { official, pub, from, to } = await this.getNarrativeGapPosts(profileId!, sampleOpts, filter);
    const exclude = buildExcludeSet([profile?.name, ...(profile?.keywords || [])]);
    const computed = computeNarrativeGap({ official, public: pub, exclude });

    let llmRaw: string | null = null;
    let meta: any = { source: 'computed', runId };
    const hasClusters = computed.narratives.length > 0 || computed.uncovered.topics.length > 0;
    if (hasClusters && !filtered) {
      // Labelling is best-effort: on failure the widget falls back to keyword labels.
      try {
        const [stats, posts, topNegative] = await Promise.all([
          this.getStatsContext(profileId!, runId, filter),
          this.getPostsSample(profileId!, runId, 30, sampleOpts, filter),
          this.getTopNegativePosts(profileId!, runId, 5, filter),
        ]);
        const result = await this.invokePrompt({
          promptName: 'narrative_gap_analysis',
          inputVars: {
            // v1.2 variables
            narrative_clusters: buildLabellingInput(computed),
            coverage_facts: buildCoverageFacts(computed),
            writing_rules: PERSIAN_WRITING_RULES,
            output_format: NARRATIVE_GAP_OUTPUT_FORMAT,
            profile_name: profile?.name || '',
            // v1.1 variables (its numbers are ignored; only v1.2 labels are used)
            stats, posts_sample: posts, top_negative_posts: topNegative,
          },
          identifier: await this.resolveIdentifier(orgId, profileId),
          params: { temperature: 0.2, max_tokens: 900 },
          profileId,
        });
        llmRaw = result.result;
        meta = { ...result, source: 'computed+llm_labels' };
      } catch (err) {
        this.logger.warn(`narrative_gap labelling failed for ${profileId}: ${err?.message}`);
      }
    }

    const text = JSON.stringify(mergeNarrativeGap(computed, llmRaw, { from, to }));
    if (filtered) return { text, meta: { ...meta, source: 'computed', filtered: true } };
    await this.saveCache(profileId!, runId, cacheName, text, meta);
    return { text, meta };
  }

  async generatePoliticalSpectrum(orgId: string, profileId: string | null = null, forceRefresh = false, filter?: PostFilter): Promise<{ text: string; meta: any }> {
    // Political spectrum is derived directly from batch_sentiment classifications
    // stored on selected_posts — no LLM call needed. It's a cheap aggregate, so
    // it is computed fresh on every request instead of being served from cache
    // (a cached copy never got regenerated after new ingest runs).
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;

    // Latest run, or the dashboard filter's period / platforms (never cached)
    const params: unknown[] = [profileId];
    const runFilter = this.aiScopeSql(runId, filter, rawBinder(params));

    const rows: Array<{ spectrum: string; pos: string; neg: string; neu: string }> = await this.postRepo.query(
      `SELECT
         political_spectrum AS spectrum,
         COUNT(*) FILTER (WHERE LOWER(sentiment) = 'positive') AS pos,
         COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS neg,
         COUNT(*) FILTER (WHERE LOWER(sentiment) = 'neutral') AS neu
       FROM selected_posts
       WHERE profile_id = $1
         AND canonical_id IS NULL
         AND political_spectrum IS NOT NULL
         AND (relevance_score IS NULL OR relevance_score >= 3)
         AND (selection_reason IS NULL OR (selection_reason NOT LIKE 'official_page_%' AND selection_reason NOT LIKE 'display_%'))
         ${runFilter}
       GROUP BY political_spectrum
       ORDER BY (COUNT(*) FILTER (WHERE LOWER(sentiment) = 'positive') + COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative')) DESC`,
      params,
    );

    const LABEL_MAP: Record<string, string> = {
      Conservative: 'اصولگرا',
      Reformist: 'اصلاح‌طلب',
      Moderate: 'میانه‌رو',
      Opposition: 'اپوزیسیون',
      Independent: 'مستقل',
      Unknown: 'نامشخص',
    };

    const result = rows.map((r) => ({
      label: LABEL_MAP[r.spectrum] || r.spectrum,
      positive: parseInt(r.pos, 10) || 0,
      negative: parseInt(r.neg, 10) || 0,
      neutral: parseInt(r.neu, 10) || 0,
    }));

    const text = JSON.stringify(result);
    return { text, meta: { cached: false, source: 'db_aggregate', runId } };
  }

  async generateAll(orgId: string, profileId: string | null = null, forceRefresh = false, sampleOpts?: SampleOptions): Promise<Record<string, { text: string; meta: any }>> {
    const results: Record<string, { text: string; meta: any }> = {};
    // Record the exact posts being sent to the prompts so the CSV export is faithful.
    await this.recordSamplePostSnapshot(profileId, sampleOpts);
    const sections = [
      { key: 'ai_summary',        fn: () => this.generateAiSummary(orgId, profileId, forceRefresh, sampleOpts) },
      { key: 'macro_context',     fn: () => this.generateMacroContext(orgId, profileId, forceRefresh, sampleOpts) },
      { key: 'recommendations',   fn: () => this.generateRecommendations(orgId, profileId, forceRefresh, sampleOpts) },
      { key: 'narrative_gap',     fn: () => this.generateNarrativeGap(orgId, profileId, forceRefresh, sampleOpts) },
    ];
    for (const section of sections) {
      try {
        results[section.key] = await section.fn();
        this.logger.log(`Generated: ${section.key}`);
      } catch (err) {
        results[section.key] = { text: `[ERROR] ${err.message}`, meta: { error: err.message } };
        this.logger.error(`Failed: ${section.key} — ${err.message}`);
      }
    }
    return results;
  }

  /**
   * Scenario simulator: analyses a "what if" question in the context of the profile.
   * Returns structured JSON with risk level, sentiment shift, recommendations, etc.
   */
  async generateScenario(
    scenario: string,
    orgId: string,
    profileId: string | null = null,
  ): Promise<{ text: string; meta: any }> {
    const [stats, posts] = await Promise.all([
      this.getStatsContext(profileId!, null),
      this.getPostsSample(profileId!, null, 30),
    ]);

    const result = await this.invokePrompt({
      promptName: 'scenario_simulator',
      inputVars: {
        scenario,
        stats,
        posts_sample: posts,
      },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.5, max_tokens: 800 },
      profileId,
    });

    await this.saveCache(profileId!, null, `scenario_${scenario.slice(0, 40)}`, result.result, result);
    return { text: result.result, meta: result };
  }
}
