import { BadRequestException } from '@nestjs/common';
import {
  MAX_RANGE_DAYS, hasPostFilter, normalisePlatforms, parsePostFilter, postFilterKey, postFilterSql,
} from './post-filter';
import { rawBinder } from './post-quality';

describe('post-filter', () => {
  const now = new Date('2026-11-04T12:00:00Z');

  describe('normalisePlatforms', () => {
    it('maps x → twitter, youtube → aparat, de-duplicates and sorts', () => {
      expect(normalisePlatforms('x,Bale, eitaa,twitter')).toEqual(['bale', 'eitaa', 'twitter']);
      expect(normalisePlatforms(['youtube', 'aparat'])).toEqual(['aparat']);
    });
    it('treats an empty value as "all platforms"', () => {
      expect(normalisePlatforms('')).toBeUndefined();
      expect(normalisePlatforms(undefined)).toBeUndefined();
    });
    it('rejects unknown platforms', () => {
      expect(() => normalisePlatforms('myspace')).toThrow(BadRequestException);
    });
  });

  describe('parsePostFilter', () => {
    it('accepts platforms or sources', () => {
      expect(parsePostFilter({ sources: 'x' }, now).platforms).toEqual(['twitter']);
      expect(parsePostFilter({ platforms: 'bale' }, now).platforms).toEqual(['bale']);
    });
    it('uses from / to and lets from win over since / days', () => {
      const f = parsePostFilter({ from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z', since: '2026-01-01', days: '3' }, now);
      expect(f.from?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
      expect(f.to?.toISOString()).toBe('2026-10-10T00:00:00.000Z');
    });
    it('derives the start from days / hours, ending at now or at `to`', () => {
      expect(parsePostFilter({ days: '7' }, now).from?.toISOString()).toBe('2026-10-28T12:00:00.000Z');
      expect(parsePostFilter({ hours: '24' }, now).from?.toISOString()).toBe('2026-11-03T12:00:00.000Z');
      expect(parsePostFilter({ days: '1', to: '2026-11-01T00:00:00Z' }, now).from?.toISOString()).toBe('2026-10-31T00:00:00.000Z');
    });
    it('clamps days to the retention period', () => {
      const f = parsePostFilter({ days: '365' }, now);
      expect((now.getTime() - f.from!.getTime()) / 86_400_000).toBe(MAX_RANGE_DAYS);
    });
    it('rejects bad dates, reversed and too-long ranges', () => {
      expect(() => parsePostFilter({ from: 'nope' }, now)).toThrow(BadRequestException);
      expect(() => parsePostFilter({ from: '2026-10-10', to: '2026-10-01' }, now)).toThrow(BadRequestException);
      expect(() => parsePostFilter({ from: '2026-01-01', to: '2026-11-01' }, now)).toThrow(BadRequestException);
    });
    it('is empty without parameters', () => {
      expect(parsePostFilter({}, now)).toEqual({});
      expect(hasPostFilter(parsePostFilter({}, now))).toBe(false);
    });
  });

  describe('postFilterSql', () => {
    it('binds the range and the platforms', () => {
      const params: unknown[] = ['p1'];
      const sql = postFilterSql(
        { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-02T00:00:00Z'), platforms: ['bale'] },
        rawBinder(params),
        'p',
      );
      expect(sql).toBe(' AND p.published_at >= $2 AND p.published_at < $3 AND LOWER(p.source_type) = ANY($4::text[])');
      expect(params).toHaveLength(4);
    });
    it('returns nothing for no filter', () => {
      expect(postFilterSql(undefined, rawBinder([]))).toBe('');
    });
  });

  describe('filter key', () => {
    it('is empty without a filter and stable for the same filter', () => {
      expect(postFilterKey({})).toBe('');
      expect(postFilterKey({ platforms: ['bale', 'eitaa'] })).toBe('p=bale,eitaa');
    });
  });
});
