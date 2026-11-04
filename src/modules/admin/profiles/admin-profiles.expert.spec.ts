import { ForbiddenException } from '@nestjs/common';

import { AdminProfilesService } from './admin-profiles.service';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

function makeService() {
  const profiles: any[] = [
    { id: P1, name: 'One', tier: 'medium', priority: 10, keywords: ['a'], honorific: null, role: 'وزیر', promises: [] },
    { id: P2, name: 'Two', tier: 'light', priority: 5, keywords: [], honorific: null, role: null, promises: [] },
  ];
  const profileRepo = {
    find: jest.fn(async () => [...profiles]),
    findOne: jest.fn(async ({ where }) => profiles.find((p) => p.id === where.id) ?? null),
    save: jest.fn(async (p) => p),
    query: jest.fn(async () => []),
  };
  const countRepo = { count: jest.fn(async () => 0) };
  const service = new AdminProfilesService(
    profileRepo as any,
    countRepo as any,
    countRepo as any,
    countRepo as any,
    {} as any,
  );
  return { service, profiles };
}

const expert = { role: 'client_expert', accessibleProfileIds: [P1] };

describe('AdminProfilesService for experts', () => {
  it('list() returns only the assigned profiles to an expert', async () => {
    const { service } = makeService();
    const rows = await service.list(expert);
    expect(rows.map((r) => r.id)).toEqual([P1]);
  });

  it('list() returns every profile to super_admin', async () => {
    const { service } = makeService();
    const rows = await service.list({ role: 'super_admin', accessibleProfileIds: ['*'] });
    expect(rows).toHaveLength(2);
  });

  it('an expert edits keywords, honorific, title and promises', async () => {
    const { service } = makeService();
    const saved: any = await service.update(
      P1,
      { keywords: ['a', 'b', 'b'], honorific: ' دکتر ', role: 'رئیس', promises: [] } as any,
      expert,
    );
    expect(saved.keywords).toEqual(['a', 'b']);
    expect(saved.honorific).toBe('دکتر');
    expect(saved.role).toBe('رئیس');
  });

  it('an expert cannot change tier, priority or name', async () => {
    const { service, profiles } = makeService();
    await expect(service.update(P1, { tier: 'heavy' } as any, expert)).rejects.toThrow(ForbiddenException);
    await expect(service.update(P1, { priority: 99, name: 'X' } as any, expert)).rejects.toThrow('priority، name');
    expect(profiles[0].tier).toBe('medium');
  });

  it('unchanged restricted fields sent by a full form are ignored', async () => {
    const { service } = makeService();
    const saved: any = await service.update(P1, { name: 'One', tier: 'medium', keywords: ['z'] } as any, expert);
    expect(saved.keywords).toEqual(['z']);
    expect(saved.tier).toBe('medium');
  });

  it('super_admin may change every field', async () => {
    const { service } = makeService();
    const saved: any = await service.update(P1, { tier: 'heavy', name: 'New' } as any, { role: 'super_admin' });
    expect(saved.tier).toBe('heavy');
    expect(saved.name).toBe('New');
  });
});
