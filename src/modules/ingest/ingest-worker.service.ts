import { Injectable, Logger, NotFoundException, OnApplicationBootstrap, Optional, forwardRef, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, Interval, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';

import { Profile } from '../profile/profile.entity';
import { DataSource as DataSourceEntity } from '../data-source/data-source.entity';
import { SampleSelectorService } from './sample-selector.service';
import { BatchSentimentService } from './batch-sentiment.service';
import { PlatformTotalsService } from './platform-totals.service';
import { DisplayFeedService } from './display-feed.service';
import { OfficialPagesFeedService } from './official-pages-feed.service';
import { PromiseFeedService } from './promise-feed.service';
import { IngestRun, IngestStage, INGEST_STAGES } from './ingest-run.entity';
import { SelectedPost } from './selected-post.entity';
import { HourlyAggregate } from './hourly-aggregate.entity';
import { AiContentService } from '../content/ai-content.service';
import { GlobalContext } from '../admin/global-context/global-context.entity';
import {
  DEFAULT_INGEST_SETTINGS, INGEST_TIERS, INGEST_TIMEZONE, IngestSettings, IngestTier,
  describeCron, mergeIngestSettings,
} from './ingest-settings';
import { AGGREGATE_POST_FILTER, HOUR_BUCKET_SQL, buildHourlyAggregates } from './hourly-aggregate.builder';
import { APP_EVENTS, AppEvents } from '../notifications/app-events';

// ── Tier → sample size (fallback if DB settings unavailable) ─────────────────
const TIER_SAMPLE_SIZE: Record<string, number> = {
  heavy:  DEFAULT_INGEST_SETTINGS.heavy.sampleSize,
  medium: DEFAULT_INGEST_SETTINGS.medium.sampleSize,
  light:  DEFAULT_INGEST_SETTINGS.light.sampleSize,
};

// ── Tier → fetch range (fallback) ────────────────────────────────────────────
const TIER_RANGE: Record<string, string> = {
  heavy:  DEFAULT_INGEST_SETTINGS.heavy.range,
  medium: DEFAULT_INGEST_SETTINGS.medium.range,
  light:  DEFAULT_INGEST_SETTINGS.light.range,
};

/** A 'running' run older than this is treated as dead (crashed process / hung step). */
const STALE_RUN_MS = 90 * 60_000;
/** Upper bound for the awaited AI-sections step so a hung LLM call can't pin the run. */
const AI_STAGE_TIMEOUT_MS = 20 * 60_000;

export interface TierSchedule {
  tier: IngestTier;
  /** Effective cron expression (default if the configured one is invalid) */
  cron: string;
  configuredCron: string;
  timezone: string;
  /** Persian description, e.g. «هر ۶ ساعت (ساعت ۰۰:۰۰، ۰۶:۰۰، …)» */
  description: string;
  enabled: boolean;
  nextRuns: string[];
  error: string | null;
}

@Injectable()
export class IngestWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IngestWorkerService.name);
  private readonly credentials: { username: string; password: string };
  /** tier → cron expression currently registered in the SchedulerRegistry */
  private readonly registeredCrons = new Map<IngestTier, string>();

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
    @InjectRepository(GlobalContext)
    private readonly globalContextRepo: Repository<GlobalContext>,
    private readonly selector: SampleSelectorService,
    private readonly batchSentiment: BatchSentimentService,
    private readonly platformTotals: PlatformTotalsService,
    private readonly displayFeed: DisplayFeedService,
    private readonly officialPagesFeed: OfficialPagesFeedService,
    private readonly promiseFeed: PromiseFeedService,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(forwardRef(() => AiContentService))
    private readonly aiContent: AiContentService,
    @Optional()
    private readonly events?: AppEvents,
  ) {
    this.credentials = {
      username: this.config.get<string>('HASHTAG_USERNAME', ''),
      password: this.config.get<string>('HASHTAG_PASSWORD', ''),
    };
  }

  // ── Cron schedules ──────────────────────────────────────────────────────────
  // Tier crons are registered at startup from ingest_settings (cron per tier,
  // Asia/Tehran) via SchedulerRegistry and re-synced every minute and whenever
  // the admin schedule endpoint is read, so saved settings take effect without
  // a restart. `automaticCollectionEnabled` is checked when a job fires.

  async onApplicationBootstrap() {
    await this.failOrphanedRuns();
    await this.syncSchedules().catch((err) =>
      this.logger.error(`Schedule sync failed: ${err.message}`),
    );
  }

  /** Periodic re-sync so saved cron changes apply within a minute. */
  @Interval('ingest_schedule_sync', 60_000)
  async periodicScheduleSync() {
    await this.syncSchedules().catch((err) =>
      this.logger.warn(`Schedule sync failed: ${err.message}`),
    );
  }

  async runHeavy() {
    this.logger.log('Cron: ingest_heavy triggered');
    await this.runScheduledTier('heavy');
  }

  async runMedium() {
    this.logger.log('Cron: ingest_medium triggered');
    await this.runScheduledTier('medium');
  }

  async runLight() {
    this.logger.log('Cron: ingest_light triggered');
    await this.runScheduledTier('light');
  }

  /** Data retention cleanup: runs weekly at 02:00 Sunday (Tehran) */
  @Cron('0 2 * * 0', { name: 'ingest_cleanup', timeZone: INGEST_TIMEZONE })
  async runCleanup() {
    this.logger.log('Cron: ingest_cleanup triggered');
    await this.cleanup();
  }

  /**
   * (Re)registers the ingest_<tier> cron jobs from the stored settings.
   * Jobs whose expression is unchanged are left alone; an invalid expression
   * falls back to the tier's default cron. Returns the effective schedule.
   */
  async syncSchedules(): Promise<TierSchedule[]> {
    const settings = await this.getSettings();
    const handlers: Record<IngestTier, () => Promise<void>> = {
      heavy: () => this.runHeavy(),
      medium: () => this.runMedium(),
      light: () => this.runLight(),
    };

    return INGEST_TIERS.map((tier) => {
      const name = `ingest_${tier}`;
      const wanted = (settings[tier].cron || '').trim();
      let cron = wanted;
      let error: string | null = null;
      try {
        if (!cron) throw new Error('empty expression');
        // Validate before touching the registered job
        new CronJob(cron, () => undefined, null, false, INGEST_TIMEZONE);
      } catch (err) {
        error = `عبارت cron نامعتبر است (${wanted || '—'}); زمان‌بندی پیش‌فرض استفاده شد`;
        this.logger.warn(`Invalid cron for ${tier} "${wanted}": ${err.message}; using default`);
        cron = DEFAULT_INGEST_SETTINGS[tier].cron;
      }

      if (this.registeredCrons.get(tier) !== cron || !this.scheduler.doesExist('cron', name)) {
        if (this.scheduler.doesExist('cron', name)) this.scheduler.deleteCronJob(name);
        const job = new CronJob(cron, () => {
          handlers[tier]().catch((err) => this.logger.error(`Cron ${name} failed: ${err.message}`));
        }, null, false, INGEST_TIMEZONE);
        this.scheduler.addCronJob(name, job);
        job.start();
        this.registeredCrons.set(tier, cron);
        this.logger.log(`Scheduled ${name}: "${cron}" (${INGEST_TIMEZONE})`);
      }

      let nextRuns: string[] = [];
      try {
        nextRuns = this.scheduler.getCronJob(name).nextDates(3).map((d: any) => d.toJSDate().toISOString());
      } catch { /* job missing (e.g. in tests) */ }

      return {
        tier,
        cron,
        configuredCron: wanted,
        timezone: INGEST_TIMEZONE,
        description: describeCron(cron),
        enabled: settings.automaticCollectionEnabled,
        nextRuns,
        error,
      };
    });
  }

  async cleanup(): Promise<{ deletedPosts: number; deletedRuns: number; deletedAggregates: number }> {
    const { retentionDays } = await this.getSettings();
    const now = new Date();
    const postsCutoff = new Date(now.getTime() - retentionDays * 24 * 3600_000);
    // Aggregates are tiny and feed the long-range trend — keep them at least a year.
    const aggCutoff = new Date(now.getTime() - Math.max(365, retentionDays) * 24 * 3600_000);

    // Delete selected_posts older than the retention window
    const postsResult = await this.postRepo.query(
      `DELETE FROM selected_posts WHERE created_at < $1`,
      [postsCutoff],
    );

    // Delete ingest_runs older than the retention window (cascades to selected_posts via FK)
    const runsResult = await this.runRepo.query(
      `DELETE FROM ingest_runs WHERE created_at < $1`,
      [postsCutoff],
    );

    const aggResult = await this.aggRepo.query(
      `DELETE FROM hourly_aggregates WHERE hour < $1`,
      [aggCutoff],
    );

    await this.postRepo.query(
      `DELETE FROM ai_result_cache WHERE created_at < $1`,
      [postsCutoff],
    );

    const deletedPosts = postsResult[1] || 0;
    const deletedRuns = runsResult[1] || 0;
    const deletedAggregates = aggResult[1] || 0;

    this.logger.log(
      `Cleanup (retention ${retentionDays}d): deleted ${deletedPosts} posts, ${deletedRuns} runs, ${deletedAggregates} aggregates`,
    );

    return { deletedPosts, deletedRuns, deletedAggregates };
  }

  // ── Manual triggers ─────────────────────────────────────────────────────────

  /** Runs the whole pipeline and resolves when it is finished (cron + tests). */
  async runForProfile(profileId: string, options: { skipAi?: boolean } = {}): Promise<IngestRun> {
    const profile = await this.profileRepo.findOne({ where: { id: profileId } });
    if (!profile) throw new Error(`Profile ${profileId} not found`);
    return this.ingestProfile(profile, options);
  }

  /**
   * Creates the run record and starts the pipeline in the background.
   * Resolves as soon as the run row exists, so HTTP callers can return
   * `{ runId }` immediately and poll latest-run for stage/progress.
   */
  async startRunForProfile(profileId: string, options: { skipAi?: boolean } = {}): Promise<IngestRun> {
    const profile = await this.profileRepo.findOne({ where: { id: profileId } });
    if (!profile) throw new NotFoundException('پروفایل یافت نشد');
    const run = await this.createRun(profile);
    // Snapshot first: the pipeline mutates `run` synchronously before its first await
    const queued = { ...run } as IngestRun;
    this.executeRun(profile, run, options).catch((err) =>
      this.logger.error(`Background ingest crashed for ${profile.name}: ${err.message}`),
    );
    return queued;
  }

  /**
   * A run counts as in flight while status='running' and it started within
   * STALE_RUN_MS; older "running" rows are leftovers of a crashed process.
   */
  isRunInFlight(run: Pick<IngestRun, 'status' | 'startedAt'> | null | undefined): boolean {
    if (!run || run.status !== 'running') return false;
    const started = run.startedAt ? new Date(run.startedAt).getTime() : 0;
    return Date.now() - started < STALE_RUN_MS;
  }

  /** Load ingest settings from DB, falling back to defaults */
  async getSettings(): Promise<IngestSettings> {
    try {
      const row = await this.globalContextRepo.findOne({ where: { key: 'ingest_settings' } });
      if (row?.value) return mergeIngestSettings(JSON.parse(row.value));
    } catch { /* ignore parse errors */ }
    return mergeIngestSettings(null);
  }

  /** Background runs die with the process; mark them failed at startup so they don't block new runs. */
  private async failOrphanedRuns(): Promise<void> {
    try {
      const res = await this.runRepo.query(
        `UPDATE ingest_runs
            SET status = 'failed', finished_at = NOW(),
                error_message = COALESCE(error_message, 'اجرا با راه‌اندازی مجدد سرور متوقف شد')
          WHERE status = 'running'`,
      );
      const n = Array.isArray(res) ? res[1] : 0;
      if (n) this.logger.warn(`Marked ${n} orphaned running ingest run(s) as failed`);
    } catch (err) {
      this.logger.warn(`Could not clean orphaned runs: ${err.message}`);
    }
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

  /**
   * Runs a tier from the scheduler only when automatic collection is enabled.
   * `runForProfile` deliberately does not use this gate so the manual
   * "run now" actions remain available while scheduled collection is paused.
   */
  private async runScheduledTier(tier: string): Promise<void> {
    const settings = await this.getSettings();
    if (!settings.automaticCollectionEnabled) {
      this.logger.log(`Cron: automatic collection is disabled; skipping ${tier} tier`);
      return;
    }
    await this.runForTier(tier);
  }

  private async ingestProfile(profile: Profile, options: { skipAi?: boolean } = {}): Promise<IngestRun> {
    const run = await this.createRun(profile);
    return this.executeRun(profile, run, options);
  }

  private createRun(profile: Profile): Promise<IngestRun> {
    return this.runRepo.save(
      this.runRepo.create({
        profileId: profile.id,
        status: 'running',
        stage: 'queued',
        progress: 0,
        startedAt: new Date(),
      }),
    );
  }

  /** Records the current pipeline step; failures here never break the run. */
  private async setStage(run: IngestRun, stage: IngestStage): Promise<void> {
    run.stage = stage;
    run.progress = INGEST_STAGES[stage];
    try {
      await this.runRepo.update(run.id, { stage, progress: run.progress });
    } catch (err) {
      this.logger.warn(`Could not record stage ${stage} for run ${run.id}: ${err.message}`);
    }
  }

  /**
   * Pipeline: fetch → dedup → store → totals → feeds → sentiment (+ hourly
   * aggregate rebuild) → ai → done. The run stays status='running' until every
   * step has finished so pollers see real progress; optional steps (totals,
   * feeds, sentiment, AI) log and continue on failure.
   */
  private async executeRun(profile: Profile, run: IngestRun, options: { skipAi?: boolean } = {}): Promise<IngestRun> {
    this.logger.log(`Ingest start: ${profile.name} (${profile.tier})`);

    try {
      const or = (profile.keywords || []).join('|');
      if (!or) {
        this.logger.warn(`Profile ${profile.name} has no keywords — skipping`);
        run.status = 'failed';
        run.errorMessage = 'No keywords configured';
        run.finishedAt = new Date();
        const saved = await this.runRepo.save(run);
        this.events?.emit(APP_EVENTS.INGEST_RUN_FAILED, { profileId: profile.id, runId: run.id, error: run.errorMessage });
        return saved;
      }

      const not = (profile.excludedKeywords || []).join('|') || undefined;
      const settings = await this.getSettings();
      const tierSettings = settings[profile.tier as IngestTier];
      const targetSize = tierSettings?.sampleSize ?? (TIER_SAMPLE_SIZE[profile.tier] || 80);
      const range = tierSettings?.range ?? (TIER_RANGE[profile.tier] || 'week');

      // ── fetch + dedup (both inside the selector) ────────────────────────
      await this.setStage(run, 'fetch');
      const result = await this.selector.select(this.credentials, {
        or,
        not,
        range,
        sourceWeights: profile.sourceWeights || {},
        targetSize,
      });
      await this.setStage(run, 'dedup');
      run.postsFetched = result.stats.afterFilter;
      run.postsAfterDedup = result.stats.afterDedup;
      run.postsSelected = result.stats.selected;
      run.stats = result.stats;

      // ── store ───────────────────────────────────────────────────────────
      await this.setStage(run, 'store');
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
          // ON CONFLICT: update ingest_run_id so the post is associated with
          // the current run. This means AI prompts (which filter by run_id)
          // will include re-fetched posts, reflecting the current source weights.
          .orUpdate(
            ['ingest_run_id', 'view_count', 'like_count', 'retweet_count', 'reply_count'],
            ['external_id', 'source_type', 'profile_id'],
          )
          .execute();
      }

      // Update profile daily_avg_posts (rolling estimate)
      await this.updateDailyAvg(profile, result.stats.selected, range);

      this.logger.log(
        `Ingest stored: ${profile.name} — fetched=${run.postsFetched} deduped=${run.postsAfterDedup} selected=${run.postsSelected}`,
      );

      // ── totals: platform totals from 8tag (40 lightweight calls) ────────
      await this.setStage(run, 'totals');
      try {
        await this.platformTotals.captureForProfile(this.credentials, profile.id, { or, not });
        this.logger.log(`PlatformTotals captured for ${profile.name}`);
      } catch (err) {
        this.logger.warn(`PlatformTotals failed for ${profile.name}: ${err.message}`);
      }

      // ── feeds: display, official pages, promises ────────────────────────
      await this.setStage(run, 'feeds');

      // Display feeds: top-N posts per source per metric (16 parallel calls).
      // Stored before sentiment so they are classified below.
      try {
        const feedResult = await this.displayFeed.fetchForProfile(
          this.credentials, profile.id, run.id, { or, not }, profile.sourceWeights || {},
        );
        this.logger.log(`DisplayFeed: ${profile.name} — fetched=${feedResult.totalFetched} stored=${feedResult.totalStored}`);
      } catch (err) {
        this.logger.warn(`DisplayFeed failed for ${profile.name}: ${err.message}`);
      }

      // Official pages: recent posts FROM the profile's official Telegram channels.
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

      // Promise feed: posts related to each promise (selection_reason = 'promise_<index>').
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

      // ── sentiment: batch LLM classification of every post in this run ───
      await this.setStage(run, 'sentiment');
      const allRunPosts = (await this.postRepo.find({
        where: { ingestRunId: run.id },
        select: ['id', 'text'],
      })) || [];

      if (profile.promticIdentifier?.external_id && allRunPosts.length > 0) {
        const postsForSentiment = allRunPosts
          .filter(p => p.text && p.text.length > 10)
          .map(p => ({ id: p.id, text: p.text as string }));

        try {
          await this.batchSentiment.classifyForProfile(postsForSentiment, {
            external_id: profile.promticIdentifier.external_id,
            name: profile.name,
          }, profile.id);
          this.logger.log(`BatchSentiment done for ${profile.name} (${postsForSentiment.length} posts)`);
        } catch (err) {
          this.logger.warn(`BatchSentiment failed for ${profile.name}: ${err.message}`);
        }
      }

      // Rebuild hourly aggregates for the hours this run touched, now that
      // sentiment is final (single sentiment source for trend/health/AI).
      try {
        const rows = await this.rebuildAggregatesForRun(profile.id, run.id);
        this.logger.log(`HourlyAggregates rebuilt for ${profile.name}: ${rows} rows`);
      } catch (err) {
        this.logger.warn(`HourlyAggregates rebuild failed for ${profile.name}: ${err.message}`);
      }

      // ── ai: regenerate dashboard AI sections with the classified posts ──
      // Awaited (with a timeout) so the run reports progress until the
      // dashboard is fully refreshed. Failures don't fail the ingest.
      if (!options.skipAi) {
        await this.setStage(run, 'ai');
        const orgId = profile.promticIdentifier?.external_id || profile.id;
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            this.aiContent.generateAll(orgId, profile.id, true),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('AI generation timed out')), AI_STAGE_TIMEOUT_MS);
            }),
          ]);
          this.logger.log(`AI sections pre-generated for ${profile.name}`);
        } catch (err) {
          this.logger.warn(`AI pre-generation failed for ${profile.name}: ${err.message}`);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        this.logger.log(`AI generation skipped for ${profile.name} (posts-only mode)`);
      }

      run.status = 'completed';
      run.stage = 'done';
      run.progress = INGEST_STAGES.done;
      run.finishedAt = new Date();
      this.logger.log(`Ingest done: ${profile.name}`);
      const saved = await this.runRepo.save(run);
      this.events?.emit(APP_EVENTS.INGEST_RUN_COMPLETED, {
        profileId: profile.id, runId: run.id, postsSelected: run.postsSelected,
      });
      return saved;
    } catch (err) {
      // Keep run.stage: it shows which step failed
      run.status = 'failed';
      run.errorMessage = err.message;
      run.finishedAt = new Date();
      this.logger.error(`Ingest error for ${profile.name} (stage ${run.stage}): ${err.message}`);
      const saved = await this.runRepo.save(run);
      this.events?.emit(APP_EVENTS.INGEST_RUN_FAILED, { profileId: profile.id, runId: run.id, error: err.message });
      return saved;
    }
  }

  /**
   * Recomputes hourly_aggregates for every published hour touched by `runId`
   * from ALL of the profile's qualifying posts in those hours (posts from
   * earlier runs share the same hour buckets). Returns the number of rows written.
   */
  async rebuildAggregatesForRun(profileId: string, runId: string): Promise<number> {
    const hourRows: { hour: Date | string }[] = (await this.postRepo.query(
      `SELECT DISTINCT ${HOUR_BUCKET_SQL} AS hour
         FROM selected_posts
        WHERE ingest_run_id = $1 AND published_at IS NOT NULL`,
      [runId],
    )) || [];
    if (hourRows.length === 0) return 0;
    const hours = hourRows.map((r) => new Date(r.hour).toISOString());

    const posts: any[] = (await this.postRepo.query(
      `SELECT source_type, sentiment, published_at, view_count, like_count, reply_count
         FROM selected_posts
        WHERE profile_id = $1
          AND ${AGGREGATE_POST_FILTER}
          AND ${HOUR_BUCKET_SQL} = ANY($2::timestamptz[])`,
      [profileId, hours],
    )) || [];

    const rows = buildHourlyAggregates(profileId, posts.map((p) => ({
      sourceType: p.source_type,
      sentiment: p.sentiment,
      publishedAt: p.published_at,
      viewCount: p.view_count,
      likeCount: p.like_count,
      replyCount: p.reply_count,
    })));

    await this.aggRepo.manager.transaction(async (m) => {
      await m.query(
        `DELETE FROM hourly_aggregates WHERE profile_id = $1 AND hour = ANY($2::timestamptz[])`,
        [profileId, hours],
      );
      for (let i = 0; i < rows.length; i += 500) {
        await m.createQueryBuilder().insert().into(HourlyAggregate).values(rows.slice(i, i + 500)).execute();
      }
    });
    return rows.length;
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
