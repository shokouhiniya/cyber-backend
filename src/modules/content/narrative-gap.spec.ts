import {
  GapPost, buildExcludeSet, computeNarrativeGap, gapLevelFor, mergeNarrativeGap, tokenize,
} from './narrative-gap';

let seq = 0;
const post = (text: string, extra: Partial<GapPost> = {}): GapPost => ({ id: `p${++seq}`, text, ...extra });

const official = [
  post('طرح ساماندهی بازار مسکن و اجاره در مجلس تصویب شد', { topics: ['مسکن'], viewCount: 900 }),
  post('حمایت از مستاجران؛ طرح ساماندهی بازار اجاره مسکن', { topics: ['مسکن'], viewCount: 500 }),
  post('بودجه سال آینده با رویکرد معیشت مردم بررسی شد', { topics: ['بودجه'], viewCount: 700 }),
  post('کمیسیون تلفیق بودجه جلسه فشرده برگزار کرد', { topics: ['بودجه'], viewCount: 300 }),
];

const pub = [
  // addresses housing (shared topic)
  post('اجاره خانه دیگر قابل پرداخت نیست', { topics: ['مسکن'], sentiment: 'Negative', viewCount: 50 }),
  // addresses housing (two shared distinctive words, no topic)
  post('این طرح ساماندهی بازار هم شعار است', { sentiment: 'Negative' }),
  // addresses budget (shared topic)
  post('کسری بودجه را از جیب مردم جبران می‌کنند', { topics: ['بودجه'], sentiment: 'Negative' }),
  // public-only topics (gap)
  post('قیمت بنزین دوباره بالا رفت', { topics: ['بنزین'], sentiment: 'Negative' }),
  post('صف بنزین در شهرستان‌ها طولانی شد', { topics: ['بنزین'], sentiment: 'Neutral' }),
  post('فیلترینگ اینستاگرام کسب‌وکارها را نابود کرد', { topics: ['فیلترینگ'], sentiment: 'Negative' }),
  post('فیلترینگ را بردارید', { topics: ['فیلترینگ'], sentiment: 'Negative' }),
  post('یک پست بی‌ربط درباره فوتبال', { topics: ['ورزش'] }),
  // shares only ONE generic word with an official post → not a match
  post('جلسه امروز طولانی بود'),
];

describe('narrative-gap', () => {
  it('tokenises Persian text: stopwords, plural suffixes and Arabic letters', () => {
    expect(tokenize('وعده‌ها و كاربران در مجلس')).toEqual(['وعده', 'کاربران', 'مجلس']);
  });

  it('clusters official posts and measures real coverage over ALL public posts', () => {
    const res = computeNarrativeGap({ official, public: pub });
    expect(res.totals).toEqual({ official: 4, public: 9, covered: 3, coveredPercent: 33.3 });
    expect(res.gapLevel).toBe('medium');
    expect(res.narratives).toHaveLength(2);
    const housing = res.narratives.find((n) => n.topic === 'مسکن')!;
    const budget = res.narratives.find((n) => n.topic === 'بودجه')!;
    expect(housing).toMatchObject({ officialPosts: 2, officialShare: 50, publicPosts: 2, publicPercent: 22.2 });
    expect(housing.sentiment).toEqual({ positive: 0, negative: 2, neutral: 0 });
    expect(budget).toMatchObject({ officialPosts: 2, publicPosts: 1, publicPercent: 11.1 });
    // the gap is broken into the public's own topics; singletons fall into «other»
    expect(res.uncovered.publicPosts).toBe(6);
    expect(res.uncovered.percent).toBe(66.7);
    expect(res.uncovered.topics.map((t) => [t.topic, t.publicPosts])).toEqual([['بنزین', 2], ['فیلترینگ', 2]]);
    expect(res.uncovered.otherPosts).toBe(2);
    // every public post is accounted for exactly once
    const sum = res.narratives.reduce((s, n) => s + n.publicPosts, 0)
      + res.uncovered.topics.reduce((s, t) => s + t.publicPosts, 0) + res.uncovered.otherPosts;
    expect(sum).toBe(pub.length);
  });

  it('ignores the profile name / keywords as matching terms', () => {
    const exclude = buildExcludeSet(['قالیباف']);
    const res = computeNarrativeGap({
      official: [post('قالیباف در جلسه مجلس سخنرانی کرد')],
      public: [post('قالیباف کجاست؟ خبری نیست'), post('قالیباف باید پاسخ بدهد')],
      exclude,
    });
    expect(res.totals.covered).toBe(0);
  });

  it('returns an empty but valid result without official posts', () => {
    const res = computeNarrativeGap({ official: [], public: pub });
    expect(res.narratives).toEqual([]);
    expect(res.totals.coveredPercent).toBe(0);
    expect(res.gapLevel).toBe('high');
  });

  it('gap level thresholds', () => {
    expect(gapLevelFor(60)).toBe('low');
    expect(gapLevelFor(30)).toBe('medium');
    expect(gapLevelFor(10)).toBe('high');
  });

  it('merges LLM labels but never LLM numbers, and falls back to keyword labels', () => {
    const res = computeNarrativeGap({ official, public: pub });
    const housingId = res.narratives.find((n) => n.topic === 'مسکن')!.id;
    const llm = JSON.stringify({
      labels: [{ id: housingId, label: '**ساماندهی بازار اجاره**', summary: 'طرح مجلس برای مستاجران', percent: 99 }],
      insight: 'فقط ۳۳.۳٪ پست‌ها به روایت رسمی پرداخته‌اند',
      officialPercent: 99,
    });
    const out = mergeNarrativeGap(res, llm, { from: new Date('2026-10-28'), to: new Date('2026-11-04') });
    const housing = out.narratives.find((n) => n.id === housingId)!;
    expect(housing).toMatchObject({ label: 'ساماندهی بازار اجاره', labelSource: 'llm', publicPercent: 22.2 });
    const budget = out.narratives.find((n) => n.id !== housingId)!;
    expect(budget).toMatchObject({ label: 'بودجه', labelSource: 'keywords' });
    expect(out.totals.coveredPercent).toBe(33.3);
    expect(out.insight).toContain('۳۳.۳٪');
    // legacy fields for the PDF report come from computed numbers
    expect(out.officialPercent).toBe(50);
    expect(out.public.reduce((s, p) => s + p.percent, 0)).toBeCloseTo(100 - out.uncovered.otherPercent, 0);
  });

  it('survives an unparseable LLM reply', () => {
    const res = computeNarrativeGap({ official, public: pub });
    const out = mergeNarrativeGap(res, 'خطا', { from: null, to: null });
    expect(out.narratives.every((n) => n.labelSource === 'keywords')).toBe(true);
    expect(out.insight).toBeNull();
  });
});
