import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DataSourceApiService } from '../data-source/data-source-api.service';
import { SelectedPost } from './selected-post.entity';

// ── Feed definitions ──────────────────────────────────────────────────────────

/**
 * Each display feed fetches the top N posts from specific sources sorted by
 * a specific metric. These are stored in selected_posts with a distinct
 * selection_reason so the frontend can query them directly.
 */
const DISPLAY_FEEDS: Array<{
  key: string;           // selection_reason prefix
  sort: string;          // 8tag sort param
  sources: string[];     // which sources support this sort
  size: number;          // how many to fetch per source
}> = [
  {
    key: 'display_top_views',
    sort: 'views',
    sources: ['telegram', 'twitter', 'instagram', 'news', 'media', 'bale', 'rubika', 'forum', 'aparat'],
    size: 10,
  },
  {
    key: 'display_top_comments',
    sort: 'comments',
    sources: ['telegram', 'twitter', 'instagram', 'news'],
    size: 10,
  },
  {
    key: 'display_top_forwards',
    sort: 'forwards',
    sources: ['telegram', 'twitter', 'instagram'],
    size: 10,
  },
];

@Injectable()
export class DisplayFeedService {
  private readonly logger = new Logger(DisplayFeedService.name);

  constructor(
    @InjectRepository(SelectedPost)
    private readonly postRepo: Repository<SelectedPost>,
    private readonly apiService: DataSourceApiService,
  ) {}

  /**
   * Fetches display feeds for a profile and stores them in selected_posts.
   * Called during each ingest run.
   *
   * Runs in batches of 4 with a 500ms delay to avoid rate limiting.
   * Total API calls: 9 + 4 + 3 = 16 per profile.
   */
  async fetchForProfile(
    credentials: { username: string; password: string },
    profileId: string,
    runId: string,
    keywords: { or: string; not?: string },
  ): Promise<{ totalFetched: number; totalStored: number }> {
    let totalFetched = 0;
    let totalStored = 0;

    // Build all fetch tasks as flat list
    const tasks: Array<{ source: string; sort: string; key: string; size: number }> = [];
    for (const feed of DISPLAY_FEEDS) {
      for (const source of feed.sources) {
        tasks.push({ source, sort: feed.sort, key: feed.key, size: feed.size });
      }
    }

    const BATCH_SIZE = 4;
    const BATCH_DELAY_MS = 600;

    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(({ source, sort, key, size }) =>
          this.fetchAndStore(credentials, profileId, runId, keywords, source, sort, key, size),
        ),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          totalFetched += result.value.fetched;
          totalStored += result.value.stored;
        } else {
          this.logger.warn(`DisplayFeed batch item failed: ${result.reason?.message}`);
        }
      }

      if (i + BATCH_SIZE < tasks.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    this.logger.log(
      `DisplayFeed: profile=${profileId} fetched=${totalFetched} stored=${totalStored}`,
    );

    return { totalFetched, totalStored };
  }

  private async fetchAndStore(
    credentials: { username: string; password: string },
    profileId: string,
    runId: string,
    keywords: { or: string; not?: string },
    source: string,
    sort: string,
    selectionKey: string,
    size: number,
  ): Promise<{ fetched: number; stored: number }> {
    const result = await this.apiService.search8tag(credentials, {
      source,
      or: keywords.or,
      not: keywords.not,
      range: 'week',
      sort,
      size,
      lang: 'fa',
      forward: 'false',
      retweet: 'false',
      maxHashtags: 10,
    });

    const items = result.data || [];
    if (items.length === 0) return { fetched: 0, stored: 0 };

    const selectionReason = `${selectionKey}_${source}`;

    const entities = items.map((p: any) =>
      this.postRepo.create({
        ingestRunId: runId,
        profileId,
        externalId: String(p.id),
        sourceType: p.sourceType || source,
        screenName: p.screenName || null,
        displayName: p.displayName || null,
        profileImageUrl: p.profileImageUrl || null,
        text: p.text || '',
        publishedAt: p.publishedAt ? new Date(p.publishedAt) : null,
        postUrl: p.postUrl || null,
        mediaUrl: p.mediaUrl || null,
        viewCount: p.viewCount || 0,
        likeCount: p.likeCount || 0,
        retweetCount: p.retweetCount || 0,
        replyCount: p.replyCount || 0,
        sentiment: typeof p.sentiment === 'number'
          ? (p.sentiment === 1 ? 'Positive' : p.sentiment === -1 ? 'Negative' : 'Neutral')
          : (p.sentiment || null),
        simhash: null,
        canonicalId: null,
        selectionReason,
        hashtags: p.hashtags || [],
      }),
    );

    // Batch insert — dedup via unique constraint
    if (entities.length > 0) {
      await this.postRepo
        .createQueryBuilder()
        .insert()
        .into(SelectedPost)
        .values(entities)
        .orIgnore()
        .execute();
    }

    // Count how many were actually new
    const stored = await this.postRepo.count({
      where: { ingestRunId: runId, profileId, selectionReason },
    });

    return { fetched: items.length, stored };
  }
}
