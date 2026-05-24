import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

import { Profile } from '../profile/profile.entity';
import { DataSource as DataSourceEntity } from '../data-source/data-source.entity';
import { SampleSelectorService } from './sample-selector.service';
import { BatchSentimentService } from './batch-sentiment.service';
import { PlatformTotalsService } from './platform-totals.service';
import { DisplayFeedService } from './display-feed.service';
import { OfficialPagesFeedService } from './official-pages-feed.service';
import { PromiseFeedService } from './promise-feed.service';
import { IngestRun } from './ingest-run.entity';
import { SelectedPost } from './selected-post.entity';
import { HourlyAggregate } from './hourly-aggregate.entity';
import { AiContentService } from '../content/ai-content.service';

// ── Tier → sample size ────────────────────────────────────────────────────────
const TIER_SAMPLE_SIZE: Record<string, number> = {
  heavy:  100,
  medium:  80,
  light:   60,
};

// ── Tier → fetch range ────────────────────────────────────────────────────────
// Heavy profiles fetch the last 6h window (4×/day), medium/light fetch 'week'.
const TIER_RANGE: Record<string, string> = {
  heavy:  'day',
  medium: 'week',
  light:  'week',
};

@Injectable()
export class IngestWorkerService {
  private readonly logger = new Logger(IngestWorkerService.name);
  private readonly credentials: { username: string; password: string };

