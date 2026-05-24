import { Test, TestingModule } from '@nestjs/testing';
import { SampleSelectorService } from './sample-selector.service';
import { DataSourceApiService } from '../data-source/data-source-api.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePost(overrides: Partial<any> = {}): any {
  return {
    id: Math.random().toString(36).slice(2),
    text: 'متن پست نمونه برای تست',
    sourceType: 'telegram',
    screenName: 'test_channel',
    displayName: null,
    publishedAt: new Date().toISOString(),
    viewCount: 1000,
    likeCount: 50,
    retweetCount: 10,
    replyCount: 5,
    sentiment: 'neutral',
    reactions: null,
    hashtags: [],
    postUrl: null,
    mediaUrl: null,
    profileImageUrl: null,
    selectionReason: '',
    simhash: '',
    canonicalId: null,
    ...overrides,
  };
}

// ── Mock DataSourceApiService ─────────────────────────────────────────────────

const mockApiService = {
  search8tag: jest.fn(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SampleSelectorService', () => {
  let service: SampleSelectorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SampleSelectorService,
        { provide: DataSourceApiService, useValue: mockApiService },
      ],
    }).compile();

    service = module.get<SampleSelectorService>(SampleSelectorService);
    jest.clearAllMocks();
  });

  // ── Quota computation ───────────────────────────────────────────────────────

  describe('computeQuotas (via select)', () => {
    it('returns zero quota for eitaa by default', async () => {
      mockApiService.search8tag.mockResolvedValue({ data: [] });

      const result = await service.select(
        { username: 'u', password: 'p' },
        { or: 'test', targetSize: 76 },
      );

      // eitaa should not have been fetched (quota = 0)
      const eitaaCalls = mockApiService.search8tag.mock.calls.filter(
        (c) => c[1]?.source === 'eitaa',
      );
      expect(eitaaCalls).toHaveLength(0);
    });

    it('respects weight multiplier — doubled weight doubles quota', async () => {
      mockApiService.search8tag.mockResolvedValue({ data: [] });

      await service.select(
        { username: 'u', password: 'p' },
        { or: 'test', targetSize: 76, sourceWeights: { telegram: 2.0 } },
      );

      const telegramCall = mockApiService.search8tag.mock.calls.find(
        (c) => c[1]?.source === 'telegram',
      );
      const defaultCall_size = 12 * 4; // default quota * 4 over-fetch
      // With weight 2.0, quota doubles → fetch size should be larger
      expect(telegramCall[1].size).toBeGreaterThan(defaultCall_size);
    });

    it('weight = 0 disables a source', async () => {
      mockApiService.search8tag.mockResolvedValue({ data: [] });

      await service.select(
        { username: 'u', password: 'p' },
        { or: 'test', targetSize: 76, sourceWeights: { telegram: 0 } },
      );

      const telegramCalls = mockApiService.search8tag.mock.calls.filter(
        (c) => c[1]?.source === 'telegram',
      );
      expect(telegramCalls).toHaveLength(0);
    });
  });

  // ── Parallel fetch ──────────────────────────────────────────────────────────

  describe('parallel fetch', () => {
    it('fetches all active sources in parallel (Promise.allSettled)', async () => {
      mockApiService.search8tag.mockResolvedValue({ data: [] });

      await service.select(
        { username: 'u', password: 'p' },
        { or: 'test', targetSize: 76 },
      );

      // 10 active sources (eitaa excluded by default quota=0)
      expect(mockApiService.search8tag).toHaveBeenCalledTimes(10);
    });

    it('continues when one source fails', async () => {
      mockApiService.search8tag
        .mockRejectedValueOnce(new Error('API timeout'))  // first call fails
        .mockResolvedValue({ data: [makePost()] });        // rest succeed

      const result = await service.select(
        { username: 'u', password: 'p' },
        { or: 'test', targetSize: 76 },
      );

      // Should not throw; should return posts from the successful sources
      expect(result.posts).toBeDefined();
      expect(result.stats.fetchedPerSource).toBeDefined();
    });

    it('passes or/not/range/sort to each source call', async () => {
      mockApiService.search8tag.mockResolvedValue({ data: [] });

      await service.select(
        { username: 'u', password: 'p' },
        { or: 'قالیباف', not: 'تبلیغ', range: 'month', targetSize: 76 },
      );

      const firstCall = mockApiService.search8tag.mock.calls[0][1];
      expect(firstCall.or).toBe('قالیباف');
      expect(firstCall.not).toBe('تبلیغ');
      expect(firstCall.range).toBe('month');
      expect(firstCall.lang).toBe('fa');
      expect(firstCall.forward).toBe('false');
    });
  });

  // ── Simhash dedup ───────────────────────────────────────────────────────────

  describe('simhash deduplication', () => {
    it('removes near-duplicate posts (same text)', async () => {
      const sameText = 'محمدباقر قالیباف در جلسه مجلس سخنرانی کرد';
      const posts = [
        makePost({ id: '1', text: sameText, sourceType: 'telegram', viewCount: 5000 }),
        makePost({ id: '2', text: sameText, sourceType: 'bale',     viewCount: 100 }),
        makePost({ id: '3', text: sameText, sourceType: 'rubika',   viewCount: 200 }),
      ];

      mockApiService.search8tag.mockImplementation((_creds, params) => {
        const src = params.source;
        const srcPosts = posts.filter((p) => p.sourceType === src);
        return Promise.resolve({ data: srcPosts });
      });

      const result = await service.select(
        { username: 'u', password: 'p' },
        { or: 'قالیباف', targetSize: 76 },
      );

      // All three are near-identical — only the highest-engagement one should survive
      const selectedIds = result.posts.map((p) => p.id);
      expect(selectedIds).toContain('1');   // highest views → canonical
      expect(selectedIds).not.toContain('2');
      expect(selectedIds).not.toContain('3');
    });

    it('keeps posts with different content', async () => {
      const posts = [
        makePost({ id: 'a', text: 'قالیباف در مجلس گفت که بودجه تصویب شد', sourceType: 'telegram' }),
        makePost({ id: 'b', text: 'ظریف در مصاحبه از مذاکرات هسته‌ای گفت', sourceType: 'telegram' }),
        makePost({ id: 'c', text: 'روحانی در سخنرانی از دولت انتقاد کرد', sourceType: 'telegram' }),
      ];

      mockApiService.search8tag.mockImplementation((_creds, params) => {
        if (params.source === 'telegram') return Promise.resolve({ data: posts });
        return Promise.resolve({ data: [] });
      });

      const result = await service.select(
        { username: 'u', password: 'p' },
        { or: 'test', targetSize: 76 },
      );

      const selectedIds = result.posts.map((p) => p.id);
      expect(selectedIds).toContain('a');
      expect(selectedIds).toContain('b');
      expect(selectedIds).toContain('c');
    });

    it('dedup stats are reported correctly', async () => {
      const text = 'متن تکراری برای تست';
      const posts = Array.from({ length: 5 }, (_, i) =>
        makePost({ id: String(i), text, sourceType: 'telegram' }),
      );

      mockApiService.search8tag.mockImplementation((_creds, params) => {
        if (params.source === 'telegram') return Promise.resolve({ data: posts });
        return Promise.resolve({ data: [] });
      });

      const result = await service.select(
        { username: 'u', password: 'p' },
        { or: 'test', targetSize: 76 },
      );

      expect(result.stats.afterFilter).toBe(5);
      expect(result.stats.afterDedup).toBe(1);
    });
  });

  // ── Per-source quota application ────────────────────────────────────────────

  describe('quota application', () => {
    it('caps each source at its quota', async () => {
      // Return 50 posts for telegram (quota is 12)
      const telegramPosts = Array.from({ length: 50 }, (_, i) =>
        makePost({ id: `tg-${i}`, text: `پست تلگرام شماره ${i} متن کاملاً متفاوت`, sourceType: 'telegram' }),
      );

      mockApiService.search8tag.mockImplementation((_creds, params) => {
        if (params.source === 'telegram') return Promise.resolve({ data: telegramPosts });
        return Promise.resolve({ data: [] });
      });

      const result = await service.select(
        { username: 'u', password: 'p' },
        { or: 'test', targetSize: 76 },
      );

      const telegramSelected = result.posts.filter((p) => p.sourceType === 'telegram');
      expect(telegramSelected.length).toBeLessThanOrEqual(12);
    });

    it('selection_reason is set on each post', async () => {
      mockApiService.search8tag.mockImplementation((_creds, params) => {
        if (params.source === 'telegram') {
          return Promise.resolve({ data: [makePost({ sourceType: 'telegram' })] });
        }
        return Promise.resolve({ data: [] });
      });

      const result = await service.select(
        { username: 'u', password: 'p' },
        { or: 'test', targetSize: 76 },
      );

      const telegramPost = result.posts.find((p) => p.sourceType === 'telegram');
      expect(telegramPost?.selectionReason).toContain('telegram');
    });
  });
});
