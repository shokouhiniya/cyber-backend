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

  /**
   * Returns the profile currently scoped to the request.
   * Falls back to the single active profile if no scope was resolved
   * (unauthenticated public view).
   */
  async getActiveProfile(profileId: string | null) {
    const profile = profileId
      ? await this.repo.findOne({ where: { id: profileId } })
      : await this.repo.findOne({ where: { isActive: true } });

    if (!profile) {
      throw new NotFoundException('پروفایل یافت نشد');
    }

    return {
      id: profile.id,
      name: profile.name,
      role: profile.role,
      organization: profile.organization,
      avatar: profile.avatar,
      keywords: profile.keywords,
      excludedKeywords: profile.excludedKeywords ?? [],
      sortName: profile.sortName,
      isActive: profile.isActive,
      tier: profile.tier,
      primaryColor: profile.primaryColor,
      logoUrl: profile.logoUrl,
      officialChannels: profile.officialChannels ?? [],
      promticIdentifier: profile.promticIdentifier ?? null,
      promises: profile.promises ?? [],
      sourceWeights: profile.sourceWeights ?? {},
      lastUpdate: profile.updatedAt,
    };
  }
}
