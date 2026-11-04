import {
  AccountRow, accountSignals, classifyAccount, handlePatternScore, scoreAccount, summariseBotAnalysis,
} from './bot-analysis';

const acct = (over: Partial<AccountRow>): AccountRow => ({
  handle: 'ali_reza',
  displayName: 'علی رضایی',
  platform: 'twitter',
  posts: 6,
  scoredPosts: 6,
  avgProbability: 10,
  dupPosts: 0,
  burstPosts: 0,
  activeDays: 4,
  hasAvatar: true,
  followers: 1200,
  ...over,
});

describe('handlePatternScore', () => {
  it('flags generated-looking handles only', () => {
    expect(handlePatternScore('user84512')).toBe(1);
    expect(handlePatternScore('maryam12345678')).toBe(1);
    expect(handlePatternScore('news_bot_99812')).toBe(0.8);
    expect(handlePatternScore('a1b2c3d4e5')).toBe(0.7);
    expect(handlePatternScore('xkqzrtvbn')).toBe(0.6);
    expect(handlePatternScore('reza1990')).toBe(0.3);
    expect(handlePatternScore('ali_reza')).toBe(0);
    expect(handlePatternScore('کانال_خبری')).toBe(0); // non-Latin handles: no opinion
    expect(handlePatternScore(null)).toBe(0);
  });
});

describe('scoreAccount', () => {
  it('a normal account is human with no reasons', () => {
    const s = scoreAccount(acct({}));
    expect(s.class).toBe('human');
    expect(s.score).toBeLessThan(35);
    expect(s.reasons).toEqual([]);
    expect(s.confidence).toBe('high');
  });

  it('copy-paste + bursts + generated handle → bot, with the reasons ranked', () => {
    const s = scoreAccount(acct({
      handle: 'user7781234', displayName: null, hasAvatar: false, followers: 3,
      avgProbability: 40, posts: 10, scoredPosts: 10, dupPosts: 8, burstPosts: 6, activeDays: 1,
    }));
    expect(s.class).toBe('bot');
    expect(s.score).toBeGreaterThanOrEqual(90);
    expect(s.reasons.map((r) => r.key)).toEqual(['duplicate', 'burst', 'followers']);
    expect(s.reasons[0].label).toBe('80٪ پست‌ها هم‌متن با حساب‌های دیگر');
    expect(s.reasons[1].label).toBe('6 پست با فاصلهٔ کمتر از ۲ دقیقه');
    expect(s.confidence).toBe('high');
  });

  it('a single weak heuristic never makes a bot', () => {
    const s = scoreAccount(acct({ handle: 'user99887766', scoredPosts: 0, avgProbability: null, posts: 1, activeDays: 1 }));
    // handle alone: 0.3 × 1 = 30 → stays below the suspicious line
    expect(s.class).toBe('human');
    expect(s.score).toBe(30);
  });

  it('LLM alone: bot only with a high average over enough scored posts', () => {
    expect(scoreAccount(acct({ avgProbability: 90, scoredPosts: 5, posts: 5 })).class).toBe('bot');
    // high but only 2 scored posts → not corroborated
    const few = scoreAccount(acct({ avgProbability: 90, scoredPosts: 2, posts: 2 }));
    expect(few.class).toBe('suspicious');
    expect(few.confidence).not.toBe('high');
    // 72 avg, nothing else → suspicious
    expect(scoreAccount(acct({ avgProbability: 72 })).class).toBe('suspicious');
    // LLM 72 + bursts → corroborated bot
    expect(scoreAccount(acct({ avgProbability: 72, burstPosts: 4 })).class).toBe('bot');
  });

  it('accounts with no LLM score and no fired signal are unscored', () => {
    const s = scoreAccount(acct({ scoredPosts: 0, avgProbability: null, posts: 1 }));
    expect(s.class).toBe('unscored');
    expect(s.confidence).toBe('low');
  });

  it('one shared headline is not treated as copy-paste', () => {
    const sig = accountSignals(acct({ posts: 6, dupPosts: 1 })).find((x) => x.key === 'duplicate')!;
    expect(sig.fired).toBe(false);
    // a single post that is a copy weighs only a third
    const one = accountSignals(acct({ posts: 1, dupPosts: 1 })).find((x) => x.key === 'duplicate')!;
    expect(one.contribution).toBeCloseTo(0.7 / 3, 2);
  });

  it('platform-specific signals are skipped where they mean nothing', () => {
    const news = accountSignals(acct({ platform: 'news', handle: 'user123456', hasAvatar: false, followers: 2 }));
    expect(news.map((s) => s.key)).not.toEqual(expect.arrayContaining(['handle']));
    expect(news.map((s) => s.key)).not.toContain('profile');
    expect(news.map((s) => s.key)).not.toContain('followers');
    // outlets syndicate text: no duplicate signal for news / newspaper / aparat
    expect(accountSignals(acct({ platform: 'newspaper', dupPosts: 6 })).map((s) => s.key)).not.toContain('duplicate');
    // Telegram "followers" are channel members, not a person's followers
    expect(accountSignals(acct({ platform: 'telegram', followers: 2 })).map((s) => s.key)).not.toContain('followers');
  });

  it('classifyAccount keeps working for an LLM-only average', () => {
    expect(classifyAccount(95, 5)).toBe('bot');
    expect(classifyAccount(50)).toBe('suspicious');
    expect(classifyAccount(10)).toBe('human');
    expect(classifyAccount(null)).toBe('unscored');
    expect(classifyAccount(80, 0)).toBe('unscored');
  });
});

