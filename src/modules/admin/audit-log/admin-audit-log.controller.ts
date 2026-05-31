import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AdminAuditLogService } from './admin-audit-log.service';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { IngestRun } from '../../ingest/ingest-run.entity';
import { Profile } from '../../profile/profile.entity';

@Controller('admin/audit-log')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin')
export class AdminAuditLogController {
  constructor(
    private readonly service: AdminAuditLogService,
    @InjectRepository(IngestRun)
    private readonly runRepo: Repository<IngestRun>,
    @InjectRepository(Profile)
    private readonly profileRepo: Repository<Profile>,
  ) {}

  @Get()
  list(
    @Query('userId') userId?: string,
    @Query('profileId') profileId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.list({
      userId,
      profileId,
      action,
      from,
      to,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  /**
   * Unified activity feed — combines admin audit log entries with ingest runs
   * into a single timeline sorted by date. Designed for the admin log page.
   */
  @Get('activity-feed')
  async activityFeed(
    @Query('limit') limitStr?: string,
    @Query('category') category?: string,
  ) {
    const limit = Math.min(parseInt(limitStr || '100', 10), 200);

    // Fetch profiles for name resolution
    const profiles = await this.profileRepo.find({ select: ['id', 'name'] });
    const profileMap = Object.fromEntries(profiles.map((p) => [p.id, p.name]));

    const items: any[] = [];

    // ── Ingest runs (category: ingest) ──────────────────────────────────
    if (!category || category === 'ingest') {
      const runs = await this.runRepo.find({
        order: { startedAt: 'DESC' },
        take: limit,
        select: ['id', 'profileId', 'status', 'startedAt', 'finishedAt', 'postsFetched', 'postsAfterDedup', 'postsSelected', 'errorMessage'],
      });

      for (const r of runs) {
        items.push({
          id: `run_${r.id}`,
          category: 'ingest',
          timestamp: r.finishedAt || r.startedAt,
          status: r.status,
          profileName: profileMap[r.profileId] || r.profileId,
          summary: r.status === 'completed'
            ? `${r.postsSelected} پست انتخاب شد (از ${r.postsFetched} دریافتی، ${r.postsAfterDedup} پس از حذف تکراری)`
            : r.status === 'failed'
              ? r.errorMessage || 'خطای ناشناخته'
              : 'در حال اجرا...',
          actor: 'سیستم (زمان‌بندی)',
          duration: r.finishedAt && r.startedAt
            ? Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)
            : null,
          error: r.status === 'failed' ? r.errorMessage : null,
        });
      }
    }

    // ── Admin operations (category: admin) ──────────────────────────────
    if (!category || category === 'admin') {
      const { data: auditRows } = await this.service.list({ limit });

      for (const a of auditRows) {
        // Determine a human-readable summary from the action
        let summary = a.action;
        const parts = a.action.split('.');
        const entity = parts[0] || '';
        const method = parts[1] || '';

        // Special-case well-known action strings for human-readable summaries
        const knownActions: Record<string, string> = {
          'ai-content.regenerate-all': 'بازتولید تحلیل هوش مصنوعی',
          'ingest.run-now':            'جمع‌آوری کامل (دستی)',
          'ingest.posts-only':         'جمع‌آوری پست‌ها (بدون هوش مصنوعی)',
        };

        if (knownActions[a.action]) {
          summary = knownActions[a.action];
          if (a.profileId && profileMap[a.profileId]) summary += `: ${profileMap[a.profileId]}`;
          // For AI regeneration, include per-section results if available
          if (a.action === 'ai-content.regenerate-all' && a.diff?.results) {
            const errCount = a.diff.errorCount ?? 0;
            const durSec = a.diff.durationMs ? Math.round(a.diff.durationMs / 1000) : null;
            if (errCount > 0) summary += ` — ${errCount} خطا`;
            if (durSec) summary += ` (${durSec}s)`;
          }
        } else {
          const entityLabels: Record<string, string> = {
            profiles: 'پروفایل',
            users: 'کاربر',
            'data-sources': 'منبع داده',
            'global-context': 'متغیر عمومی',
          };
          const methodLabels: Record<string, string> = {
            post: 'ایجاد',
            patch: 'ویرایش',
            put: 'ویرایش',
            delete: 'حذف',
          };
          const entityLabel = entityLabels[entity] || entity;
          const methodLabel = methodLabels[method] || method;
          summary = `${methodLabel} ${entityLabel}`;
          if (a.entityId) {
            const resolvedName = profileMap[a.entityId];
            if (resolvedName) summary += `: ${resolvedName}`;
          }
        }

        // Determine category: force-ingest and force-AI go under 'ingest' category
        const itemCategory = (a.action === 'ingest.run-now' || a.action === 'ingest.posts-only')
          ? 'ingest'
          : 'admin';

        items.push({
          id: `audit_${a.id}`,
          category: itemCategory,
          timestamp: a.createdAt,
          status: a.diff?.errorCount > 0 ? 'partial' : 'completed',
          profileName: a.profileId ? (profileMap[a.profileId] || null) : null,
          summary,
          actor: a.userId || 'ناشناس (دستی)',
          actorId: a.userId,
          entityType: entity,
          entityId: a.entityId,
          diff: a.diff,
          error: a.diff?.errorCount > 0 ? `${a.diff.errorCount} بخش با خطا مواجه شد` : null,
        });
      }
    }

    // Sort by timestamp descending and limit
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return items.slice(0, limit);
  }
}
