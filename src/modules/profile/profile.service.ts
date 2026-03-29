import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Profile } from './profile.entity';

@Injectable()
export class ProfileService {
  constructor(
    @InjectRepository(Profile)
    private readonly repo: Repository<Profile>,
  ) {}

  async getActiveProfile() {
    const profile = await this.repo.findOne({ where: { isActive: true } });
    if (!profile) {
      throw new NotFoundException('پروفایل فعالی یافت نشد');
    }

    return {
      id: profile.id,
      name: profile.name,
      role: profile.role,
      organization: profile.organization,
      avatar: profile.avatar,
      keywords: profile.keywords,
      isActive: profile.isActive,
      lastUpdate: profile.updatedAt,
    };
  }
}
