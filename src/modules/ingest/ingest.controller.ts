import { Controller, Post, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response } from 'express';

import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { IngestWorkerService } from './ingest-worker.service';
import { MacroContextService } from './macro-context.service';
import { TrendService } from './trend.service';
import { IngestRun } from './ingest-run.entity';
import { SelectedPost } from './selected-post.entity';
import { AiResultCache } from './ai-result-cache.entity';
import { GlobalContext } from '../admin/global-context/global-context.entity';

@Controller('admin/ingest')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin')
export class IngestController {
  constructor(
    private readonly worker: IngestWorkerService,
    private readonly macroContext: MacroContextService,
    private readonly trend: TrendService,
    @InjectRepository(IngestRun)
    private readonly runRepo: Repository<IngestRun>,
    @InjectRepository(SelectedPost)
    private readonly postRepo: Repository<SelectedPost>,
    @InjectRepository(AiResultCache)
    private readonly cacheRepo: Repository<AiResultCache>,
    @InjectRepository(GlobalContext)
    private readonly contextRepo: Repository<GlobalContext>,
  ) {}

  /** Manually trigger ingest for a specific profile */
  @Post('profiles/:id/run')
  async runNow(@Param('id') id: string) {
    const run = await this.worker.runForProfile(id);
    return { runId: run.id, status: run.status, postsSelected: run.postsSelected };
  }

  /** List recent ingest runs for a profile */
  @Get('profiles/:id/runs')
  async listRuns(
    @Param('id') id: string,
    @Query('limit') limit = '10',
  ) {
    return this.runRepo.find({
      where: { profileId: id },
      order: { startedAt: 'DESC' },
      take: Math.min(parseInt(limit, 10) || 10, 50),
      select: ['id', 'status', 'startedAt', 'finishedAt', 'postsFetched', 'postsAfterDedup', 'postsSelected', 'errorMessage'],
    });
  }

  /** Get the latest ingest run for a profile */
  @Get('profiles/:id/runs/latest')
  async latestRun(@Param('id') id: string) {
    return this.runRepo.findOne({
      where: { profileId: id },
      order: { startedAt: 'DESC' },
    });
  }

  /** Get trend data for a profile */
  @Get('profiles/:id/trend')
  @Roles('super_admin', 'client_admin', 'client_viewer')
  async getTrend(
    @Param('id') id: string,
    @Query('hours') hours = '24',
  ) {
    return this.trend.getTrend(id, Math.min(parseInt(hours, 10) || 24, 168));
  }

  /**
   * Aggregates the 8tag `totalPerSource` values from ingest_runs.stats
   * for the current profile within the given time window.
   *
   * Returns the MAX total seen per source across all runs in the window —
   * this is the best proxy for "how many posts exist on 8tag for this profile
   * in this timeframe" without making a live API call.
   */
  @Get('source-totals')
  @Roles('super_admin', 'client_admin', 'client_viewer')
  async getSourceTotals(
    @CurrentProfile() profileId: string | null,
    @Query('since') since?: string,
  ) {
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 7 * 24 * 3600_000);

    const profileFilter = profileId ? `AND profile_id = '${profileId}'` : '';

    const rows = await this.runRepo.query(
      `SELECT
         source_key,
         MAX((stats->'totalPerSource'->source_key)::int) AS max_total,
         SUM((stats->'totalPerSource'->source_key)::int) AS sum_total,
         COUNT(*) AS run_count
       FROM ingest_runs,
            jsonb_object_keys(stats->'totalPerSource') AS source_key
       WHERE status = 'completed'
         AND started_at >= $1
         AND stats->'totalPerSource' IS NOT NULL
         ${profileFilter}
       GROUP BY source_key
       ORDER BY max_total DESC`,
      [sinceDate],
    );

