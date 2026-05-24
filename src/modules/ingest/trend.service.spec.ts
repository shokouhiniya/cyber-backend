import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TrendService } from './trend.service';
import { HourlyAggregate } from './hourly-aggregate.entity';
import { IngestRun } from './ingest-run.entity';
import { SelectedPost } from './selected-post.entity';

const makeRepoMock = () => ({
  findOne: jest.fn(),
  query: jest.fn(),
});

describe('TrendService', () => {
  let service: TrendService;
  let aggRepo: ReturnType<typeof makeRepoMock>;
  let runRepo: ReturnType<typeof makeRepoMock>;
  let postRepo: ReturnType<typeof makeRepoMock>;

  beforeEach(async () => {
    aggRepo = makeRepoMock();
    runRepo = makeRepoMock();
    postRepo = makeRepoMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrendService,
        { provide: getRepositoryToken(HourlyAggregate), useValue: aggRepo },
        { provide: getRepositoryToken(IngestRun), useValue: runRepo },
        { provide: getRepositoryToken(SelectedPost), useValue: postRepo },
      ],
    }).compile();

    service = module.get<TrendService>(TrendService);
    jest.clearAllMocks();
  });

  // ── getTrend structure ──────────────────────────────────────────────────────

  describe('getTrend', () => {
    beforeEach(() => {
      runRepo.findOne.mockResolvedValue({
        id: 'run-1', finishedAt: new Date(), status: 'completed',
      });
      // hourly rows
      aggRepo.query.mockResolvedValue([]);
      // source shares
      postRepo.query.mockResolvedValue([
        { source_type: 'telegram', post_count: '40', total_views: '50000', positive_count: '20', negative_count: '10' },
        { source_type: 'news',     post_count: '20', total_views: '30000', positive_count: '10', negative_count: '5' },
      ]);
    });

    it('returns the expected shape', async () => {
      const result = await service.getTrend('profile-1', 24);

      expect(result).toMatchObject({
        profileId: 'profile-1',
        windowHours: 24,
        trend: expect.any(Array),
        sourceShares: expect.any(Array),
        spikes: expect.any(Array),
        sentimentShift: expect.objectContaining({
          positiveDelta: expect.any(Number),
          negativeDelta: expect.any(Number),
          neutralDelta: expect.any(Number),
        }),
      });
    });

    it('computes source share percentages correctly', async () => {
      const result = await service.getTrend('profile-1', 24);

      const telegram = result.sourceShares.find((s) => s.sourceType === 'telegram');
      const news = result.sourceShares.find((s) => s.sourceType === 'news');

      expect(telegram?.postCount).toBe(40);
      expect(news?.postCount).toBe(20);
      // 40 out of 60 total = 67%
      expect(telegram?.pct).toBe(67);
      // 20 out of 60 = 33%
      expect(news?.pct).toBe(33);
    });

    it('returns empty trend when no aggregates exist', async () => {
      aggRepo.query.mockResolvedValue([]);
      postRepo.query.mockResolvedValue([]);

      const result = await service.getTrend('profile-1', 24);

      expect(result.trend).toHaveLength(0);
      expect(result.sourceShares).toHaveLength(0);
      expect(result.totalPostsInWindow).toBe(0);
    });
  });

  // ── Spike detection ─────────────────────────────────────────────────────────

  describe('spike detection', () => {
    it('detects a spike when current volume doubles vs baseline', async () => {
      runRepo.findOne.mockResolvedValue({ id: 'run-1', finishedAt: new Date() });
      postRepo.query.mockResolvedValue([]);

      // aggRepo.query is called 3 times: hourly trend, curr sentiment, prev sentiment, spikes
      aggRepo.query
        .mockResolvedValueOnce([])   // hourly trend
        .mockResolvedValueOnce([])   // curr sentiment
        .mockResolvedValueOnce([])   // prev sentiment
        .mockResolvedValueOnce([     // spike detection
          {
            source_type: 'telegram',
            sentiment: 'all',
            curr_posts: '200',
            prev_posts: '50',
            curr_views: '100000',
            prev_views: '25000',
          },
        ]);

      const result = await service.getTrend('profile-1', 24);

      expect(result.spikes).toHaveLength(1);
      expect(result.spikes[0].sourceType).toBe('telegram');
      expect(result.spikes[0].changePercent).toBe(300);
      expect(result.spikes[0].severity).toBe('high');
    });

    it('does not flag a spike below 100% increase', async () => {
      runRepo.findOne.mockResolvedValue({ id: 'run-1', finishedAt: new Date() });
      postRepo.query.mockResolvedValue([]);

      aggRepo.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            source_type: 'telegram',
            sentiment: 'all',
            curr_posts: '60',   // +50% — below threshold
            prev_posts: '40',
            curr_views: '0',
            prev_views: '0',
          },
        ]);

      const result = await service.getTrend('profile-1', 24);
      expect(result.spikes).toHaveLength(0);
    });

    it('caps spikes at 5 alerts', async () => {
      runRepo.findOne.mockResolvedValue({ id: 'run-1', finishedAt: new Date() });
      postRepo.query.mockResolvedValue([]);

      const manySpikes = Array.from({ length: 10 }, (_, i) => ({
        source_type: `source_${i}`,
        sentiment: 'all',
        curr_posts: '1000',
        prev_posts: '100',
        curr_views: '0',
        prev_views: '0',
      }));

      aggRepo.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(manySpikes);

      const result = await service.getTrend('profile-1', 24);
      expect(result.spikes.length).toBeLessThanOrEqual(5);
    });
  });

  // ── Sentiment shift ─────────────────────────────────────────────────────────

  describe('sentiment shift', () => {
    it('computes positive delta correctly', async () => {
      runRepo.findOne.mockResolvedValue({ id: 'run-1', finishedAt: new Date() });
      postRepo.query.mockResolvedValue([]);

      aggRepo.query
        .mockResolvedValueOnce([])   // hourly trend
        // curr sentiment: 60% positive
        .mockResolvedValueOnce([
          { sentiment: 'Positive', cnt: '60' },
          { sentiment: 'Negative', cnt: '20' },
          { sentiment: 'Neutral',  cnt: '20' },
        ])
        // prev sentiment: 40% positive
        .mockResolvedValueOnce([
          { sentiment: 'Positive', cnt: '40' },
          { sentiment: 'Negative', cnt: '30' },
          { sentiment: 'Neutral',  cnt: '30' },
        ])
        .mockResolvedValueOnce([]);  // spikes

      const result = await service.getTrend('profile-1', 24);

      // 60% - 40% = +20 percentage points
      expect(result.sentimentShift.positiveDelta).toBe(20);
      // 20% - 30% = -10
      expect(result.sentimentShift.negativeDelta).toBe(-10);
    });

    it('returns zero deltas when no aggregate data exists', async () => {
      runRepo.findOne.mockResolvedValue(null);
      postRepo.query.mockResolvedValue([]);
      aggRepo.query.mockResolvedValue([]);

      const result = await service.getTrend('profile-1', 24);

      expect(result.sentimentShift.positiveDelta).toBe(0);
      expect(result.sentimentShift.negativeDelta).toBe(0);
      expect(result.sentimentShift.neutralDelta).toBe(0);
    });
  });
});
