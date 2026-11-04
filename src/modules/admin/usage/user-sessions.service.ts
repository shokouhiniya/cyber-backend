import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserSession } from './user-session.entity';

/** A session with no activity for this long is over (ended_at = its last activity). */
export const SESSION_IDLE_MINUTES = 30;
/** Activity is written at most this often per user. */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

const IDLE = `interval '${SESSION_IDLE_MINUTES} minutes'`;

export interface SessionClientInfo {
  ip?: string | null;
  userAgent?: string | null;
}

export interface SessionReportFilters {
  from?: string;
  to?: string;
  userId?: string;
}

/**
 * Login sessions per user (table user_sessions):
 *   start()  on sign-in: closes any open session ('replaced', or 'timeout' if idle) and opens one;
 *   touch()  on authenticated requests, throttled to once a minute: bumps
 *            last_activity_at, or opens a 'resume' session when the last one went idle;
 *   end()    on sign-out: closes the open session with 'logout'.
 * Idle sessions are closed lazily ('timeout' at their last activity) by touch()
 * and before every report.
 */
@Injectable()
export class UserSessionsService {
  private readonly logger = new Logger(UserSessionsService.name);
  private readonly lastTouch = new Map<string, number>();

  constructor(@InjectRepository(UserSession) private readonly repo: Repository<UserSession>) {}

  async start(userId: string, client: SessionClientInfo = {}) {
    await this.repo.query(
      `UPDATE user_sessions
          SET ended_at   = CASE WHEN last_activity_at < now() - ${IDLE} THEN last_activity_at ELSE now() END,
              end_reason = CASE WHEN last_activity_at < now() - ${IDLE} THEN 'timeout' ELSE 'replaced' END
        WHERE user_id = $1 AND ended_at IS NULL`,
      [userId],
    );
    await this.open(userId, 'login', client);
    this.lastTouch.set(userId, Date.now());
  }

  /** Throttled per user; never throws (activity tracking must not break a request). */
  async touch(userId: string, client: SessionClientInfo = {}, now = Date.now()) {
    const last = this.lastTouch.get(userId);
    if (last !== undefined && now - last < SESSION_TOUCH_INTERVAL_MS) return false;
    this.lastTouch.set(userId, now);
    try {
      const updated = await this.repo.query(
        `UPDATE user_sessions SET last_activity_at = now()
          WHERE user_id = $1 AND ended_at IS NULL AND last_activity_at >= now() - ${IDLE}
          RETURNING id`,
        [userId],
      );
      if (this.rowCount(updated) > 0) return true;
      await this.closeIdle(userId);
      await this.open(userId, 'resume', client);
      return true;
    } catch (err: any) {
      this.logger.warn(`session touch failed for ${userId}: ${err?.message ?? err}`);
      return false;
    }
  }

  async end(userId: string) {
    this.lastTouch.delete(userId);
    // An already idle session timed out at its last activity, not now.
    await this.closeIdle(userId);
    await this.repo.query(
      `UPDATE user_sessions SET ended_at = now(), last_activity_at = now(), end_reason = 'logout'
        WHERE user_id = $1 AND ended_at IS NULL`,
      [userId],
    );
    return { ended: true };
  }

  /** Closes idle sessions, of one user or of everyone. */
  async closeIdle(userId?: string) {
    await this.repo.query(
      `UPDATE user_sessions SET ended_at = last_activity_at, end_reason = 'timeout'
        WHERE ended_at IS NULL AND last_activity_at < now() - ${IDLE}
        ${userId ? 'AND user_id = $1' : ''}`,
      userId ? [userId] : [],
    );
  }

  /**
   * Per-user totals for sessions started in [from, to].
   * `userIds` null = every user (super_admin); otherwise only those ids, and
   * super_admin accounts are never included.
   */
  async report(filters: SessionReportFilters, userIds: string[] | null) {
    await this.closeIdle();
    const { where, params } = this.where(filters, userIds);
    const rows = await this.repo.query(
      `SELECT s.user_id AS "userId", u.name, u.username, u.role, u.is_active AS "isActive",
              COUNT(*)::int AS sessions,
              COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_activity_at) - s.started_at))), 0)::bigint AS "totalSeconds",
              MAX(s.started_at) AS "lastLoginAt",
              MAX(s.ended_at) FILTER (WHERE s.end_reason = 'logout') AS "lastLogoutAt",
              MAX(s.last_activity_at) AS "lastSeenAt",
              BOOL_OR(s.ended_at IS NULL) AS online
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE ${where}
        GROUP BY s.user_id, u.name, u.username, u.role, u.is_active
        ORDER BY MAX(s.last_activity_at) DESC`,
      params,
    );
    return rows.map((r: any) => {
      const totalSeconds = Number(r.totalSeconds) || 0;
      return { ...r, totalSeconds, avgSeconds: r.sessions ? Math.round(totalSeconds / r.sessions) : 0 };
    });
  }

  /** Individual sessions (newest first), same filters and scoping as report(). */
  async list(filters: SessionReportFilters, userIds: string[] | null, limit = 200) {
    await this.closeIdle();
    const { where, params } = this.where(filters, userIds);
    const rows = await this.repo.query(
      `SELECT s.id, s.user_id AS "userId", u.name, u.username, u.role,
              s.started_at AS "startedAt", s.last_activity_at AS "lastActivityAt",
              s.ended_at AS "endedAt", s.start_reason AS "startReason", s.end_reason AS "endReason",
              s.ip, s.user_agent AS "userAgent",
              EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_activity_at) - s.started_at))::bigint AS "durationSeconds"
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE ${where}
        ORDER BY s.started_at DESC
        LIMIT ${Math.min(Math.max(1, Math.floor(limit) || 200), 1000)}`,
      params,
    );
    return rows.map((r: any) => ({ ...r, durationSeconds: Number(r.durationSeconds) || 0 }));
  }

  /** Builds the shared WHERE clause; exported for tests through report()/list(). */
  where(filters: SessionReportFilters, userIds: string[] | null) {
    const parts: string[] = [];
    const params: any[] = [];
    const add = (sql: string, value: any) => {
      params.push(value);
      parts.push(sql.replace('?', `$${params.length}`));
    };
    if (filters.from) add('s.started_at >= ?', this.date(filters.from, 'from'));
    if (filters.to) add('s.started_at <= ?', this.date(filters.to, 'to'));
    if (filters.userId) add('s.user_id = ?', filters.userId);
    if (userIds) {
      add('s.user_id = ANY(?::uuid[])', userIds);
      parts.push(`u.role <> 'super_admin'`);
    }
    return { where: parts.length ? parts.join(' AND ') : 'TRUE', params };
  }

  private date(value: string, name: string) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`تاریخ ${name} نامعتبر است`);
    return d;
  }

  private async open(userId: string, reason: 'login' | 'resume', client: SessionClientInfo) {
    await this.repo.query(
      `INSERT INTO user_sessions (user_id, start_reason, ip, user_agent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) WHERE ended_at IS NULL DO NOTHING`,
      [userId, reason, client.ip?.slice(0, 64) ?? null, client.userAgent?.slice(0, 500) ?? null],
    );
  }

  /** TypeORM's pg driver returns [rows, affected] for UPDATE … RETURNING; tolerate a rows array too. */
  private rowCount(result: any): number {
    if (Array.isArray(result) && Array.isArray(result[0])) return result[0].length;
    if (Array.isArray(result) && typeof result[1] === 'number') return result[1];
    return Array.isArray(result) ? result.length : 0;
  }
}
