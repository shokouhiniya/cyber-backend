import { ForbiddenException } from '@nestjs/common';

import {
  CLIENT_ASSIGNABLE_ROLES,
  EXPERT_EDITABLE_PROFILE_FIELDS,
  PERMISSIONS,
  ROLE_LABELS,
  ROLES,
  can,
  hasProfileAccess,
  roleSatisfies,
} from './roles';
import { RolesGuard } from './roles.guard';
import { ProfileAccessGuard } from './profile-access.guard';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

/** Minimal ExecutionContext + Reflector doubles. */
function ctxFor(req: any) {
  return {
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}
const reflectorReturning = (value: any) => ({ getAllAndOverride: () => value }) as any;

describe('permission matrix', () => {
  // The client's three-level model, row by row.
  const MATRIX: Record<string, Record<string, boolean>> = {
    'dashboard.view': { super_admin: true, client_admin: true, client_expert: true, client_viewer: true },
    'profiles.editData': { super_admin: true, client_admin: true, client_expert: true, client_viewer: false },
    'profiles.manage': { super_admin: true, client_admin: false, client_expert: false, client_viewer: false },
    'users.manage': { super_admin: true, client_admin: true, client_expert: false, client_viewer: false },
    'usage.read': { super_admin: true, client_admin: true, client_expert: false, client_viewer: false },
    'system.manage': { super_admin: true, client_admin: false, client_expert: false, client_viewer: false },
  };

  for (const [perm, row] of Object.entries(MATRIX)) {
    for (const [role, expected] of Object.entries(row)) {
      it(`${role} ${expected ? 'has' : 'lacks'} ${perm}`, () => {
        expect(can(role, perm as keyof typeof PERMISSIONS)).toBe(expected);
      });
    }
  }

  it('covers every declared permission', () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual(Object.keys(MATRIX).sort());
  });

  it('unknown or missing roles have no permission', () => {
    expect(can(undefined, 'dashboard.view')).toBe(false);
    expect(can('admin', 'dashboard.view')).toBe(false);
  });

  it('has a Persian label for every role', () => {
    expect(ROLE_LABELS).toEqual({
      super_admin: 'مدیر کل',
      client_admin: 'مدیر',
      client_expert: 'کارشناس',
      client_viewer: 'کاربر',
    });
    expect(Object.keys(ROLE_LABELS).sort()).toEqual([...ROLES].sort());
  });

  it('a client_admin can hand out every role but super_admin', () => {
    expect(CLIENT_ASSIGNABLE_ROLES.sort()).toEqual(['client_admin', 'client_expert', 'client_viewer']);
  });

  it('experts may edit only profile data fields', () => {
    expect([...EXPERT_EDITABLE_PROFILE_FIELDS].sort()).toEqual(
      ['avatar', 'contextKeywords', 'excludedKeywords', 'honorific', 'keywords', 'officialChannels', 'promises', 'role'].sort(),
    );
  });
});

describe('roleSatisfies', () => {
  it('matches a listed role', () => {
    expect(roleSatisfies('client_admin', ['super_admin', 'client_admin'])).toBe(true);
  });

  it('client_expert inherits client_viewer endpoints', () => {
    expect(roleSatisfies('client_expert', ['super_admin', 'client_admin', 'client_viewer'])).toBe(true);
  });

  it('client_expert does not inherit admin-only endpoints', () => {
    expect(roleSatisfies('client_expert', ['super_admin', 'client_admin'])).toBe(false);
  });

  it('client_viewer does not inherit client_expert endpoints', () => {
    expect(roleSatisfies('client_viewer', ['super_admin', 'client_expert'])).toBe(false);
  });

  it('no role satisfies nothing', () => {
    expect(roleSatisfies(undefined, ['client_viewer'])).toBe(false);
  });
});

describe('RolesGuard', () => {
  it('allows when no roles are declared', () => {
    const guard = new RolesGuard(reflectorReturning(undefined));
    expect(guard.canActivate(ctxFor({ user: { role: 'client_viewer' } }))).toBe(true);
  });

  it('lets client_expert through a viewer endpoint', () => {
    const guard = new RolesGuard(reflectorReturning(['super_admin', 'client_admin', 'client_viewer']));
    expect(guard.canActivate(ctxFor({ user: { role: 'client_expert' } }))).toBe(true);
  });

  it('blocks client_expert from user management', () => {
    const guard = new RolesGuard(reflectorReturning([...PERMISSIONS['users.manage']]));
    expect(() => guard.canActivate(ctxFor({ user: { role: 'client_expert' } }))).toThrow(ForbiddenException);
  });

  it('blocks client_viewer from profile editing', () => {
    const guard = new RolesGuard(reflectorReturning([...PERMISSIONS['profiles.editData']]));
    expect(() => guard.canActivate(ctxFor({ user: { role: 'client_viewer' } }))).toThrow(ForbiddenException);
  });

  it('blocks an unauthenticated request', () => {
    const guard = new RolesGuard(reflectorReturning(['client_viewer']));
    expect(() => guard.canActivate(ctxFor({}))).toThrow(ForbiddenException);
  });
});

describe('ProfileAccessGuard / hasProfileAccess', () => {
  const expert = { role: 'client_expert', accessibleProfileIds: [P1] };

  it('super_admin reaches every profile', () => {
    expect(hasProfileAccess({ role: 'super_admin', accessibleProfileIds: ['*'] }, P2)).toBe(true);
  });

  it('an expert reaches only assigned profiles', () => {
    expect(hasProfileAccess(expert, P1)).toBe(true);
    expect(hasProfileAccess(expert, P2)).toBe(false);
    expect(hasProfileAccess(null, P1)).toBe(false);
  });

  it('passes for an assigned profile', () => {
    const guard = new ProfileAccessGuard(reflectorReturning('id'));
    expect(guard.canActivate(ctxFor({ user: expert, params: { id: P1 } }))).toBe(true);
  });

  it('rejects another profile with a Persian 403', () => {
    const guard = new ProfileAccessGuard(reflectorReturning('id'));
    expect(() => guard.canActivate(ctxFor({ user: expert, params: { id: P2 } }))).toThrow(
      'به این شخصیت دسترسی ندارید',
    );
  });

  it('does nothing on routes without @ProfileParam', () => {
    const guard = new ProfileAccessGuard(reflectorReturning(undefined));
    expect(guard.canActivate(ctxFor({ user: expert, params: { id: P2 } }))).toBe(true);
  });
});
