import { Controller, Get, Query, UseGuards } from '@nestjs/common';
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
    @CurrentProfile() profileId: string | null,
  ) {
    return this.contentService.getTopPosts(limit ? parseInt(limit, 10) : 10, profileId, since);
  }

  @Get('top-commented')
  getTopCommented(
    @Query('limit') limit: string | undefined,
    @Query('since') since: string | undefined,
    @CurrentProfile() profileId: string | null,
  ) {
    return this.contentService.getTopCommentedPosts(limit ? parseInt(limit, 10) : 20, profileId, since);
  }

  @Get('top-forwarded')
  getTopForwarded(
    @Query('limit') limit: string | undefined,
    @Query('since') since: string | undefined,
    @CurrentProfile() profileId: string | null,
  ) {
    return this.contentService.getTopForwardedPosts(limit ? parseInt(limit, 10) : 20, profileId, since);
  }

  @Get('hashtags')
  getHashtagStats(@Query('limit') limit: string | undefined, @CurrentProfile() profileId: string | null) {
    return this.contentService.getHashtagStats(limit ? parseInt(limit, 10) : 10, profileId);
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

  @Get('user-distribution')
  getUserDistribution(@CurrentProfile() profileId: string | null) {
    return this.contentService.getUserDistribution(profileId);
  }

  @Get('promise-perception')
  getPromisePerception(@CurrentProfile() profileId: string | null) {
    if (!profileId) return [];
    return this.contentService.getPromisePerception(profileId);
  }

  /**
   * Crisis radar metrics — 5 dimensions where 50 = normal baseline.
   * Values below 50 = below average, above 50 = above average.
   * All computed from our own stored data (self-calibrating over time).
   *
   * Dimensions:
   *   negativeSentiment  — current neg% vs profile's historical neg% (50 = normal)
   *   spreadVelocity     — today's 8tag total (from platform_totals) vs avg daily total
   *   officialReach      — recent official page views vs long-term avg
   *   influence          — recent avg views vs all-time avg views for this profile
   *   interactions       — recent avg interactions vs all-time avg
   */
  @Get('crisis')
  async getCrisisMetrics(@CurrentProfile() profileId: string | null) {
    if (!profileId) {
      return { dimensions: [], level: 'safe', score: 0, spikes: [] };
    }

    const now = new Date();
    const h24ago = new Date(now.getTime() - 24 * 3600_000);
    const h48ago = new Date(now.getTime() - 48 * 3600_000);
    const d7ago  = new Date(now.getTime() - 7 * 86400_000);

    // ── 1. Negative sentiment — current week vs all-time ratio ───────────────
    const [sentRecent] = await this.postRepo.query(
      `SELECT
         COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS neg,
         COUNT(*) FILTER (WHERE sentiment IS NOT NULL) AS total
       FROM selected_posts
       WHERE profile_id = $1 AND canonical_id IS NULL
         AND published_at >= $2
         AND (relevance_score IS NULL OR relevance_score >= 3)`,
      [profileId, d7ago],
    );
    const [sentAllTime] = await this.postRepo.query(
      `SELECT
         COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS neg,
         COUNT(*) FILTER (WHERE sentiment IS NOT NULL) AS total
       FROM selected_posts
       WHERE profile_id = $1 AND canonical_id IS NULL
         AND (relevance_score IS NULL OR relevance_score >= 3)`,
      [profileId],
    );
    const recentNegPct = sentRecent.total > 0 ? sentRecent.neg / sentRecent.total : 0;
    const baseNegPct   = sentAllTime.total > 0 ? sentAllTime.neg / sentAllTime.total : 0.3;
    // 50 = baseline. If recent is 2× baseline → 100. If 0 → 0.
    const negativeSentiment = baseNegPct > 0
      ? Math.min(100, Math.max(0, Math.round((recentNegPct / baseNegPct) * 50)))
      : (recentNegPct > 0 ? 75 : 50);

    // ── 2. Spread velocity — today's platform_totals vs weekly avg ───────────
    const [todayTotals] = await this.platformTotalRepo.query(
      `SELECT COALESCE(SUM(total), 0) AS today_total
       FROM platform_totals
       WHERE profile_id = $1 AND timeframe = 'day'`,
      [profileId],
    );
    const [weekTotals] = await this.platformTotalRepo.query(
      `SELECT COALESCE(SUM(total), 0) AS week_total
       FROM platform_totals
       WHERE profile_id = $1 AND timeframe = 'week'`,
      [profileId],
    );
    const todayTotal = Number(todayTotals.today_total) || 0;
    const weekTotal  = Number(weekTotals.week_total) || 1;
    const avgDaily   = weekTotal / 7;
    const spreadVelocity = avgDaily > 0
      ? Math.min(100, Math.max(0, Math.round((todayTotal / avgDaily) * 50)))
      : 50;

    // ── 3. Official reach — recent 7d views vs all-time avg weekly views ─────
    const [reachRecent] = await this.postRepo.query(
      `SELECT COALESCE(AVG(view_count), 0) AS avg_views
       FROM selected_posts
       WHERE profile_id = $1
         AND selection_reason LIKE 'official_page_%'
         AND published_at >= $2`,
      [profileId, d7ago],
    );
    const [reachAllTime] = await this.postRepo.query(
      `SELECT COALESCE(AVG(view_count), 0) AS avg_views
       FROM selected_posts
       WHERE profile_id = $1
         AND selection_reason LIKE 'official_page_%'`,
      [profileId],
    );
    const recentReach = Number(reachRecent.avg_views) || 0;
    const baseReach   = Number(reachAllTime.avg_views) || 0;
    // null = no data for this dimension (will be excluded from radar)
    const officialReach = baseReach > 0
      ? Math.min(100, Math.max(0, Math.round((recentReach / baseReach) * 50)))
      : null;

    // ── 4. Influence — recent avg views vs all-time avg views ────────────────
    const [viewsRecent] = await this.postRepo.query(
      `SELECT COALESCE(AVG(view_count), 0) AS avg_views
       FROM selected_posts
       WHERE profile_id = $1 AND canonical_id IS NULL
         AND published_at >= $2 AND view_count > 0
         AND (relevance_score IS NULL OR relevance_score >= 3)`,
      [profileId, d7ago],
    );
    const [viewsAllTime] = await this.postRepo.query(
      `SELECT COALESCE(AVG(view_count), 0) AS avg_views
       FROM selected_posts
       WHERE profile_id = $1 AND canonical_id IS NULL
         AND view_count > 0
         AND (relevance_score IS NULL OR relevance_score >= 3)`,
      [profileId],
    );
    const recentViews = Number(viewsRecent.avg_views) || 0;
    const baseViews   = Number(viewsAllTime.avg_views) || 0;
    const influence = baseViews > 0
      ? Math.min(100, Math.max(0, Math.round((recentViews / baseViews) * 50)))
      : null;

    // ── 5. Interactions — recent avg vs all-time avg ─────────────────────────
    const [intRecent] = await this.postRepo.query(
      `SELECT COALESCE(AVG(like_count + reply_count + retweet_count), 0) AS avg_int
       FROM selected_posts
       WHERE profile_id = $1 AND canonical_id IS NULL
         AND published_at >= $2
         AND (relevance_score IS NULL OR relevance_score >= 3)`,
      [profileId, d7ago],
    );
    const [intAllTime] = await this.postRepo.query(
      `SELECT COALESCE(AVG(like_count + reply_count + retweet_count), 0) AS avg_int
       FROM selected_posts
       WHERE profile_id = $1 AND canonical_id IS NULL
         AND (relevance_score IS NULL OR relevance_score >= 3)`,
      [profileId],
    );
    const recentInt = Number(intRecent.avg_int) || 0;
    const baseInt   = Number(intAllTime.avg_int) || 0;
    const interactions = baseInt > 0
      ? Math.min(100, Math.max(0, Math.round((recentInt / baseInt) * 50)))
      : null;

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

    // ── Overall score — weighted, centered at 50 ─────────────────────────────
    // Only include dimensions that have data. Score > 50 = above normal activity.
    const allDims = [
      { key: 'negativeSentiment', label: 'احساسات منفی',       value: negativeSentiment, weight: 0.40 },
      { key: 'spreadVelocity',    label: 'سرعت انتشار',        value: spreadVelocity,    weight: 0.20 },
      { key: 'officialReach',     label: 'بازتاب صفحات رسمی',  value: officialReach,     weight: 0.10 },
      { key: 'influence',         label: 'تأثیرگذاری',         value: influence,         weight: 0.15 },
      { key: 'interactions',      label: 'تعاملات',            value: interactions,      weight: 0.15 },
    ];

    // Filter out dimensions with no data (null)
    const dimensions = allDims
      .filter((d) => d.value !== null)
      .map(({ key, label, value }) => ({ key, label, value: value as number }));

    // Recalculate score from active dimensions only
    const activeDims = allDims.filter((d) => d.value !== null);
    const totalWeight = activeDims.reduce((s, d) => s + d.weight, 0);
    const score = totalWeight > 0
      ? Math.round(activeDims.reduce((s, d) => s + (d.value as number) * (d.weight / totalWeight), 0))
      : 50;

    const level = score >= 70 ? 'critical' : score >= 55 ? 'warning' : 'safe';

    return {
      score,
      level,
      dimensions,
      spikes,
    };
  }
}
