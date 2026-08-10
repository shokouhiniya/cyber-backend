import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BatchSentimentService } from './batch-sentiment.service';
import { SelectedPost } from './selected-post.entity';
import { PromticService } from '../../libs/promtic';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const makePostRepo = () => ({
  query: jest.fn().mockResolvedValue(undefined),
});

const makePromtic = () => ({
  invoke: jest.fn(),
});

const profileIdentifier = { external_id: 'ghalibaf', name: 'محمدباقر قالیباف' };

const fakePost = (id: string, text = 'متن نمونه'): { id: string; text: string } => ({ id, text });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BatchSentimentService', () => {
  let service: BatchSentimentService;
  let postRepo: ReturnType<typeof makePostRepo>;
  let promtic: ReturnType<typeof makePromtic>;

  beforeEach(async () => {
    postRepo = makePostRepo();
    promtic = makePromtic();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BatchSentimentService,
        { provide: getRepositoryToken(SelectedPost), useValue: postRepo },
        { provide: PromticService, useValue: promtic },
      ],
    }).compile();

    service = module.get<BatchSentimentService>(BatchSentimentService);
    jest.clearAllMocks();
  });

  it('returns early without calling Promtic when posts list is empty', async () => {
    await service.classifyForProfile([], profileIdentifier);
    expect(promtic.invoke).not.toHaveBeenCalled();
    expect(postRepo.query).not.toHaveBeenCalled();
  });

  it('sends posts to Promtic and persists parsed results', async () => {
    const posts = [fakePost('uuid-1', 'پست اول'), fakePost('uuid-2', 'پست دوم')];

    promtic.invoke.mockResolvedValue(JSON.stringify([
      { id: 1, sentiment: 'positive', political_spectrum: 'reformist', relevance_score: 5, bot_probability: 1, reasoning_brief: 'مثبت', keywords: ['مجلس', 'قالیباف'] },
      { id: 2, sentiment: 'negative', political_spectrum: 'hardliner', relevance_score: 4, bot_probability: 2, reasoning_brief: 'منفی', keywords: ['اقتصاد'] },
    ]));

    await service.classifyForProfile(posts, profileIdentifier);

    expect(promtic.invoke).toHaveBeenCalledTimes(1);
    const invokeArg = promtic.invoke.mock.calls[0][0];
    expect(invokeArg.promptName).toBe('batch_sentiment');
    expect(invokeArg.identifier.external_id).toBe('ghalibaf');
    expect(invokeArg.inputVars.posts_batch).toContain('پست اول');
    expect(invokeArg.inputVars.posts_batch).toContain('پست دوم');

    expect(postRepo.query).toHaveBeenCalledTimes(1);
    const sqlArgs = postRepo.query.mock.calls[0][1];
    expect(sqlArgs[0]).toEqual(['uuid-1', 'uuid-2']);
    expect(sqlArgs[1]).toEqual(['positive', 'negative']);
  });

  it('strips markdown fences from Promtic response before parsing', async () => {
    const posts = [fakePost('uuid-1', 'tester')];
    promtic.invoke.mockResolvedValue('```json\n[{"id":1,"sentiment":"neutral","political_spectrum":"centrist","relevance_score":3,"bot_probability":0,"reasoning_brief":"","keywords":[]}]\n```');

    await service.classifyForProfile(posts, profileIdentifier);

    expect(postRepo.query).toHaveBeenCalled();
    const sqlArgs = postRepo.query.mock.calls[0][1];
    expect(sqlArgs[1]).toEqual(['neutral']);
  });

  it('continues processing remaining batches when a single batch errors', async () => {
    // 51 posts → 3 batches of 25/25/1
    const posts = Array.from({ length: 51 }, (_, i) => fakePost(`uuid-${i}`, `پست ${i}`));

    promtic.invoke
      .mockResolvedValueOnce(JSON.stringify(
        Array.from({ length: 25 }, (_, i) => ({ id: i + 1, sentiment: 'positive', political_spectrum: 'centrist', relevance_score: 4, bot_probability: 1, reasoning_brief: '', keywords: [] }))
      ))
      .mockRejectedValueOnce(new Error('Promtic timeout'))
      .mockResolvedValueOnce(JSON.stringify([
        { id: 1, sentiment: 'negative', political_spectrum: 'centrist', relevance_score: 4, bot_probability: 1, reasoning_brief: '', keywords: [] },
      ]));

    await expect(service.classifyForProfile(posts, profileIdentifier)).resolves.not.toThrow();

    // Two successful batches → two persist calls
    expect(promtic.invoke).toHaveBeenCalledTimes(3);
    expect(postRepo.query).toHaveBeenCalledTimes(2);
  });

  it('drops items whose id index is out of bounds', async () => {
    const posts = [fakePost('uuid-1', 'one')];
    // Promtic returns id=2 even though only 1 post was sent — should be ignored
    promtic.invoke.mockResolvedValue(JSON.stringify([
      { id: 2, sentiment: 'positive', political_spectrum: 'centrist', relevance_score: 4, bot_probability: 1, reasoning_brief: '', keywords: [] },
    ]));

    await service.classifyForProfile(posts, profileIdentifier);

    // No items collected → no SQL update issued
    expect(postRepo.query).not.toHaveBeenCalled();
  });
});
