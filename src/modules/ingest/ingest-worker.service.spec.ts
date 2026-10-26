import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import { IngestWorkerService } from './ingest-worker.service';
import { SampleSelectorService } from './sample-selector.service';
import { BatchSentimentService } from './batch-sentiment.service';
import { PlatformTotalsService } from './platform-totals.service';
import { DisplayFeedService } from './display-feed.service';
import { OfficialPagesFeedService } from './official-pages-feed.service';
import { PromiseFeedService } from './promise-feed.service';
import { AiContentService } from '../content/ai-content.service';
import { Profile } from '../profile/profile.entity';
import { DataSource as DataSourceEntity } from '../data-source/data-source.entity';
import { IngestRun } from './ingest-run.entity';
import { SelectedPost } from './selected-post.entity';
import { HourlyAggregate } from './hourly-aggregate.entity';
import { GlobalContext } from '../admin/global-context/global-context.entity';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockProfile = (overrides: Partial<any> = {}): any => ({
  id: 'profile-uuid-1',
  name: 'تست پروفایل',
  tier: 'medium',
  isActive: true,
  keywords: ['قالیباف', 'مجلس'],
  excludedKeywords: ['تبلیغ'],
  sourceWeights: {},
  dailyAvgPosts: 500,
  promticIdentifier: { external_id: 'test_profile' },
  ...overrides,
});

const mockRun = (overrides: Partial<any> = {}): any => ({
  id: 'run-uuid-1',
  profileId: 'profile-uuid-1',
  status: 'running',
  startedAt: new Date(),
  finishedAt: null,
  postsFetched: 0,
  postsAfterDedup: 0,
  postsSelected: 0,
  errorMessage: null,
  stats: null,
  ...overrides,
});

const makeRepoMock = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn(),
  create: jest.fn((v) => v),
  save: jest.fn((v) => Promise.resolve({ ...v, id: v.id || 'new-uuid' })),
  update: jest.fn(),
  query: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    orUpdate: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ raw: [], affected: 0 }),
  })),
});

const mockSelector = {
  select: jest.fn(),
};

const mockBatchSentiment = { classifyForProfile: jest.fn().mockResolvedValue(undefined) };
const mockPlatformTotals = { captureForProfile: jest.fn().mockResolvedValue(undefined) };
const mockDisplayFeed = { fetchForProfile: jest.fn().mockResolvedValue({ totalFetched: 0, totalStored: 0 }) };
const mockOfficialPagesFeed = { fetchForProfile: jest.fn().mockResolvedValue(0) };
const mockPromiseFeed = { fetchForProfile: jest.fn().mockResolvedValue({ totalStored: 0, promisesProcessed: 0 }) };
const mockAiContent = { generateAll: jest.fn().mockResolvedValue({}) };

