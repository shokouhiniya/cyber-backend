import { bucketWeekly, clampWeeks, weekStartOf, weekWindows, zonedDate } from './weekly-buckets';

describe('weekly-buckets', () => {
  // Tuesday 2026-10-27 10:00 UTC = 13:30 Tehran, same day
  const NOW = new Date('2026-10-27T10:00:00Z');

  it('uses the Tehran calendar day', () => {
    // 21:00 UTC Friday = 00:30 Saturday in Tehran
    expect(zonedDate(new Date('2026-10-23T21:00:00Z'))).toBe('2026-10-24');
    expect(zonedDate(new Date('2026-10-23T20:00:00Z'))).toBe('2026-10-23');
  });

  it('starts weeks on Saturday', () => {
    expect(weekStartOf('2026-10-24')).toBe('2026-10-24'); // Saturday
    expect(weekStartOf('2026-10-27')).toBe('2026-10-24'); // Tuesday
    expect(weekStartOf('2026-10-30')).toBe('2026-10-24'); // Friday
    expect(weekStartOf('2026-10-31')).toBe('2026-10-31'); // next Saturday
  });

  it('returns N continuous weeks, oldest first, ending with the current week', () => {
    const { firstDay, starts } = weekWindows(12, NOW);
    expect(starts).toHaveLength(12);
    expect(starts[11]).toBe('2026-10-24');
    expect(starts[0]).toBe('2026-08-08');
    expect(firstDay).toBe('2026-08-08');
  });

  it('sums day rows into their week and zero-fills empty weeks', () => {
    const rows = [
      { day: '2026-10-24', posts: 2, views: 100, likes: 5, shares: 1 },
      { day: '2026-10-27', posts: '3' as any, views: '50' as any, likes: 1, shares: 0 },
      { day: '2026-10-23', posts: 1, views: 10, likes: 0, shares: 2 }, // Friday → previous week
      { day: '2026-08-08', posts: 4, views: 40, likes: 4, shares: 4 }, // first day of the window
      { day: '2026-08-07', posts: 9, views: 9, likes: 9, shares: 9 }, // before the window → ignored
    ];
    const weeks = bucketWeekly(rows, 12, NOW);
    expect(weeks).toHaveLength(12);
    expect(weeks[11]).toEqual({ weekStart: '2026-10-24', weekEnd: '2026-10-30', posts: 5, views: 150, likes: 6, shares: 1 });
    expect(weeks[10]).toEqual({ weekStart: '2026-10-17', weekEnd: '2026-10-23', posts: 1, views: 10, likes: 0, shares: 2 });
    expect(weeks[0].posts).toBe(4);
    expect(weeks.slice(1, 10).every((w) => w.posts === 0 && w.views === 0)).toBe(true);
    expect(weeks.reduce((s, w) => s + w.posts, 0)).toBe(10);
  });

  it('clamps the week count', () => {
    expect(clampWeeks(undefined)).toBe(12);
    expect(clampWeeks('abc')).toBe(12);
    expect(clampWeeks('0')).toBe(12);
    expect(clampWeeks('4')).toBe(4);
    expect(clampWeeks(500)).toBe(52);
  });
});
