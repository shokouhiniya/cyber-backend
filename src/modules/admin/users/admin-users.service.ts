import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';

import { User } from '../../user/user.entity';
import { UserProfile } from '../../user/user-profile.entity';
import { ApplyAccessDto, CreateUserDto, UpdateUserDto } from '../admin.dto';
import { CLIENT_ASSIGNABLE_ROLES } from '../../auth/roles';

/** The authenticated caller, as set on req.user by the JWT strategy. */
export interface AdminActor {
  sub: string;
  role: string;
  accessibleProfileIds: string[];
}

/** Optional filters for the users list (query string values). */
export interface UserListFilters {
  q?: string;
  role?: string;
  active?: string;
}

const OUT_OF_SCOPE = 'به این کاربر دسترسی ندارید';

/**
 * super_admin manages every user. client_admin manages only the users of their
 * own organisation or those sharing at least one profile with them — never a
 * super_admin — and may only link profiles they can access themselves.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(UserProfile) private readonly userProfileRepo: Repository<UserProfile>,
  ) {}

  /** Users the caller may manage (all for super_admin), with their profile links. */
  private async loadVisible(actor: AdminActor) {
    const users = await this.userRepo.find({ order: { createdAt: 'DESC' } });
    const links = await this.userProfileRepo.find();
    const byUser: Record<string, string[]> = {};
    for (const l of links) {
      (byUser[l.userId] ||= []).push(l.profileId);
    }

    let visible = users;
    if (!this.isSuper(actor)) {
      const org = this.orgOf(users.find((u) => u.id === actor.sub));
      visible = users.filter((u) => this.inScope(actor, org, u, byUser[u.id] ?? []));
    }
    return { visible, byUser };
  }

  /** Ids of the users whose activity the caller may see; null = everyone (super_admin). */
  async visibleUserIds(actor: AdminActor): Promise<string[] | null> {
    if (this.isSuper(actor)) return null;
    const { visible } = await this.loadVisible(actor);
    return visible.map((u) => u.id);
  }

  async list(actor: AdminActor, filters: UserListFilters = {}) {
    const { visible: scoped, byUser } = await this.loadVisible(actor);
    const visible = this.applyFilters(scoped, filters);

    return visible.map((u) => ({
      id: u.id,
      name: u.name,
      username: u.username,
      email: u.email,
      phone: u.phone ?? null,
      role: u.role,
      organization: u.organization,
      avatar: u.avatar,
      isActive: u.isActive,
      createdAt: u.createdAt,
      profileIds: this.visibleProfileIds(actor, byUser[u.id] ?? []),
    }));
  }

  /** Search (name / username / email) and role / active filters, after scoping. */
  private applyFilters(users: User[], { q, role, active }: UserListFilters): User[] {
    const needle = (q || '').trim().replace(/^@/, '').toLowerCase();
    const roles = (role || '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    if (active && active !== 'true' && active !== 'false') {
      throw new BadRequestException('پارامتر active باید true یا false باشد');
    }
    return users.filter((u) => {
      if (needle) {
        const hay = [u.name, u.username, u.email].map((v) => (v || '').toLowerCase());
        if (!hay.some((v) => v.includes(needle))) return false;
      }
      if (roles.length > 0 && !roles.includes(u.role)) return false;
      if (active === 'true' && !u.isActive) return false;
      if (active === 'false' && u.isActive) return false;
      return true;
    });
  }

  async get(id: string, actor: AdminActor) {
    const { user: u, profileIds } = await this.loadInScope(id, actor);
    return {
      ...u,
      passwordHash: undefined,
      profileIds: this.visibleProfileIds(actor, profileIds),
    };
  }

  async create(dto: CreateUserDto, actor: AdminActor) {
    let organization = dto.organization;
    if (!this.isSuper(actor)) {
      if (!CLIENT_ASSIGNABLE_ROLES.includes(dto.role)) {
        throw new ForbiddenException('شما فقط می‌توانید کاربر با نقش مدیر، کارشناس یا کاربر بسازید');
      }
      this.assertProfilesAccessible(actor, dto.profileIds ?? []);
      organization = this.orgOf(await this.userRepo.findOne({ where: { id: actor.sub } })) ?? undefined;
    }

    const existing = await this.userRepo.findOne({ where: { username: dto.username } });
    if (existing) throw new ConflictException('این نام کاربری قبلاً ثبت شده است');

    if (dto.role !== 'super_admin' && (!dto.profileIds || dto.profileIds.length === 0)) {
      throw new BadRequestException('برای نقش‌های غیر مدیر کل باید حداقل یک شخصیت انتخاب شود');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.saveUser(
      this.userRepo.create({
        name: dto.name,
        username: dto.username,
        email: dto.email,
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        passwordHash,
        role: dto.role,
        organization,
        isActive: true,
      } as Partial<User>),
    );

    if (dto.role !== 'super_admin' && dto.profileIds?.length) {
      await this.userProfileRepo.save(
        dto.profileIds.map((profileId) => ({ userId: user.id, profileId })),
      );
    }

    return this.get(user.id, actor);
  }

  async update(id: string, dto: UpdateUserDto, actor: AdminActor) {
    const { user: u, profileIds: currentProfileIds } = await this.loadInScope(id, actor);
    const isSelf = id === actor.sub;

    let nextProfileIds = dto.profileIds;
    if (!this.isSuper(actor)) {
      if (dto.role !== undefined && dto.role !== u.role) {
        if (isSelf) throw new ForbiddenException('نمی‌توانید نقش خودتان را تغییر دهید');
        if (!CLIENT_ASSIGNABLE_ROLES.includes(dto.role)) {
          throw new ForbiddenException('شما فقط می‌توانید نقش مدیر، کارشناس یا کاربر را تعیین کنید');
        }
      }
      if (isSelf && dto.isActive === false) {
        throw new ForbiddenException('نمی‌توانید حساب خودتان را غیرفعال کنید');
      }
      if (dto.organization !== undefined && (dto.organization || null) !== (u.organization || null)) {
        throw new ForbiddenException('تغییر سازمان فقط توسط مدیرکل امکان‌پذیر است');
      }
      if (dto.profileIds) {
        this.assertProfilesAccessible(actor, dto.profileIds);
        // Links to profiles outside the caller's reach are not theirs to remove.
        const kept = currentProfileIds.filter((pid) => !actor.accessibleProfileIds.includes(pid));
        nextProfileIds = [...new Set([...kept, ...dto.profileIds])];
      }
    }

    if (dto.username && dto.username !== u.username) {
      const dup = await this.userRepo.findOne({ where: { username: dto.username } });
      if (dup) throw new ConflictException('این نام کاربری قبلاً ثبت شده است');
      u.username = dto.username;
    }

    if (dto.email !== undefined) u.email = dto.email;
    if (dto.phone !== undefined) u.phone = dto.phone;
    if (dto.name !== undefined) u.name = dto.name;
    if (dto.role !== undefined) u.role = dto.role;
    if (dto.organization !== undefined) u.organization = dto.organization;
    if (dto.isActive !== undefined) u.isActive = dto.isActive;

    await this.saveUser(u);

    if (nextProfileIds) {
      await this.userProfileRepo.delete({ userId: id });
      if (u.role !== 'super_admin' && nextProfileIds.length) {
        await this.userProfileRepo.save(
          nextProfileIds.map((profileId) => ({ userId: id, profileId })),
        );
      }
    }

    return this.get(id, actor);
  }

  async resetPassword(id: string, newPassword: string, actor: AdminActor) {
    const { user: u } = await this.loadInScope(id, actor);
    u.passwordHash = await bcrypt.hash(newPassword, 10);
    await this.userRepo.save(u);
    return { id, reset: true };
  }

  async deactivate(id: string, actor: AdminActor) {
    if (!this.isSuper(actor) && id === actor.sub) {
      throw new ForbiddenException('نمی‌توانید حساب خودتان را غیرفعال کنید');
    }
    const { user: u } = await this.loadInScope(id, actor);
    u.isActive = false;
    await this.userRepo.save(u);
    return { id, deactivated: true };
  }

  /**
   * Permanently removes a user and their profile links. Nobody deletes
   * themselves; a client_admin only deletes in-scope users (never super_admin).
   */
  async remove(id: string, actor: AdminActor) {
    if (id === actor.sub) throw new ForbiddenException('نمی‌توانید حساب خودتان را حذف کنید');
    const { user } = await this.loadInScope(id, actor);
    if (user.role === 'super_admin' && user.isActive) {
      const activeSupers = await this.userRepo.count({ where: { role: 'super_admin', isActive: true } });
      if (activeSupers <= 1) throw new ForbiddenException('آخرین مدیر کل فعال را نمی‌توان حذف کرد');
    }
    try {
      await this.userRepo.manager.transaction(async (em) => {
        // global_context.updated_by has no ON DELETE rule
        await em.query(`UPDATE global_context SET updated_by = NULL WHERE updated_by = $1`, [id]);
        await em.delete(UserProfile, { userId: id });
        await em.delete(User, { id });
      });
    } catch (err: any) {
      if (err?.code === '23503') {
        throw new ConflictException('این کاربر سوابق وابسته دارد و حذف نشد؛ به‌جای حذف، غیرفعالش کنید');
      }
      throw err;
    }
    return { id, deleted: true };
  }

  // ------------------------------------------------- permission matrix

  /**
   * Users (non-super_admin, in the caller's scope) with the links to the
   * profiles the caller can see. The frontend crosses them with its profile list.
   */
  async accessMatrix(actor: AdminActor) {
    const { visible, byUser } = await this.loadVisible(actor);
    const users = visible
      .filter((u) => u.role !== 'super_admin')
      .map((u) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        role: u.role,
        organization: u.organization,
        isActive: u.isActive,
        profileIds: this.visibleProfileIds(actor, byUser[u.id] ?? []),
      }));
    return { users };
  }

  /**
   * Applies grants and revokes from the permission matrix in one transaction.
   * Every pair must name an in-scope, non-super_admin user and a profile the
   * caller can access; a revoke may not leave a user with no profile at all.
   */
  async applyAccess(dto: ApplyAccessDto, actor: AdminActor) {
    const grant = dto.grant ?? [];
    const revoke = dto.revoke ?? [];
    if (!grant.length && !revoke.length) return { granted: 0, revoked: 0 };

    const { visible, byUser } = await this.loadVisible(actor);
    const byId = new Map(visible.map((u) => [u.id, u]));
    const pairs = [...grant, ...revoke];

    for (const p of pairs) {
      const u = byId.get(p.userId);
      if (!u) throw new ForbiddenException(OUT_OF_SCOPE);
      if (u.role === 'super_admin') {
        throw new BadRequestException('مدیر کل به همه شخصیت‌ها دسترسی دارد و نیازی به تخصیص ندارد');
      }
    }
    this.assertProfilesAccessible(actor, [...new Set(pairs.map((p) => p.profileId))]);

    const key = (p: { userId: string; profileId: string }) => `${p.userId}:${p.profileId}`;
    const grantKeys = new Set(grant.map(key));
    const revokeKeys = new Set(revoke.map(key));
    for (const k of grantKeys) {
      if (revokeKeys.has(k)) throw new BadRequestException('یک دسترسی هم‌زمان اعطا و لغو شده است');
    }

    for (const userId of new Set(pairs.map((p) => p.userId))) {
      const next = new Set(byUser[userId] ?? []);
      for (const p of grant) if (p.userId === userId) next.add(p.profileId);
      for (const p of revoke) if (p.userId === userId) next.delete(p.profileId);
      if (next.size === 0) {
        const name = byId.get(userId)?.name ?? '';
        throw new BadRequestException(`کاربر «${name}» باید دست‌کم به یک شخصیت دسترسی داشته باشد`);
      }
    }

    const existing = new Set(
      Object.entries(byUser).flatMap(([userId, ids]) => ids.map((profileId) => `${userId}:${profileId}`)),
    );
    const toInsert = [...grantKeys].filter((k) => !existing.has(k));
    const toDelete = [...revokeKeys].filter((k) => existing.has(k));
    const split = (k: string) => {
      const [userId, profileId] = k.split(':');
      return { userId, profileId };
    };

    await this.userProfileRepo.manager.transaction(async (em) => {
      for (const k of toDelete) await em.delete(UserProfile, split(k));
      if (toInsert.length) await em.insert(UserProfile, toInsert.map(split));
    });

    return { granted: toInsert.length, revoked: toDelete.length };
  }

  /** Saves a user, turning unique violations (users.phone / username) into Persian 409s. */
  private async saveUser(u: User) {
    try {
      return await this.userRepo.save(u);
    } catch (err: any) {
      if (err?.code === '23505') {
        const detail = `${err.constraint ?? ''} ${err.detail ?? ''}`;
        if (detail.includes('phone')) throw new ConflictException('این شماره قبلاً ثبت شده');
        throw new ConflictException('این نام کاربری قبلاً ثبت شده است');
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- scoping

  private isSuper(actor: AdminActor) {
    return actor.role === 'super_admin';
  }

  private orgOf(user?: User | null): string | null {
    return user?.organization?.trim() || null;
  }

  private inScope(actor: AdminActor, actorOrg: string | null, user: User, profileIds: string[]) {
    if (user.role === 'super_admin') return false;
    if (user.id === actor.sub) return true;
    if (actorOrg && this.orgOf(user) === actorOrg) return true;
    return profileIds.some((pid) => actor.accessibleProfileIds.includes(pid));
  }

  /** Loads the target user and its profile links; 404 if missing, 403 if outside the caller's scope. */
  private async loadInScope(id: string, actor: AdminActor) {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('کاربر یافت نشد');
    const profileIds = (await this.userProfileRepo.find({ where: { userId: id } })).map(
      (l) => l.profileId,
    );

    if (!this.isSuper(actor)) {
      const caller =
        actor.sub === id ? user : await this.userRepo.findOne({ where: { id: actor.sub } });
      if (!this.inScope(actor, this.orgOf(caller), user, profileIds)) {
        throw new ForbiddenException(OUT_OF_SCOPE);
      }
    }
    return { user, profileIds };
  }

  private assertProfilesAccessible(actor: AdminActor, profileIds: string[]) {
    const outside = profileIds.filter((pid) => !actor.accessibleProfileIds.includes(pid));
    if (outside.length) {
      throw new ForbiddenException('فقط پروفایل‌هایی را می‌توانید اختصاص دهید که خودتان به آن‌ها دسترسی دارید');
    }
  }

  /** A client_admin only sees the links to profiles they can access. */
  private visibleProfileIds(actor: AdminActor, profileIds: string[]) {
    return this.isSuper(actor)
      ? profileIds
      : profileIds.filter((pid) => actor.accessibleProfileIds.includes(pid));
  }
}
