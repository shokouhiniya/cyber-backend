import {
  combineCrisis, geoMeanPlusOne, negativeShareScore, perPostScore, ratioToScore, spreadScore,
} from './crisis-formula';

describe('crisis-formula', () => {
  describe('ratioToScore', () => {
    it('maps ratio 1 to 50 (normal)', () => {
      expect(ratioToScore(1)).toBe(50);
    });
    it('is symmetric in log space and clamps at ×2 / ×0.5', () => {
      expect(ratioToScore(2)).toBe(100);
      expect(ratioToScore(0.5)).toBe(0);
      expect(ratioToScore(10)).toBe(100);
      expect(ratioToScore(0.01)).toBe(0);
      expect(ratioToScore(1.5)).toBe(79);
      expect(ratioToScore(1 / 1.5)).toBe(21);
    });
    it('handles degenerate ratios', () => {
      expect(ratioToScore(0)).toBe(0);
      expect(ratioToScore(Infinity)).toBe(100);
      expect(ratioToScore(NaN)).toBe(50);
    });
  });

  describe('negativeShareScore', () => {
    it('is 50 when the recent share equals the baseline share', () => {
      expect(negativeShareScore({ neg: 30, total: 100 }, { neg: 120, total: 400 })).toBe(50);
    });
    it('rises when the recent negative share grows', () => {
      const v = negativeShareScore({ neg: 60, total: 100 }, { neg: 120, total: 400 })!;
      expect(v).toBeGreaterThan(70);
    });
    it('falls when the recent negative share drops', () => {
      const v = negativeShareScore({ neg: 5, total: 100 }, { neg: 120, total: 400 })!;
      expect(v).toBeLessThan(30);
    });
    it('shrinks small recent samples toward the baseline', () => {
      // 5 of 5 recent posts negative is extreme but a tiny sample
      const small = negativeShareScore({ neg: 5, total: 5 }, { neg: 100, total: 400 })!;
      const large = negativeShareScore({ neg: 100, total: 100 }, { neg: 100, total: 400 })!;
      expect(small).toBeLessThan(large);
      expect(small).toBeLessThan(100);
    });
    it('returns null without enough posts on either side', () => {
      expect(negativeShareScore({ neg: 1, total: 4 }, { neg: 100, total: 400 })).toBeNull();
      expect(negativeShareScore({ neg: 10, total: 50 }, { neg: 2, total: 9 })).toBeNull();
    });
  });

  describe('spreadScore', () => {
    it('compares mentions per day: week/7 vs (month − week)/23', () => {
      // 7000/7 = 1000/day vs 23000/23 = 1000/day → normal
      expect(spreadScore(7000, 30000)).toBe(50);
      // 2000/day vs 1000/day → ×2
      expect(spreadScore(14000, 37000)).toBe(100);
    });
    it('returns null when 8tag totals are missing', () => {
      expect(spreadScore(0, 0)).toBeNull();
      expect(spreadScore(5000, 5000)).toBeNull();
    });
  });

  describe('perPostScore + geoMeanPlusOne', () => {
    it('compares the typical post on both sides', () => {
      const base = Array(20).fill(1000);
      const recent = Array(10).fill(2000);
      const v = perPostScore(
        { geoMean: geoMeanPlusOne(recent), n: recent.length },
        { geoMean: geoMeanPlusOne(base), n: base.length },
      );
      expect(v).toBe(100);
    });
    it('is robust to a single viral outlier, unlike the arithmetic mean', () => {
      const base = Array(20).fill(1000);
      const recent = [...Array(9).fill(1000), 1_000_000];
      const v = perPostScore(
        { geoMean: geoMeanPlusOne(recent), n: recent.length },
        { geoMean: geoMeanPlusOne(base), n: base.length },
      )!;
      // arithmetic mean ratio would be ~101× → 100; geometric mean ratio ≈ 2×
      expect(v).toBeGreaterThan(50);
      expect(v).toBeLessThanOrEqual(100);
      expect(geoMeanPlusOne(recent) / geoMeanPlusOne(base)).toBeLessThan(2.1);
    });
    it('treats all-zero metrics on both sides as normal', () => {
      const v = perPostScore(
        { geoMean: geoMeanPlusOne(Array(10).fill(0)), n: 10 },
        { geoMean: geoMeanPlusOne(Array(20).fill(0)), n: 20 },
      );
      expect(v).toBe(50);
    });
    it('returns null without enough mature posts', () => {
      expect(perPostScore({ geoMean: 100, n: 4 }, { geoMean: 100, n: 50 })).toBeNull();
      expect(perPostScore({ geoMean: 100, n: 10 }, { geoMean: 100, n: 9 })).toBeNull();
    });
  });

  describe('combineCrisis', () => {
    it('weights only axes with data and returns 50/safe when nothing has data', () => {
      expect(combineCrisis([
        { key: 'negativeSentiment', label: '', value: null },
        { key: 'influence', label: '', value: null },
      ])).toEqual({ score: 50, level: 'safe' });
    });
    it('re-normalises weights over the active axes', () => {
      // negativeSentiment 0.40 · 80 + spreadVelocity 0.20 · 50 → (32 + 10) / 0.6 = 70
      expect(combineCrisis([
        { key: 'negativeSentiment', label: '', value: 80 },
        { key: 'spreadVelocity', label: '', value: 50 },
        { key: 'influence', label: '', value: null },
      ])).toEqual({ score: 70, level: 'critical' });
    });
    it('uses 55 / 70 as the warning / critical thresholds', () => {
      expect(combineCrisis([{ key: 'influence', label: '', value: 54 }]).level).toBe('safe');
      expect(combineCrisis([{ key: 'influence', label: '', value: 55 }]).level).toBe('warning');
      expect(combineCrisis([{ key: 'influence', label: '', value: 70 }]).level).toBe('critical');
    });
  });
});
