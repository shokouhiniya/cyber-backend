/**
 * The four roles of the client's three-level model, and what each may do.
 *
 *   super_admin   مدیر کل   platform staff, everything
 *   client_admin  مدیر      monitoring centre: users + access within its profiles, usage stats
 *   client_expert کارشناس   for assigned profiles: view the dashboard + edit profile data
 *   client_viewer کاربر     the official or their office: view-only
 *
 * Endpoint guards keep listing roles with @Roles(...). A role also satisfies
 * the roles it inherits (ROLE_INHERITS), so `@Roles(..., 'client_viewer')` on
 * the read-only dashboard endpoints admits client_expert too without every
 * controller having to name it.
 */
export const ROLES = ['super_admin', 'client_admin', 'client_expert', 'client_viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'مدیر کل',
  client_admin: 'مدیر',
  client_expert: 'کارشناس',
  client_viewer: 'کاربر',
};

/** Roles whose endpoints a role may also call. */
export const ROLE_INHERITS: Record<string, string[]> = {
  client_expert: ['client_viewer'],
};

/** True when `role` is one of `required`, directly or through ROLE_INHERITS. */
export function roleSatisfies(role: string | undefined | null, required: string[]): boolean {
  if (!role) return false;
  if (required.includes(role)) return true;
  return (ROLE_INHERITS[role] ?? []).some((r) => required.includes(r));
}

/** Named permissions. The frontend mirrors this table in src/auth/permissions.js. */
export const PERMISSIONS = {
  /** Dashboard, posts, analytics for accessible profiles. */
  'dashboard.view': ['super_admin', 'client_admin', 'client_expert', 'client_viewer'],
  /** Keywords, accounts, promises, honorific, title, avatar of accessible profiles. */
  'profiles.editData': ['super_admin', 'client_admin', 'client_expert'],
  /** Create / delete / archive profiles, tier, priority, weights, contexts, batch import. */
  'profiles.manage': ['super_admin'],
  /** Users, roles and profile access (client_admin within its own scope). */
  'users.manage': ['super_admin', 'client_admin'],
  /** Usage statistics and session reports (client_admin within its own scope). */
  'usage.read': ['super_admin', 'client_admin'],
  /** Data sources, ingest settings, global settings, audit log. */
  'system.manage': ['super_admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: string | undefined | null, permission: Permission): boolean {
  return !!role && (PERMISSIONS[permission] as readonly string[]).includes(role);
}

/** Roles a client_admin may hand out (never super_admin). */
export const CLIENT_ASSIGNABLE_ROLES: string[] = ['client_admin', 'client_expert', 'client_viewer'];

/**
 * Profile fields a non-super role with `profiles.editData` may change.
 * Everything else on the profile (name, tier, priority, weights, contexts,
 * hidden widgets, activation…) stays with super_admin.
 */
export const EXPERT_EDITABLE_PROFILE_FIELDS = [
  'keywords',
  'excludedKeywords',
  'contextKeywords',
  'officialChannels',
  'promises',
  'honorific',
  'role',
  'avatar',
] as const;

/** True when the caller may act on `profileId` (super_admin's '*' covers all). */
export function hasProfileAccess(
  user: { role?: string; accessibleProfileIds?: string[] } | undefined | null,
  profileId: string,
): boolean {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  const ids = user.accessibleProfileIds ?? [];
  return ids.includes('*') || ids.includes(profileId);
}
