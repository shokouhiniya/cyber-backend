import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AiContentService } from './ai-content.service';
import { Profile } from '../profile/profile.entity';
import { SelectedPost } from '../ingest/selected-post.entity';
import { IngestRun } from '../ingest/ingest-run.entity';
import { AiResultCache } from '../ingest/ai-result-cache.entity';
import { PromticService } from '../../libs/promtic';
import { GlobalContextService } from '../admin/global-context/global-context.service';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const makeRepoMock = () => ({
  findOne: jest.fn(),
  query: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    orUpdate: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  })),
});

const mockPromtic = {
  invokeWithMeta: jest.fn(),
};

const mockGlobalContext = {
  asInputVars: jest.fn().mockResolvedValue({}),
};

const mockProfile = {
  id: 'profile-1',
  promticIdentifier: { external_id: 'test_slug', name: 'Test Profile', type: 'political_figure' },
};

const mockRun = {
  id: 'run-1',
  profileId: 'profile-1',
  status: 'completed',
  finishedAt: new Date(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AiContentService', () => {
  let service: AiContentService;
  let profileRepo: ReturnType<typeof makeRepoMock>;
  let postRepo: ReturnType<typeof makeRepoMock>;
  let runRepo: ReturnType<typeof makeRepoMock>;
  let cacheRepo: ReturnType<typeof makeRepoMock>;

  beforeEach(async () => {
    profileRepo = makeRepoMock();
    postRepo = makeRepoMock();
    runRepo = makeRepoMock();
    cacheRepo = makeRepoMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiContentService,
        { provide: getRepositoryToken(Profile), useValue: profileRepo },
        { provide: getRepositoryToken(SelectedPost), useValue: postRepo },
        { provide: getRepositoryToken(IngestRun), useValue: runRepo },
        { provide: getRepositoryToken(AiResultCache), useValue: cacheRepo },
        { provide: PromticService, useValue: mockPromtic },
        { provide: GlobalContextService, useValue: mockGlobalContext },
      ],
    }).compile();

    service = module.get<AiContentService>(AiContentService);
    jest.clearAllMocks();
  });

  // ── Cache hit ───────────────────────────────────────────────────────────────

  describe('cache behaviour', () => {
    it('returns cached result without calling Promtic', async () => {
      profileRepo.findOne.mockResolvedValue(mockProfile);
      runRepo.findOne.mockResolvedValue(mockRun);
      cacheRepo.findOne.mockResolvedValue({
        result: '{"summary":"cached result"}',
        modelName: 'gpt-4o-mini',
        latencyMs: 500,
      });

      const result = await service.generateAiSummary('test_slug', 'profile-1');

      expect(result.text).toBe('{"summary":"cached result"}');
      expect(result.meta.cached).toBe(true);
      expect(mockPromtic.invokeWithMeta).not.toHaveBeenCalled();
    });

    it('calls Promtic on cache miss and saves result', async () => {
      profileRepo.findOne.mockResolvedValue(mockProfile);
      runRepo.findOne.mockResolvedValue(mockRun);
      cacheRepo.findOne.mockResolvedValue(null); // cache miss

      // Mock data queries — use the full repo mock shape
      postRepo.query.mockResolvedValue([{ total: '10', positive: '5', negative: '3', neutral_count: '2' }]);

      mockPromtic.invokeWithMeta.mockResolvedValue({
        result: '{"summary":"fresh result"}',
        modelName: 'gpt-4o-mini',
        latencyMs: 1200,
        tokenUsage: { prompt: 300, completion: 100, total: 400 },
      });

      const result = await service.generateAiSummary('test_slug', 'profile-1');

      expect(mockPromtic.invokeWithMeta).toHaveBeenCalledTimes(1);
      expect(result.text).toBe('{"summary":"fresh result"}');
      // Cache should have been written
      expect(cacheRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it('uses null runId when no completed run exists', async () => {
      profileRepo.findOne.mockResolvedValue(mockProfile);
      runRepo.findOne.mockResolvedValue(null); // no run yet
      cacheRepo.findOne.mockResolvedValue(null);

      postRepo.query.mockResolvedValue([{ total: '0', positive: '0', negative: '0', neutral_count: '0' }]);

      mockPromtic.invokeWithMeta.mockResolvedValue({
        result: '{"summary":"no run result"}',
        modelName: 'gpt-4o-mini',
        latencyMs: 800,
        tokenUsage: null,
      });

      // Should not throw even with no run
      await expect(service.generateAiSummary('test_slug', 'profile-1')).resolves.toBeDefined();
    });
  });

  // ── Identifier resolution ───────────────────────────────────────────────────

  describe('identifier resolution', () => {
    it('uses profile promticIdentifier when available', async () => {
      profileRepo.findOne.mockResolvedValue(mockProfile);
      runRepo.findOne.mockResolvedValue(mockRun);
      cacheRepo.findOne.mockResolvedValue(null);
      postRepo.query.mockResolvedValue([{ total: '0', positive: '0', negative: '0', neutral_count: '0' }]);
      mockPromtic.invokeWithMeta.mockResolvedValue({ result: '{}', modelName: 'gpt-4o-mini', latencyMs: 100, tokenUsage: null });

      await service.generateAiSummary('fallback_org', 'profile-1');

      const call = mockPromtic.invokeWithMeta.mock.calls[0][0];
      expect(call.identifier.external_id).toBe('test_slug');
    });

    it('falls back to orgId when profile has no promticIdentifier', async () => {
      profileRepo.findOne.mockResolvedValue({ id: 'profile-1', promticIdentifier: null });
      runRepo.findOne.mockResolvedValue(mockRun);
      cacheRepo.findOne.mockResolvedValue(null);
      postRepo.query.mockResolvedValue([{ total: '0', positive: '0', negative: '0', neutral_count: '0' }]);
      mockPromtic.invokeWithMeta.mockResolvedValue({ result: '{}', modelName: 'gpt-4o-mini', latencyMs: 100, tokenUsage: null });

      await service.generateAiSummary('fallback_org', 'profile-1');

      const call = mockPromtic.invokeWithMeta.mock.calls[0][0];
      expect(call.identifier.external_id).toBe('fallback_org');
    });
  });

  // ── generateAll ─────────────────────────────────────────────────────────────

  describe('generateAll', () => {
    it('returns results for all 4 LLM sections', async () => {
      profileRepo.findOne.mockResolvedValue(mockProfile);
      runRepo.findOne.mockResolvedValue(mockRun);
      cacheRepo.findOne.mockResolvedValue({ result: '{"ok":true}', modelName: 'gpt-4o-mini', latencyMs: 100 });

      const results = await service.generateAll('test_slug', 'profile-1');

      // political_spectrum is now DB-computed and no longer part of generateAll
      expect(Object.keys(results)).toEqual(
        expect.arrayContaining([
          'ai_summary', 'macro_context',
          'recommendations', 'narrative_gap',
        ]),
      );
    });

    it('includes error entry when one section fails', async () => {
      profileRepo.findOne.mockResolvedValue(mockProfile);
      runRepo.findOne.mockResolvedValue(mockRun);

      // First call (ai_summary) throws, rest return cached
      cacheRepo.findOne
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValue({ result: '{"ok":true}', modelName: 'gpt-4o-mini', latencyMs: 100 });

      const results = await service.generateAll('test_slug', 'profile-1');

      expect(results.ai_summary.text).toContain('[ERROR]');
      // Other sections should still succeed
      expect(results.macro_context.text).toBe('{"ok":true}');
    });
  });

  // ── Stats context format ────────────────────────────────────────────────────

  describe('stats context', () => {
    it('includes percentage breakdown in stats string', async () => {
      profileRepo.findOne.mockResolvedValue(mockProfile);
      runRepo.findOne.mockResolvedValue(mockRun);
      cacheRepo.findOne.mockResolvedValue(null);

      postRepo.query.mockResolvedValue([
        { total: '100', positive: '60', negative: '30', neutral_count: '10' },
      ]);

      let capturedInputVars: any;
      mockPromtic.invokeWithMeta.mockImplementation((opts) => {
        capturedInputVars = opts.inputVars;
        return Promise.resolve({ result: '{}', modelName: 'gpt-4o-mini', latencyMs: 100, tokenUsage: null });
      });

      await service.generateAiSummary('test_slug', 'profile-1');

      expect(capturedInputVars.stats).toContain('60%');
      expect(capturedInputVars.stats).toContain('30%');
    });
  });
});
