import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { AdminActor, AdminUsersService } from './admin-users.service';
import { CreateUserDto, UpdateUserDto, normalisePhone } from '../admin.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

// Expert role, phone, delete and the permission matrix.

const P1 = '11111111-1111-4111-8111-111111111111'; // caller's profile
const P2 = '22222222-2222-4222-8222-222222222222'; // caller's second profile
const P3 = '33333333-3333-4333-8333-333333333333'; // someone else's profile

function makeRepos() {
  const users: any[] = [
    { id: 'super', name: 'S', username: 'super', role: 'super_admin', organization: 'ACME', isActive: true },
    { id: 'super2', name: 'S2', username: 'super2', role: 'super_admin', organization: null, isActive: true },
    { id: 'ca', name: 'CA', username: 'ca', role: 'client_admin', organization: 'ACME', isActive: true },
    { id: 'expert', name: 'Ex', username: 'expert', role: 'client_expert', organization: null, isActive: true },
    { id: 'viewer', name: 'V', username: 'viewer', role: 'client_viewer', organization: null, isActive: true },
    { id: 'stranger', name: 'X', username: 'stranger', role: 'client_viewer', organization: 'Other', isActive: true },
  ];
  let links: any[] = [
    { userId: 'ca', profileId: P1 },
    { userId: 'ca', profileId: P2 },
    { userId: 'expert', profileId: P1 },
    { userId: 'viewer', profileId: P1 },
    { userId: 'viewer', profileId: P3 },
    { userId: 'stranger', profileId: P3 },
  ];
  const match = (row: any, where: any = {}) => Object.entries(where).every(([k, v]) => row[k] === v);
  const queries: string[] = [];

  const em = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      return [];
    }),
    delete: jest.fn(async (entity: any, where: any) => {
      if (entity.name === 'UserProfile') links = links.filter((l) => !match(l, where));
      else {
        const i = users.findIndex((u) => match(u, where));
        if (i >= 0) users.splice(i, 1);
      }
    }),
    insert: jest.fn(async (_entity: any, rows: any[]) => {
      links.push(...rows);
    }),
  };
  const manager = { transaction: jest.fn(async (cb: any) => cb(em)) };

  const userRepo = {
    manager,
    find: jest.fn(async () => [...users]),
    findOne: jest.fn(async ({ where }) => users.find((u) => match(u, where)) ?? null),
    count: jest.fn(async ({ where }) => users.filter((u) => match(u, where)).length),
    create: jest.fn((x) => ({ ...x })),
    save: jest.fn(async (u) => {
      if (!u.id) u.id = `new-${users.length}`;
      const i = users.findIndex((x) => x.id === u.id);
      if (i >= 0) users[i] = u;
      else users.push(u);
      return u;
    }),
  };
  const userProfileRepo = {
    manager,
    find: jest.fn(async (opts?: any) => links.filter((l) => match(l, opts?.where))),
    save: jest.fn(async (rows: any[]) => {
      links.push(...rows);
      return rows;
    }),
    delete: jest.fn(async (where: any) => {
      links = links.filter((l) => !match(l, where));
    }),
  };
  return { users, getLinks: () => links, userRepo, userProfileRepo, queries };
}

const superActor: AdminActor = { sub: 'super', role: 'super_admin', accessibleProfileIds: ['*'] };
const clientActor: AdminActor = { sub: 'ca', role: 'client_admin', accessibleProfileIds: [P1, P2] };

