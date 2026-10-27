import { Controller, Get, Optional, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ContentService } from './content.service';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PlatformTotal } from '../ingest/platform-total.entity';
import { SelectedPost } from '../ingest/selected-post.entity';
import { HourlyAggregate } from '../ingest/hourly-aggregate.entity';
import { AGGREGATE_POST_FILTER } from '../ingest/hourly-aggregate.builder';
import {
  CRISIS_BASELINE_DAYS, CRISIS_MIN_POST_AGE_HOURS, CRISIS_RECENT_DAYS, CrisisDimension,
  combineCrisis, negativeShareScore, perPostScore, spreadScore,
} from '../ingest/crisis-formula';
import { APP_EVENTS, AppEvents } from '../notifications/app-events';

@Controller('stats')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin', 'client_admin', 'client_viewer')
export class StatsController {
  constructor(
    private readonly contentService: ContentService,
    @InjectRepository(PlatformTotal)
    private readonly platformTotalRepo: Repository<PlatformTotal>,
    @InjectRepository(SelectedPost)
    private readonly postRepo: Repository<SelectedPost>,
    @InjectRepository(HourlyAggregate)
    private readonly aggRepo: Repository<HourlyAggregate>,
    @Optional()
    private readonly events?: AppEvents,
  ) {}

  @Get()
  getStats(
    @CurrentProfile() profileId: string | null,
    @Query('since') since?: string,
  ) {
    return this.contentService.getStats(profileId, since);
  }

  @Get('top-posts')
  getTopPosts(
    @Query('limit') limit: string | undefined,
    @Query('since') since: string | undefined,
    @Query('source') source: string | undefined,
    @CurrentProfile() profileId: string | null,
  ) {
    return this.contentService.getTopPosts(limit ? parseInt(limit, 10) : 10, profileId, since, source);
  }

  @Get('top-commented')
  getTopCommented(
    @Query('limit') limit: string | undefined,
    @Query('since') since: string | undefined,
    @Query('source') source: string | undefined,
    @CurrentProfile() profileId: string | null,
  ) {
    return this.contentService.getTopCommentedPosts(limit ? parseInt(limit, 10) : 20, profileId, since, source);
  }

  @Get('top-forwarded')
  getTopForwarded(
    @Query('limit') limit: string | undefined,
    @Query('since') since: string | undefined,
    @Query('source') source: string | undefined,
    @CurrentProfile() profileId: string | null,
  ) {
    return this.contentService.getTopForwardedPosts(limit ? parseInt(limit, 10) : 20, profileId, since, source);
  }

  @Get('hashtags')
  getHashtagStats(
    @Query('limit') limit: string | undefined,
    @Query('since') since: string | undefined,
    @CurrentProfile() profileId: string | null,
  ) {
    return this.contentService.getHashtagStats(limit ? parseInt(limit, 10) : 10, profileId, since);
  }

  @Get('sources')
  getSourceStats(
    @CurrentProfile() profileId: string | null,
    @Query('since') since?: string,
  ) {
    return this.contentService.getSourceStats(profileId, since);
  }

  /**
   * Platform totals — reads pre-computed counts from platform_totals table.
   * Data is captured during each ingest run (40 8tag calls per profile).
   * Instant DB read, no live API calls on page visit.
   *
   * Query: ?timeframe=week (day | week | month | quarter)
   */
  @Get('platform-totals')
  async getPlatformTotals(
    @CurrentProfile() profileId: string | null,
    @Query('timeframe') timeframe = 'week',
  ) {
    if (!profileId) {
      return [];
    }

    const rows = await this.platformTotalRepo.find({
      where: { profileId, timeframe },
      order: { total: 'DESC' },
    });

    return rows.map((r) => ({
      source: r.sourceType,
      count: Number(r.total),
      fetchedAt: r.fetchedAt,
    }));
  }

  /**
   * Bot analysis per account: average LLM bot_probability per
   * (screen_name, source_type) → bot ≥ 60 / suspicious 30–59 / human < 30 /
   * unscored. Returns account + post counts per class and the top suspicious
   * accounts. ?since= limits it to the report period.
   */
  @Get('bot-analysis')
  getBotAnalysis(
    @CurrentProfile() profileId: string | null,
    @Query('since') since?: string,
  ) {
    return this.contentService.getBotAnalysis(profileId, since);
  }

  @Get('promise-perception')
  getPromisePerception(
    @CurrentProfile() profileId: string | null,
    @Query('since') since?: string,
  ) {
    if (!profileId) return [];
    return this.contentService.getPromisePerception(profileId, since);
  }

