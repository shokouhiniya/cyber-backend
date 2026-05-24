import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Profile } from '../profile/profile.entity';
import { PromticService } from '../../libs/promtic';
import { GlobalContextService } from '../admin/global-context/global-context.service';
import { SelectedPost } from '../ingest/selected-post.entity';
import { IngestRun } from '../ingest/ingest-run.entity';
import { AiResultCache } from '../ingest/ai-result-cache.entity';

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
  ): Promise<AiResultCache | null> {
    // Cache by profile + prompt only — not tied to a specific run.
    // This ensures page visits always get cached results instantly.
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

  private async getPostsSample(profileId: string, runId: string | null, limit: number): Promise<string> {
    const qb = this.postRepo
      .createQueryBuilder('p')
      .select(['p.text', 'p.sentiment', 'p.sourceType', 'p.viewCount', 'p.screenName', 'p.politicalSpectrum'])
      .where('p.profile_id = :profileId', { profileId })
      .andWhere('p.canonical_id IS NULL')
      .andWhere('(p.relevance_score IS NULL OR p.relevance_score >= 3)')
      .orderBy('p.view_count + p.like_count * 2 + p.reply_count * 3', 'DESC')
      .take(limit);

    const posts = await qb.getMany();
    return posts
      .map((p, i) =>
        `[${i + 1}] (${p.sourceType}|${p.sentiment || 'neutral'}|${p.politicalSpectrum || '?'}|views:${p.viewCount}) @${p.screenName || '?'}: ${p.text?.slice(0, 200)}`,
      )
      .join('\n');
  }

  private async getStatsContext(profileId: string, runId: string | null): Promise<string> {
    const rows = await this.postRepo.query(
      `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE sentiment = 'Positive') AS positive,
        COUNT(*) FILTER (WHERE sentiment = 'Negative') AS negative,
        COUNT(*) FILTER (WHERE sentiment = 'Neutral' OR sentiment IS NULL) AS neutral_count
       FROM selected_posts
       WHERE profile_id = $1 AND canonical_id IS NULL
         AND (relevance_score IS NULL OR relevance_score >= 3)`,
      [profileId],
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
    const rows = await this.postRepo.query(
      `SELECT source_type,
        COUNT(*) AS cnt,
        COUNT(*) FILTER (WHERE sentiment = 'Positive') AS pos,
        COUNT(*) FILTER (WHERE sentiment = 'Negative') AS neg,
        SUM(view_count) AS views
       FROM selected_posts
       WHERE profile_id = $1 AND canonical_id IS NULL
         AND (relevance_score IS NULL OR relevance_score >= 3)
       GROUP BY source_type ORDER BY cnt DESC`,
      [profileId],
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
       WHERE hashtags IS NOT NULL AND profile_id = $2 AND canonical_id IS NULL ${runFilter}
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
  }) {
    const globals = await this.globalContext.asInputVars();
    return this.promtic.invokeWithMeta({
      promptName: args.promptName,
      inputVars: { ...globals, ...args.inputVars },
      identifier: args.identifier,
      params: args.params,
    });
  }

  // ── Public generate methods ─────────────────────────────────────────────────

  async generateAiSummary(orgId: string, profileId: string | null = null): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cached = await this.getCached(profileId!, runId, 'dashboard_ai_summary');
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const [stats, posts, platformBreakdown, topHashtags] = await Promise.all([
      this.getStatsContext(profileId!, runId),
      this.getPostsSample(profileId!, runId, 60),
      this.getPlatformBreakdown(profileId!, runId),
      this.getTopHashtags(profileId!, runId),
    ]);
    const result = await this.invokePrompt({
      promptName: 'dashboard_ai_summary',
      inputVars: { stats, posts_sample: posts, platform_breakdown: platformBreakdown, top_hashtags: topHashtags },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.5, max_tokens: 400 },
    });
    await this.saveCache(profileId!, runId, 'dashboard_ai_summary', result.result, result);
    return { text: result.result, meta: result };
  }

  async generateMacroContext(orgId: string, profileId: string | null = null): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cached = await this.getCached(profileId!, runId, 'macro_context_analysis');
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const [stats, posts, topHashtags, topNegative] = await Promise.all([
      this.getStatsContext(profileId!, runId),
      this.getPostsSample(profileId!, runId, 60),
      this.getTopHashtags(profileId!, runId),
      this.getTopNegativePosts(profileId!, runId, 8),
    ]);
    const result = await this.invokePrompt({
      promptName: 'macro_context_analysis',
      inputVars: { stats, posts_sample: posts, top_hashtags: topHashtags, top_negative_posts: topNegative },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.4, max_tokens: 600 },
    });
    await this.saveCache(profileId!, runId, 'macro_context_analysis', result.result, result);
    return { text: result.result, meta: result };
  }

  async generateRecommendations(orgId: string, profileId: string | null = null): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cached = await this.getCached(profileId!, runId, 'smart_recommendations');
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const [stats, posts, platformCtx, hashtagCtx, negCtx] = await Promise.all([
      this.getStatsContext(profileId!, runId),
      this.getPostsSample(profileId!, runId, 80),
      this.getPlatformBreakdown(profileId!, runId),
      this.getTopHashtags(profileId!, runId),
      this.getTopNegativePosts(profileId!, runId, 10),
    ]);
    const result = await this.invokePrompt({
      promptName: 'smart_recommendations',
      inputVars: { stats, posts_sample: posts, platform_breakdown: platformCtx, top_hashtags: hashtagCtx, top_negative_posts: negCtx },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.6, max_tokens: 1200 },
    });
    await this.saveCache(profileId!, runId, 'smart_recommendations', result.result, result);
    return { text: result.result, meta: result };
  }

  async generateNarrativeGap(orgId: string, profileId: string | null = null): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cached = await this.getCached(profileId!, runId, 'narrative_gap_analysis');
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const [stats, posts, topNegative] = await Promise.all([
      this.getStatsContext(profileId!, runId),
      this.getPostsSample(profileId!, runId, 60),
      this.getTopNegativePosts(profileId!, runId, 8),
    ]);
    const result = await this.invokePrompt({
      promptName: 'narrative_gap_analysis',
      inputVars: { stats, posts_sample: posts, top_negative_posts: topNegative },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.4, max_tokens: 700 },
    });
    await this.saveCache(profileId!, runId, 'narrative_gap_analysis', result.result, result);
    return { text: result.result, meta: result };
  }

  async generatePoliticalSpectrum(orgId: string, profileId: string | null = null): Promise<{ text: string; meta: any }> {
    const run = profileId ? await this.getLatestRun(profileId) : null;
    const runId = run?.id ?? null;
    const cached = await this.getCached(profileId!, runId, 'political_spectrum');
    if (cached) return { text: cached.result, meta: { cached: true, runId } };

    const [stats, posts, topHashtags] = await Promise.all([
      this.getStatsContext(profileId!, runId),
      this.getPostsSample(profileId!, runId, 70),
      this.getTopHashtags(profileId!, runId),
    ]);
    const result = await this.invokePrompt({
      promptName: 'political_spectrum',
      inputVars: { stats, posts_sample: posts, top_hashtags: topHashtags },
      identifier: await this.resolveIdentifier(orgId, profileId),
      params: { temperature: 0.3, max_tokens: 400 },
    });
    await this.saveCache(profileId!, runId, 'political_spectrum', result.result, result);
    return { text: result.result, meta: result };
  }

  async generateAll(orgId: string, profileId: string | null = null): Promise<Record<string, { text: string; meta: any }>> {
    const results: Record<string, { text: string; meta: any }> = {};
    const sections = [
      { key: 'ai_summary',        fn: () => this.generateAiSummary(orgId, profileId) },
      { key: 'macro_context',     fn: () => this.generateMacroContext(orgId, profileId) },
      { key: 'recommendations',   fn: () => this.generateRecommendations(orgId, profileId) },
      { key: 'narrative_gap',     fn: () => this.generateNarrativeGap(orgId, profileId) },
      { key: 'political_spectrum',fn: () => this.generatePoliticalSpectrum(orgId, profileId) },
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
    });

    await this.saveCache(profileId!, null, `scenario_${scenario.slice(0, 40)}`, result.result, result);
    return { text: result.result, meta: result };
  }
}
