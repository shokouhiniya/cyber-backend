import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HourlyAggregate } from './hourly-aggregate.entity';
import { IngestRun } from './ingest-run.entity';
import { SelectedPost } from './selected-post.entity';

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
   * Compares against the previous window of the same length to compute deltas.
   */
  async getTrend(profileId: string, windowHours = 24): Promise<TrendSummary> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowHours * 3600_000);
    const prevWindowStart = new Date(windowStart.getTime() - windowHours * 3600_000);

    // Latest completed run
    const latestRun = await this.runRepo.findOne({
      where: { profileId, status: 'completed' },
      order: { finishedAt: 'DESC' },
    });

    // ── Hourly trend (current window) ────────────────────────────────────────
    const hourlyRows = await this.aggRepo.query(
      `SELECT hour, source_type, sentiment, post_count, total_views
       FROM hourly_aggregates
       WHERE profile_id = $1
         AND hour >= $2
         AND source_type = 'all'
       ORDER BY hour ASC`,
      [profileId, windowStart],
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

    // ── Source shares (from selected_posts of latest run) ────────────────────
    const sourceRows = await this.postRepo.query(
      `SELECT source_type,
         COUNT(*) AS post_count,
         SUM(view_count) AS total_views,
         COUNT(*) FILTER (WHERE sentiment = 'Positive') AS positive_count,
         COUNT(*) FILTER (WHERE sentiment = 'Negative') AS negative_count
       FROM selected_posts
       WHERE profile_id = $1
         AND canonical_id IS NULL
         ${latestRun ? 'AND ingest_run_id = $2' : ''}
       GROUP BY source_type
       ORDER BY post_count DESC`,
      latestRun ? [profileId, latestRun.id] : [profileId],
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
      this.getSentimentTotals(profileId, windowStart, now),
      this.getSentimentTotals(profileId, prevWindowStart, windowStart),
    ]);

    const sentimentShift = {
      positiveDelta: currSent.positivePct - prevSent.positivePct,
      negativeDelta: currSent.negativePct - prevSent.negativePct,
      neutralDelta: currSent.neutralPct - prevSent.neutralPct,
    };

    // ── Spike detection ──────────────────────────────────────────────────────
    const spikes = await this.detectSpikes(profileId, windowStart, prevWindowStart);

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
  ): Promise<{ positivePct: number; negativePct: number; neutralPct: number }> {
    const rows = await this.aggRepo.query(
      `SELECT sentiment, SUM(post_count) AS cnt
       FROM hourly_aggregates
       WHERE profile_id = $1 AND hour >= $2 AND hour < $3
         AND source_type = 'all' AND sentiment != 'all'
       GROUP BY sentiment`,
      [profileId, from, to],
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
  ): Promise<SpikeAlert[]> {
    const spikes: SpikeAlert[] = [];

    // Compare post volume per source between current and previous window
    const rows = await this.aggRepo.query(
      `SELECT source_type, sentiment,
         SUM(CASE WHEN hour >= $2 THEN post_count ELSE 0 END) AS curr_posts,
         SUM(CASE WHEN hour >= $3 AND hour < $2 THEN post_count ELSE 0 END) AS prev_posts,
         SUM(CASE WHEN hour >= $2 THEN total_views ELSE 0 END) AS curr_views,
         SUM(CASE WHEN hour >= $3 AND hour < $2 THEN total_views ELSE 0 END) AS prev_views
       FROM hourly_aggregates
       WHERE profile_id = $1
         AND hour >= $3
         AND sentiment = 'all'
       GROUP BY source_type, sentiment`,
      [profileId, windowStart, prevWindowStart],
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
