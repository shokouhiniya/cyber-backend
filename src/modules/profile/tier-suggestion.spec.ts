import { loadTierSuggestions, suggestTier, tierSuggestionFromTotals } from './tier-suggestion';

describe('tier-suggestion', () => {
  it('maps average daily mentions to a tier', () => {
    expect(suggestTier(25_000)).toBe('heavy');
    expect(suggestTier(10_001)).toBe('heavy');
    expect(suggestTier(10_000)).toBe('medium');
    expect(suggestTier(500)).toBe('medium');
    expect(suggestTier(499)).toBe('light');
    expect(suggestTier(0)).toBe('light');
    expect(suggestTier(null)).toBeNull();
    expect(suggestTier(NaN)).toBeNull();
  });

  it('prefers the week total divided by 7', () => {
    const s = tierSuggestionFromTotals([
      { timeframe: 'month', total: '600000' },
      { timeframe: 'week', total: '16800', fetchedAt: '2026-10-26T10:00:00Z' },
    ]);
    expect(s).toEqual({ suggested: 'medium', avgDailyMentions: 2400, basis: 'week', fetchedAt: '2026-10-26T10:00:00.000Z' });
  });

  it('falls back to the month total divided by 30', () => {
    expect(tierSuggestionFromTotals([{ timeframe: 'week', total: 0 }, { timeframe: 'month', total: 450_000 }]))
      .toMatchObject({ suggested: 'heavy', avgDailyMentions: 15_000, basis: 'month' });
  });

  it('returns an empty suggestion without totals', () => {
    expect(tierSuggestionFromTotals([])).toEqual({ suggested: null, avgDailyMentions: null, basis: null, fetchedAt: null });
  });

  it('loads suggestions for many profiles with one bound query', async () => {
    const query = jest.fn().mockResolvedValue([
      { profile_id: 'a', timeframe: 'week', total: '700', fetchedAt: null },
      { profile_id: 'b', timeframe: 'week', total: '140000', fetchedAt: null },
    ]);
    const res = await loadTierSuggestions(query, ['a', 'b', 'c']);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([['a', 'b', 'c']]);
    expect(res.a).toMatchObject({ suggested: 'light', avgDailyMentions: 100 });
    expect(res.b).toMatchObject({ suggested: 'heavy', avgDailyMentions: 20_000 });
    expect(res.c.suggested).toBeNull();
    expect(await loadTierSuggestions(query, [])).toEqual({});
  });
});
