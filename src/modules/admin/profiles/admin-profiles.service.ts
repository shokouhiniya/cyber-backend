import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Profile } from '../../profile/profile.entity';
import { UserProfile } from '../../user/user-profile.entity';
import { Content } from '../../content/content.entity';
import { DataSource } from '../../data-source/data-source.entity';
import { CreateProfileDto, UpdateProfileDto } from '../admin.dto';

@Injectable()
export class AdminProfilesService {
  constructor(
    @InjectRepository(Profile) private readonly profileRepo: Repository<Profile>,
    @InjectRepository(UserProfile) private readonly userProfileRepo: Repository<UserProfile>,
    @InjectRepository(Content) private readonly contentRepo: Repository<Content>,
    @InjectRepository(DataSource) private readonly dataSourceRepo: Repository<DataSource>,
  ) {}

  async list() {
    const profiles = await this.profileRepo.find({ order: { sortName: 'ASC' } });

    // Batch: latest completed ingest run per profile (one query)
    const latestRuns: Record<string, { finishedAt: Date; postsSelected: number }> = {};
    // Batch: latest AI cache entry per profile (one query)
    const latestAiAt: Record<string, Date> = {};

    if (profiles.length > 0) {
      const ids = profiles.map((p) => p.id);
      const runRows = await this.profileRepo.query(
        `SELECT DISTINCT ON (profile_id) profile_id, finished_at, posts_selected
         FROM ingest_runs
         WHERE profile_id = ANY($1) AND status = 'completed'
         ORDER BY profile_id, finished_at DESC`,
        [ids],
      );
      for (const r of runRows) {
        latestRuns[r.profile_id] = { finishedAt: r.finished_at, postsSelected: r.posts_selected };
      }

      const aiRows = await this.profileRepo.query(
        `SELECT DISTINCT ON (profile_id) profile_id, created_at
         FROM ai_result_cache
         WHERE profile_id = ANY($1)
         ORDER BY profile_id, created_at DESC`,
        [ids],
      );
      for (const r of aiRows) {
        latestAiAt[r.profile_id] = r.created_at;
      }
    }

    // Cheap counts per profile (one query each; fine for v1 scale)
    const results = await Promise.all(
      profiles.map(async (p) => {
        const [postCount, userCount, sourceCount] = await Promise.all([
          this.contentRepo.count({ where: { profileId: p.id } }),
          this.userProfileRepo.count({ where: { profileId: p.id } }),
          this.dataSourceRepo.count({ where: { profileId: p.id } }),
        ]);

        const lastRun = latestRuns[p.id] ?? null;
        const nextFetch = lastRun ? this.computeNextFetch(p.tier, lastRun.finishedAt) : null;

        return {
          id: p.id,
          name: p.name,
          sortName: p.sortName,
          role: p.role,
          organization: p.organization,
          avatar: p.avatar,
          keywords: p.keywords ?? [],
          excludedKeywords: p.excludedKeywords ?? [],
          sortCriteria: p.sortCriteria,
          plan: p.plan,
          primaryColor: p.primaryColor,
          logoUrl: p.logoUrl,
          isActive: p.isActive,
          tier: p.tier,
          dailyAvgPosts: p.dailyAvgPosts,
          sourceWeights: p.sourceWeights ?? {},
          officialChannels: p.officialChannels ?? [],
          promticIdentifier: p.promticIdentifier ?? null,
          profileContexts: p.profileContexts ?? {},
          hiddenWidgets: p.hiddenWidgets ?? [],
          postCount,
          userCount,
          sourceCount,
          lastFetchAt: lastRun?.finishedAt ?? null,
          lastFetchPosts: lastRun?.postsSelected ?? null,
          nextFetchAt: nextFetch,
          lastAiAt: latestAiAt[p.id] ?? null,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        };
      }),
    );
    return results;
  }

  /** Compute the next scheduled fetch time based on tier and last run */
  private computeNextFetch(tier: string, lastFinishedAt: Date): Date {
    const last = new Date(lastFinishedAt);
    switch (tier) {
      case 'heavy': {
        // Runs at 00:00, 06:00, 12:00, 18:00 — find next slot after last run
        const slots = [0, 6, 12, 18];
        const next = new Date(last);
        next.setMinutes(0, 0, 0);
        for (const h of slots) {
          next.setHours(h);
          if (next > last) return next;
        }
        // Wrap to next day 00:00
        next.setDate(next.getDate() + 1);
        next.setHours(0);
        return next;
      }
      case 'light': {
        // Every 3 days at 04:00
        const next = new Date(last);
        next.setDate(next.getDate() + 3);
        next.setHours(4, 0, 0, 0);
        return next;
      }
      default: {
        // Medium: daily at 03:00
        const next = new Date(last);
        next.setDate(next.getDate() + 1);
        next.setHours(3, 0, 0, 0);
        return next;
      }
    }
  }

  async get(id: string) {
    const p = await this.profileRepo.findOne({ where: { id } });
    if (!p) throw new NotFoundException('پروفایل یافت نشد');
    return p;
  }

