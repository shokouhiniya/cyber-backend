import { rawBinder } from '../content/post-quality';
import { isPromiseExpired, normalisePromiseDate, promiseWindowSql, sanitisePromises } from './promises';

describe('promises', () => {
  describe('promiseWindowSql', () => {
    it('adds nothing for promises without a window (old behaviour)', () => {
      const params: unknown[] = ['p', 'promise_0'];
      expect(promiseWindowSql({ }, rawBinder(params))).toBe('');
      expect(params).toEqual(['p', 'promise_0']);
    });

    it('bounds published_at by Tehran days, validUntil inclusive, as bound parameters', () => {
      const params: unknown[] = ['p', 'promise_0', new Date('2026-09-01T00:00:00Z')];
      const sql = promiseWindowSql({ validFrom: '2026-06-01', validUntil: '2026-09-30' }, rawBinder(params));
      expect(params.slice(3)).toEqual(['2026-06-01', '2026-09-30']);
      expect(sql).toContain(`published_at >= ($4::date)::timestamp AT TIME ZONE 'Asia/Tehran'`);
      expect(sql).toContain(`published_at < (($5::date + 1)::timestamp AT TIME ZONE 'Asia/Tehran')`);
      expect(sql).not.toMatch(/2026-/); // values are never interpolated
    });

    it('supports open-ended windows and ignores malformed dates', () => {
      const p1: unknown[] = [];
      expect(promiseWindowSql({ validFrom: '2026-06-01' }, rawBinder(p1))).toMatch(/>=/);
      expect(p1).toEqual(['2026-06-01']);
      const p2: unknown[] = [];
      expect(promiseWindowSql({ validFrom: "2026-01-01'; DROP TABLE x;--", validUntil: '2026-02-31' }, rawBinder(p2))).toBe('');
      expect(p2).toEqual([]);
    });
  });

  it('marks a promise expired only after its last day (Tehran)', () => {
    const now = new Date('2026-10-27T10:00:00Z');
    expect(isPromiseExpired({ validUntil: '2026-10-26' }, now)).toBe(true);
    expect(isPromiseExpired({ validUntil: '2026-10-27' }, now)).toBe(false);
    expect(isPromiseExpired({}, now)).toBe(false);
    // 21:00 UTC on the 26th is already the 27th in Tehran
    expect(isPromiseExpired({ validUntil: '2026-10-26' }, new Date('2026-10-26T21:00:00Z'))).toBe(true);
  });

  it('normalises dates', () => {
    expect(normalisePromiseDate('2026-06-01')).toBe('2026-06-01');
    expect(normalisePromiseDate('2026-06-01T20:30:00.000Z')).toBe('2026-06-01');
    expect(normalisePromiseDate('2026-02-30')).toBeUndefined();
    expect(normalisePromiseDate('1405/03/11')).toBeUndefined();
    expect(normalisePromiseDate(null)).toBeUndefined();
  });

  it('sanitises admin input', () => {
    const out = sanitisePromises([
      { text: '  کاهش تورم ', status: 'weird', addedAt: '2026-01-01T00:00:00Z', position: ' رئیس مجلس ', validFrom: '2026-09-01', validUntil: '2026-01-01', extra: 1 },
      { text: 'بدون دوره', status: 'fulfilled', addedAt: '2026-01-01T00:00:00Z', validFrom: '', position: '' },
      { nope: true },
    ]);
    expect(out).toEqual([
      { text: 'کاهش تورم', status: 'pending', addedAt: '2026-01-01T00:00:00Z', position: 'رئیس مجلس', validFrom: '2026-01-01', validUntil: '2026-09-01' },
      { text: 'بدون دوره', status: 'fulfilled', addedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(sanitisePromises('x')).toEqual([]);
  });
});
