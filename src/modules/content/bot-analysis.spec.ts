import { classifyAccount, summariseBotAnalysis } from './bot-analysis';

describe('bot-analysis', () => {
  it('classifies by average bot probability', () => {
    expect(classifyAccount(95)).toBe('bot');
    expect(classifyAccount(60)).toBe('bot');
    expect(classifyAccount(59.9)).toBe('suspicious');
    expect(classifyAccount(30)).toBe('suspicious');
    expect(classifyAccount(29.99)).toBe('human');
    expect(classifyAccount(0)).toBe('human');
    expect(classifyAccount(null)).toBe('unscored');
    expect(classifyAccount(80, 0)).toBe('unscored');
  });

  it('counts accounts and posts per class and lists the top suspicious accounts', () => {
    const res = summariseBotAnalysis([
      { handle: 'farm_1', platform: 'twitter', posts: 10, scoredPosts: 10, avgProbability: 82 },
      { handle: 'farm_2', platform: 'telegram', posts: 4, scoredPosts: 4, avgProbability: 82 },
      { handle: 'odd', platform: 'twitter', posts: 3, scoredPosts: 2, avgProbability: 45 },
      { handle: 'alice', platform: 'twitter', posts: 20, scoredPosts: 20, avgProbability: 8 },
      { handle: 'new', platform: 'instagram', posts: 3, scoredPosts: 0, avgProbability: null },
    ]);
    const by = Object.fromEntries(res.classes.map((c) => [c.key, c]));
    expect(res.totalAccounts).toBe(5);
    expect(res.totalPosts).toBe(40);
    expect(by.bot).toMatchObject({ accounts: 2, posts: 14, accountPercent: 40, postPercent: 35 });
    expect(by.suspicious).toMatchObject({ accounts: 1, posts: 3, accountPercent: 20, postPercent: 7.5 });
    expect(by.human).toMatchObject({ accounts: 1, posts: 20 });
    expect(by.unscored).toMatchObject({ accounts: 1, posts: 3, label: 'تحلیل‌نشده' });
    // Highest average first, ties broken by post count; humans / unscored never listed
    expect(res.topSuspicious.map((a) => a.handle)).toEqual(['farm_1', 'farm_2', 'odd']);
    expect(res.topSuspicious[2]).toMatchObject({ platform: 'twitter', avgProbability: 45, postCount: 3, class: 'suspicious' });
    expect(res.criterion).toEqual({ botMin: 60, suspiciousMin: 30 });
  });

  it('handles an empty period', () => {
    const res = summariseBotAnalysis([]);
    expect(res.totalAccounts).toBe(0);
    expect(res.classes.every((c) => c.accounts === 0 && c.accountPercent === 0)).toBe(true);
    expect(res.topSuspicious).toEqual([]);
  });
});
