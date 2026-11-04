import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Content } from './content.entity';
import {
  BLOCKED_ACCOUNTS_KEY, Bind, blockedSql, parseBlockedAccounts, qbBinder, rawBinder, relevanceSql,
} from './post-quality';
import { SelectedPost } from '../ingest/selected-post.entity';
import { AccountRow, summariseBotAnalysis } from './bot-analysis';
import { DayRow, WEEKLY_TIMEZONE, bucketWeekly, clampWeeks, weekWindows } from './weekly-buckets';
import { ProfilePromise, isPromiseExpired, normalisePromiseDate, promiseWindowSql } from '../profile/promises';
import { IngestRun } from '../ingest/ingest-run.entity';
import { officialAccountStates, officialHandleKey } from '../profile/official-channels';

/**
 * Handles / display names that look like news outlets (Postgres regex, case-
 * insensitive). Keeps outlets out of the report's supporters / critics lists.
 */
/** Per-account aggregate: true when the account's posts are YouTube videos (the 'aparat' source mixes both). */
const YOUTUBE_URL_SQL = `BOOL_OR(post_url ~* '(youtube\\.com|youtu\\.be)/')`;

const NEWS_ACCOUNT_PATTERN =
  '(news|press|agency|akhbar|khabar|_tv|tv$|خبر|اخبار|روزنامه|شبکه|رسانه|تلویزیون|سیما|پایگاه)';

/**
 * All read methods query `selected_posts` (the curated ingest pipeline output).
 * The old `content` table is kept for import/legacy but is no longer the
 * primary data source for dashboard queries.
 *
 * All methods accept an optional `profileId` and scope the query when present.
 */
@Injectable()
export class ContentService {
  constructor(
    @InjectRepository(Content)
    private readonly legacyRepo: Repository<Content>,
    @InjectRepository(SelectedPost)
    private readonly postRepo: Repository<SelectedPost>,
    @InjectRepository(IngestRun)
    private readonly runRepo: Repository<IngestRun>,
  ) {}

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Optional profile / date scope as bound parameters. Values are appended to
   * `params`, so placeholders continue after any earlier ones (e.g. LIMIT $1).
   */
  private scope(params: unknown[], profileId?: string | null, since?: string): string {
    let sql = '';
    if (profileId) {
      params.push(profileId);
      sql += ` AND profile_id = $${params.length}`;
    }
    const sinceDate = this.sinceDate(since);
    if (sinceDate) {
      params.push(sinceDate);
      sql += ` AND published_at >= $${params.length}`;
    }
    return sql;
  }

  /** Parse an optional `since` filter — an unparseable date is a client error, not a 500. */
  private sinceDate(since?: string): Date | undefined {
    if (!since) return undefined;
    const d = new Date(since);
    if (isNaN(d.getTime())) throw new BadRequestException('پارامتر since تاریخ معتبری نیست');
    return d;
  }

