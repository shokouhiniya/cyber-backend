import { BadRequestException } from '@nestjs/common';

import { SESSION_TOUCH_INTERVAL_MS, UserSessionsService } from './user-sessions.service';

/** Records every SQL statement; UPDATE … RETURNING answers with `updateRows`. */
function makeRepo(updateRows: any[] = [{ id: 1 }]) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const repo = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/RETURNING id/.test(sql)) return [updateRows, updateRows.length];
      return [];
    }),
  };
  return { repo, calls };
}

describe('UserSessionsService', () => {
  it('start() closes any open session and opens a login session', async () => {
    const { repo, calls } = makeRepo();
    await new UserSessionsService(repo as any).start('u1', { ip: '1.2.3.4', userAgent: 'UA' });
    expect(calls[0].sql).toMatch(/UPDATE user_sessions SET ended_at/);
    expect(calls[0].sql).toMatch(/'replaced'/);
    expect(calls[0].sql).toMatch(/'timeout'/);
    expect(calls[1].sql).toMatch(/INSERT INTO user_sessions/);
    expect(calls[1].params).toEqual(['u1', 'login', '1.2.3.4', 'UA']);
  });

  it('touch() bumps last activity at most once a minute', async () => {
    const { repo, calls } = makeRepo();
    const s = new UserSessionsService(repo as any);
    const t0 = 1_000_000;
    expect(await s.touch('u1', {}, t0)).toBe(true);
    expect(await s.touch('u1', {}, t0 + 30_000)).toBe(false);
    expect(await s.touch('u1', {}, t0 + SESSION_TOUCH_INTERVAL_MS)).toBe(true);
    expect(calls.filter((c) => c.sql.startsWith('UPDATE user_sessions SET last_activity_at'))).toHaveLength(2);
  });

  it('touch() throttles per user', async () => {
    const { repo } = makeRepo();
    const s = new UserSessionsService(repo as any);
    expect(await s.touch('u1', {}, 5)).toBe(true);
    expect(await s.touch('u2', {}, 6)).toBe(true);
  });

  it('touch() after 30 idle minutes times the old session out and opens a resume session', async () => {
    const { repo, calls } = makeRepo([]);
    await new UserSessionsService(repo as any).touch('u1', { ip: 'x' }, 1);
    expect(calls[0].sql).toMatch(/last_activity_at >= now\(\) - interval '30 minutes'/);
    expect(calls[1].sql).toMatch(/SET ended_at = last_activity_at, end_reason = 'timeout'/);
    expect(calls[2].sql).toMatch(/INSERT INTO user_sessions/);
    expect(calls[2].params.slice(0, 2)).toEqual(['u1', 'resume']);
  });

  it('touch() never throws', async () => {
    const repo = { query: jest.fn(async () => { throw new Error('db down'); }) };
    await expect(new UserSessionsService(repo as any).touch('u1', {}, 1)).resolves.toBe(false);
  });

  it('end() closes the open session as logout and resets the throttle', async () => {
    const { repo, calls } = makeRepo();
    const s = new UserSessionsService(repo as any);
    await s.touch('u1', {}, Date.now());
    await s.end('u1');
    expect(calls.some((c) => /end_reason = 'logout'/.test(c.sql))).toBe(true);
    // a request right after a new sign-in is written again
    expect(await s.touch('u1', {}, Date.now())).toBe(true);
  });

  describe('report scoping', () => {
    const s = new UserSessionsService(makeRepo().repo as any);

    it('super_admin (null ids) is unrestricted', () => {
      expect(s.where({}, null)).toEqual({ where: 'TRUE', params: [] });
    });

    it('a scoped caller is limited to its users and never sees super_admin', () => {
      const { where, params } = s.where({ userId: 'u1' }, ['u1', 'u2']);
      expect(where).toBe(`s.user_id = $1 AND s.user_id = ANY($2::uuid[]) AND u.role <> 'super_admin'`);
      expect(params).toEqual(['u1', ['u1', 'u2']]);
    });

    it('filters by date range', () => {
      const { where, params } = s.where({ from: '2026-11-01T00:00:00Z', to: '2026-11-04T00:00:00Z' }, null);
      expect(where).toBe('s.started_at >= $1 AND s.started_at <= $2');
      expect(params[0]).toEqual(new Date('2026-11-01T00:00:00Z'));
    });

    it('rejects an invalid date', () => {
      expect(() => s.where({ from: 'yesterday' }, null)).toThrow(BadRequestException);
    });
  });

  it('report() closes idle sessions first and computes the average', async () => {
    const repo = {
      query: jest.fn(async (sql: string) =>
        /GROUP BY/.test(sql) ? [{ userId: 'u1', sessions: 4, totalSeconds: '3600' }] : [],
      ),
    };
    const rows = await new UserSessionsService(repo as any).report({}, null);
    expect(repo.query.mock.calls[0][0]).toMatch(/end_reason = 'timeout'/);
    expect(rows).toEqual([{ userId: 'u1', sessions: 4, totalSeconds: 3600, avgSeconds: 900 }]);
  });
});