  constructor(
    @InjectRepository(Profile)
    private readonly profileRepo: Repository<Profile>,
    @InjectRepository(DataSourceEntity)
    private readonly dataSourceRepo: Repository<DataSourceEntity>,
    @InjectRepository(IngestRun)
    private readonly runRepo: Repository<IngestRun>,
    @InjectRepository(SelectedPost)
    private readonly postRepo: Repository<SelectedPost>,
    @InjectRepository(HourlyAggregate)
    private readonly aggRepo: Repository<HourlyAggregate>,
    private readonly selector: SampleSelectorService,
    private readonly batchSentiment: BatchSentimentService,
    private readonly platformTotals: PlatformTotalsService,
    private readonly displayFeed: DisplayFeedService,
    private readonly officialPagesFeed: OfficialPagesFeedService,
    private readonly promiseFeed: PromiseFeedService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => AiContentService))
    private readonly aiContent: AiContentService,
  ) {
    this.credentials = {
      username: this.config.get<string>('HASHTAG_USERNAME', ''),
      password: this.config.get<string>('HASHTAG_PASSWORD', ''),
    };
  }

  // ── Cron schedules ──────────────────────────────────────────────────────────

  /** Heavy profiles: every 6 hours (4×/day) */
  @Cron('0 0,6,12,18 * * *', { name: 'ingest_heavy' })
  async runHeavy() {
    this.logger.log('Cron: ingest_heavy triggered');
    await this.runForTier('heavy');
  }

  /** Medium profiles: once daily at 03:00 */
  @Cron('0 3 * * *', { name: 'ingest_medium' })
  async runMedium() {
    this.logger.log('Cron: ingest_medium triggered');
    await this.runForTier('medium');
  }

  /** Light profiles: every 3 days at 04:00 */
  @Cron('0 4 */3 * *', { name: 'ingest_light' })
  async runLight() {
    this.logger.log('Cron: ingest_light triggered');
    await this.runForTier('light');
  }

  /** Data retention cleanup: runs weekly at 02:00 Sunday */
  @Cron('0 2 * * 0', { name: 'ingest_cleanup' })
  async runCleanup() {
    this.logger.log('Cron: ingest_cleanup triggered');
    await this.cleanup();
  }

  async cleanup(): Promise<{ deletedPosts: number; deletedRuns: number; deletedAggregates: number }> {
    const now = new Date();
    const posts90d = new Date(now.getTime() - 90 * 24 * 3600_000);
    const agg365d = new Date(now.getTime() - 365 * 24 * 3600_000);

    // Delete selected_posts older than 90 days
    const postsResult = await this.postRepo.query(
      `DELETE FROM selected_posts WHERE created_at < $1`,
      [posts90d],
    );

    // Delete ingest_runs older than 90 days (cascades to selected_posts via FK)
    const runsResult = await this.runRepo.query(
      `DELETE FROM ingest_runs WHERE created_at < $1`,
      [posts90d],
    );

    // Delete hourly_aggregates older than 365 days
    const aggResult = await this.aggRepo.query(
      `DELETE FROM hourly_aggregates WHERE hour < $1`,
      [agg365d],
    );

    // Delete ai_result_cache older than 90 days
    await this.postRepo.query(
      `DELETE FROM ai_result_cache WHERE created_at < $1`,
      [posts90d],
    );

    const deletedPosts = postsResult[1] || 0;
    const deletedRuns = runsResult[1] || 0;
    const deletedAggregates = aggResult[1] || 0;

    this.logger.log(
      `Cleanup: deleted ${deletedPosts} posts, ${deletedRuns} runs, ${deletedAggregates} aggregates`,
    );

    return { deletedPosts, deletedRuns, deletedAggregates };
  }

  // ── Manual trigger (for admin "run now" button) ─────────────────────────────

  async runForProfile(profileId: string): Promise<IngestRun> {
    const profile = await this.profileRepo.findOne({ where: { id: profileId } });
    if (!profile) throw new Error(`Profile ${profileId} not found`);
    return this.ingestProfile(profile);
  }

  // ── Core pipeline ───────────────────────────────────────────────────────────

  private async runForTier(tier: string): Promise<void> {
    const profiles = await this.profileRepo.find({
      where: { tier: tier as any, isActive: true },
    });
    this.logger.log(`Ingest ${tier}: ${profiles.length} profiles`);

    // Run sequentially to avoid hammering the API
    for (const profile of profiles) {
      try {
        await this.ingestProfile(profile);
      } catch (err) {
        this.logger.error(`Ingest failed for ${profile.name}: ${err.message}`);
      }
    }
  }

  private async ingestProfile(profile: Profile): Promise<IngestRun> {
    this.logger.log(`Ingest start: ${profile.name} (${profile.tier})`);

    // Create run record
    const run = await this.runRepo.save(
      this.runRepo.create({
        profileId: profile.id,
        status: 'running',
        startedAt: new Date(),
      }),
    );

    try {
      const or = (profile.keywords || []).join('|');
      if (!or) {
        this.logger.warn(`Profile ${profile.name} has no keywords — skipping`);
        run.status = 'failed';
        run.errorMessage = 'No keywords configured';
        run.finishedAt = new Date();
        return this.runRepo.save(run);
      }

      const not = (profile.excludedKeywords || []).join('|') || undefined;
      const targetSize = TIER_SAMPLE_SIZE[profile.tier] || 80;
      const range = TIER_RANGE[profile.tier] || 'week';

      // Run the selector
      const result = await this.selector.select(this.credentials, {
        or,
        not,
        range,
        sourceWeights: profile.sourceWeights || {},
        targetSize,
      });

      // Persist selected posts
      const postEntities = result.posts.map((p) =>
        this.postRepo.create({
          ingestRunId: run.id,
          profileId: profile.id,
          externalId: String(p.id),
          sourceType: p.sourceType,
          screenName: p.screenName,
          displayName: p.displayName,
          profileImageUrl: p.profileImageUrl,
          text: p.text,
          publishedAt: p.publishedAt ? new Date(p.publishedAt) : null,
          postUrl: p.postUrl,
          mediaUrl: p.mediaUrl,
          viewCount: p.viewCount || 0,
          likeCount: p.likeCount || 0,
          retweetCount: p.retweetCount || 0,
          replyCount: p.replyCount || 0,
          sentiment: typeof p.sentiment === 'number'
            ? (p.sentiment === 1 ? 'Positive' : p.sentiment === -1 ? 'Negative' : 'Neutral')
            : (p.sentiment || null),
          simhash: p.simhash,
          canonicalId: null,
          selectionReason: p.selectionReason,
          hashtags: p.hashtags || [],
        }),
      );

      // Batch insert — skip posts already stored for this profile+source
      if (postEntities.length > 0) {
        await this.postRepo
          .createQueryBuilder()
          .insert()
          .into(SelectedPost)
          .values(postEntities)
          .orIgnore()   // conflicts on uq_selected_posts_extid_source_profile
          .execute();
      }

      // Update hourly aggregates
      await this.updateAggregates(profile.id, postEntities);

      // Update run record
      run.status = 'completed';
      run.finishedAt = new Date();
      run.postsFetched = result.stats.afterFilter;
      run.postsAfterDedup = result.stats.afterDedup;
      run.postsSelected = result.stats.selected;
      run.stats = result.stats;

      // Update profile daily_avg_posts (rolling estimate)
      await this.updateDailyAvg(profile, result.stats.selected, range);

      this.logger.log(
        `Ingest done: ${profile.name} — fetched=${run.postsFetched} deduped=${run.postsAfterDedup} selected=${run.postsSelected}`,
      );

      // Save the run as completed before triggering background tasks
      await this.runRepo.save(run);

      // ── Background: capture platform totals ─────────────────────────────
      // Fetch total post counts from 8tag for all sources × timeframes.
      // 40 lightweight API calls (size=1 each), all in parallel.
      this.platformTotals
        .captureForProfile(this.credentials, profile.id, { or, not })
        .then(() => this.logger.log(`PlatformTotals captured for ${profile.name}`))
        .catch((err) => this.logger.warn(`PlatformTotals failed for ${profile.name}: ${err.message}`));

      // ── Display feeds: top posts by views/comments/forwards ─────────────
      // Fetches top-N posts per source per metric and stores them.
      // 16 API calls, all parallel. Runs synchronously so the posts are
      // available for sentiment classification below.
      try {
        const feedResult = await this.displayFeed.fetchForProfile(
          this.credentials, profile.id, run.id, { or, not },
        );
        this.logger.log(`DisplayFeed: ${profile.name} — fetched=${feedResult.totalFetched} stored=${feedResult.totalStored}`);
      } catch (err) {
        this.logger.warn(`DisplayFeed failed for ${profile.name}: ${err.message}`);
      }

      // ── Official pages feed ──────────────────────────────────────────────
      // Fetches recent posts FROM the profile's official Telegram channels.
      // Stored with selection_reason = 'official_page_telegram_<handle>'.
      try {
        const officialCount = await this.officialPagesFeed.fetchForProfile(
          this.credentials, profile, run.id,
        );
        if (officialCount > 0) {
          this.logger.log(`OfficialPages: ${profile.name} — ${officialCount} new posts`);
        }
      } catch (err) {
        this.logger.warn(`OfficialPages failed for ${profile.name}: ${err.message}`);
      }

      // ── Promise feed ─────────────────────────────────────────────────────
      // Fetches posts related to each promise for perception tracking.
      // Stored with selection_reason = 'promise_<index>'.
      if ((profile.promises || []).length > 0) {
        try {
          const promiseResult = await this.promiseFeed.fetchForProfile(
            this.credentials, profile, run.id, 'week',
          );
          if (promiseResult.totalStored > 0) {
            this.logger.log(`PromiseFeed: ${profile.name} — ${promiseResult.totalStored} new posts for ${promiseResult.promisesProcessed} promises`);
          }
        } catch (err) {
          this.logger.warn(`PromiseFeed failed for ${profile.name}: ${err.message}`);
        }
      }

      // ── Fetch ALL posts inserted in this run (AI sample + display feeds) ──
      // Re-query to include display feed posts for sentiment classification.
      const allRunPosts = await this.postRepo.find({
        where: { ingestRunId: run.id },
        select: ['id', 'text'],
      });

      // ── Batch sentiment classification (synchronous) ────────────────────
      // Classify sentiment for all newly ingested posts BEFORE AI generation
      // so the AI prompts see the correct sentiment values.
      if (profile.promticIdentifier?.external_id && allRunPosts.length > 0) {
        const postsForSentiment = allRunPosts
          .filter(p => p.text && p.text.length > 10)
          .map(p => ({ id: p.id, text: p.text as string }));

        try {
          await this.batchSentiment.classifyForProfile(postsForSentiment, {
            external_id: profile.promticIdentifier.external_id,
            name: profile.name,
          });
          this.logger.log(`BatchSentiment done for ${profile.name} (${postsForSentiment.length} posts)`);
        } catch (err) {
          this.logger.warn(`BatchSentiment failed for ${profile.name}: ${err.message}`);
        }
      }

      // ── Background: pre-generate dashboard AI sections ──────────────────
      // Now that sentiment is classified, generate AI summaries with correct data.
      // Runs in background — failures are logged but don't fail the ingest.
      const orgId = profile.promticIdentifier?.external_id || profile.id;
      this.aiContent.generateAll(orgId, profile.id).then(() => {
        this.logger.log(`AI sections pre-generated for ${profile.name}`);
      }).catch((err) => {
        this.logger.warn(`AI pre-generation failed for ${profile.name}: ${err.message}`);
      });

      return run;
    } catch (err) {
      run.status = 'failed';
      run.errorMessage = err.message;
      run.finishedAt = new Date();
      this.logger.error(`Ingest error for ${profile.name}: ${err.message}`);
      return this.runRepo.save(run);
    }

    // Should not reach here (success path returns early above)
    return run;
  }

  private async updateAggregates(
    profileId: string,
    posts: Partial<SelectedPost>[],
  ): Promise<void> {
    if (posts.length === 0) return;

    const hour = new Date();
    hour.setMinutes(0, 0, 0);

    // Group by (sourceType, sentiment)
    const groups = new Map<string, { postCount: number; totalViews: number; totalLikes: number; totalReplies: number }>();

    for (const p of posts) {
      const sentiment = p.sentiment || 'Neutral';
      const keys = [`${p.sourceType}|${sentiment}`, `${p.sourceType}|all`, `all|${sentiment}`, 'all|all'];
      for (const key of keys) {
        const [src, sent] = key.split('|');
        const mapKey = `${src}|${sent}`;
        const existing = groups.get(mapKey) || { postCount: 0, totalViews: 0, totalLikes: 0, totalReplies: 0 };
        existing.postCount++;
        existing.totalViews += p.viewCount || 0;
        existing.totalLikes += p.likeCount || 0;
        existing.totalReplies += p.replyCount || 0;
        groups.set(mapKey, existing);
      }
    }

    for (const [key, agg] of groups) {
      const [sourceType, sentiment] = key.split('|');
      await this.aggRepo
        .createQueryBuilder()
        .insert()
        .into(HourlyAggregate)
        .values({
          profileId,
          hour,
          sourceType,
          sentiment,
          postCount: agg.postCount,
          totalViews: agg.totalViews,
          totalLikes: agg.totalLikes,
          totalReplies: agg.totalReplies,
        })
        .orUpdate(
          ['post_count', 'total_views', 'total_likes', 'total_replies'],
          ['profile_id', 'hour', 'source_type', 'sentiment'],
        )
        .execute();
    }
  }

  private async updateDailyAvg(
    profile: Profile,
    selectedCount: number,
    range: string,
  ): Promise<void> {
    // Rough estimate: selected posts are a sample, scale up by fetch ratio
    // For now just use a simple EMA (exponential moving average) with α=0.2
    const alpha = 0.2;
    const daysInRange = range === 'day' ? 1 : range === 'week' ? 7 : 30;
    const estimatedDaily = selectedCount / daysInRange;
    const current = profile.dailyAvgPosts ?? estimatedDaily;
    const updated = alpha * estimatedDaily + (1 - alpha) * current;

    await this.profileRepo.update(profile.id, { dailyAvgPosts: Math.round(updated) });
  }
}