describe('AdminUsersService: expert role, phone, delete, matrix', () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: AdminUsersService;

  beforeEach(() => {
    repos = makeRepos();
    service = new AdminUsersService(repos.userRepo as any, repos.userProfileRepo as any);
  });

  describe('expert role', () => {
    it('client_admin may create a client_expert on its own profile', async () => {
      const u = await service.create(
        { name: 'E', username: 'e2', password: 'secret123', role: 'client_expert', profileIds: [P1] } as any,
        clientActor,
      );
      expect(u.role).toBe('client_expert');
      expect(u.profileIds).toEqual([P1]);
    });

    it('client_admin may turn a viewer into an expert', async () => {
      const u = await service.update('viewer', { role: 'client_expert' } as any, clientActor);
      expect(u.role).toBe('client_expert');
    });

    it('the users list can filter by the expert role', async () => {
      const rows = await service.list(superActor, { role: 'client_expert' });
      expect(rows.map((r) => r.id)).toEqual(['expert']);
    });
  });

  describe('phone', () => {
    it('is saved on create and returned by the list', async () => {
      await service.create(
        { name: 'P', username: 'p', password: 'secret123', role: 'client_viewer', profileIds: [P1], phone: '09121234567' } as any,
        superActor,
      );
      const rows = await service.list(superActor, { q: 'p' });
      expect(rows.find((r) => r.username === 'p')!.phone).toBe('09121234567');
    });

    it('can be cleared on update', async () => {
      await service.update('viewer', { phone: '09120000000' } as any, superActor);
      await service.update('viewer', { phone: null } as any, superActor);
      expect(repos.users.find((u) => u.id === 'viewer').phone).toBeNull();
    });

    it.each([
      ['09121234567', '09121234567'],
      ['۰۹۱۲۱۲۳۴۵۶۷', '09121234567'],
      ['+989121234567', '09121234567'],
      ['00989121234567', '09121234567'],
      ['9121234567', '09121234567'],
      ['0912 123 4567', '09121234567'],
      ['', null],
    ])('normalises %p to %p', (input, expected) => {
      expect(normalisePhone(input)).toBe(expected);
    });

    it('the DTO rejects a non-mobile number and accepts a normalised one', async () => {
      const bad = plainToInstance(UpdateUserDto, { phone: '02112345678' });
      expect((await validate(bad)).map((e) => e.property)).toEqual(['phone']);
      const good = plainToInstance(CreateUserDto, {
        name: 'n', username: 'u', password: 'secret123', role: 'client_expert', phone: '+98 912 123 4567',
      });
      expect(await validate(good)).toEqual([]);
      expect(good.phone).toBe('09121234567');
    });

    it('the DTO accepts client_expert and rejects unknown roles', async () => {
      const dto = plainToInstance(UpdateUserDto, { role: 'owner' });
      expect((await validate(dto)).map((e) => e.property)).toEqual(['role']);
    });
  });

  describe('remove', () => {
    it('super_admin deletes a user and their links', async () => {
      await service.remove('viewer', superActor);
      expect(repos.users.find((u) => u.id === 'viewer')).toBeUndefined();
      expect(repos.getLinks().some((l) => l.userId === 'viewer')).toBe(false);
      expect(repos.queries.some((q) => q.includes('global_context'))).toBe(true);
    });

    it('nobody deletes themselves', async () => {
      await expect(service.remove('super', superActor)).rejects.toThrow(ForbiddenException);
      await expect(service.remove('ca', clientActor)).rejects.toThrow(ForbiddenException);
    });

    it('client_admin deletes an in-scope expert but not a stranger or a super_admin', async () => {
      await service.remove('expert', clientActor);
      expect(repos.users.find((u) => u.id === 'expert')).toBeUndefined();
      await expect(service.remove('stranger', clientActor)).rejects.toThrow(ForbiddenException);
      await expect(service.remove('super2', clientActor)).rejects.toThrow(ForbiddenException);
    });

    it('the last active super_admin cannot be deleted', async () => {
      await service.remove('super2', superActor);
      const other: AdminActor = { sub: 'nobody', role: 'super_admin', accessibleProfileIds: ['*'] };
      await expect(service.remove('super', other)).rejects.toThrow('آخرین مدیر کل');
    });
  });

  describe('access matrix', () => {
    it('lists in-scope non-super users with links to visible profiles only', async () => {
      const { users } = await service.accessMatrix(clientActor);
      expect(users.map((u) => u.id).sort()).toEqual(['ca', 'expert', 'viewer']);
      expect(users.find((u) => u.id === 'viewer')!.profileIds).toEqual([P1]);
    });

    it('super_admin sees every non-super user', async () => {
      const { users } = await service.accessMatrix(superActor);
      expect(users.map((u) => u.id).sort()).toEqual(['ca', 'expert', 'stranger', 'viewer']);
    });

    it('grants and revokes in bulk', async () => {
      const res = await service.applyAccess(
        {
          grant: [
            { userId: 'expert', profileId: P2 },
            { userId: 'viewer', profileId: P2 },
            { userId: 'expert', profileId: P1 }, // already linked: no-op
          ],
          revoke: [{ userId: 'viewer', profileId: P1 }],
        },
        clientActor,
      );
      expect(res).toEqual({ granted: 2, revoked: 1 });
      const links = repos.getLinks();
      expect(links.filter((l) => l.userId === 'expert').map((l) => l.profileId).sort()).toEqual([P1, P2].sort());
      // the viewer's link to a profile outside the caller's reach is untouched
      expect(links.filter((l) => l.userId === 'viewer').map((l) => l.profileId).sort()).toEqual([P2, P3].sort());
    });

    it('client_admin cannot grant a profile it cannot access', async () => {
      await expect(
        service.applyAccess({ grant: [{ userId: 'expert', profileId: P3 }] }, clientActor),
      ).rejects.toThrow(ForbiddenException);
    });

    it('client_admin cannot touch an out-of-scope user', async () => {
      await expect(
        service.applyAccess({ grant: [{ userId: 'stranger', profileId: P1 }] }, clientActor),
      ).rejects.toThrow(ForbiddenException);
    });

    it('super_admin rows are refused', async () => {
      await expect(
        service.applyAccess({ grant: [{ userId: 'super2', profileId: P1 }] }, superActor),
      ).rejects.toThrow(BadRequestException);
    });

    it('a revoke may not leave a user without any profile', async () => {
      await expect(
        service.applyAccess({ revoke: [{ userId: 'expert', profileId: P1 }] }, clientActor),
      ).rejects.toThrow('دست‌کم به یک شخصیت');
      expect(repos.getLinks().some((l) => l.userId === 'expert')).toBe(true);
    });

    it('the same pair cannot be granted and revoked at once', async () => {
      await expect(
        service.applyAccess(
          { grant: [{ userId: 'viewer', profileId: P2 }], revoke: [{ userId: 'viewer', profileId: P2 }] },
          clientActor,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  it('visibleUserIds is null for super_admin and the scoped ids otherwise', async () => {
    expect(await service.visibleUserIds(superActor)).toBeNull();
    expect((await service.visibleUserIds(clientActor))!.sort()).toEqual(['ca', 'expert', 'viewer']);
  });
});
