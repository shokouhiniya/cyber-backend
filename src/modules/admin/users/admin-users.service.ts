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
import { CreateUserDto, UpdateUserDto } from '../admin.dto';

/** The authenticated caller, as set on req.user by the JWT strategy. */
export interface AdminActor {
  sub: string;
  role: string;
  accessibleProfileIds: string[];
}

/** Roles a client_admin may hand out. */
const CLIENT_ASSIGNABLE_ROLES = ['client_admin', 'client_viewer'];

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

  async list(actor: AdminActor) {
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

    return visible.map((u) => ({
      id: u.id,
      name: u.name,
      username: u.username,
      email: u.email,
      role: u.role,
      organization: u.organization,
      avatar: u.avatar,
      isActive: u.isActive,
      createdAt: u.createdAt,
      profileIds: this.visibleProfileIds(actor, byUser[u.id] ?? []),
    }));
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
        throw new ForbiddenException('شما فقط می‌توانید کاربر با نقش مدیر مشتری یا کارشناس بسازید');
      }
      this.assertProfilesAccessible(actor, dto.profileIds ?? []);
      organization = this.orgOf(await this.userRepo.findOne({ where: { id: actor.sub } })) ?? undefined;
    }

    const existing = await this.userRepo.findOne({ where: { username: dto.username } });
    if (existing) throw new ConflictException('این نام کاربری قبلاً ثبت شده است');

    if (dto.role !== 'super_admin' && (!dto.profileIds || dto.profileIds.length === 0)) {
      throw new BadRequestException('برای نقش‌های غیر مدیرکل باید حداقل یک پروفایل انتخاب شود');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.userRepo.save(
      this.userRepo.create({
        name: dto.name,
        username: dto.username,
        email: dto.email,
        passwordHash,
        role: dto.role,
        organization,
        isActive: true,
      }),
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
          throw new ForbiddenException('شما فقط می‌توانید نقش مدیر مشتری یا کارشناس را تعیین کنید');
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
    if (dto.name !== undefined) u.name = dto.name;
    if (dto.role !== undefined) u.role = dto.role;
    if (dto.organization !== undefined) u.organization = dto.organization;
    if (dto.isActive !== undefined) u.isActive = dto.isActive;

    await this.userRepo.save(u);

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
