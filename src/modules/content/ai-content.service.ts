import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Profile } from '../profile/profile.entity';
import { PromticService } from '../../libs/promtic';
import { GlobalContextService } from '../admin/global-context/global-context.service';
import { SelectedPost } from '../ingest/selected-post.entity';
import { IngestRun } from '../ingest/ingest-run.entity';
import { AiResultCache } from '../ingest/ai-result-cache.entity';

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
      // Upsert: overwrite existing cache for this profile+prompt
      await this.cacheRepo
        .createQueryBuilder()
        .insert()
        .into(AiResultCache)
        .values({
          profileId,
          ingestRunId: runId,
          promptName,
          result,
          tokenUsage: meta?.tokenUsage ?? null,
          modelName: meta?.modelName ?? null,
          latencyMs: meta?.latencyMs ?? null,
        })
        .orUpdate(
          ['result', 'ingest_run_id', 'token_usage', 'model_name', 'latency_ms', 'created_at'],
          ['profile_id', 'prompt_name'],
        )
        .execute();
    } catch {
      // Cache write failure is non-fatal
    }
  }

  // ── Data helpers (read from selected_posts) ─────────────────────────────────

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
  ): Promise<SelectedPost[]> {
    const effectiveLimit = opts?.limit ?? limit;
    const sortBy = opts?.sortBy ?? 'engagement';

    const qb = this.postRepo
      .createQueryBuilder('p')
      .select(['p.id', 'p.text', 'p.sentiment', 'p.sourceType', 'p.viewCount', 'p.screenName', 'p.politicalSpectrum'])
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
    // only posts (re)fetched into the latest run are eligible.
    if (runId) qb.andWhere('p.ingest_run_id = :runId', { runId });

    return qb.getMany();
  }

  private async getPostsSample(profileId: string, runId: string | null, limit: number, opts?: SampleOptions): Promise<string> {
    const posts = await this.selectSamplePosts(profileId, runId, limit, opts);
    return posts
      .map((p, i) =>
        `[${i + 1}] (${p.sourceType}|${p.sentiment || 'neutral'}|${p.politicalSpectrum || '?'}|views:${p.viewCount}) @${p.screenName || '?'}: ${p.text?.slice(0, 200)}`,
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

      await this.cacheRepo
        .createQueryBuilder()
        .insert()
        .into(AiResultCache)
        .values({
          profileId,
          ingestRunId: runId,
          promptName: '__sample_snapshot',
          result: JSON.stringify(snapshot),
        })
        .orUpdate(['result', 'ingest_run_id', 'created_at'], ['profile_id', 'prompt_name'])
        .execute();

      return posts.length;
    } catch (err) {
      this.logger.warn(`recordSamplePostSnapshot failed for ${profileId}: ${err?.message}`);
      return 0;
    }
  }

  private async getStatsContext(profileId: string, runId: string | null): Promise<string> {
    const runFilter = runId ? 'AND ingest_run_id = $2' : '';
    const params = runId ? [profileId, runId] : [profileId];
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

  private async getPlatformBreakdown(profileId: string, runId: string | null): Promise<string> {
    const runFilter = runId ? 'AND ingest_run_id = $2' : '';
    const params = runId ? [profileId, runId] : [profileId];
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

  private async getTopHashtags(profileId: string, runId: string | null, limit = 15): Promise<string> {
    const runFilter = runId ? 'AND ingest_run_id = $3' : '';
    const params = runId ? [limit, profileId, runId] : [limit, profileId];
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

  private async getTopNegativePosts(profileId: string, runId: string | null, limit = 10): Promise<string> {
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
    if (runId) qb.andWhere('p.ingest_run_id = :runId', { runId });
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

  async generateAiSummary(orgId: string, profileId: string | null = null, forceRefresh = false, sampleOpts?: SampleOptions): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cached = await this.getCached(profileId!, runId, 'dashboard_ai_summary', forceRefresh);
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const [stats, posts, platformBreakdown, topHashtags] = await Promise.all([
      this.getStatsContext(profileId!, runId),
      this.getPostsSample(profileId!, runId, 60, sampleOpts),
      this.getPlatformBreakdown(profileId!, runId),
      this.getTopHashtags(profileId!, runId),
    ]);
    const result = await this.invokePrompt({
      promptName: 'dashboard_ai_summary',
      inputVars: { stats, posts_sample: posts, platform_breakdown: platformBreakdown, top_hashtags: topHashtags },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.5, max_tokens: 400 },
      profileId,
    });
    await this.saveCache(profileId!, runId, 'dashboard_ai_summary', result.result, result);
    return { text: result.result, meta: result };
  }

  async generateMacroContext(orgId: string, profileId: string | null = null, forceRefresh = false, sampleOpts?: SampleOptions): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cached = await this.getCached(profileId!, runId, 'macro_context_analysis', forceRefresh);
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const [stats, posts, topHashtags, topNegative] = await Promise.all([
      this.getStatsContext(profileId!, runId),
      this.getPostsSample(profileId!, runId, 60, sampleOpts),
      this.getTopHashtags(profileId!, runId),
      this.getTopNegativePosts(profileId!, runId, 8),
    ]);
    const result = await this.invokePrompt({
      promptName: 'macro_context_analysis',
      inputVars: { stats, posts_sample: posts, top_hashtags: topHashtags, top_negative_posts: topNegative },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.4, max_tokens: 600 },
      profileId,
    });
    await this.saveCache(profileId!, runId, 'macro_context_analysis', result.result, result);
    return { text: result.result, meta: result };
  }

  async generateRecommendations(orgId: string, profileId: string | null = null, forceRefresh = false, sampleOpts?: SampleOptions): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cached = await this.getCached(profileId!, runId, 'smart_recommendations', forceRefresh);
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const [stats, posts, platformCtx, hashtagCtx, negCtx] = await Promise.all([
      this.getStatsContext(profileId!, runId),
      this.getPostsSample(profileId!, runId, 80, sampleOpts),
      this.getPlatformBreakdown(profileId!, runId),
      this.getTopHashtags(profileId!, runId),
      this.getTopNegativePosts(profileId!, runId, 10),
    ]);
    const result = await this.invokePrompt({
      promptName: 'smart_recommendations',
      inputVars: { stats, posts_sample: posts, platform_breakdown: platformCtx, top_hashtags: hashtagCtx, top_negative_posts: negCtx },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.6, max_tokens: 1200 },
      profileId,
    });
    await this.saveCache(profileId!, runId, 'smart_recommendations', result.result, result);
    return { text: result.result, meta: result };
  }

  async generateNarrativeGap(orgId: string, profileId: string | null = null, forceRefresh = false, sampleOpts?: SampleOptions): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cached = await this.getCached(profileId!, runId, 'narrative_gap_analysis', forceRefresh);
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const [stats, posts, topNegative] = await Promise.all([
      this.getStatsContext(profileId!, runId),
      this.getPostsSample(profileId!, runId, 60, sampleOpts),
      this.getTopNegativePosts(profileId!, runId, 8),
    ]);
    const result = await this.invokePrompt({
      promptName: 'narrative_gap_analysis',
      inputVars: { stats, posts_sample: posts, top_negative_posts: topNegative },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.4, max_tokens: 700 },
      profileId,
    });
    await this.saveCache(profileId!, runId, 'narrative_gap_analysis', result.result, result);
    return { text: result.result, meta: result };
  }

  async generatePoliticalSpectrum(orgId: string, profileId: string | null = null, forceRefresh = false): Promise<{ text: string; meta: any }> {
    // Political spectrum is derived directly from batch_sentiment classifications
    // stored on selected_posts — no LLM call needed.
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cached = await this.getCached(profileId!, runId, 'political_spectrum', forceRefresh);
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const runFilter = runId ? 'AND ingest_run_id = $2' : '';
    const params = runId ? [profileId, runId] : [profileId];

    const rows: Array<{ spectrum: string; pos: string; neg: string }> = await this.postRepo.query(
      `SELECT
         political_spectrum AS spectrum,
         COUNT(*) FILTER (WHERE LOWER(sentiment) = 'positive') AS pos,
         COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS neg
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
    }));

    const text = JSON.stringify(result);
    await this.saveCache(profileId!, runId, 'political_spectrum', text, { source: 'db_aggregate' });
    return { text, meta: { cached: false, source: 'db_aggregate' } };
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
