import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DataSourceApiService } from '../data-source/data-source-api.service';
import { SelectedPost } from './selected-post.entity';
import { Profile } from '../profile/profile.entity';

// Only sources where 8tag lets us verify authorship (peer_username / channel handle)
const VERIFIABLE_SOURCES: Record<string, string> = {
  telegram: 'telegram',
  // twitter and instagram skipped — 8tag can't filter by author for those
};

@Injectable()
export class OfficialPagesFeedService {
  private readonly logger = new Logger(OfficialPagesFeedService.name);

  constructor(
    @InjectRepository(SelectedPost)
    private readonly postRepo: Repository<SelectedPost>,
    private readonly apiService: DataSourceApiService,
  ) {}

  /**
   * Fetches recent posts FROM the profile's official pages and stores them.
   * Only Telegram is supported (authorship verifiable via peer_username).
   *
   * Uses 'week' range to catch posts since the last ingest run.
   * Deduplication is handled by the unique constraint on (external_id, source_type, profile_id).
   */
  async fetchForProfile(
    credentials: { username: string; password: string },
    profile: Profile,
    runId: string,
  ): Promise<number> {
    const channels = (profile.officialChannels || []).filter(
      (ch) => VERIFIABLE_SOURCES[ch.platform] && ch.active !== false && ch.handle,
    );

    if (channels.length === 0) return 0;

    let totalStored = 0;

    for (const channel of channels) {
      const source = VERIFIABLE_SOURCES[channel.platform];
      const handle = channel.handle.replace(/^@/, '').toLowerCase();

      try {
        const stored = await this.fetchChannel(credentials, profile.id, runId, source, handle);
        totalStored += stored;
        this.logger.log(`OfficialPages: ${profile.name} / ${channel.platform}:${handle} → ${stored} new posts`);
      } catch (err) {
        this.logger.warn(`OfficialPages: ${profile.name} / ${channel.platform}:${handle} failed — ${err.message}`);
      }

      // Small delay between channels to avoid rate limiting
      await new Promise((r) => setTimeout(r, 400));
    }

    return totalStored;
  }

  private async fetchChannel(
    credentials: { username: string; password: string },
    profileId: string,
    runId: string,
    source: string,
    handle: string,
  ): Promise<number> {
    // Fetch recent posts using the handle as keyword, then filter to only keep
    // posts where the author handle matches exactly.
    const result = await this.apiService.search8tag(credentials, {
      source,
      or: handle,
      range: 'week',
      sort: 'recent',
      size: 100,
      lang: 'fa',
      forward: 'false',
      retweet: 'false',
      maxHashtags: 10,
    });

    const items = (result.data || []).filter((item: any) => {
      const authorHandle = (item.screenName || '').replace(/^@/, '').toLowerCase();
      return authorHandle === handle;
    });

    if (items.length === 0) return 0;

    const selectionReason = `official_page_${source}_${handle}`;

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

    if (entities.length > 0) {
      await this.postRepo
        .createQueryBuilder()
        .insert()
        .into(SelectedPost)
        .values(entities)
        .orIgnore()
        .execute();
    }

    // Count how many were actually new (not duplicates)
    const stored = await this.postRepo.count({
      where: { ingestRunId: runId, profileId, selectionReason },
    });

    return stored;
  }
}
