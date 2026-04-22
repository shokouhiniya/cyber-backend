import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Content } from './content.entity';

@Injectable()
export class ContentService {
  constructor(
    @InjectRepository(Content)
    private readonly repo: Repository<Content>,
  ) {}

  async getStats() {
    const result = await this.repo
      .createQueryBuilder('c')
      .select('COUNT(*)', 'totalPosts')
      .addSelect('COALESCE(SUM(c.view_count), 0)', 'totalViews')
      .addSelect('COALESCE(SUM(c.like_count), 0)', 'totalLikes')
      .addSelect('COALESCE(SUM(c.retweet_count), 0)', 'totalRetweets')
      .getRawOne();

    return {
      totalPosts: parseInt(result.totalPosts) || 0,
      totalViews: parseInt(result.totalViews) || 0,
      totalLikes: parseInt(result.totalLikes) || 0,
      totalRetweets: parseInt(result.totalRetweets) || 0,
    };
  }

  async getEmotions(): Promise<Record<string, number>> {
    const rows = await this.repo
      .createQueryBuilder('c')
      .select('c.emotion', 'emotion')
      .addSelect('COUNT(*)', 'count')
      .where('c.emotion IS NOT NULL')
      .groupBy('c.emotion')
      .orderBy('count', 'DESC')
      .getRawMany();

    const data: Record<string, number> = {};
    rows.forEach((r) => (data[r.emotion] = parseInt(r.count)));
    return data;
  }

  async getPosts(limit = 20, offset = 0, emotion?: string, keyword?: string, username?: string, since?: string) {
    const qb = this.repo
      .createQueryBuilder('c')
      .select([
        'c.id',
        'c.text',
        'c.screenName',
        'c.userId',
        'c.userFollowers',
        'c.viewCount',
        'c.likeCount',
        'c.retweetCount',
        'c.emotion',
        'c.publishedAt',
      ])
      .orderBy('c.publishedAt', 'DESC');

    if (emotion) {
      qb.andWhere('c.emotion = :emotion', { emotion });
    }
    if (keyword) {
      qb.andWhere('c.text ILIKE :keyword', { keyword: `%${keyword}%` });
    }
    if (username) {
      qb.andWhere('c.screen_name ILIKE :username', { username: `%${username}%` });
    }
    if (since) {
      qb.andWhere('c.published_at >= :since', { since: new Date(since) });
    }

    const total = await qb.getCount();
    const data = await qb.take(limit).skip(offset).getMany();

    return {
      data,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    };
  }

  async getInfluencers(limit = 10) {
    const rows = await this.repo
      .createQueryBuilder('c')
      .select('c.screen_name', 'username')
      .addSelect('MAX(c.user_followers)', 'followers')
      .addSelect('COUNT(*)', 'postCount')
      .addSelect('ROUND(AVG(c.view_count))', 'avgViews')
      .addSelect('SUM(c.like_count)', 'totalLikes')
      .where('c.user_followers > 0')
      .groupBy('c.screen_name')
      .orderBy('"followers"', 'DESC')
      .limit(limit)
      .getRawMany();

    return rows.map((r) => ({
      username: r.username,
      followers: parseInt(r.followers),
      postCount: parseInt(r.postCount),
      avgViews: parseInt(r.avgViews) || 0,
      totalLikes: parseInt(r.totalLikes),
    }));
  }

  async getTopPosts(limit = 5) {
    const rows = await this.repo
      .createQueryBuilder('c')
      .select([
        'c.id',
        'c.text',
        'c.screenName',
        'c.userFollowers',
        'c.likeCount',
        'c.retweetCount',
        'c.viewCount',
        'c.emotion',
        'c.sentiment',
        'c.sourceType',
        'c.publishedAt',
      ])
      .orderBy('c.likeCount + c.retweetCount + c.viewCount', 'DESC')
      .take(limit)
      .getMany();

    return rows;
  }

  async getHashtagStats(limit = 10) {
    // Unnest hashtags array and count occurrences
    const rows = await this.repo.query(
      `SELECT tag, COUNT(*) as count
       FROM content, unnest(hashtags) AS tag
       WHERE hashtags IS NOT NULL
       GROUP BY tag
       ORDER BY count DESC
       LIMIT $1`,
      [limit],
    );

    return rows.map((r: any) => ({
      label: r.tag,
      count: parseInt(r.count),
    }));
  }

  async getSourceStats() {
    const rows = await this.repo
      .createQueryBuilder('c')
      .select('c.source_type', 'source')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(c.like_count)', 'likes')
      .addSelect('SUM(c.retweet_count)', 'retweets')
      .where('c.source_type IS NOT NULL')
      .groupBy('c.source_type')
      .orderBy('count', 'DESC')
      .getRawMany();

    return rows.map((r: any) => ({
      source: r.source,
      count: parseInt(r.count),
      likes: parseInt(r.likes) || 0,
      retweets: parseInt(r.retweets) || 0,
    }));
  }

  async getUserDistribution() {
    const result = await this.repo.query(`
      SELECT
        COUNT(*) FILTER (WHERE user_followers > 10000) as influencers,
        COUNT(*) FILTER (WHERE user_followers <= 10000 AND user_followers > 100) as regular,
        COUNT(*) FILTER (WHERE user_followers <= 100) as suspicious,
        COUNT(*) as total
      FROM content
    `);

    const row = result[0];
    const total = parseInt(row.total) || 1;

    return {
      influencers: parseInt(row.influencers) || 0,
      regular: parseInt(row.regular) || 0,
      suspicious: parseInt(row.suspicious) || 0,
      total,
      influencerPercent: Math.round((parseInt(row.influencers) / total) * 100),
      regularPercent: Math.round((parseInt(row.regular) / total) * 100),
      suspiciousPercent: Math.round((parseInt(row.suspicious) / total) * 100),
    };
  }

  async getCategoryStats() {
    // Get category counts
    const categoryRows = await this.repo
      .createQueryBuilder('c')
      .select('c.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where('c.category IS NOT NULL')
      .groupBy('c.category')
      .orderBy('count', 'DESC')
      .getRawMany();

    // Get subcategory counts
    const subcategoryRows = await this.repo
      .createQueryBuilder('c')
      .select('c.category', 'category')
      .addSelect('c.subcategory', 'subcategory')
      .addSelect('COUNT(*)', 'count')
      .where('c.category IS NOT NULL')
      .andWhere('c.subcategory IS NOT NULL')
      .groupBy('c.category, c.subcategory')
      .orderBy('count', 'DESC')
      .getRawMany();

    return {
      categories: categoryRows.map((r: any) => ({
        name: r.category,
        count: parseInt(r.count),
      })),
      subcategories: subcategoryRows.map((r: any) => ({
        category: r.category,
        name: r.subcategory,
        count: parseInt(r.count),
      })),
    };
  }
}