  async batchImport(rows: Record<string, string>[]): Promise<{
    created: number;
    skipped: number;
    errors: Array<{ row: number; name: string; error: string }>;
  }> {
    let created = 0;
    let skipped = 0;
    const errors: Array<{ row: number; name: string; error: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = r.name?.trim();
      if (!name) { skipped++; continue; }

      // Check for duplicate by exact name
      const extId = r.promtic_external_id?.trim() || this.slug(name);
      const existing = await this.profileRepo.findOne({ where: { name } });
      if (existing) { skipped++; continue; }

      try {
        // Build officialChannels from flat columns
        const officialChannels: any[] = [];
        const channelMap: Record<string, string> = {
          telegram: r.channel_telegram,
          eitaa: r.channel_eitaa,
          rubika: r.channel_rubika,
          bale: r.channel_bale,
          x: r.channel_x,
          instagram: r.channel_instagram,
          web: r.channel_web,
        };
        for (const [platform, handle] of Object.entries(channelMap)) {
          if (handle?.trim()) officialChannels.push({ platform, handle: handle.trim() });
        }

        // Build sourceWeights from flat columns (omit if empty)
        const sourceWeights: Record<string, number> = {};
        const weightKeys = ['telegram', 'twitter', 'instagram', 'news', 'newspaper', 'media', 'bale', 'rubika', 'aparat', 'forum', 'eitaa'];
        for (const k of weightKeys) {
          const v = r[`weight_${k}`]?.trim();
          if (v !== '' && v != null && !isNaN(Number(v))) sourceWeights[k] = Number(v);
        }

        // Build profileContexts
        const profileContexts: Record<string, string> = {};
        if (r.context_default?.trim()) profileContexts['default'] = r.context_default.trim();

        // Parse promises from JSON column if present
        let promises: any[] = [];
        if (r.promises_json?.trim()) {
          try { promises = JSON.parse(r.promises_json.trim()); } catch { promises = []; }
        }

        const entity = this.profileRepo.create({
          name,
          sortName: r.sort_name?.trim() || undefined,
          role: r.role?.trim() || undefined,
          organization: r.organization?.trim() || undefined,
          tier: (['heavy', 'medium', 'light'].includes(r.tier) ? r.tier : 'medium') as any,
          isActive: r.is_active?.toLowerCase() !== 'false',
          keywords: r.keywords?.trim() ? r.keywords.split('|').map((k) => k.trim()).filter(Boolean) : [],
          excludedKeywords: r.excluded_keywords?.trim() ? r.excluded_keywords.split('|').map((k) => k.trim()).filter(Boolean) : [],
          primaryColor: r.primary_color?.trim() || undefined,
          plan: r.plan?.trim() || undefined,
          officialChannels: officialChannels.length ? officialChannels : [],
          sourceWeights,
          profileContexts,
          promises,
          promticIdentifier: {
            external_id: extId,
            name: r.promtic_display_name?.trim() || name,
            type: r.promtic_type?.trim() || 'political_figure',
          },
        } as any);

        await this.profileRepo.save(entity);
        created++;
      } catch (err) {
        errors.push({ row: i + 2, name, error: err?.message || 'unknown error' });
      }
    }

    return { created, skipped, errors };
  }

  async create(dto: CreateProfileDto) {
    const promticIdentifier = {
      external_id: this.slug(dto.name),
      name: dto.name,
      type: 'client',
    };

    const entity = this.profileRepo.create({
      ...dto,
      tier: (dto.tier as any) ?? 'medium',
      promticIdentifier,
    });
    return this.profileRepo.save(entity);
  }

  async update(id: string, dto: UpdateProfileDto) {
    const p = await this.get(id);
    Object.assign(p, { ...dto, ...(dto.tier ? { tier: dto.tier as any } : {}) });
    return this.profileRepo.save(p);
  }

  async archive(id: string) {
    const p = await this.get(id);
    p.isActive = false;
    await this.profileRepo.save(p);
    return { id, archived: true };
  }

  async delete(id: string) {
    const p = await this.get(id);
    await this.profileRepo.remove(p);
    return { id, deleted: true };
  }

  /** Returns the profiles a user may access. super_admin sees them all. */
  async listAccessibleFor(userId: string, role: string) {
    if (role === 'super_admin') {
      const profiles = await this.profileRepo.find({
        order: { sortName: 'ASC' },
        select: ['id', 'name', 'sortName', 'role', 'organization', 'avatar', 'isActive', 'primaryColor', 'logoUrl'],
      });
      return profiles;
    }

    const links = await this.userProfileRepo.find({ where: { userId } });
    if (links.length === 0) return [];
    const ids = links.map((l) => l.profileId);
    return this.profileRepo
      .createQueryBuilder('p')
      .select(['p.id', 'p.name', 'p.sortName', 'p.role', 'p.organization', 'p.avatar', 'p.isActive', 'p.primaryColor', 'p.logoUrl'])
      .whereInIds(ids)
      .orderBy('p.sort_name', 'ASC')
      .getMany();
  }

  private slug(name: string) {
    // Preserve non-latin characters where possible; fall back to a readable id.
    return name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^\w\u0600-\u06FF_-]/g, '')
      .slice(0, 64) || `profile_${Date.now()}`;
  }
}