    return rows.map((r: any) => ({
      source: r.source_key,
      total: parseInt(r.max_total) || 0,
      runCount: parseInt(r.run_count) || 0,
    }));
  }

  /** Manually trigger macro context generation */
  @Post('macro-context/generate')
  async generateMacroContext() {
    const result = await this.macroContext.generate();
    return { success: true, length: result.length };
  }

  /** Read the current macro political context (for the frontend widget) */
  @Get('macro-context')
  @Roles('super_admin', 'client_admin', 'client_viewer')
  async getMacroContext() {
    const today = await this.contextRepo.findOne({ where: { key: 'macro_political_context' } });
    const rolling = await this.contextRepo.findOne({ where: { key: 'macro_political_context_7d' } });
    return {
      today: today?.value || null,
      updatedAt: today?.updatedAt || null,
      rolling7d: rolling?.value || null,
    };
  }

  // ── Export endpoints ────────────────────────────────────────────────────────

  /**
   * Export all saved posts for a profile as UTF-8 CSV.
   * Columns: source, screen_name, published_at, sentiment, relevance_score,
   * political_spectrum, bot_probability, engagement counts, selection_reason,
   * hashtags, post_url, full text.
   */
  @Get('profiles/:id/export-posts')
  async exportPosts(
    @Param('id') profileId: string,
    @Res() res: Response,
  ) {
    const posts = await this.postRepo.find({
      where: { profileId, canonicalId: null as any },
      order: { publishedAt: 'DESC' },
      select: [
        'id', 'sourceType', 'screenName', 'publishedAt',
        'sentiment', 'relevanceScore', 'politicalSpectrum', 'botProbability',
        'viewCount', 'likeCount', 'retweetCount', 'replyCount',
        'selectionReason', 'hashtags', 'postUrl', 'text',
      ],
    });

    const esc = (v: any): string => {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
    };

    const headers = [
      'source', 'screen_name', 'published_at', 'sentiment', 'relevance_score',
      'political_spectrum', 'bot_probability', 'view_count', 'like_count',
      'retweet_count', 'reply_count', 'selection_reason', 'hashtags', 'post_url', 'text',
    ];

    const rows = posts.map((p) => [
      p.sourceType, p.screenName, p.publishedAt?.toISOString() ?? '',
      p.sentiment, p.relevanceScore, p.politicalSpectrum, p.botProbability,
      p.viewCount, p.likeCount, p.retweetCount, p.replyCount,
      p.selectionReason, (p.hashtags || []).join('|'), p.postUrl, p.text,
    ].map(esc).join(','));

    const csv = '\uFEFF' + [headers.join(','), ...rows].join('\n');
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="posts-${profileId.slice(0, 8)}-${date}.csv"`);
    res.send(csv);
  }

  /**
   * Export all AI analysis results for a profile as UTF-8 CSV.
   * Excludes batch_sentiment (per-post classifier, not a dashboard section).
   * Columns: prompt_name, model, created_at, latency_ms, token_usage, result_text.
   */
  @Get('profiles/:id/export-analysis')
  async exportAnalysis(
    @Param('id') profileId: string,
    @Res() res: Response,
  ) {
    const EXCLUDED = ['batch_sentiment', '__sample_snapshot'];

    const rows = await this.cacheRepo.find({
      where: { profileId },
      order: { createdAt: 'DESC' },
    });

    const filtered = rows.filter((r) => !EXCLUDED.some((ex) => r.promptName.startsWith(ex)));

    const esc = (v: any): string => {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
    };

    const headers = ['prompt_name', 'model', 'created_at', 'latency_ms', 'prompt_tokens', 'completion_tokens', 'result'];

    const csvRows = filtered.map((r) => [
      r.promptName,
      r.modelName,
      r.createdAt?.toISOString() ?? '',
      r.latencyMs,
      r.tokenUsage?.prompt ?? '',
      r.tokenUsage?.completion ?? '',
      r.result,
    ].map(esc).join(','));

    const csv = '\uFEFF' + [headers.join(','), ...csvRows].join('\n');
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="analysis-${profileId.slice(0, 8)}-${date}.csv"`);
    res.send(csv);
  }

  /** Get distinct source types from a specific run (for AI sample customization) */
  @Get('profiles/:id/run-sources')
  @Roles('super_admin', 'client_admin', 'client_viewer')
  async getRunSources(
    @Param('id') profileId: string,
    @Query('runId') runId?: string,
  ) {
    const qb = this.postRepo
      .createQueryBuilder('p')
      .select('DISTINCT p.source_type', 'source')
      .where('p.profile_id = :profileId', { profileId })
      .andWhere('p.canonical_id IS NULL')
      .andWhere("(p.selection_reason IS NULL OR (p.selection_reason NOT LIKE 'official_page_%' AND p.selection_reason NOT LIKE 'display_%'))");
    if (runId) qb.andWhere('p.ingest_run_id = :runId', { runId });
    const rows = await qb.getRawMany();
    return rows.map((r: any) => r.source).filter(Boolean);
  }

  /**
   * Export the exact posts that were last sent to the general AI analysis prompts.
   *
   * Reads the `__sample_snapshot` row recorded by AiContentService at generation
   * time (regenerate-all / scheduled ingest / regenerate-ai). This is the SAME
   * ordered set of posts that was formatted and sent to the LLMs — including any
   * manual source selection, custom limit, or sort order chosen in the dialog.
   *
   * Falls back to re-deriving the default sample only when no snapshot exists yet
   * (e.g. a profile analysed before this feature shipped).
   */
  @Get('profiles/:id/export-ai-sample')
  async exportAiSample(
    @Param('id') profileId: string,
    @Res() res: Response,
  ) {
    const snapshotRow = await this.cacheRepo.findOne({
      where: { profileId, promptName: '__sample_snapshot' },
      order: { createdAt: 'DESC' },
    });

    let posts: any[] = [];
    let runLabel = 'no-run';
    let optionsNote = '';

    if (snapshotRow?.result) {
      // ── Faithful path: read the recorded snapshot ──────────────────────────
      let snap: { runId: string | null; generatedAt: string; options: any; postIds: string[] };
      try {
        snap = JSON.parse(snapshotRow.result);
      } catch {
        snap = { runId: null, generatedAt: '', options: {}, postIds: [] };
      }

      const ids = Array.isArray(snap.postIds) ? snap.postIds : [];
      if (ids.length > 0) {
        const rows: any[] = await this.postRepo.query(
          `SELECT
             id, source_type, screen_name, published_at,
             sentiment, relevance_score, political_spectrum, bot_probability,
             view_count, like_count, retweet_count, reply_count,
             (view_count + like_count * 2 + reply_count * 3) AS engagement_score,
             selection_reason, hashtags, post_url, ingest_run_id, text
           FROM selected_posts
           WHERE id = ANY($1::uuid[])`,
          [ids],
        );
        // Preserve the exact order in which posts were sent to the LLM
        const byId = new Map(rows.map((r) => [r.id, r]));
        posts = ids.map((id) => byId.get(id)).filter(Boolean);
      }

      const opts = snap.options || {};
      const srcNote = opts.sources ? `sources=${opts.sources.join('+')}` : 'sources=all';
      optionsNote = `${srcNote}; sort=${opts.sortBy || 'engagement'}; limit=${opts.limit ?? 'default'}`;
      if (snap.runId) {
        const genDate = snap.generatedAt ? snap.generatedAt.slice(0, 10) : 'snap';
        runLabel = `run_${snap.runId.slice(0, 8)}_${genDate}`;
      }
    } else {
      // ── Fallback: re-derive the default sample (legacy profiles only) ──────
      const latestRun = await this.runRepo.findOne({
        where: { profileId, status: 'completed' },
        order: { finishedAt: 'DESC' },
        select: ['id', 'finishedAt'],
      });

      const runFilter = latestRun?.id ? 'AND ingest_run_id = $2' : '';
      const params: any[] = latestRun?.id ? [profileId, latestRun.id] : [profileId];

      posts = await this.postRepo.query(
        `SELECT
           source_type, screen_name, published_at,
           sentiment, relevance_score, political_spectrum, bot_probability,
           view_count, like_count, retweet_count, reply_count,
           (view_count + like_count * 2 + reply_count * 3) AS engagement_score,
           selection_reason, hashtags, post_url, ingest_run_id, text
         FROM selected_posts
         WHERE profile_id = $1
           AND canonical_id IS NULL
           AND (relevance_score IS NULL OR relevance_score >= 3)
           AND (selection_reason IS NULL OR (selection_reason NOT LIKE 'official_page_%' AND selection_reason NOT LIKE 'display_%'))
           ${runFilter}
         ORDER BY (view_count + like_count * 2 + reply_count * 3) DESC
         LIMIT 80`,
        params,
      );
      optionsNote = 'fallback (no snapshot recorded yet) — default engagement/all-sources/80';
      if (latestRun) {
        runLabel = `run_${latestRun.id.slice(0, 8)}_${new Date(latestRun.finishedAt!).toISOString().slice(0, 10)}`;
      }
    }

    const esc = (v: any): string => {
      if (v == null) return '';
      const s = Array.isArray(v) ? v.join('|') : String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
    };

    const headers = [
      'ai_rank', 'source', 'screen_name', 'published_at', 'sentiment', 'relevance_score',
      'political_spectrum', 'bot_probability', 'view_count', 'like_count',
      'retweet_count', 'reply_count', 'engagement_score', 'selection_reason',
      'hashtags', 'post_url', 'ingest_run_id', 'text',
    ];

    const csvRows = posts.map((p, i) => [
      i + 1,
      p.source_type, p.screen_name,
      p.published_at ? new Date(p.published_at).toISOString() : '',
      p.sentiment, p.relevance_score, p.political_spectrum, p.bot_probability,
      p.view_count, p.like_count, p.retweet_count, p.reply_count, p.engagement_score,
      p.selection_reason, p.hashtags, p.post_url, p.ingest_run_id, p.text,
    ].map(esc).join(','));

    // First line is a comment documenting the exact selection options used.
    const meta = `# ${optionsNote}; total=${posts.length}`;
    const csv = '\uFEFF' + [meta, headers.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ai-sample-${runLabel}.csv"`);
    res.send(csv);
  }
}