  /**
   * Crisis radar metrics — 5 dimensions where 50 = normal.
   * Each axis compares the last 7 days with the previous 4 weeks (same metric
   * per day / per post on both sides); views and interactions use the typical
   * (geometric-mean) post and only posts older than 48h. Full formula and constants: src/modules/ingest/crisis-formula.ts.
   *
   * Response: { score, level, window, dimensions[{key,label,value,hasData}], spikes }
   */
  @Get('crisis')
  async getCrisisMetrics(@CurrentProfile() profileId: string | null) {
    if (!profileId) {
      return { dimensions: [], level: 'safe', score: 0, spikes: [] };
    }

    const now = new Date();
    const h24ago = new Date(now.getTime() - 24 * 3600_000);
    const h48ago = new Date(now.getTime() - 48 * 3600_000);
    const recentStart = new Date(now.getTime() - CRISIS_RECENT_DAYS * 86400_000);
    const baselineStart = new Date(recentStart.getTime() - CRISIS_BASELINE_DAYS * 86400_000);
    // Per-post medians: only posts old enough to have accumulated views
    const matureBefore = new Date(now.getTime() - CRISIS_MIN_POST_AGE_HOURS * 3600_000);

    // ── 1. Negative sentiment share — 7d vs previous 28d ─────────────────────
    // Same post set as the hourly aggregates / AI summary.
    const [sent] = await this.postRepo.query(
      `SELECT
         COUNT(*) FILTER (WHERE published_at >= $2 AND LOWER(sentiment) = 'negative') AS neg_recent,
         COUNT(*) FILTER (WHERE published_at >= $2) AS total_recent,
         COUNT(*) FILTER (WHERE published_at < $2 AND LOWER(sentiment) = 'negative') AS neg_base,
         COUNT(*) FILTER (WHERE published_at < $2) AS total_base
       FROM selected_posts
       WHERE profile_id = $1 AND published_at >= $3 AND published_at < $4
         AND ${AGGREGATE_POST_FILTER}`,
      [profileId, recentStart, baselineStart, now],
    );
    const negativeSentiment = negativeShareScore(
      { neg: Number(sent.neg_recent), total: Number(sent.total_recent) },
      { neg: Number(sent.neg_base), total: Number(sent.total_base) },
    );

    // ── 2. Spread velocity — 8tag mentions/day: last week vs the 23 days before
    const [totals] = await this.platformTotalRepo.query(
      `SELECT
         COALESCE(SUM(total) FILTER (WHERE timeframe = 'week'), 0)  AS week_total,
         COALESCE(SUM(total) FILTER (WHERE timeframe = 'month'), 0) AS month_total
       FROM platform_totals
       WHERE profile_id = $1`,
      [profileId],
    );
    const spreadVelocity = spreadScore(Number(totals.week_total) || 0, Number(totals.month_total) || 0);

    // ── 3–5. Typical post = geometric mean of (x+1); posts older than 48h ───
    const perPostAxis = async (metric: string, postFilter: string) => {
      const [r] = await this.postRepo.query(
        `SELECT
           COUNT(*) FILTER (WHERE published_at >= $2) AS n_recent,
           COALESCE(EXP(AVG(LN(GREATEST(${metric}, 0) + 1)) FILTER (WHERE published_at >= $2)), 0) AS geo_recent,
           COUNT(*) FILTER (WHERE published_at < $2) AS n_base,
           COALESCE(EXP(AVG(LN(GREATEST(${metric}, 0) + 1)) FILTER (WHERE published_at < $2)), 0) AS geo_base
         FROM selected_posts
         WHERE profile_id = $1 AND published_at >= $3 AND published_at < $4
           AND ${postFilter}`,
        [profileId, recentStart, baselineStart, matureBefore],
      );
      return perPostScore(
        { geoMean: Number(r.geo_recent), n: Number(r.n_recent) },
        { geoMean: Number(r.geo_base), n: Number(r.n_base) },
      );
    };

    const [officialReach, influence, interactions] = await Promise.all([
      perPostAxis('view_count', `selection_reason LIKE 'official_page_%'`),
      perPostAxis('view_count', AGGREGATE_POST_FILTER),
      perPostAxis('(like_count + reply_count + retweet_count)', AGGREGATE_POST_FILTER),
    ]);

    // ── Spikes ───────────────────────────────────────────────────────────────
    const spikeRows = await this.aggRepo.query(
      `SELECT source_type,
         SUM(CASE WHEN hour >= $2 THEN post_count ELSE 0 END) AS curr,
         SUM(CASE WHEN hour >= $3 AND hour < $2 THEN post_count ELSE 0 END) AS prev
       FROM hourly_aggregates
       WHERE profile_id = $1 AND hour >= $3 AND sentiment = 'all'
         AND source_type != 'all'
       GROUP BY source_type
       HAVING SUM(CASE WHEN hour >= $3 AND hour < $2 THEN post_count ELSE 0 END) > 0`,
      [profileId, h24ago, h48ago],
    );

    const spikes = spikeRows
      .map((r: any) => {
        const curr = Number(r.curr);
        const prev = Number(r.prev);
        const pct = Math.round(((curr - prev) / prev) * 100);
        return { sourceType: r.source_type, changePercent: pct, curr, prev };
      })
      .filter((s: any) => s.changePercent >= 80)
      .sort((a: any, b: any) => b.changePercent - a.changePercent)
      .slice(0, 5);

    // ── Overall score — weighted mean of axes with data, centered at 50 ─────
    const allDims: CrisisDimension[] = [
      { key: 'negativeSentiment', label: 'احساسات منفی',      value: negativeSentiment },
      { key: 'spreadVelocity',    label: 'سرعت انتشار',       value: spreadVelocity },
      { key: 'officialReach',     label: 'بازتاب صفحات رسمی', value: officialReach },
      { key: 'influence',         label: 'تأثیرگذاری',        value: influence },
      { key: 'interactions',      label: 'تعاملات',           value: interactions },
    ];

    // Always return all 5 axes so the radar keeps its shape; axes without data
    // are flagged with hasData=false and excluded from the score.
    const anyData = allDims.some((d) => d.value !== null);
    const dimensions = anyData
      ? allDims.map(({ key, label, value }) => ({ key, label, value: value ?? 0, hasData: value !== null }))
      : [];

    const { score, level } = combineCrisis(allDims);
    // The notifications listener de-duplicates against the last level it saw
    if (anyData) this.events?.emit(APP_EVENTS.CRISIS_LEVEL_CHANGED, { profileId, level, score });

    return {
      score,
      level,
      window: { recentDays: CRISIS_RECENT_DAYS, baselineDays: CRISIS_BASELINE_DAYS },
      dimensions,
      spikes,
    };
  }
}
