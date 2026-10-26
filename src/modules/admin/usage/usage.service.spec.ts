import { ForbiddenException } from '@nestjs/common';

import { UsageService } from './usage.service';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

/** Minimal query-builder mock that records andWhere calls. */
function makeQb() {
  const qb: any = { wheres: [] as Array<[string, any]> };
  for (const m of ['select', 'addSelect', 'where', 'groupBy', 'orderBy', 'limit']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.andWhere = jest.fn((sql: string, params?: any) => {
    qb.wheres.push([sql, params]);
    return qb;
  });
  qb.getRawMany = jest.fn(async () => []);
  qb.getRawOne = jest.fn(async () => ({ total: '0' }));
  return qb;
}

describe('UsageService scoping', () => {
  let qbs: any[];
  let repo: any;
  let service: UsageService;

  beforeEach(() => {
    qbs = [];
    repo = {
      createQueryBuilder: jest.fn(() => {
        const qb = makeQb();
        qbs.push(qb);
        return qb;
      }),
      query: jest.fn(async () => []),
    };
    service = new UsageService(repo);
  });

  describe('resolveScope', () => {
    const client = { role: 'client_admin', accessibleProfileIds: [P1] };

    it('super_admin is unrestricted', () => {
      expect(service.resolveScope({ role: 'super_admin', accessibleProfileIds: ['*'] }, P2)).toEqual({
        profileId: P2,
        scope: null,
      });
    });

    it('client_admin is scoped to their profiles', () => {
      expect(service.resolveScope(client)).toEqual({ profileId: null, scope: [P1] });
      expect(service.resolveScope(client, P1)).toEqual({ profileId: P1, scope: [P1] });
    });

    it('client_admin asking for a foreign profile gets 403', () => {
      expect(() => service.resolveScope(client, P2)).toThrow(ForbiddenException);
    });
  });

  it('scoped queries filter profile_id to the scope', async () => {
    await service.summary(undefined, undefined, null, [P1]);
    for (const qb of qbs) {
      expect(qb.wheres).toContainEqual(['e.profile_id IN (:...scope)', { scope: [P1] }]);
    }
  });

  it('an empty scope matches nothing', async () => {
    await service.profilesRanking(undefined, undefined, []);
    expect(qbs[0].wheres).toContainEqual(['1 = 0', undefined]);
  });

  it('unscoped queries add no profile filter', async () => {
    await service.daily(undefined, undefined, null, null);
    expect(qbs[0].wheres).toEqual([]);
  });

  it('byProfile hides super_admin activity only when asked', async () => {
    await service.byProfile(P1, undefined, undefined, true);
    expect(repo.query.mock.calls[0][0]).toContain("u.role = 'super_admin'");
    repo.query.mockClear();
    await service.byProfile(P1);
    expect(repo.query.mock.calls[0][0]).not.toContain("u.role = 'super_admin'");
  });
});