describe('summariseBotAnalysis', () => {
  it('counts classes, ranks the top accounts by score and explains them', () => {
    const res = summariseBotAnalysis([
      acct({ handle: 'farm_1', avgProbability: 82, posts: 10, scoredPosts: 10, dupPosts: 9, burstPosts: 5 }),
      acct({ handle: 'farm_2', platform: 'telegram', avgProbability: 70, posts: 4, scoredPosts: 4, dupPosts: 4 }),
      acct({ handle: 'odd', avgProbability: 45, posts: 3, scoredPosts: 2 }),
      acct({ handle: 'alice', avgProbability: 8, posts: 20, scoredPosts: 20, activeDays: 10 }),
      acct({ handle: 'new', platform: 'instagram', posts: 3, scoredPosts: 0, avgProbability: null, followers: null }),
    ]);
    const by = Object.fromEntries(res.classes.map((c) => [c.key, c]));
    expect(res.totalAccounts).toBe(5);
    expect(res.totalPosts).toBe(40);
    expect(by.bot).toMatchObject({ accounts: 2, posts: 14, accountPercent: 40, postPercent: 35 });
    expect(by.suspicious).toMatchObject({ accounts: 1, posts: 3 });
    expect(by.human).toMatchObject({ accounts: 1, posts: 20 });
    expect(by.unscored).toMatchObject({ accounts: 1, posts: 3, label: 'تحلیل‌نشده' });
    expect(res.topSuspicious.map((a) => a.handle)).toEqual(['farm_1', 'farm_2', 'odd']);
    expect(res.topSuspicious[0]).toMatchObject({ class: 'bot', confidence: 'high', confidenceLabel: 'بالا', avgProbability: 82 });
    expect(res.topSuspicious[0].reasons[0].key).toBe('duplicate');
    expect(res.topSuspicious[2]).toMatchObject({ platform: 'twitter', postCount: 3, class: 'suspicious' });
    expect(res.criterion).toMatchObject({ botMin: 60, suspiciousMin: 35, method: 'signals' });
    expect(res.reasonCounts.find((r) => r.key === 'duplicate')).toMatchObject({ accounts: 2 });
    expect(res.flaggedConfidence.high + res.flaggedConfidence.medium + res.flaggedConfidence.low).toBe(3);
  });

  it('handles an empty period', () => {
    const res = summariseBotAnalysis([]);
    expect(res.totalAccounts).toBe(0);
    expect(res.classes.every((c) => c.accounts === 0 && c.accountPercent === 0)).toBe(true);
    expect(res.topSuspicious).toEqual([]);
    expect(res.reasonCounts).toEqual([]);
  });
});