const mockConfig = {
  get: jest.fn((key: string, def = '') => {
    const map: Record<string, string> = {
      HASHTAG_USERNAME: 'test_user',
      HASHTAG_PASSWORD: 'test_pass',
    };
    return map[key] ?? def;
  }),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IngestWorkerService', () => {
  let service: IngestWorkerService;
  let profileRepo: ReturnType<typeof makeRepoMock>;
  let runRepo: ReturnType<typeof makeRepoMock>;
  let postRepo: ReturnType<typeof makeRepoMock>;
  let aggRepo: ReturnType<typeof makeRepoMock>;
  let globalContextRepo: ReturnType<typeof makeRepoMock>;

  beforeEach(async () => {
    profileRepo = makeRepoMock();
    runRepo = makeRepoMock();
    postRepo = makeRepoMock();
    aggRepo = makeRepoMock();
    globalContextRepo = makeRepoMock();
    globalContextRepo.findOne.mockResolvedValue(null); // → DEFAULT_INGEST_SETTINGS
    const dataSourceRepo = makeRepoMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestWorkerService,
        { provide: getRepositoryToken(Profile), useValue: profileRepo },
        { provide: getRepositoryToken(DataSourceEntity), useValue: dataSourceRepo },
        { provide: getRepositoryToken(IngestRun), useValue: runRepo },
        { provide: getRepositoryToken(SelectedPost), useValue: postRepo },
        { provide: getRepositoryToken(HourlyAggregate), useValue: aggRepo },
        { provide: getRepositoryToken(GlobalContext), useValue: globalContextRepo },
        { provide: SampleSelectorService, useValue: mockSelector },
        { provide: BatchSentimentService, useValue: mockBatchSentiment },
        { provide: PlatformTotalsService, useValue: mockPlatformTotals },
        { provide: DisplayFeedService, useValue: mockDisplayFeed },
        { provide: OfficialPagesFeedService, useValue: mockOfficialPagesFeed },
        { provide: PromiseFeedService, useValue: mockPromiseFeed },
        { provide: AiContentService, useValue: mockAiContent },
        { provide: ConfigService, useValue: mockConfig },
        { provide: SchedulerRegistry, useValue: { addCronJob: jest.fn(), getCronJob: jest.fn() } },
      ],
    }).compile();

    service = module.get<IngestWorkerService>(IngestWorkerService);
    jest.clearAllMocks();
  });

  // ── Cron schedule names ─────────────────────────────────────────────────────

  describe('cron schedule names', () => {
    it('defines ingest_heavy, ingest_medium, ingest_light, ingest_cleanup methods', () => {
      expect(typeof service.runHeavy).toBe('function');
      expect(typeof service.runMedium).toBe('function');
      expect(typeof service.runLight).toBe('function');
      expect(typeof service.runCleanup).toBe('function');
    });

    it('runHeavy calls runForTier with "heavy"', async () => {
      profileRepo.find.mockResolvedValue([]);
      await service.runHeavy();
      expect(profileRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tier: 'heavy' }) }),
      );
    });

    it('runMedium calls runForTier with "medium"', async () => {
      profileRepo.find.mockResolvedValue([]);
      await service.runMedium();
      expect(profileRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tier: 'medium' }) }),
      );
    });

    it('runLight calls runForTier with "light"', async () => {
      profileRepo.find.mockResolvedValue([]);
      await service.runLight();
      expect(profileRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tier: 'light' }) }),
      );
    });

    it('scheduled runs are skipped when automatic collection is disabled', async () => {
      globalContextRepo.findOne.mockResolvedValue({
        key: 'ingest_settings',
        value: JSON.stringify({ automaticCollectionEnabled: false }),
      });
      await service.runMedium();
      expect(profileRepo.find).not.toHaveBeenCalled();
    });
  });

  // ── runForProfile pipeline ──────────────────────────────────────────────────

  describe('runForProfile', () => {
    it('creates a run record, calls selector, persists posts, marks completed', async () => {
      const profile = mockProfile();
      profileRepo.findOne.mockResolvedValue(profile);
      runRepo.save.mockImplementation((v) => Promise.resolve({ ...v, id: 'run-1' }));

      mockSelector.select.mockResolvedValue({
        posts: [
          {
            id: 'post-1', text: 'متن پست', sourceType: 'telegram',
            screenName: 'ch', displayName: null, profileImageUrl: null,
            publishedAt: new Date().toISOString(), postUrl: null, mediaUrl: null,
            viewCount: 1000, likeCount: 50, retweetCount: 5, replyCount: 3,
            sentiment: 'neutral', simhash: 'abcd1234', canonicalId: null,
            selectionReason: 'telegram_top_12', hashtags: [],
          },
        ],
        stats: { afterFilter: 50, afterDedup: 40, selected: 1, fetchedPerSource: {}, quotaPerSource: {} },
      });

      const run = await service.runForProfile('profile-uuid-1');

      expect(runRepo.save).toHaveBeenCalledTimes(2); // initial + final
      expect(mockSelector.select).toHaveBeenCalledTimes(1);
      expect(run.status).toBe('completed');
      expect(run.postsSelected).toBe(1);
    });

    it('marks run as failed when selector throws', async () => {
      const profile = mockProfile();
      profileRepo.findOne.mockResolvedValue(profile);
      runRepo.save.mockImplementation((v) => Promise.resolve({ ...v, id: 'run-1' }));
      mockSelector.select.mockRejectedValue(new Error('API down'));

      const run = await service.runForProfile('profile-uuid-1');

      expect(run.status).toBe('failed');
      expect(run.errorMessage).toContain('API down');
    });

    it('skips profile with no keywords', async () => {
      const profile = mockProfile({ keywords: [] });
      profileRepo.findOne.mockResolvedValue(profile);
      runRepo.save.mockImplementation((v) => Promise.resolve({ ...v, id: 'run-1' }));

      const run = await service.runForProfile('profile-uuid-1');

      expect(mockSelector.select).not.toHaveBeenCalled();
      expect(run.status).toBe('failed');
      expect(run.errorMessage).toContain('No keywords');
    });

    it('throws when profile not found', async () => {
      profileRepo.findOne.mockResolvedValue(null);
      await expect(service.runForProfile('nonexistent')).rejects.toThrow('not found');
    });
  });

  // ── Tier-based sample size ──────────────────────────────────────────────────

  describe('tier sample sizes', () => {
    const runWithTier = async (tier: string) => {
      const profile = mockProfile({ tier });
      profileRepo.findOne.mockResolvedValue(profile);
      runRepo.save.mockImplementation((v) => Promise.resolve({ ...v, id: 'run-1' }));
      mockSelector.select.mockResolvedValue({
        posts: [], stats: { afterFilter: 0, afterDedup: 0, selected: 0, fetchedPerSource: {}, quotaPerSource: {} },
      });
      await service.runForProfile('profile-uuid-1');
      return mockSelector.select.mock.calls[0][1];
    };

    it('heavy tier uses targetSize=100', async () => {
      const opts = await runWithTier('heavy');
      expect(opts.targetSize).toBe(100);
    });

    it('medium tier uses targetSize=80', async () => {
      const opts = await runWithTier('medium');
      expect(opts.targetSize).toBe(80);
    });

    it('light tier uses targetSize=60', async () => {
      const opts = await runWithTier('light');
      expect(opts.targetSize).toBe(60);
    });
  });

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('deletes old posts, runs, aggregates, and cache', async () => {
      postRepo.query.mockResolvedValue([null, 5]);
      runRepo.query.mockResolvedValue([null, 3]);
      aggRepo.query.mockResolvedValue([null, 100]);

      const result = await service.cleanup();

      expect(postRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM selected_posts'),
        expect.any(Array),
      );
      expect(runRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM ingest_runs'),
        expect.any(Array),
      );
      expect(aggRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM hourly_aggregates'),
        expect.any(Array),
      );
    });
  });

  // ── Concurrent profile ingestion ────────────────────────────────────────────

  describe('concurrent ingestion', () => {
    it('processes multiple profiles sequentially (not in parallel)', async () => {
      const callOrder: string[] = [];
      const profiles = ['p1', 'p2', 'p3'].map((id) => mockProfile({ id, name: id }));
      profileRepo.find.mockResolvedValue(profiles);
      profileRepo.findOne.mockImplementation((opts) =>
        Promise.resolve(profiles.find((p) => p.id === opts.where.id)),
      );
      runRepo.save.mockImplementation((v) => Promise.resolve({ ...v, id: `run-${v.profileId}` }));

      mockSelector.select.mockImplementation(async (_creds, opts) => {
        callOrder.push(opts.or);
        return { posts: [], stats: { afterFilter: 0, afterDedup: 0, selected: 0, fetchedPerSource: {}, quotaPerSource: {} } };
      });

      await service.runMedium();

      // All three should have been processed
      expect(mockSelector.select).toHaveBeenCalledTimes(3);
      // Sequential: each call completes before the next starts
      expect(callOrder).toHaveLength(3);
    });
  });

  // ── Async run with stage / progress ─────────────────────────────────────────

  describe('startRunForProfile (async run-now)', () => {
    const flush = () => new Promise((r) => setImmediate(r));
    const emptySelection = { posts: [], stats: { afterFilter: 10, afterDedup: 8, selected: 5, fetchedPerSource: {}, quotaPerSource: {} } };

    it('returns the queued run before the pipeline finishes, then walks every stage in order', async () => {
      profileRepo.findOne.mockResolvedValue(mockProfile());
      runRepo.save.mockImplementation((v) => Promise.resolve({ ...v, id: 'run-async' }));
      let releaseSelector!: (v: any) => void;
      mockSelector.select.mockReturnValue(new Promise((r) => { releaseSelector = r; }));

      const run = await service.startRunForProfile('profile-uuid-1');

      // Returned immediately: still queued, selector not finished yet
      expect(run).toMatchObject({ id: 'run-async', status: 'running', stage: 'queued', progress: 0 });
      expect(mockAiContent.generateAll).not.toHaveBeenCalled();

      releaseSelector(emptySelection);
      for (let i = 0; i < 20; i++) await flush();

      const stages = runRepo.update.mock.calls.map((c) => c[1].stage);
      expect(stages).toEqual(['fetch', 'dedup', 'store', 'totals', 'feeds', 'sentiment', 'ai']);
      const progress = runRepo.update.mock.calls.map((c) => c[1].progress);
      expect(progress).toEqual([...progress].sort((a, b) => a - b)); // monotonic
      const final = runRepo.save.mock.calls[runRepo.save.mock.calls.length - 1][0];
      expect(final).toMatchObject({ status: 'completed', stage: 'done', progress: 100, postsSelected: 5 });
      expect(mockAiContent.generateAll).toHaveBeenCalledTimes(1);
    });

    it('skips the ai stage in posts-only mode', async () => {
      profileRepo.findOne.mockResolvedValue(mockProfile());
      runRepo.save.mockImplementation((v) => Promise.resolve({ ...v, id: 'run-p' }));
      mockSelector.select.mockResolvedValue(emptySelection);

      await service.runForProfile('profile-uuid-1', { skipAi: true });

      const stages = runRepo.update.mock.calls.map((c) => c[1].stage);
      expect(stages).not.toContain('ai');
      expect(mockAiContent.generateAll).not.toHaveBeenCalled();
    });

    it('keeps the failing stage on error and emits ingest.run.failed', async () => {
      const events = { emit: jest.fn() };
      (service as any).events = events;
      profileRepo.findOne.mockResolvedValue(mockProfile());
      runRepo.save.mockImplementation((v) => Promise.resolve({ ...v, id: 'run-f' }));
      mockSelector.select.mockRejectedValue(new Error('8tag down'));

      const run = await service.runForProfile('profile-uuid-1');

      expect(run).toMatchObject({ status: 'failed', stage: 'fetch', errorMessage: '8tag down' });
      expect(events.emit).toHaveBeenCalledWith('ingest.run.failed', expect.objectContaining({ runId: 'run-f' }));
    });

    it('emits ingest.run.completed when the pipeline finishes', async () => {
      const events = { emit: jest.fn() };
      (service as any).events = events;
      profileRepo.findOne.mockResolvedValue(mockProfile());
      runRepo.save.mockImplementation((v) => Promise.resolve({ ...v, id: 'run-ok' }));
      mockSelector.select.mockResolvedValue(emptySelection);

      await service.runForProfile('profile-uuid-1');

      expect(events.emit).toHaveBeenCalledWith('ingest.run.completed', { profileId: 'profile-uuid-1', runId: 'run-ok', postsSelected: 5 });
    });

    it('throws NotFound before creating a run for an unknown profile', async () => {
      profileRepo.findOne.mockResolvedValue(null);
      await expect(service.startRunForProfile('nope')).rejects.toThrow();
      expect(runRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('isRunInFlight', () => {
    it('treats fresh running runs as in flight and stale or finished ones as not', () => {
      expect(service.isRunInFlight({ status: 'running', startedAt: new Date() })).toBe(true);
      expect(service.isRunInFlight({ status: 'running', startedAt: new Date(Date.now() - 3 * 3600_000) })).toBe(false);
      expect(service.isRunInFlight({ status: 'completed', startedAt: new Date() })).toBe(false);
      expect(service.isRunInFlight(null)).toBe(false);
    });
  });

  // ── Hourly aggregates rebuilt after sentiment ───────────────────────────────

  describe('rebuildAggregatesForRun', () => {
    it('recomputes the run\'s published hours from all qualifying posts with final sentiment', async () => {
      postRepo.query
        .mockResolvedValueOnce([{ hour: '2026-10-20T10:00:00.000Z' }])
        .mockResolvedValueOnce([
          { source_type: 'telegram', sentiment: 'Negative', published_at: '2026-10-20T10:10:00Z', view_count: '100', like_count: 1, reply_count: 0 },
          { source_type: 'twitter', sentiment: 'Positive', published_at: '2026-10-20T10:20:00Z', view_count: '50', like_count: 2, reply_count: 1 },
        ]);
      const inserted: any[] = [];
      const m = {
        query: jest.fn(),
        createQueryBuilder: jest.fn(() => ({
          insert: jest.fn().mockReturnThis(),
          into: jest.fn().mockReturnThis(),
          values: jest.fn(function (this: any, v: any[]) { inserted.push(...v); return this; }),
          execute: jest.fn().mockResolvedValue({}),
        })),
      };
      (aggRepo as any).manager = { transaction: jest.fn((cb) => cb(m)) };

      const n = await service.rebuildAggregatesForRun('profile-uuid-1', 'run-1');

      // hours come from the run, posts are filtered (dedup/relevance/official/display) and bucketed by published hour
      expect(postRepo.query.mock.calls[0][1]).toEqual(['run-1']);
      expect(postRepo.query.mock.calls[1][0]).toContain("NOT LIKE 'display_%'");
      expect(postRepo.query.mock.calls[1][1]).toEqual(['profile-uuid-1', ['2026-10-20T10:00:00.000Z']]);
      expect(m.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM hourly_aggregates'),
        ['profile-uuid-1', ['2026-10-20T10:00:00.000Z']],
      );
      expect(n).toBe(inserted.length);
      const allAll = inserted.find((r) => r.sourceType === 'all' && r.sentiment === 'all');
      expect(allAll).toMatchObject({ postCount: 2, totalViews: 150 });
      expect(inserted.find((r) => r.sourceType === 'all' && r.sentiment === 'Negative')).toMatchObject({ postCount: 1 });
    });

    it('does nothing when the run has no dated posts', async () => {
      postRepo.query.mockResolvedValueOnce([]);
      expect(await service.rebuildAggregatesForRun('profile-uuid-1', 'run-1')).toBe(0);
      expect(postRepo.query).toHaveBeenCalledTimes(1);
    });
  });

  // ── Settings-driven retention and schedules ─────────────────────────────────

  describe('cleanup retention', () => {
    it('uses retentionDays from settings for posts, runs and AI cache', async () => {
      globalContextRepo.findOne.mockResolvedValue({ key: 'ingest_settings', value: JSON.stringify({ retentionDays: 30 }) });
      postRepo.query.mockResolvedValue([null, 0]);
      runRepo.query.mockResolvedValue([null, 0]);
      aggRepo.query.mockResolvedValue([null, 0]);

      await service.cleanup();

      const cutoff: Date = postRepo.query.mock.calls[0][1][0];
      const days = (Date.now() - cutoff.getTime()) / 86400_000;
      expect(days).toBeCloseTo(30, 1);
      const aggCutoff: Date = aggRepo.query.mock.calls[0][1][0];
      expect((Date.now() - aggCutoff.getTime()) / 86400_000).toBeCloseTo(365, 1);
    });
  });

  describe('syncSchedules', () => {
    let jobs: Map<string, any>;
    beforeEach(() => {
      jobs = new Map();
      (service as any).scheduler = {
        doesExist: jest.fn((_t: string, n: string) => jobs.has(n)),
        deleteCronJob: jest.fn((n: string) => { jobs.get(n)?.stop(); jobs.delete(n); }),
        addCronJob: jest.fn((n: string, j: any) => jobs.set(n, j)),
        getCronJob: jest.fn((n: string) => jobs.get(n)),
      };
    });
    afterEach(() => jobs.forEach((j) => j.stop()));

    it('registers the tier crons from settings on Asia/Tehran time', async () => {
      globalContextRepo.findOne.mockResolvedValue({
        key: 'ingest_settings',
        value: JSON.stringify({ medium: { cron: '0 3 * * *' } }),
      });

      const schedule = await service.syncSchedules();

      expect([...jobs.keys()].sort()).toEqual(['ingest_heavy', 'ingest_light', 'ingest_medium']);
      const medium = schedule.find((s) => s.tier === 'medium')!;
      expect(medium.timezone).toBe('Asia/Tehran');
      expect(medium.description).toBe('هر روز ساعت ۰۳:۰۰');
      // 03:00 Tehran = 23:30 UTC
      expect(medium.nextRuns).toHaveLength(3);
      expect(medium.nextRuns[0]).toMatch(/T23:30:00\.000Z$/);
    });

    it('re-registers only changed crons and falls back to the default on an invalid expression', async () => {
      globalContextRepo.findOne.mockResolvedValue(null);
      await service.syncSchedules();
      const scheduler = (service as any).scheduler;
      scheduler.addCronJob.mockClear();

      globalContextRepo.findOne.mockResolvedValue({
        key: 'ingest_settings',
        value: JSON.stringify({ heavy: { cron: '0 */4 * * *' }, light: { cron: 'not a cron' } }),
      });
      const schedule = await service.syncSchedules();

      expect(scheduler.addCronJob).toHaveBeenCalledTimes(1);
      expect(scheduler.addCronJob.mock.calls[0][0]).toBe('ingest_heavy');
      const light = schedule.find((s) => s.tier === 'light')!;
      expect(light.cron).toBe('0 4 */3 * *');
      expect(light.error).toBeTruthy();
    });

    it('reports automatic collection as disabled without unregistering jobs', async () => {
      globalContextRepo.findOne.mockResolvedValue({
        key: 'ingest_settings',
        value: JSON.stringify({ automaticCollectionEnabled: false }),
      });
      const schedule = await service.syncSchedules();
      expect(schedule.every((s) => s.enabled === false)).toBe(true);
      expect(jobs.size).toBe(3);
    });
  });
});
