import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Content } from './content.entity';
import { SelectedPost } from '../ingest/selected-post.entity';

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
  ) {}

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private profileFilter(profileId?: string | null): string {
    return profileId ? `AND profile_id = '${profileId}'` : '';
  }

  /**
   * Relevance filter: exclude posts the LLM scored 1-2 (not about the profile).
   * Posts without a score yet (NULL) pass through — they haven't been classified.
   */
  private readonly relevanceFilter = `AND (relevance_score IS NULL OR relevance_score >= 3)`;

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
    const pf = this.profileFilter(profileId);
    const sinceFilter = since ? `AND published_at >= '${new Date(since).toISOString()}'` : '';
    const rows = await this.postRepo.query(
      `SELECT
        COUNT(*) AS "totalPosts",
        COALESCE(SUM(view_count), 0) AS "totalViews",
        COALESCE(SUM(like_count), 0) AS "totalLikes",
        COALESCE(SUM(retweet_count), 0) AS "totalRetweets"
       FROM selected_posts
       WHERE canonical_id IS NULL ${pf} ${sinceFilter}`,
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
    const pf = this.profileFilter(profileId);
    const sinceFilter = since ? `AND published_at >= '${new Date(since).toISOString()}'` : '';
    const rows = await this.postRepo.query(
      `SELECT sentiment, COUNT(*) AS count
       FROM selected_posts
       WHERE sentiment IS NOT NULL AND canonical_id IS NULL ${pf} ${sinceFilter} ${this.relevanceFilter}
       GROUP BY sentiment ORDER BY count DESC`,
    );
    const data: Record<string, number> = {};
    for (const r of rows) {
      const emotion = this.sentimentToEmotion(r.sentiment);
      data[emotion] = (data[emotion] || 0) + parseInt(r.count);
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
    const qb = this.postRepo
      .createQueryBuilder('p')
      .where('p.canonical_id IS NULL')
      .andWhere('(p.relevance_score IS NULL OR p.relevance_score >= 3)')
      .orderBy('p.published_at', 'DESC')
      .take(limit)
      .skip(offset);

    if (profileId) qb.andWhere('p.profile_id = :profileId', { profileId });
    if (keyword) qb.andWhere('p.text ILIKE :keyword', { keyword: `%${keyword}%` });
    if (username) qb.andWhere('p.screen_name ILIKE :username', { username: `%${username}%` });
    if (since) qb.andWhere('p.published_at >= :since', { since: new Date(since) });
    if (source) qb.andWhere('p.source_type = :source', { source });
    if (emotion) {
      // Map emotion back to sentiment for filtering
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
    const pf = this.profileFilter(profileId);
    const rows = await this.postRepo.query(
      `SELECT screen_name AS username,
         source_type AS "sourceType",
         COUNT(*) AS "postCount",
         MAX(view_count) AS "maxViews",
         ROUND(AVG(view_count)) AS "avgViews",
         SUM(view_count) AS "totalViews",
         SUM(like_count) AS "totalLikes"
       FROM selected_posts
       WHERE screen_name IS NOT NULL AND canonical_id IS NULL ${pf} ${this.relevanceFilter}
       GROUP BY screen_name, source_type
       ORDER BY "totalViews" DESC
       LIMIT $1`,
      [limit],
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
   */
  async getInfluencerMap(limit = 20, profileId?: string | null) {
    const pf = this.profileFilter(profileId);

    // Get official channel handles for this profile to exclude them
    let officialHandlesFilter = '';
    if (profileId) {
      const [profileRow] = await this.postRepo.query(
        `SELECT official_channels FROM profiles WHERE id = $1`,
        [profileId],
      );
      const channels: Array<{ handle: string }> = profileRow?.official_channels || [];
      if (channels.length > 0) {
        const handles = channels
          .map((c) => c.handle?.replace(/^@/, '').toLowerCase())
          .filter(Boolean)
          .map((h) => `'${h}'`)
          .join(', ');
        if (handles) {
          officialHandlesFilter = `AND LOWER(screen_name) NOT IN (${handles})`;
        }
      }
    }
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
         COUNT(*) FILTER (WHERE sentiment IS NOT NULL)         AS "sentimentTotal"
       FROM selected_posts
       WHERE screen_name IS NOT NULL
         AND canonical_id IS NULL
         AND (selection_reason NOT LIKE 'official_page_%' OR selection_reason IS NULL)
         ${officialHandlesFilter}
         ${pf} ${this.relevanceFilter}
       GROUP BY screen_name, source_type
       HAVING SUM(view_count) > 0
       ORDER BY SUM(view_count) DESC
       LIMIT $1`,
      [limit],
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
        stance,
      };
    });
  }

  /**
   * Promise perception: reads from promise_* tagged posts (accumulated over time)
   * and returns sentiment breakdown as a perception score per promise.
   * Score 0-100: 0 = fully negative, 50 = neutral, 100 = fully positive.
   */
  async getPromisePerception(profileId: string) {
    const [profileRow] = await this.postRepo.query(
      `SELECT promises FROM profiles WHERE id = $1`,
      [profileId],
    );
    const promises: Array<{ text: string; addedAt: string }> = profileRow?.promises || [];
    if (promises.length === 0) return [];

    const results: Array<{
      text: string;
      score: number | null;
      postCount: number;
      breakdown: { positive: number; neutral: number; negative: number } | null;
    }> = [];

    for (let idx = 0; idx < promises.length; idx++) {
      const promise = promises[idx];
      if (!promise.text?.trim()) continue;

      const selectionReason = `promise_${idx}`;

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
           AND sentiment IS NOT NULL`,
        [profileId, selectionReason],
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
        text: promise.text,
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

  async getTopPosts(limit = 5, profileId?: string | null, since?: string) {
    const qb = this.postRepo
      .createQueryBuilder('p')
      .where('p.canonical_id IS NULL')
      .andWhere('(p.relevance_score IS NULL OR p.relevance_score >= 3)')
      .andWhere("(p.selection_reason IS NULL OR p.selection_reason NOT LIKE 'official_page_%')")
      .orderBy('p.view_count', 'DESC')
      .take(limit);
    if (profileId) qb.andWhere('p.profile_id = :profileId', { profileId });
    if (since) qb.andWhere('p.published_at >= :since', { since: new Date(since) });
    const posts = await qb.getMany();
    return posts.map((p) => this.mapPost(p));
  }

  /**
   * Top posts by reply count (controversial/most-discussed).
   */
  async getTopCommentedPosts(limit = 20, profileId?: string | null, since?: string) {
    const qb = this.postRepo
      .createQueryBuilder('p')
      .where('p.canonical_id IS NULL')
      .andWhere('(p.relevance_score IS NULL OR p.relevance_score >= 3)')
      .andWhere('p.reply_count > 0')
      .orderBy('p.reply_count', 'DESC')
      .take(limit);
    if (profileId) qb.andWhere('p.profile_id = :profileId', { profileId });
    if (since) qb.andWhere('p.published_at >= :since', { since: new Date(since) });
    const posts = await qb.getMany();
    return posts.map((p) => this.mapPost(p));
  }

  /**
   * Top posts by forward/retweet count (viral/most-shared).
   */
  async getTopForwardedPosts(limit = 20, profileId?: string | null, since?: string) {
    const qb = this.postRepo
      .createQueryBuilder('p')
      .where('p.canonical_id IS NULL')
      .andWhere('(p.relevance_score IS NULL OR p.relevance_score >= 3)')
      .andWhere('p.retweet_count > 0')
      .orderBy('p.retweet_count', 'DESC')
      .take(limit);
    if (profileId) qb.andWhere('p.profile_id = :profileId', { profileId });
    if (since) qb.andWhere('p.published_at >= :since', { since: new Date(since) });
    const posts = await qb.getMany();
    return posts.map((p) => this.mapPost(p));
  }

  async getHashtagStats(limit = 10, profileId?: string | null) {
    const pf = this.profileFilter(profileId);
    // Prefer AI-generated topics; fall back to raw hashtags
    const rows = await this.postRepo.query(
      `SELECT topic, COUNT(*) AS count FROM (
         SELECT unnest(ai_topics) AS topic
         FROM selected_posts
         WHERE ai_topics IS NOT NULL AND canonical_id IS NULL ${pf} ${this.relevanceFilter}
         UNION ALL
         SELECT unnest(hashtags) AS topic
         FROM selected_posts
         WHERE hashtags IS NOT NULL AND ai_topics IS NULL AND canonical_id IS NULL ${pf} ${this.relevanceFilter}
       ) t
       GROUP BY topic ORDER BY count DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r: any) => ({ label: r.topic, count: parseInt(r.count) }));
  }

  async getSourceStats(profileId?: string | null, since?: string) {
    const pf = this.profileFilter(profileId);
    const sinceFilter = since ? `AND published_at >= '${new Date(since).toISOString()}'` : '';
    const rows = await this.postRepo.query(
      `SELECT source_type AS source,
         COUNT(*) AS count,
         SUM(like_count) AS likes,
         SUM(retweet_count) AS retweets,
         SUM(view_count) AS views
       FROM selected_posts
       WHERE source_type IS NOT NULL AND canonical_id IS NULL ${pf} ${sinceFilter}
       GROUP BY source_type ORDER BY count DESC`,
    );
    return rows.map((r: any) => ({
      source: r.source,
      count: parseInt(r.count),
      likes: parseInt(r.likes) || 0,
      retweets: parseInt(r.retweets) || 0,
      views: parseInt(r.views) || 0,
    }));
  }

  async getUserDistribution(profileId?: string | null) {
    const pf = this.profileFilter(profileId);
    const rows = await this.postRepo.query(
      `SELECT
         COUNT(*) FILTER (WHERE view_count > 100000) AS influencers,
         COUNT(*) FILTER (WHERE view_count <= 100000 AND view_count > 1000) AS regular,
         COUNT(*) FILTER (WHERE view_count <= 1000) AS suspicious,
         COUNT(*) AS total
       FROM selected_posts
       WHERE canonical_id IS NULL ${pf}`,
    );
    const r = rows[0];
    const total = parseInt(r.total) || 1;
    return {
      influencers: parseInt(r.influencers) || 0,
      regular: parseInt(r.regular) || 0,
      suspicious: parseInt(r.suspicious) || 0,
      total,
      influencerPercent: Math.round((parseInt(r.influencers) / total) * 100),
      regularPercent: Math.round((parseInt(r.regular) / total) * 100),
      suspiciousPercent: Math.round((parseInt(r.suspicious) / total) * 100),
    };
  }

  async getOfficialPosts(
    limit = 50,
    offset = 0,
    source?: string,
    profileId?: string | null,
  ) {
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

  async getCategoryStats(profileId?: string | null) {    // selected_posts has `topic` instead of category — use it as the category
    const pf = this.profileFilter(profileId);
    const rows = await this.postRepo.query(
      `SELECT topic AS category, COUNT(*) AS count
       FROM selected_posts
       WHERE topic IS NOT NULL AND canonical_id IS NULL ${pf}
       GROUP BY topic ORDER BY count DESC`,
    );
    return {
      categories: rows.map((r: any) => ({ name: r.category, count: parseInt(r.count) })),
      subcategories: [],
    };
  }
}