  /** Clamp a caller-supplied page size; NaN / non-positive values fall back to the default. */
  private clampLimit(limit: number, fallback: number, max = 200): number {
    return Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), max) : fallback;
  }

  private clampOffset(offset: number): number {
    return Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  }

  private blockedCache: { at: number; handles: string[] } | null = null;

  /** Admin blocklist from global_context, cached for a minute. */
  private async blockedAccounts(): Promise<string[]> {
    if (this.blockedCache && Date.now() - this.blockedCache.at < 60_000) return this.blockedCache.handles;
    const [row] = await this.postRepo.query(`SELECT value FROM global_context WHERE key = $1`, [BLOCKED_ACCOUNTS_KEY]);
    const handles = parseBlockedAccounts(row?.value);
    this.blockedCache = { at: Date.now(), handles };
    return handles;
  }

  /**
   * Data-quality filter (relevance + account blocklist) shared by every
   * user-facing list / stat — see post-quality.ts. Returns an `AND …` fragment.
   */
  private async quality(bind: Bind, alias = 'selected_posts'): Promise<string> {
    const blocked = await this.blockedAccounts();
    return ` AND ${relevanceSql(alias)} AND ${blockedSql(alias, blocked, bind)}`;
  }

  /** Same filter applied to a query builder over selected_posts. */
  private async applyQuality(qb: SelectQueryBuilder<SelectedPost>): Promise<void> {
    const sql = await this.quality(qbBinder(qb), qb.alias);
    qb.andWhere(sql.replace(/^ AND /, ''));
  }

  /** Map selected_post to the shape the frontend expects (mirrors Content entity) */
  private mapPost(p: SelectedPost): any {
    return {
      id: p.id,
      text: p.text,
      screenName: p.screenName,
      userId: null,
      userFollowers: p.viewCount > 100000 ? 100000 : 0, // rough proxy
      viewCount: p.viewCount,
      likeCount: p.likeCount,
      retweetCount: p.retweetCount,
      replyCount: p.replyCount,
      quoteCount: 0,
      bookmarkCount: 0,
      emotion: this.sentimentToEmotion(p.sentiment),
      sentiment: p.sentiment?.toLowerCase() || 'neutral',
      sourceType: p.sourceType,
      hashtags: p.hashtags || [],
      publishedAt: p.publishedAt,
      mediaUrl: p.mediaUrl,
      hasMedia: !!(p.hasMedia || p.mediaUrl),
      postType: null,
      profileImageUrl: p.profileImageUrl,
      postUrl: p.postUrl,
      selectionReason: p.selectionReason,
    };
  }

  private sentimentToEmotion(sentiment: string | null): string {
    if (!sentiment) return 'neutral';
    const s = sentiment.toLowerCase();
    if (s === 'positive') return 'hope';
    if (s === 'negative') return 'worry';
    return 'neutral';
  }

  // ── Stats ────────────────────────────────────────────────────────────────────

  async getStats(profileId?: string | null, since?: string) {
    const params: unknown[] = [];
    const scope = this.scope(params, profileId, since);
    const quality = await this.quality(rawBinder(params));
    const rows = await this.postRepo.query(
      `SELECT
        COUNT(*) AS "totalPosts",
        COALESCE(SUM(view_count), 0) AS "totalViews",
        COALESCE(SUM(like_count), 0) AS "totalLikes",
        COALESCE(SUM(retweet_count), 0) AS "totalRetweets"
       FROM selected_posts
       WHERE canonical_id IS NULL ${scope} ${quality}`,
      params,
    );
    const r = rows[0];
    return {
      totalPosts: parseInt(r.totalPosts) || 0,
      totalViews: parseInt(r.totalViews) || 0,
      totalLikes: parseInt(r.totalLikes) || 0,
      totalRetweets: parseInt(r.totalRetweets) || 0,
    };
  }

  async getEmotions(profileId?: string | null, since?: string): Promise<Record<string, number>> {
    const params: unknown[] = [];
    const scope = this.scope(params, profileId, since);
    const quality = await this.quality(rawBinder(params));
    // Use outlook field (from batch_sentiment) if available, fall back to sentiment mapping
    const rows = await this.postRepo.query(
      `SELECT
         COALESCE(LOWER(outlook), CASE
           WHEN LOWER(sentiment) = 'positive' THEN 'hope'
           WHEN LOWER(sentiment) = 'negative' THEN 'worry'
           ELSE 'neutral'
         END) AS emotion,
         COUNT(*) AS count
       FROM selected_posts
       WHERE sentiment IS NOT NULL AND canonical_id IS NULL ${scope} ${quality}
       GROUP BY emotion ORDER BY count DESC`,
      params,
    );
    const data: Record<string, number> = {};
    for (const r of rows) {
      data[r.emotion] = (data[r.emotion] || 0) + parseInt(r.count);
    }
    return data;
  }

  async getPosts(
    limit = 20,
    offset = 0,
    emotion?: string,
    keyword?: string,
    username?: string,
    since?: string,
    profileId?: string | null,
    source?: string,
  ) {
    limit = this.clampLimit(limit, 20);
    offset = this.clampOffset(offset);
    const qb = this.postRepo
      .createQueryBuilder('p')
      .where('p.canonical_id IS NULL')
      .orderBy('p.published_at', 'DESC')
      .take(limit)
      .skip(offset);
    await this.applyQuality(qb);

    if (profileId) qb.andWhere('p.profile_id = :profileId', { profileId });
    if (keyword) qb.andWhere('p.text ILIKE :keyword', { keyword: `%${keyword}%` });
    if (username) qb.andWhere('p.screen_name ILIKE :username', { username: `%${username}%` });
    if (since) qb.andWhere('p.published_at >= :since', { since: this.sinceDate(since) });
    if (source) qb.andWhere('p.source_type = :source', { source });
    if (emotion) {
      const sentimentMap: Record<string, string> = { hope: 'Positive', worry: 'Negative', neutral: 'Neutral' };
      const sent = sentimentMap[emotion];
      if (sent) qb.andWhere('p.sentiment = :sent', { sent });
    }

    const total = await qb.getCount();
    const posts = await qb.getMany();

    return {
      data: posts.map((p) => this.mapPost(p)),
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    };
  }

  async getInfluencers(limit = 10, profileId?: string | null) {
    limit = this.clampLimit(limit, 10);
    const params: unknown[] = [limit];
    const scope = this.scope(params, profileId);
    const quality = await this.quality(rawBinder(params));
    const rows = await this.postRepo.query(
      `SELECT screen_name AS username,
         source_type AS "sourceType",
         COUNT(*) AS "postCount",
         MAX(view_count) AS "maxViews",
         ROUND(AVG(view_count)) AS "avgViews",
         SUM(view_count) AS "totalViews",
         SUM(like_count) AS "totalLikes"
       FROM selected_posts
       WHERE screen_name IS NOT NULL AND canonical_id IS NULL ${scope} ${quality}
       GROUP BY screen_name, source_type
       ORDER BY "totalViews" DESC
       LIMIT $1`,
      params,
    );
    return rows.map((r: any) => ({
      username: r.username,
      sourceType: r.sourceType,
      followers: 0,
      postCount: parseInt(r.postCount),
      avgViews: parseInt(r.avgViews) || 0,
      totalViews: parseInt(r.totalViews) || 0,
      totalLikes: parseInt(r.totalLikes) || 0,
    }));
  }

  /**
   * Influencer map: top accounts ranked by reach, with sentiment-based stance.
   * Stance: ≥60% positive → موافق, ≥60% negative → مخالف, else خنثی
   * Excludes:
   *   - official page posts (selection_reason LIKE 'official_page_%')
   *   - accounts whose handle matches a profile's official channel
   *   - irrelevant / blocklisted / proxy accounts (shared quality filter)
   * `since` limits it to posts published in the report period.
   */
  async getInfluencerMap(limit = 20, profileId?: string | null, since?: string) {
    limit = this.clampLimit(limit, 20);
    const params: unknown[] = [limit];
    const scope = this.scope(params, profileId, since);
    const quality = await this.quality(rawBinder(params));

    // Get official channel handles for this profile to exclude them
    const officialHandlesFilter = await this.officialHandlesFilter(params, profileId);
    const rows = await this.postRepo.query(
      `SELECT
         screen_name AS username,
         source_type AS "sourceType",
         COUNT(*) AS "postCount",
         SUM(view_count) AS "totalViews",
         SUM(like_count) AS "totalLikes",
         SUM(retweet_count) AS "totalRetweets",
         COUNT(*) FILTER (WHERE LOWER(sentiment) = 'positive') AS "posCount",
         COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS "negCount",
         COUNT(*) FILTER (WHERE LOWER(sentiment) = 'neutral')  AS "neuCount",
         COUNT(*) FILTER (WHERE sentiment IS NOT NULL)         AS "sentimentTotal",
         ${YOUTUBE_URL_SQL}                                    AS "isYoutube"
       FROM selected_posts
       WHERE screen_name IS NOT NULL
         AND canonical_id IS NULL
         AND (selection_reason NOT LIKE 'official_page_%' OR selection_reason IS NULL)
         ${officialHandlesFilter}
         ${scope} ${quality}
       GROUP BY screen_name, source_type
       HAVING SUM(view_count) > 0
       ORDER BY SUM(view_count) DESC
       LIMIT $1`,
      params,
    );

    return rows.map((r: any) => {
      const pos = parseInt(r.posCount) || 0;
      const neg = parseInt(r.negCount) || 0;
      const sentTotal = parseInt(r.sentimentTotal) || 0;

      let stance: 'supporter' | 'critic' | 'neutral' = 'neutral';
      if (sentTotal > 0) {
        const posRatio = pos / sentTotal;
        const negRatio = neg / sentTotal;
        if (posRatio >= 0.6) stance = 'supporter';
        else if (negRatio >= 0.6) stance = 'critic';
      }

      return {
        username: r.username,
        sourceType: r.sourceType,
        postCount: parseInt(r.postCount),
        totalViews: parseInt(r.totalViews) || 0,
        totalLikes: parseInt(r.totalLikes) || 0,
        totalRetweets: parseInt(r.totalRetweets) || 0,
        posCount: pos,
        negCount: neg,
        neuCount: parseInt(r.neuCount) || 0,
        sentimentTotal: sentTotal,
        // The 'aparat' source also carries YouTube videos — tell the UI which site to link
        platform: r.isYoutube ? 'youtube' : r.sourceType,
        stance,
      };
    });
  }

  /**
   * `AND LOWER(screen_name) <> ALL(...)` excluding the profile's own official
   * channel handles, or '' when it has none. Appends to `params`.
   */
  private async officialHandlesFilter(params: unknown[], profileId?: string | null): Promise<string> {
    if (!profileId) return '';
    const [profileRow]: Array<{ official_channels: Array<{ handle: string }> | null }> =
      await this.postRepo.query(`SELECT official_channels FROM profiles WHERE id = $1`, [profileId]);
    const channels = profileRow?.official_channels || [];
    const handles = channels
      .map((c) => officialHandleKey(c.handle))
      .filter(Boolean);
    if (handles.length === 0) return '';
    params.push(handles);
    return `AND LOWER(screen_name) <> ALL($${params.length})`;
  }

  /**
   * Top supporters and critics for the report: authors ranked by their stance
   * toward the monitored profile over the period (post `sentiment` is the tone
   * toward the profile, see the batch_sentiment prompt), not by reach.
   *
   * Per author: net = (positive - negative) / posts with a sentiment.
   *   supporter: net >= 0.5, ranked by positive posts, then views
   *   critic:    net <= -0.5, ranked by negative posts, then views
   * Excluded, so the lists hold opinion-holders rather than outlets:
   *   - news / newspaper / media sources, and accounts whose handle or display
   *     name looks like a news outlet (NEWS_ACCOUNT_PATTERN)
   *   - official page posts and the profile's own official channels
   *   - the shared quality filter (irrelevant / blocklisted accounts)
   */
  async getStanceLeaders(limit = 6, profileId?: string | null, since?: string) {
    limit = this.clampLimit(limit, 6, 50);
    const params: unknown[] = [limit];
    const scope = this.scope(params, profileId, since);
    const quality = await this.quality(rawBinder(params));
    const officialHandlesFilter = await this.officialHandlesFilter(params, profileId);
    params.push(NEWS_ACCOUNT_PATTERN);
    const newsPattern = `$${params.length}`;

    // pg returns COUNT / SUM as strings
    type StanceRow = {
      username: string;
      displayName: string | null;
      sourceType: string;
      postCount: string;
      totalViews: string;
      pos: string;
      neg: string;
      rated: string;
      isYoutube: boolean | null;
      stance: 'supporter' | 'critic';
    };
    const rows: StanceRow[] = await this.postRepo.query(
      `WITH authors AS (
         SELECT
           screen_name AS username,
           source_type AS "sourceType",
           MAX(display_name) AS "displayName",
           COUNT(*) AS "postCount",
           COALESCE(SUM(view_count), 0) AS "totalViews",
           COUNT(*) FILTER (WHERE LOWER(sentiment) = 'positive') AS pos,
           COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS neg,
           COUNT(*) FILTER (WHERE sentiment IS NOT NULL) AS rated,
           ${YOUTUBE_URL_SQL} AS "isYoutube"
         FROM selected_posts
         WHERE screen_name IS NOT NULL
           AND canonical_id IS NULL
           AND source_type NOT IN ('news', 'newspaper', 'media')
           AND (selection_reason NOT LIKE 'official_page_%' OR selection_reason IS NULL)
           AND screen_name !~* ${newsPattern}
           AND COALESCE(display_name, '') !~* ${newsPattern}
           ${officialHandlesFilter}
           ${scope} ${quality}
         GROUP BY screen_name, source_type
       ), ranked AS (
         SELECT *,
           CASE WHEN rated > 0 AND (pos - neg)::float / rated >= 0.5 THEN 'supporter'
                WHEN rated > 0 AND (pos - neg)::float / rated <= -0.5 THEN 'critic'
           END AS stance
         FROM authors
       ), numbered AS (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY stance
           ORDER BY CASE WHEN stance = 'supporter' THEN pos ELSE neg END DESC, "totalViews" DESC
         ) AS rn
         FROM ranked WHERE stance IS NOT NULL
       )
       SELECT * FROM numbered WHERE rn <= $1 ORDER BY stance, rn`,
      params,
    );

    const toRow = (r: StanceRow) => {
      const pos = parseInt(r.pos) || 0;
      const neg = parseInt(r.neg) || 0;
      const rated = parseInt(r.rated) || 0;
      return {
        username: r.username,
        displayName: r.displayName || null,
        sourceType: r.sourceType,
        postCount: parseInt(r.postCount) || 0,
        totalViews: parseInt(r.totalViews) || 0,
        posCount: pos,
        negCount: neg,
        sentimentTotal: rated,
        platform: r.isYoutube ? 'youtube' : r.sourceType,
        stanceScore: rated > 0 ? Math.round(((pos - neg) / rated) * 100) : 0,
        stance: r.stance,
      };
    };
    return {
      supporters: rows.filter((r) => r.stance === 'supporter').map(toRow),
      critics: rows.filter((r) => r.stance === 'critic').map(toRow),
    };
  }

  /**
   * Promise perception: reads from promise_* tagged posts (accumulated over time)
   * and returns sentiment breakdown as a perception score per promise.
   * Score 0-100: 0 = fully negative, 50 = neutral, 100 = fully positive.
   * Only posts published inside the promise's validity window (validFrom …
   * validUntil, Tehran days) count, intersected with `since` (the report
   * period); promises without a window count every collected post. Promise posts
   * are fetched by the promise's own keywords, so only the account blocklist
   * applies here (not the profile-keyword relevance check).
   */
  async getPromisePerception(profileId: string, since?: string) {
    const sinceDate = this.sinceDate(since);
    const blocked = await this.blockedAccounts();
    const [profileRow] = await this.postRepo.query(
      `SELECT promises FROM profiles WHERE id = $1`,
      [profileId],
    );
    const promises: ProfilePromise[] = profileRow?.promises || [];
    if (promises.length === 0) return [];

    const results: Array<{
      index: number;
      text: string;
      position: string | null;
      validFrom: string | null;
      validUntil: string | null;
      expired: boolean;
      score: number | null;
      postCount: number;
      breakdown: { positive: number; neutral: number; negative: number } | null;
    }> = [];

    for (let idx = 0; idx < promises.length; idx++) {
      const promise = promises[idx];
      if (!promise.text?.trim()) continue;

      const selectionReason = `promise_${idx}`;
      const params: unknown[] = [profileId, selectionReason];
      const bind = rawBinder(params);
      // Only posts inside the promise's validity window, intersected with `since`
      const sinceSql = (sinceDate ? `AND published_at >= ${bind(sinceDate)}` : '') + promiseWindowSql(promise, bind);
      const blockedFilter = blockedSql('selected_posts', blocked, bind);

      const rows = await this.postRepo.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE LOWER(sentiment) = 'positive') AS pos,
           COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS neg,
           COUNT(*) FILTER (WHERE LOWER(sentiment) = 'neutral')  AS neu
         FROM selected_posts
         WHERE profile_id = $1
           AND selection_reason = $2
           AND canonical_id IS NULL
           AND sentiment IS NOT NULL
           ${sinceSql}
           AND ${blockedFilter}`,
        params,
      );

      const r = rows[0];
      const total = parseInt(r.total) || 0;
      const pos = parseInt(r.pos) || 0;
      const neg = parseInt(r.neg) || 0;
      const neu = parseInt(r.neu) || 0;

      // Score: positive=100, neutral=50, negative=0 (weighted average)
      const score = total > 0
        ? Math.round(((pos * 100) + (neu * 50) + (neg * 0)) / total)
        : null;

      results.push({
        index: idx,
        text: promise.text,
        position: promise.position || null,
        validFrom: normalisePromiseDate(promise.validFrom) ?? null,
        validUntil: normalisePromiseDate(promise.validUntil) ?? null,
        expired: isPromiseExpired(promise),
        score,
        postCount: total,
        breakdown: total > 0 ? {
          positive: Math.round((pos / total) * 100),
          neutral: Math.round((neu / total) * 100),
          negative: Math.round((neg / total) * 100),
        } : null,
      });
    }

    return results;
  }

  async getTopPosts(limit = 5, profileId?: string | null, since?: string, source?: string) {
    limit = this.clampLimit(limit, 5);
    const qb = this.postRepo
      .createQueryBuilder('p')
      .where('p.canonical_id IS NULL')
      .andWhere("(p.selection_reason IS NULL OR p.selection_reason NOT LIKE 'official_page_%')")
      .orderBy('p.view_count', 'DESC')
      .take(limit);
    await this.applyQuality(qb);
    if (profileId) qb.andWhere('p.profile_id = :profileId', { profileId });
    if (since) qb.andWhere('p.published_at >= :since', { since: this.sinceDate(since) });
    if (source) qb.andWhere('LOWER(p.source_type) = LOWER(:source)', { source });
    const posts = await qb.getMany();
    return posts.map((p) => this.mapPost(p));
  }

  /**
   * Top posts by reply count (controversial/most-discussed).
   */
  async getTopCommentedPosts(limit = 20, profileId?: string | null, since?: string, source?: string) {
    limit = this.clampLimit(limit, 20);
    const qb = this.postRepo
      .createQueryBuilder('p')
      .where('p.canonical_id IS NULL')
      .andWhere('p.reply_count > 0')
      .orderBy('p.reply_count', 'DESC')
      .take(limit);
    await this.applyQuality(qb);
    if (profileId) qb.andWhere('p.profile_id = :profileId', { profileId });
    if (since) qb.andWhere('p.published_at >= :since', { since: this.sinceDate(since) });
    if (source) qb.andWhere('LOWER(p.source_type) = LOWER(:source)', { source });
    const posts = await qb.getMany();
    return posts.map((p) => this.mapPost(p));
  }

  /**
   * Top posts by forward/retweet count (viral/most-shared).
   */
  async getTopForwardedPosts(limit = 20, profileId?: string | null, since?: string, source?: string) {
    limit = this.clampLimit(limit, 20);
    const qb = this.postRepo
      .createQueryBuilder('p')
      .where('p.canonical_id IS NULL')
      .andWhere('p.retweet_count > 0')
      .orderBy('p.retweet_count', 'DESC')
      .take(limit);
    await this.applyQuality(qb);
    if (profileId) qb.andWhere('p.profile_id = :profileId', { profileId });
    if (since) qb.andWhere('p.published_at >= :since', { since: this.sinceDate(since) });
    if (source) qb.andWhere('LOWER(p.source_type) = LOWER(:source)', { source });
    const posts = await qb.getMany();
    return posts.map((p) => this.mapPost(p));
  }

  async getHashtagStats(limit = 10, profileId?: string | null, since?: string) {
    limit = this.clampLimit(limit, 10);
    const params: unknown[] = [limit];
    const scope = this.scope(params, profileId, since);
    const quality = await this.quality(rawBinder(params));
    // Prefer AI-generated topics; fall back to raw hashtags
    const rows = await this.postRepo.query(
      `SELECT topic, COUNT(*) AS count FROM (
         SELECT unnest(ai_topics) AS topic
         FROM selected_posts
         WHERE ai_topics IS NOT NULL AND canonical_id IS NULL ${scope} ${quality}
         UNION ALL
         SELECT unnest(hashtags) AS topic
         FROM selected_posts
         WHERE hashtags IS NOT NULL AND ai_topics IS NULL AND canonical_id IS NULL ${scope} ${quality}
       ) t
       GROUP BY topic ORDER BY count DESC LIMIT $1`,
      params,
    );
    return rows.map((r: any) => ({ label: r.topic, count: parseInt(r.count) }));
  }

  async getSourceStats(profileId?: string | null, since?: string) {
    const params: unknown[] = [];
    const scope = this.scope(params, profileId, since);
    const quality = await this.quality(rawBinder(params));
    const rows = await this.postRepo.query(
      `SELECT source_type AS source,
         COUNT(*) AS count,
         SUM(like_count) AS likes,
         SUM(retweet_count) AS retweets,
         SUM(view_count) AS views
       FROM selected_posts
       WHERE source_type IS NOT NULL AND canonical_id IS NULL ${scope} ${quality}
       GROUP BY source_type ORDER BY count DESC`,
      params,
    );
    return rows.map((r: any) => ({
      source: r.source,
      count: parseInt(r.count),
      likes: parseInt(r.likes) || 0,
      retweets: parseInt(r.retweets) || 0,
      views: parseInt(r.views) || 0,
    }));
  }

  /**
   * Account-level bot analysis: posts are grouped by account (screen_name +
   * source_type) and each account is scored from several signals — LLM
   * bot_probability, text shared with other accounts, burst timing, posting
   * rate, handle pattern, profile completeness, followers. See bot-analysis.ts.
   *
   * Near-duplicate rows (canonical_id set) are included here on purpose: an
   * account that only re-posts other accounts' text is exactly what this
   * widget is for. Posts without a screen_name can't be attributed and are
   * only counted.
   */
  async getBotAnalysis(profileId?: string | null, since?: string) {
    const params: unknown[] = [];
    const scope = this.scope(params, profileId, since);
    const quality = await this.quality(rawBinder(params));
    // The profile's own official accounts are never bot candidates
    const sharedParamCount = params.length;
    const officialHandles = await this.officialHandlesFilter(params, profileId);
    const rows = await this.postRepo.query(
      `WITH base AS (
         SELECT id, canonical_id, screen_name, display_name, profile_image_url, published_at,
                bot_probability, author_followers,
                LOWER(screen_name) AS h, LOWER(source_type) AS platform,
                LOWER(screen_name) || '|' || LOWER(source_type) AS acct,
                -- identical text after dropping links, spaces and punctuation (short texts ignored)
                CASE WHEN length(COALESCE(text, '')) >= 30
                     THEN md5(regexp_replace(regexp_replace(LOWER(text), 'https?://\\S+', '', 'g'), '[^[:alnum:]]+', '', 'g'))
                END AS text_hash
         FROM selected_posts
         WHERE screen_name IS NOT NULL AND btrim(screen_name) <> ''
           AND (selection_reason IS NULL OR selection_reason NOT LIKE 'official_page_%')
           ${officialHandles} ${scope} ${quality}
       ),
       -- Text groups shared by several accounts; the earliest poster is the
       -- origin and is not counted as a copier.
       near AS (
         SELECT COALESCE(canonical_id, id) AS k, COUNT(DISTINCT acct) AS n,
                (array_agg(acct ORDER BY published_at NULLS LAST))[1] AS origin
         FROM base GROUP BY 1
       ),
       same AS (
         SELECT text_hash AS k, COUNT(DISTINCT acct) AS n,
                (array_agg(acct ORDER BY published_at NULLS LAST))[1] AS origin
         FROM base WHERE text_hash IS NOT NULL GROUP BY 1
       ),
       timed AS (
         SELECT id, published_at - LAG(published_at) OVER (PARTITION BY acct ORDER BY published_at) AS gap FROM base
       )
       SELECT
         MIN(b.screen_name) AS handle,
         MAX(b.display_name) AS "displayName",
         b.platform,
         COUNT(*) AS posts,
         COUNT(b.bot_probability) AS "scoredPosts",
         AVG(b.bot_probability) AS "avgProbability",
         COUNT(*) FILTER (WHERE (near.n > 1 AND near.origin <> b.acct) OR (same.n > 1 AND same.origin <> b.acct)) AS "dupPosts",
         COUNT(*) FILTER (WHERE t.gap IS NOT NULL AND t.gap <= interval '2 minutes') AS "burstPosts",
         COUNT(DISTINCT (b.published_at AT TIME ZONE 'Asia/Tehran')::date) AS "activeDays",
         BOOL_OR(COALESCE(b.profile_image_url, '') <> '') AS "hasAvatar",
         MAX(b.author_followers) AS followers
       FROM base b
       JOIN near ON near.k = COALESCE(b.canonical_id, b.id)
       LEFT JOIN same ON same.k = b.text_hash
       JOIN timed t ON t.id = b.id
       GROUP BY b.h, b.platform`,
      params,
    );
    const [unattributed] = await this.postRepo.query(
      `SELECT COUNT(*) AS n FROM selected_posts
       WHERE canonical_id IS NULL AND (screen_name IS NULL OR btrim(screen_name) = '') ${scope} ${quality}`,
      params.slice(0, sharedParamCount),
    );
    const summary = summariseBotAnalysis(
      rows.map((r: any): AccountRow => ({
        handle: r.handle,
        displayName: r.displayName,
        platform: r.platform,
        posts: parseInt(r.posts) || 0,
        scoredPosts: parseInt(r.scoredPosts) || 0,
        avgProbability: r.avgProbability === null ? null : Number(r.avgProbability),
        dupPosts: parseInt(r.dupPosts) || 0,
        burstPosts: parseInt(r.burstPosts) || 0,
        activeDays: parseInt(r.activeDays) || 0,
        hasAvatar: r.hasAvatar === null || r.hasAvatar === undefined ? null : !!r.hasAvatar,
        followers: r.followers === null || r.followers === undefined ? null : Number(r.followers),
      })),
    );
    return { ...summary, unattributedPosts: parseInt(unattributed?.n) || 0 };
  }

  async getOfficialPosts(
    limit = 50,
    offset = 0,
    source?: string,
    profileId?: string | null,
  ) {
    limit = this.clampLimit(limit, 50);
    offset = this.clampOffset(offset);
    const qb = this.postRepo
      .createQueryBuilder('p')
      .where("p.selection_reason LIKE 'official_page_%'")
      .andWhere('p.canonical_id IS NULL')
      .orderBy('p.published_at', 'DESC')
      .take(limit)
      .skip(offset);

    if (profileId) qb.andWhere('p.profile_id = :profileId', { profileId });
    if (source) qb.andWhere('p.source_type = :source', { source });

    const total = await qb.getCount();
    const posts = await qb.getMany();

    return {
      data: posts.map((p) => this.mapPost(p)),
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    };
  }

  /**
   * Weekly totals of the profile's official-page posts (Saturday–Friday,
   * Tehran), oldest first, with zero rows for weeks without posts. Unlike the
   * paged list this covers every stored post in the window, not a sample.
   * Same scope as getOfficialPosts: the profile's own channels, deduplicated.
   */
  async getOfficialWeekly(profileId?: string | null, weeks?: unknown, now = new Date()) {
    const n = clampWeeks(weeks);
    const { firstDay } = weekWindows(n, now);
    const params: unknown[] = [WEEKLY_TIMEZONE, firstDay];
    const scope = this.scope(params, profileId);
    const rows: DayRow[] = await this.postRepo.query(
      `SELECT to_char((published_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
         COUNT(*) AS posts,
         COALESCE(SUM(view_count), 0) AS views,
         COALESCE(SUM(like_count), 0) AS likes,
         COALESCE(SUM(retweet_count), 0) AS shares
       FROM selected_posts
       WHERE selection_reason LIKE 'official_page_%' AND canonical_id IS NULL
         AND published_at >= ($2::date)::timestamp AT TIME ZONE $1 ${scope}
       GROUP BY 1`,
      params,
    );
    return bucketWeekly(rows, n, now);
  }

  /**
   * Latest post per official channel (from official_page_<source>_<handle>
   * posts), so the UI can tell active channels (posted recently) from dormant ones.
   */
  async getOfficialStatus(profileId?: string | null) {
    const params: unknown[] = [];
    const scope = this.scope(params, profileId);
    const rows = await this.postRepo.query(
      `SELECT
         substring(selection_reason from '^official_page_([^_]+)_') AS source,
         substring(selection_reason from '^official_page_[^_]+_(.+)$') AS handle,
         MAX(published_at) AS "lastPublishedAt",
         COUNT(*) AS "postCount"
       FROM selected_posts
       WHERE selection_reason LIKE 'official_page_%' AND canonical_id IS NULL ${scope}
       GROUP BY 1, 2
       ORDER BY "lastPublishedAt" DESC NULLS LAST`,
      params,
    );
    return rows
      .filter((r: any) => r.source && r.handle)
      .map((r: any) => ({
        source: r.source,
        handle: r.handle,
        lastPublishedAt: r.lastPublishedAt,
        postCount: parseInt(r.postCount) || 0,
      }));
  }

  /**
   * Every configured official account with its collection status
   * («در حال جمع‌آوری» / «بدون داده» / «غیرفعال») and the reason, for «صفحات رسمی».
   */
  async getOfficialAccounts(profileId?: string | null) {
    if (!profileId) return [];
    const [profile] = await this.postRepo.query(`SELECT official_channels FROM profiles WHERE id = $1`, [profileId]);
    const rows = await this.getOfficialStatus(profileId);
    return officialAccountStates(profile?.official_channels ?? [], rows);
  }

  async getCategoryStats(profileId?: string | null) {
    // selected_posts has no category column — use the LLM topics (ai_topics) instead
    const params: unknown[] = [];
    const scope = this.scope(params, profileId);
    const quality = await this.quality(rawBinder(params));
    const rows = await this.postRepo.query(
      `SELECT category, COUNT(*) AS count FROM (
         SELECT unnest(ai_topics) AS category
         FROM selected_posts
         WHERE ai_topics IS NOT NULL AND canonical_id IS NULL ${scope} ${quality}
       ) t
       GROUP BY category ORDER BY count DESC`,
      params,
    );
    return {
      categories: rows.map((r: any) => ({ name: r.category, count: parseInt(r.count) })),
      subcategories: [],
    };
  }
}
