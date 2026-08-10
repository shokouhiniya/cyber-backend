import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';

import { User } from '../../user/user.entity';
import { UserProfile } from '../../user/user-profile.entity';
import { CreateUserDto, UpdateUserDto } from '../admin.dto';

@Injectable()
export class AdminUsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(UserProfile) private readonly userProfileRepo: Repository<UserProfile>,
  ) {}

  async list() {
    const users = await this.userRepo.find({ order: { createdAt: 'DESC' } });
    const links = await this.userProfileRepo.find();
    const byUser: Record<string, string[]> = {};
    for (const l of links) {
      (byUser[l.userId] ||= []).push(l.profileId);
    }
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      username: u.username,
      email: u.email,
      role: u.role,
      organization: u.organization,
      avatar: u.avatar,
      isActive: u.isActive,
      createdAt: u.createdAt,
      profileIds: byUser[u.id] ?? [],
    }));
  }

  async get(id: string) {
    const u = await this.userRepo.findOne({ where: { id } });
    if (!u) throw new NotFoundException('کاربر یافت نشد');
    const links = await this.userProfileRepo.find({ where: { userId: id } });
    return {
      ...u,
      passwordHash: undefined,
      profileIds: links.map((l) => l.profileId),
    };
  }

  async create(dto: CreateUserDto) {
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
        organization: dto.organization,
        isActive: true,
      }),
    );

    if (dto.role !== 'super_admin' && dto.profileIds?.length) {
      await this.userProfileRepo.save(
        dto.profileIds.map((profileId) => ({ userId: user.id, profileId })),
      );
    }

    return this.get(user.id);
  }

  async update(id: string, dto: UpdateUserDto) {
    const u = await this.userRepo.findOne({ where: { id } });
    if (!u) throw new NotFoundException('کاربر یافت نشد');

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

    if (dto.profileIds) {
      await this.userProfileRepo.delete({ userId: id });
      if (u.role !== 'super_admin' && dto.profileIds.length) {
        await this.userProfileRepo.save(
          dto.profileIds.map((profileId) => ({ userId: id, profileId })),
        );
      }
    }

    return this.get(id);
  }

  async resetPassword(id: string, newPassword: string) {
    const u = await this.userRepo.findOne({ where: { id } });
    if (!u) throw new NotFoundException('کاربر یافت نشد');
    u.passwordHash = await bcrypt.hash(newPassword, 10);
    await this.userRepo.save(u);
    return { id, reset: true };
  }

  async deactivate(id: string) {
    const u = await this.userRepo.findOne({ where: { id } });
    if (!u) throw new NotFoundException('کاربر یافت نشد');
    u.isActive = false;
    await this.userRepo.save(u);
    return { id, deactivated: true };
  }
}
