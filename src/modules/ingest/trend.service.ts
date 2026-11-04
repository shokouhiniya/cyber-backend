import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HourlyAggregate } from './hourly-aggregate.entity';
import { IngestRun } from './ingest-run.entity';
import { SelectedPost } from './selected-post.entity';
import { AGGREGATE_POST_FILTER } from './hourly-aggregate.builder';
import { PostFilter, hasPostFilter, postFilterSql } from '../content/post-filter';
import { rawBinder } from '../content/post-quality';

/** `source_type` condition for hourly_aggregates: the 'all' rollup, or the chosen platforms summed. */
function aggSourceSql(params: unknown[], platforms?: string[]): string {
  if (!platforms?.length) return `source_type = 'all'`;
  params.push(platforms);
  return `source_type = ANY($${params.length}::text[])`;
}

export interface TrendPoint {
  hour: string;       // ISO timestamp
  postCount: number;
  totalViews: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
}

export interface SourceShare {
  sourceType: string;
  postCount: number;
  pct: number;
  totalViews: number;
  viewPct: number;
  positiveCount: number;
  negativeCount: number;
}

export interface SpikeAlert {
  metric: 'posts' | 'views' | 'negative';
  sourceType: string;
  currentValue: number;
  baselineValue: number;
  changePercent: number;
  severity: 'high' | 'medium' | 'low';
}

export interface TrendSummary {
  profileId: string;
  windowHours: number;
  trend: TrendPoint[];
  sourceShares: SourceShare[];
  spikes: SpikeAlert[];
  latestRunId: string | null;
  latestRunAt: string | null;
  totalPostsInWindow: number;
  sentimentShift: {
    positiveDelta: number;   // percentage point change vs previous window
    negativeDelta: number;
    neutralDelta: number;
  };
}

@Injectable()
export class TrendService {
  private readonly logger = new Logger(TrendService.name);

  constructor(
    @InjectRepository(HourlyAggregate)
    private readonly aggRepo: Repository<HourlyAggregate>,
    @InjectRepository(IngestRun)
    private readonly runRepo: Repository<IngestRun>,
    @InjectRepository(SelectedPost)
    private readonly postRepo: Repository<SelectedPost>,
  ) {}

  /**
   * Returns trend data for a profile over the last `windowHours` hours.
   *
   * Hourly points come from hourly_aggregates, which the ingest worker rebuilds
   * from selected_posts after LLM sentiment, bucketed by published hour (see
   * hourly-aggregate.builder.ts). Source shares use the same post filter, so
   * this endpoint, the health index and the AI summary count the same posts.
   * Compares against the previous window of the same length to compute deltas.
   *
   * `filter` (dashboard filter): from / to replace the trailing window, and
   * platforms sums those platforms' rows instead of the 'all' rollup.
   */
  async getTrend(profileId: string, windowHours = 24, filter: PostFilter = {}): Promise<TrendSummary> {
    const realNow = new Date();
    const now = filter.to && filter.to < realNow ? filter.to : realNow;
    const windowStart = filter.from ?? new Date(now.getTime() - windowHours * 3600_000);
    windowHours = Math.max(1, Math.round((now.getTime() - windowStart.getTime()) / 3600_000));
    const prevWindowStart = new Date(windowStart.getTime() - windowHours * 3600_000);
    const platforms = filter.platforms?.length ? filter.platforms : undefined;

    // Latest completed run
    const latestRun = await this.runRepo.findOne({
      where: { profileId, status: 'completed' },
      order: { finishedAt: 'DESC' },
    });

    // ── Hourly trend (current window) ────────────────────────────────────────
    const hourlyParams: unknown[] = [profileId, windowStart, now];
    const hourlySource = aggSourceSql(hourlyParams, platforms);
    const hourlyRows = await this.aggRepo.query(
      `SELECT hour, source_type, sentiment, post_count, total_views
       FROM hourly_aggregates
       WHERE profile_id = $1
         AND hour >= $2 AND hour < $3
         AND ${hourlySource}
       ORDER BY hour ASC`,
      hourlyParams,
    );

    // Aggregate by hour across all sources
    const byHour = new Map<string, TrendPoint>();
    for (const row of hourlyRows) {
      const h = new Date(row.hour).toISOString();
      if (!byHour.has(h)) {
        byHour.set(h, { hour: h, postCount: 0, totalViews: 0, positiveCount: 0, negativeCount: 0, neutralCount: 0 });
      }
      const pt = byHour.get(h)!;
      if (row.sentiment === 'all') {
        pt.postCount += Number(row.post_count);
        pt.totalViews += Number(row.total_views);
      } else if (row.sentiment.toLowerCase() === 'positive') pt.positiveCount += Number(row.post_count);
      else if (row.sentiment.toLowerCase() === 'negative') pt.negativeCount += Number(row.post_count);
      else if (row.sentiment.toLowerCase() === 'neutral') pt.neutralCount += Number(row.post_count);
    }
    const trend = Array.from(byHour.values());

    // ── Source shares (selected_posts of the latest run, or of the filter) ──
    // With a dashboard filter the shares cover the chosen period / platforms;
    // otherwise the latest run, as before.
    const filtered = hasPostFilter(filter);
    const shareParams: unknown[] = [profileId];
    const shareScope = filtered
      ? postFilterSql({ ...filter, from: windowStart, to: now }, rawBinder(shareParams))
      : latestRun ? ` AND ingest_run_id = ${rawBinder(shareParams)(latestRun.id)}` : '';
    const sourceRows = await this.postRepo.query(
      `SELECT source_type,
         COUNT(*) AS post_count,
         SUM(view_count) AS total_views,
         COUNT(*) FILTER (WHERE LOWER(sentiment) = 'positive') AS positive_count,
         COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS negative_count
       FROM selected_posts
       WHERE profile_id = $1
         AND ${AGGREGATE_POST_FILTER}
         ${shareScope}
       GROUP BY source_type
       ORDER BY post_count DESC`,
      shareParams,
    );

    const totalPosts = sourceRows.reduce((s: number, r: any) => s + Number(r.post_count), 0);
    const totalViews = sourceRows.reduce((s: number, r: any) => s + Number(r.total_views), 0);

    const sourceShares: SourceShare[] = sourceRows.map((r: any) => ({
      sourceType: r.source_type,
      postCount: Number(r.post_count),
      pct: totalPosts > 0 ? Math.round(Number(r.post_count) / totalPosts * 100) : 0,
      totalViews: Number(r.total_views),
      viewPct: totalViews > 0 ? Math.round(Number(r.total_views) / totalViews * 100) : 0,
      positiveCount: Number(r.positive_count),
      negativeCount: Number(r.negative_count),
    }));

    // ── Sentiment shift (current vs previous window) ─────────────────────────
    const [currSent, prevSent] = await Promise.all([
      this.getSentimentTotals(profileId, windowStart, now, platforms),
      this.getSentimentTotals(profileId, prevWindowStart, windowStart, platforms),
    ]);

    const sentimentShift = {
      positiveDelta: currSent.positivePct - prevSent.positivePct,
      negativeDelta: currSent.negativePct - prevSent.negativePct,
      neutralDelta: currSent.neutralPct - prevSent.neutralPct,
    };

    // ── Spike detection ──────────────────────────────────────────────────────
    const spikes = await this.detectSpikes(profileId, windowStart, prevWindowStart, now, platforms);

    return {
      profileId,
      windowHours,
      trend,
      sourceShares,
      spikes,
      latestRunId: latestRun?.id ?? null,
      latestRunAt: latestRun?.finishedAt?.toISOString() ?? null,
      totalPostsInWindow: totalPosts,
      sentimentShift,
    };
  }

