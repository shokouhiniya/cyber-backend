import { ForbiddenException } from '@nestjs/common';

import { AdminActor, AdminUsersService } from './admin-users.service';

// ── In-memory repos ───────────────────────────────────────────────────────────

const P1 = '11111111-1111-4111-8111-111111111111'; // caller's profile
const P2 = '22222222-2222-4222-8222-222222222222'; // someone else's profile

function makeRepos() {
  const users: any[] = [
    { id: 'super', name: 'S', username: 'super', role: 'super_admin', organization: 'ACME', isActive: true },
    { id: 'ca', name: 'CA', username: 'ca', role: 'client_admin', organization: 'ACME', isActive: true },
    { id: 'peer', name: 'Peer', username: 'peer', role: 'client_viewer', organization: null, isActive: true },
    { id: 'orgmate', name: 'Org', username: 'orgmate', role: 'client_viewer', organization: 'ACME', isActive: true },
    { id: 'stranger', name: 'X', username: 'stranger', role: 'client_admin', organization: 'Other', isActive: true },
  ];
  let links: any[] = [
    { userId: 'ca', profileId: P1 },
    { userId: 'peer', profileId: P1 },
    { userId: 'orgmate', profileId: P2 },
    { userId: 'stranger', profileId: P2 },
  ];
  const match = (row: any, where: any = {}) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const userRepo = {
    find: jest.fn(async () => [...users]),
    findOne: jest.fn(async ({ where }) => users.find((u) => match(u, where)) ?? null),
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
    find: jest.fn(async (opts?: any) => links.filter((l) => match(l, opts?.where))),
    save: jest.fn(async (rows: any[]) => {
      links.push(...rows);
      return rows;
    }),
    delete: jest.fn(async (where: any) => {
      links = links.filter((l) => !match(l, where));
    }),
  };
  return { users, getLinks: () => links, userRepo, userProfileRepo };
}

const superActor: AdminActor = { sub: 'super', role: 'super_admin', accessibleProfileIds: ['*'] };
const clientActor: AdminActor = { sub: 'ca', role: 'client_admin', accessibleProfileIds: [P1] };

const baseCreate = { name: 'New', username: 'newbie', password: 'secret123' };

describe('AdminUsersService scoping', () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: AdminUsersService;

  beforeEach(() => {
    repos = makeRepos();
    service = new AdminUsersService(repos.userRepo as any, repos.userProfileRepo as any);
  });

  describe('list', () => {
    it('super_admin sees every user', async () => {
      const rows = await service.list(superActor);
      expect(rows.map((r) => r.id).sort()).toEqual(['ca', 'orgmate', 'peer', 'stranger', 'super']);
    });

    it('client_admin sees self, profile-sharing and same-org users, never super_admins', async () => {
      const rows = await service.list(clientActor);
      expect(rows.map((r) => r.id).sort()).toEqual(['ca', 'orgmate', 'peer']);
    });

    it('client_admin does not see links to profiles outside their access', async () => {
      const rows = await service.list(clientActor);
      expect(rows.find((r) => r.id === 'orgmate')!.profileIds).toEqual([]);
    });
  });

  describe('get', () => {
    it('client_admin may read an in-scope user', async () => {
      await expect(service.get('peer', clientActor)).resolves.toMatchObject({ id: 'peer' });
    });

    it.each(['stranger', 'super'])('client_admin is refused %s with 403', async (id) => {
      await expect(service.get(id, clientActor)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('create', () => {
    it('client_admin creates a client_viewer with the caller organisation', async () => {
      const res: any = await service.create(
        { ...baseCreate, role: 'client_viewer', organization: 'Hacked', profileIds: [P1] },
        clientActor,
      );
      expect(res.role).toBe('client_viewer');
      expect(res.organization).toBe('ACME');
      expect(res.profileIds).toEqual([P1]);
    });

    it('client_admin cannot create a super_admin', async () => {
      await expect(
        service.create({ ...baseCreate, role: 'super_admin', profileIds: [P1] }, clientActor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repos.userRepo.save).not.toHaveBeenCalled();
    });

    it('client_admin cannot link a profile they cannot access', async () => {
      await expect(
        service.create({ ...baseCreate, role: 'client_viewer', profileIds: [P1, P2] }, clientActor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repos.userRepo.save).not.toHaveBeenCalled();
    });

    it('super_admin keeps the organisation it sends', async () => {
      const res: any = await service.create(
        { ...baseCreate, role: 'client_admin', organization: 'Other', profileIds: [P2] },
        superActor,
      );
      expect(res.organization).toBe('Other');
    });
  });

  describe('update', () => {
    it('client_admin may change an in-scope user role to client_admin', async () => {
      const res: any = await service.update('peer', { role: 'client_admin' }, clientActor);
      expect(res.role).toBe('client_admin');
    });

    it('client_admin cannot promote anyone to super_admin', async () => {
      await expect(service.update('peer', { role: 'super_admin' }, clientActor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('client_admin cannot change their own role', async () => {
      await expect(service.update('ca', { role: 'client_viewer' }, clientActor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('client_admin may edit their own name and resend their own role unchanged', async () => {
      const res: any = await service.update('ca', { name: 'Renamed', role: 'client_admin' }, clientActor);
      expect(res.name).toBe('Renamed');
    });

    it('client_admin cannot deactivate themselves through update', async () => {
      await expect(service.update('ca', { isActive: false }, clientActor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('client_admin cannot change organisation', async () => {
      await expect(service.update('peer', { organization: 'ACME' }, clientActor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('client_admin cannot edit an out-of-scope user', async () => {
      await expect(service.update('stranger', { name: 'x' }, clientActor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('client_admin cannot link a foreign profile', async () => {
      await expect(service.update('peer', { profileIds: [P2] }, clientActor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('client_admin profile edits keep links to profiles outside their access', async () => {
      // orgmate is linked to P2 (not the caller's); adding P1 must not drop P2
      await service.update('orgmate', { profileIds: [P1] }, clientActor);
      const linked = repos.getLinks().filter((l) => l.userId === 'orgmate').map((l) => l.profileId);
      expect(linked.sort()).toEqual([P1, P2].sort());
    });

    it('super_admin can change organisation and role freely', async () => {
      const res: any = await service.update('peer', { organization: 'Z', role: 'super_admin' }, superActor);
      expect(res).toMatchObject({ organization: 'Z', role: 'super_admin' });
    });
  });

  describe('reset password / deactivate', () => {
    it('client_admin may reset an in-scope user password', async () => {
      await expect(service.resetPassword('peer', 'newpass1', clientActor)).resolves.toEqual({
        id: 'peer',
        reset: true,
      });
    });

    it('client_admin cannot reset an out-of-scope or super_admin password', async () => {
      await expect(service.resetPassword('stranger', 'newpass1', clientActor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.resetPassword('super', 'newpass1', clientActor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('client_admin may deactivate an in-scope user', async () => {
      await expect(service.deactivate('orgmate', clientActor)).resolves.toEqual({
        id: 'orgmate',
        deactivated: true,
      });
    });

    it('client_admin cannot deactivate themselves', async () => {
      await expect(service.deactivate('ca', clientActor)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('client_admin cannot deactivate an out-of-scope user', async () => {
      await expect(service.deactivate('stranger', clientActor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('forbidden errors carry a Persian message', async () => {
      await expect(service.deactivate('super', clientActor)).rejects.toThrow('به این کاربر دسترسی ندارید');
    });
  });
});
