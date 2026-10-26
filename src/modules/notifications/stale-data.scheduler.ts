import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';

import { Notification } from './notification.entity';
import { NOTIFICATION_TYPES, NotificationsService } from './notifications.service';

/** Nominal hours between scheduled runs per tier (matches DEFAULT_INGEST_SETTINGS crons). */
export const TIER_INTERVAL_HOURS: Record<string, number> = {
  heavy: 6,
  medium: 24,
  light: 72,
};

const RETENTION_DAYS = 90;

/**
 * Hourly: flag profiles whose latest completed run is older than 2× their tier
 * interval («داده‌های X به‌روز نیست»). One notification per stale episode — a new
 * one is only created after a fresher run has landed. Also purges old notifications.
 */
@Injectable()
export class StaleDataScheduler {
  private readonly logger = new Logger(StaleDataScheduler.name);

  constructor(
    @InjectRepository(Notification) private readonly repo: Repository<Notification>,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'notifications_stale_data' })
  async runHourly() {
    try {
      const created = await this.checkStaleProfiles();
      if (created) this.logger.log(`Stale-data check: ${created} notification(s)`);
      await this.notifications.purgeOlderThan(RETENTION_DAYS);
    } catch (err) {
      this.logger.warn(`Stale-data check failed: ${err?.message}`);
    }
  }

  /** Returns the number of notifications created. */
  async checkStaleProfiles(now = new Date()): Promise<number> {
    if (!(await this.automaticCollectionEnabled())) return 0;

    // Latest completed run per active profile + whether a stale notice already
    // exists for that run (created after it finished).
    const rows: Array<{ id: string; name: string; tier: string; finished_at: Date; notified: boolean }> =
      await this.repo.query(
        `SELECT p.id, p.name, p.tier, lr.finished_at,
                EXISTS (
                  SELECT 1 FROM notifications n
                  WHERE n.type = $1 AND n.profile_id = p.id AND n.created_at > lr.finished_at
                ) AS notified
         FROM profiles p
         JOIN LATERAL (
           SELECT finished_at FROM ingest_runs
           WHERE profile_id = p.id AND status = 'completed' AND finished_at IS NOT NULL
           ORDER BY finished_at DESC LIMIT 1
         ) lr ON TRUE
         WHERE p.is_active = TRUE`,
        [NOTIFICATION_TYPES.DATA_STALE],
      );

    let created = 0;
    for (const r of rows) {
      if (r.notified) continue;
      const intervalH = TIER_INTERVAL_HOURS[r.tier] ?? TIER_INTERVAL_HOURS.medium;
      const ageH = (now.getTime() - new Date(r.finished_at).getTime()) / 3_600_000;
      if (ageH <= intervalH * 2) continue;

      await this.notifications.notify({
        type: NOTIFICATION_TYPES.DATA_STALE,
        profileId: r.id,
        audience: 'admin',
        title: `داده‌های ${r.name} به‌روز نیست`,
        body: `آخرین جمع‌آوری موفق ${new Intl.NumberFormat('fa-IR').format(Math.floor(ageH))} ساعت پیش بوده است.`,
        link: '/dashboard/admin/profiles',
        meta: { lastFinishedAt: r.finished_at, tier: r.tier },
      });
      created++;
    }
    return created;
  }

  /** When cron collection is switched off, staleness is expected — stay quiet. */
  private async automaticCollectionEnabled(): Promise<boolean> {
    try {
      const rows = await this.repo.query(
        `SELECT value FROM global_context WHERE key = 'ingest_settings' LIMIT 1`,
      );
      if (!rows[0]?.value) return true;
      return JSON.parse(rows[0].value)?.automaticCollectionEnabled !== false;
    } catch {
      return true;
    }
  }
}
