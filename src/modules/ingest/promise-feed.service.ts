import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DataSourceApiService } from '../data-source/data-source-api.service';
import { SelectedPost } from './selected-post.entity';
import { Profile } from '../profile/profile.entity';

// Stop words to skip when extracting keywords from promise text
const STOP_WORDS = new Set([
  'اگر', 'که', 'را', 'در', 'به', 'از', 'با', 'این', 'آن', 'برای', 'تا', 'یک',
  'می', 'است', 'و', 'یا', 'هم', 'هر', 'ما', 'شما', 'آنها', 'خود', 'نیز',
  'بر', 'پس', 'اما', 'ولی', 'چون', 'زیرا', 'تمام', 'همه', 'بین', 'طی',
  'طبق', 'جهت', 'نسبت', 'مورد', 'باید', 'خواهد', 'شد', 'شده', 'کرد',
]);

function extractKeywords(text: string): string[] {
  return text
    .split(/[\s،,،.؟?!:؛;()\[\]]+/)
    .map(w => w.trim())
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 4); // max 4 keywords per promise
}

@Injectable()
export class PromiseFeedService {
  private readonly logger = new Logger(PromiseFeedService.name);

  constructor(
    @InjectRepository(SelectedPost)
    private readonly postRepo: Repository<SelectedPost>,
    private readonly apiService: DataSourceApiService,
  ) {}

  /**
   * Fetches posts related to each promise for a profile.
   * Uses 'week' range during regular ingest (accumulates over time).
   * Uses 'year' range for backfill.
   *
   * Posts are stored with selection_reason = 'promise_<index>'
   * so getPromisePerception() can query them directly.
   */
  async fetchForProfile(
    credentials: { username: string; password: string },
    profile: Profile,
    runId: string,
    range: 'week' | 'month' | 'year' = 'week',
  ): Promise<{ promisesProcessed: number; totalStored: number }> {
    const promises: Array<{ text: string }> = profile.promises || [];
    if (promises.length === 0) return { promisesProcessed: 0, totalStored: 0 };

    let totalStored = 0;

    for (let idx = 0; idx < promises.length; idx++) {
      const promise = promises[idx];
      if (!promise.text?.trim()) continue;

      const keywords = extractKeywords(promise.text);
      if (keywords.length === 0) continue;

      // Combine profile keywords + promise keywords for better targeting
      const profileKeywords = (profile.keywords || []).slice(0, 2); // top 2 profile keywords
      const searchTerms = [...profileKeywords, ...keywords].join('|');
      const selectionReason = `promise_${idx}`;

      try {
        const result = await this.apiService.search8tag(credentials, {
          source: 'telegram', // Telegram has the most promise-related discourse
          or: searchTerms,
          not: (profile.excludedKeywords || []).join('|') || undefined,
          range,
          sort: 'reactions', // most-reacted posts about promises
          size: 30,
          lang: 'fa',
          forward: 'false',
          retweet: 'false',
          maxHashtags: 10,
        });

        const items = result.data || [];
        if (items.length === 0) continue;

        const entities = items.map((p: any) =>
          this.postRepo.create({
            ingestRunId: runId,
            profileId: profile.id,
            externalId: String(p.id),
            sourceType: p.sourceType || 'telegram',
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

        if (entities.length > 0) {
          await this.postRepo
            .createQueryBuilder()
            .insert()
            .into(SelectedPost)
            .values(entities)
            .orIgnore()
            .execute();
        }

        // Count newly stored
        const stored = await this.postRepo.count({
          where: { ingestRunId: runId, profileId: profile.id, selectionReason },
        });
        totalStored += stored;

        this.logger.log(
          `PromiseFeed: ${profile.name} / promise[${idx}] "${promise.text.slice(0, 30)}..." → ${stored} new posts`,
        );
      } catch (err) {
        this.logger.warn(
          `PromiseFeed: ${profile.name} / promise[${idx}] failed — ${err.message}`,
        );
      }

      // Small delay between promises to avoid rate limiting
      await new Promise(r => setTimeout(r, 400));
    }

    return { promisesProcessed: promises.length, totalStored };
  }
}