  private async getSentimentTotals(
    profileId: string,
    from: Date,
    to: Date,
    platforms?: string[],
  ): Promise<{ positivePct: number; negativePct: number; neutralPct: number }> {
    const params: unknown[] = [profileId, from, to];
    const source = aggSourceSql(params, platforms);
    const rows = await this.aggRepo.query(
      `SELECT sentiment, SUM(post_count) AS cnt
       FROM hourly_aggregates
       WHERE profile_id = $1 AND hour >= $2 AND hour < $3
         AND ${source} AND sentiment != 'all'
       GROUP BY sentiment`,
      params,
    );

    const totals: Record<string, number> = { Positive: 0, Negative: 0, Neutral: 0 };
    for (const r of rows) {
      const key = r.sentiment.charAt(0).toUpperCase() + r.sentiment.slice(1).toLowerCase();
      if (totals[key] !== undefined) totals[key] = Number(r.cnt);
    }
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    if (total === 0) return { positivePct: 0, negativePct: 0, neutralPct: 0 };

    return {
      positivePct: Math.round(totals.Positive / total * 100),
      negativePct: Math.round(totals.Negative / total * 100),
      neutralPct: Math.round(totals.Neutral / total * 100),
    };
  }

  private async detectSpikes(
    profileId: string,
    windowStart: Date,
    prevWindowStart: Date,
    windowEnd: Date = new Date(),
    platforms?: string[],
  ): Promise<SpikeAlert[]> {
    const spikes: SpikeAlert[] = [];

    // Compare post volume per source between current and previous window
    const params: unknown[] = [profileId, windowStart, prevWindowStart, windowEnd];
    if (platforms?.length) params.push(platforms);
    const rows = await this.aggRepo.query(
      `SELECT source_type, sentiment,
         SUM(CASE WHEN hour >= $2 THEN post_count ELSE 0 END) AS curr_posts,
         SUM(CASE WHEN hour >= $3 AND hour < $2 THEN post_count ELSE 0 END) AS prev_posts,
         SUM(CASE WHEN hour >= $2 THEN total_views ELSE 0 END) AS curr_views,
         SUM(CASE WHEN hour >= $3 AND hour < $2 THEN total_views ELSE 0 END) AS prev_views
       FROM hourly_aggregates
       WHERE profile_id = $1
         AND hour >= $3 AND hour < $4
         AND sentiment = 'all'
         ${platforms?.length ? 'AND source_type = ANY($5::text[])' : ''}
       GROUP BY source_type, sentiment`,
      params,
    );

    for (const r of rows) {
      const curr = Number(r.curr_posts);
      const prev = Number(r.prev_posts);
      if (prev === 0 || curr === 0) continue;

      const changePct = Math.round((curr - prev) / prev * 100);
      if (changePct >= 100) {
        spikes.push({
          metric: 'posts',
          sourceType: r.source_type,
          currentValue: curr,
          baselineValue: prev,
          changePercent: changePct,
          severity: changePct >= 300 ? 'high' : changePct >= 150 ? 'medium' : 'low',
        });
      }
    }

    // Sort by severity then change percent
    const severityOrder = { high: 0, medium: 1, low: 2 };
    spikes.sort((a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      b.changePercent - a.changePercent,
    );

    return spikes.slice(0, 5); // cap at 5 alerts
  }
}
