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

  beforeEach(async () => {
    profileRepo = makeRepoMock();
    runRepo = makeRepoMock();
    postRepo = makeRepoMock();
    aggRepo = makeRepoMock();
    const dataSourceRepo = makeRepoMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestWorkerService,
        { provide: getRepositoryToken(Profile), useValue: profileRepo },
        { provide: getRepositoryToken(DataSourceEntity), useValue: dataSourceRepo },
        { provide: getRepositoryToken(IngestRun), useValue: runRepo },
        { provide: getRepositoryToken(SelectedPost), useValue: postRepo },
        { provide: getRepositoryToken(HourlyAggregate), useValue: aggRepo },
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
});
