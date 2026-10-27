import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Profile } from './profile.entity';
import { loadTierSuggestions } from './tier-suggestion';
import { describeCron, mergeIngestSettings } from '../ingest/ingest-settings';

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
      priority: profile.priority ?? 0,
      isActive: profile.isActive,
      tier: profile.tier,
      tierInfo: await this.tierInfo(profile),
      primaryColor: profile.primaryColor,
      logoUrl: profile.logoUrl,
      officialChannels: profile.officialChannels ?? [],
      promticIdentifier: profile.promticIdentifier ?? null,
      promises: profile.promises ?? [],
      sourceWeights: profile.sourceWeights ?? {},
      hiddenWidgets: profile.hiddenWidgets ?? [],
      lastUpdate: profile.updatedAt,
    };
  }

  /**
   * Current tier, how often it is collected, and the tier the 8tag mention
   * volume suggests (shown next to the admin's choice, never applied).
   */
  private async tierInfo(profile: Profile) {
    const suggestions = await loadTierSuggestions((sql, params) => this.repo.query(sql, params), [profile.id]);
    let settings = mergeIngestSettings(null);
    try {
      const [row] = await this.repo.query(`SELECT value FROM global_context WHERE key = 'ingest_settings'`);
      if (row?.value) settings = mergeIngestSettings(JSON.parse(row.value));
    } catch {
      // unreadable settings → defaults
    }
    const tier = settings[profile.tier] ? profile.tier : 'medium';
    return {
      current: profile.tier,
      schedule: describeCron(settings[tier].cron),
      automaticCollectionEnabled: settings.automaticCollectionEnabled !== false,
      ...suggestions[profile.id],
    };
  }
}
