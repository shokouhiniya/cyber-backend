import { buildHourlyAggregates, hourBucket, normalizeSentiment } from './hourly-aggregate.builder';

const find = (rows: ReturnType<typeof buildHourlyAggregates>, hourIso: string, src: string, sent: string) =>
  rows.find((r) => r.hour.toISOString() === hourIso && r.sourceType === src && r.sentiment === sent);

describe('hourly-aggregate.builder', () => {
  describe('hourBucket', () => {
    it('truncates to the UTC hour (not Tehran +03:30)', () => {
      expect(hourBucket('2026-10-20T10:59:59.999Z').toISOString()).toBe('2026-10-20T10:00:00.000Z');
      // 14:10 Tehran = 10:40 UTC → 10:00 UTC bucket
      expect(hourBucket('2026-10-20T14:10:00+03:30').toISOString()).toBe('2026-10-20T10:00:00.000Z');
    });
  });

  describe('normalizeSentiment', () => {
    it('maps LLM / 8tag spellings and null to the three canonical values', () => {
      expect(normalizeSentiment('positive')).toBe('Positive');
      expect(normalizeSentiment('NEGATIVE')).toBe('Negative');
      expect(normalizeSentiment('Neutral')).toBe('Neutral');
      expect(normalizeSentiment(null)).toBe('Neutral');
      expect(normalizeSentiment('mixed')).toBe('Neutral');
    });
  });

  describe('buildHourlyAggregates', () => {
    const posts = [
      { sourceType: 'telegram', sentiment: 'Negative', publishedAt: '2026-10-20T10:05:00Z', viewCount: 100, likeCount: 5, replyCount: 1 },
      { sourceType: 'telegram', sentiment: 'negative', publishedAt: '2026-10-20T10:55:00Z', viewCount: '300', likeCount: 1, replyCount: 0 },
      { sourceType: 'twitter', sentiment: 'Positive', publishedAt: '2026-10-20T10:30:00Z', viewCount: 50, likeCount: 10, replyCount: 2 },
      { sourceType: 'twitter', sentiment: null, publishedAt: '2026-10-20T11:00:00Z', viewCount: null, likeCount: null, replyCount: null },
      { sourceType: 'news', sentiment: 'Positive', publishedAt: null, viewCount: 999 },
    ];
    const rows = buildHourlyAggregates('p1', posts);
    const h10 = '2026-10-20T10:00:00.000Z';
    const h11 = '2026-10-20T11:00:00.000Z';

    it('buckets by published hour and skips posts without published_at', () => {
      expect(new Set(rows.map((r) => r.hour.toISOString()))).toEqual(new Set([h10, h11]));
      expect(rows.some((r) => r.sourceType === 'news')).toBe(false);
    });

    it('writes (source, sentiment), (source, all), (all, sentiment) and (all, all) rows', () => {
      expect(find(rows, h10, 'telegram', 'Negative')).toMatchObject({ postCount: 2, totalViews: 400, totalLikes: 6, totalReplies: 1 });
      expect(find(rows, h10, 'telegram', 'all')).toMatchObject({ postCount: 2, totalViews: 400 });
      expect(find(rows, h10, 'all', 'Negative')).toMatchObject({ postCount: 2 });
      expect(find(rows, h10, 'all', 'Positive')).toMatchObject({ postCount: 1, totalViews: 50 });
      expect(find(rows, h10, 'all', 'all')).toMatchObject({ postCount: 3, totalViews: 450, totalLikes: 16, totalReplies: 3 });
    });

    it('counts null sentiment as Neutral and null metrics as 0', () => {
      expect(find(rows, h11, 'twitter', 'Neutral')).toMatchObject({ postCount: 1, totalViews: 0 });
      expect(find(rows, h11, 'all', 'all')).toMatchObject({ postCount: 1 });
    });

    it('sentiment rows add up to the all/all row for each hour', () => {
      for (const h of [h10, h11]) {
        const total = find(rows, h, 'all', 'all')!.postCount;
        const bySent = rows
          .filter((r) => r.hour.toISOString() === h && r.sourceType === 'all' && r.sentiment !== 'all')
          .reduce((s, r) => s + r.postCount, 0);
        expect(bySent).toBe(total);
      }
    });

    it('tags every row with the profile id', () => {
      expect(rows.every((r) => r.profileId === 'p1')).toBe(true);
    });
  });
});
