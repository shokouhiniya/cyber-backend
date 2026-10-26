/**
 * Hourly aggregates: one row per (profile, published hour, source, sentiment),
 * plus roll-up rows where source and/or sentiment is 'all'.
 *
 * Single sentiment source: rows are rebuilt from selected_posts AFTER batch LLM
 * sentiment, bucketed by the post's `published_at` hour (UTC), so the trend chart,
 * the sentiment shift and the AI summary all count the same posts with the same
 * sentiment. The post filter matches the one used by the AI summary prompts
 * (ai-content.service): non-duplicate, relevant, not official-page/display-feed posts.
 *
 * scripts/backfill-hourly-aggregates.js mirrors this logic in SQL — keep them in sync.
 */

/** WHERE clause (on selected_posts) for posts that count toward the aggregates. */
export const AGGREGATE_POST_FILTER = `published_at IS NOT NULL
  AND canonical_id IS NULL
  AND (relevance_score IS NULL OR relevance_score >= 3)
  AND (selection_reason IS NULL OR (selection_reason NOT LIKE 'official_page_%' AND selection_reason NOT LIKE 'display_%'))`;

/** SQL for the UTC hour bucket of a post (independent of the session TimeZone; Tehran is +03:30). */
export const HOUR_BUCKET_SQL = `(date_trunc('hour', published_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

export interface AggregatablePost {
  sourceType: string | null;
  sentiment: string | null;
  publishedAt: Date | string | null;
  viewCount?: number | string | null;
  likeCount?: number | string | null;
  replyCount?: number | string | null;
}

export interface HourlyAggregateRow {
  profileId: string;
  hour: Date;
  sourceType: string;
  sentiment: string;
  postCount: number;
  totalViews: number;
  totalLikes: number;
  totalReplies: number;
}

/** 'positive' / 'NEGATIVE' / null / anything else → 'Positive' | 'Negative' | 'Neutral'. */
export function normalizeSentiment(s: string | null | undefined): 'Positive' | 'Negative' | 'Neutral' {
  const v = (s || '').toLowerCase();
  if (v === 'positive') return 'Positive';
  if (v === 'negative') return 'Negative';
  return 'Neutral';
}

/** Start of the UTC hour containing `d`. */
export function hourBucket(d: Date | string): Date {
  const t = new Date(d).getTime();
  return new Date(Math.floor(t / 3_600_000) * 3_600_000);
}

/**
 * Groups posts into hourly aggregate rows. Every post is counted in four rows:
 * (source, sentiment), (source, 'all'), ('all', sentiment) and ('all', 'all').
 * Posts without a valid published_at are skipped.
 */
export function buildHourlyAggregates(profileId: string, posts: AggregatablePost[]): HourlyAggregateRow[] {
  const rows = new Map<string, HourlyAggregateRow>();

  for (const p of posts) {
    if (!p.publishedAt) continue;
    const hour = hourBucket(p.publishedAt);
    if (Number.isNaN(hour.getTime())) continue;

    const source = p.sourceType || 'unknown';
    const sentiment = normalizeSentiment(p.sentiment);
    const views = Number(p.viewCount) || 0;
    const likes = Number(p.likeCount) || 0;
    const replies = Number(p.replyCount) || 0;

    for (const [src, sent] of [[source, sentiment], [source, 'all'], ['all', sentiment], ['all', 'all']]) {
      const key = `${hour.toISOString()}|${src}|${sent}`;
      let row = rows.get(key);
      if (!row) {
        row = { profileId, hour, sourceType: src, sentiment: sent, postCount: 0, totalViews: 0, totalLikes: 0, totalReplies: 0 };
        rows.set(key, row);
      }
      row.postCount++;
      row.totalViews += views;
      row.totalLikes += likes;
      row.totalReplies += replies;
    }
  }

  return Array.from(rows.values()).sort((a, b) => a.hour.getTime() - b.hour.getTime());
}
