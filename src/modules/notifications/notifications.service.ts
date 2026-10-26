import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Notification, NotificationAudience } from './notification.entity';
import {
  APP_EVENTS,
  AppEvents,
  CrisisLevel,
  CrisisLevelChangedEvent,
  IngestRunCompletedEvent,
  IngestRunFailedEvent,
} from './app-events';

export interface NotifyInput {
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Target one user. Omit for profile-scoped / broadcast rows. */
  userId?: string | null;
  /** Scope to users who can access this profile. */
  profileId?: string | null;
  /** 'admin' = super_admin only. Default 'all'. */
  audience?: NotificationAudience;
  meta?: Record<string, any> | null;
}

/** Shape of req.user set by JwtStrategy. */
export interface NotificationViewer {
  sub: string;
  role: string;
  accessibleProfileIds: string[];
}

export const NOTIFICATION_TYPES = {
  INGEST_COMPLETED: 'ingest_completed',
  INGEST_FAILED: 'ingest_failed',
  CRISIS_LEVEL: 'crisis_level',
  DATA_STALE: 'data_stale',
} as const;

const CRISIS_LABEL: Record<CrisisLevel, string> = {
  safe: 'عادی',
  warning: 'هشدار',
  critical: 'بحرانی',
};

const faNum = (n: number) => new Intl.NumberFormat('fa-IR').format(n);

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  /** Last crisis level seen per profile (seeded lazily from the latest crisis notification). */
  private readonly crisisLevels = new Map<string, CrisisLevel>();
  /** Crisis events are handled one at a time so concurrent GETs can't double-notify. */
  private crisisQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectRepository(Notification) private readonly repo: Repository<Notification>,
    private readonly events: AppEvents,
  ) {}

  onModuleInit() {
    this.events.on(APP_EVENTS.INGEST_RUN_COMPLETED, (e) => this.onIngestCompleted(e));
    this.events.on(APP_EVENTS.INGEST_RUN_FAILED, (e) => this.onIngestFailed(e));
    this.events.on(APP_EVENTS.CRISIS_LEVEL_CHANGED, (e) => {
      this.crisisQueue = this.crisisQueue.then(() => this.onCrisisLevel(e)).catch((err) =>
        this.logger.warn(`crisis notification failed: ${err?.message}`),
      );
    });
  }

  // ── Producer API ───────────────────────────────────────────────────────────

  async notify(input: NotifyInput): Promise<Notification> {
    const row = this.repo.create({
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      userId: input.userId ?? null,
      profileId: input.profileId ?? null,
      audience: input.audience ?? 'all',
      meta: input.meta ?? null,
    });
    return this.repo.save(row);
  }

  // ── Reader API ─────────────────────────────────────────────────────────────

  /**
   * Visibility: own rows, plus shared rows whose profile the viewer can access
   * (super_admin sees every profile and admin-audience rows).
   * Params: $1 user id, $2 is-admin, $3 accessible profile ids.
   */
  private visibleSql(alias = 'n') {
    return `(${alias}.user_id = $1 OR (${alias}.user_id IS NULL
      AND (${alias}.audience = 'all' OR $2::boolean)
      AND (${alias}.profile_id IS NULL OR $2::boolean OR ${alias}.profile_id = ANY($3::uuid[]))))`;
  }

  private viewerParams(viewer: NotificationViewer): [string, boolean, string[]] {
    const isAdmin = viewer.role === 'super_admin';
    const ids = isAdmin ? [] : (viewer.accessibleProfileIds ?? []).filter((id) => id !== '*');
    return [viewer.sub, isAdmin, ids];
  }

  async list(viewer: NotificationViewer, opts: { unread?: boolean; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const params = this.viewerParams(viewer);
    const from = `FROM notifications n
      LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $1
      WHERE ${this.visibleSql()}`;
    const unreadCond = `COALESCE(n.read_at, r.read_at) IS NULL`;
    const where = opts.unread ? `${from} AND ${unreadCond}` : from;

    const [rows, totals] = await Promise.all([
      this.repo.query(
        `SELECT n.id, n.type, n.title, n.body, n.link, n.profile_id, n.audience, n.meta,
                n.created_at, COALESCE(n.read_at, r.read_at) AS read_at
         ${where}
         ORDER BY n.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      this.repo.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE ${unreadCond})::int AS unread
         ${from}`,
        params,
      ),
    ]);

    const items = rows.map((r: any) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      profileId: r.profile_id,
      audience: r.audience,
      meta: r.meta,
      createdAt: r.created_at,
      readAt: r.read_at,
    }));
    const total = opts.unread ? totals[0].unread : totals[0].total;
    return { items, total, unreadCount: totals[0].unread, limit, offset };
  }

  async markRead(viewer: NotificationViewer, id: string) {
    const params = this.viewerParams(viewer);
    const rows = await this.repo.query(
      `SELECT n.id, n.user_id FROM notifications n WHERE n.id = $4 AND ${this.visibleSql()}`,
      [...params, id],
    );
    if (!rows.length) throw new NotFoundException('اعلان یافت نشد');

    if (rows[0].user_id === viewer.sub) {
      await this.repo.query(
        `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND read_at IS NULL`,
        [id],
      );
    } else {
      await this.repo.query(
        `INSERT INTO notification_reads (notification_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [id, viewer.sub],
      );
    }
    return { id, read: true };
  }

  async markAllRead(viewer: NotificationViewer) {
    const params = this.viewerParams(viewer);
    const own = await this.repo.query(
      `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
      [viewer.sub],
    );
    const shared = await this.repo.query(
      `INSERT INTO notification_reads (notification_id, user_id)
       SELECT n.id, $1 FROM notifications n
       WHERE n.user_id IS NULL AND ${this.visibleSql()}
       ON CONFLICT DO NOTHING
       RETURNING notification_id`,
      params,
    );
    // TypeORM's pg driver returns [rows, affected] for UPDATE and the RETURNING rows for INSERT.
    const ownCount = Array.isArray(own) ? Number(own[1]) || 0 : 0;
    const sharedCount = Array.isArray(shared) ? shared.length : 0;
    return { marked: ownCount + sharedCount };
  }

  /** Hourly retention — drop notifications older than `days`. */
  async purgeOlderThan(days: number) {
    await this.repo.query(
      `DELETE FROM notifications WHERE created_at < NOW() - ($1 || ' days')::interval`,
      [String(days)],
    );
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  private async profileName(profileId: string): Promise<string> {
    const rows = await this.repo.query(`SELECT name FROM profiles WHERE id = $1`, [profileId]);
    return rows[0]?.name ?? 'پروفایل';
  }

  private async onIngestCompleted(e: IngestRunCompletedEvent) {
    if (!e?.profileId) return;
    const name = await this.profileName(e.profileId);
    const count = Number(e.postsSelected) || 0;
    await this.notify({
      type: NOTIFICATION_TYPES.INGEST_COMPLETED,
      profileId: e.profileId,
      title: `داده‌های جدید ${name} دریافت شد`,
      body: count > 0 ? `${faNum(count)} پست تازه تحلیل شد.` : 'جمع‌آوری انجام شد؛ پست تازه‌ای یافت نشد.',
      link: '/dashboard',
      meta: { runId: e.runId ?? null, postsSelected: count },
    });
  }

  private async onIngestFailed(e: IngestRunFailedEvent) {
    if (!e?.profileId) return;
    const name = await this.profileName(e.profileId);
    await this.notify({
      type: NOTIFICATION_TYPES.INGEST_FAILED,
      profileId: e.profileId,
      audience: 'admin',
      title: `جمع‌آوری داده‌های ${name} ناموفق بود`,
      body: e.error ? String(e.error).slice(0, 300) : null,
      link: '/dashboard/admin/profiles',
      meta: { runId: e.runId ?? null },
    });
  }

  private async lastCrisisLevel(profileId: string): Promise<CrisisLevel> {
    const cached = this.crisisLevels.get(profileId);
    if (cached) return cached;
    const rows = await this.repo.query(
      `SELECT meta->>'level' AS level FROM notifications
       WHERE type = $1 AND profile_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [NOTIFICATION_TYPES.CRISIS_LEVEL, profileId],
    );
    const level = (rows[0]?.level as CrisisLevel) || 'safe';
    this.crisisLevels.set(profileId, level);
    return level;
  }

  private async onCrisisLevel(e: CrisisLevelChangedEvent) {
    if (!e?.profileId || !CRISIS_LABEL[e.level]) return;
    const previous = e.previousLevel ?? (await this.lastCrisisLevel(e.profileId));
    this.crisisLevels.set(e.profileId, e.level);
    if (previous === e.level) return;

    const name = await this.profileName(e.profileId);
    const escalated = e.level !== 'safe';
    await this.notify({
      type: NOTIFICATION_TYPES.CRISIS_LEVEL,
      profileId: e.profileId,
      title: escalated
        ? `سطح بحران ${name}: ${CRISIS_LABEL[e.level]}`
        : `وضعیت ${name} به حالت عادی برگشت`,
      body: `از «${CRISIS_LABEL[previous]}» به «${CRISIS_LABEL[e.level]}»${
        e.score != null ? ` — امتیاز ${faNum(Math.round(e.score))} از ${faNum(100)}` : ''
      }`,
      link: '/dashboard',
      meta: { level: e.level, previousLevel: previous, score: e.score ?? null },
    });
  }
}
