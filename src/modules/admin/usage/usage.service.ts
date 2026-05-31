import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UsageEvent } from './usage-event.entity';

@Injectable()
export class UsageService {
  constructor(
    @InjectRepository(UsageEvent)
    private readonly repo: Repository<UsageEvent>,
  ) {}

  async record(entry: {
    userId?: string;
    profileId?: string;
    eventType: string;
    eventName: string;
    metadata?: Record<string, any>;
  }) {
    return this.repo.save(this.repo.create(entry));
  }

  /** Totals for the period. Null profileId = all profiles. */
  async summary(from?: string, to?: string, profileId?: string | null) {
    const qb = this.repo
      .createQueryBuilder('e')
      .select('e.event_name', 'eventName')
      .addSelect('COUNT(*)', 'count');
    this.applyFilters(qb, from, to, profileId);
    const byName = await qb.groupBy('e.event_name').orderBy('count', 'DESC').getRawMany();

    const totalQb = this.repo.createQueryBuilder('e').select('COUNT(*)', 'total');
    this.applyFilters(totalQb, from, to, profileId);
    const totalRow = await totalQb.getRawOne();

    return {
      total: parseInt(totalRow?.total ?? '0', 10) || 0,
      byEventName: byName.map((r) => ({ eventName: r.eventName, count: parseInt(r.count, 10) })),
    };
  }

  /** Which profiles are most active in the period. super_admin view. */
  async profilesRanking(from?: string, to?: string) {
    const qb = this.repo
      .createQueryBuilder('e')
      .select('e.profile_id', 'profileId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COUNT(DISTINCT e.user_id)', 'uniqueUsers')
      .where('e.profile_id IS NOT NULL');
    this.applyFilters(qb, from, to, null, /*skipProfile*/ true);
    const rows = await qb.groupBy('e.profile_id').orderBy('count', 'DESC').limit(50).getRawMany();
    return rows.map((r) => ({
      profileId: r.profileId,
      count: parseInt(r.count, 10),
      uniqueUsers: parseInt(r.uniqueUsers, 10),
    }));
  }

  /** Top features for a given profile (or overall if null). */
  async featuresRanking(from?: string, to?: string, profileId?: string | null) {
    const qb = this.repo
      .createQueryBuilder('e')
      .select('e.event_name', 'eventName')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COUNT(DISTINCT e.user_id)', 'uniqueUsers');
    this.applyFilters(qb, from, to, profileId);
    const rows = await qb.groupBy('e.event_name').orderBy('count', 'DESC').limit(50).getRawMany();
    return rows.map((r) => ({
      eventName: r.eventName,
      count: parseInt(r.count, 10),
      uniqueUsers: parseInt(r.uniqueUsers, 10),
    }));
  }

  /** Daily time-series for the chart. */
  async daily(from?: string, to?: string, profileId?: string | null) {
    const qb = this.repo
      .createQueryBuilder('e')
      .select("date_trunc('day', e.created_at)", 'day')
      .addSelect('COUNT(*)', 'count');
    this.applyFilters(qb, from, to, profileId);
    const rows = await qb.groupBy("date_trunc('day', e.created_at)").orderBy('day', 'ASC').getRawMany();
    return rows.map((r) => ({ day: r.day, count: parseInt(r.count, 10) }));
  }

  /**
   * Per-user breakdown for a specific profile.
   * Returns each user's total events, last seen, top features, and 7-day daily counts.
   */
  async byProfile(profileId: string, from?: string, to?: string) {
    const dateFrom = from ? new Date(from) : null;
    const dateTo   = to   ? new Date(to)   : null;

    const dateFilter = () => {
      const parts: string[] = [];
      if (dateFrom) parts.push(`e.created_at >= '${dateFrom.toISOString()}'`);
      if (dateTo)   parts.push(`e.created_at <= '${dateTo.toISOString()}'`);
      return parts.length ? `AND ${parts.join(' AND ')}` : '';
    };

    // Per-user totals
    const userRows: Array<{ userId: string; totalEvents: string; lastSeen: Date; firstSeen: Date }> =
      await this.repo.query(
        `SELECT
           e.user_id AS "userId",
           COUNT(*) AS "totalEvents",
           MAX(e.created_at) AS "lastSeen",
           MIN(e.created_at) AS "firstSeen"
         FROM usage_event e
         WHERE e.profile_id = $1
           AND e.user_id IS NOT NULL
           ${dateFilter()}
         GROUP BY e.user_id
         ORDER BY COUNT(*) DESC`,
        [profileId],
      );

    if (userRows.length === 0) return [];

    const userIds = userRows.map((r) => r.userId);

    // Resolve user names
    const userNames: Array<{ id: string; name: string; username: string }> = await this.repo.query(
      `SELECT id, name, username FROM users WHERE id = ANY($1::uuid[])`,
      [userIds],
    );
    const nameMap = Object.fromEntries(userNames.map((u) => [u.id, u]));

    // Top features per user (top 5 per user)
    const featRows: Array<{ userId: string; eventName: string; cnt: string }> =
      await this.repo.query(
        `SELECT
           e.user_id AS "userId",
           e.event_name AS "eventName",
           COUNT(*) AS cnt
         FROM usage_event e
         WHERE e.profile_id = $1
           AND e.user_id = ANY($2::uuid[])
           ${dateFilter()}
         GROUP BY e.user_id, e.event_name
         ORDER BY e.user_id, COUNT(*) DESC`,
        [profileId, userIds],
      );

    // 7-day daily counts per user (always last 7 days, ignoring from/to)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const dailyRows: Array<{ userId: string; day: string; cnt: string }> =
      await this.repo.query(
        `SELECT
           e.user_id AS "userId",
           DATE(e.created_at AT TIME ZONE 'Asia/Tehran') AS day,
           COUNT(*) AS cnt
         FROM usage_event e
         WHERE e.profile_id = $1
           AND e.user_id = ANY($2::uuid[])
           AND e.created_at >= $3
         GROUP BY e.user_id, DATE(e.created_at AT TIME ZONE 'Asia/Tehran')
         ORDER BY e.user_id, day`,
        [profileId, userIds, sevenDaysAgo],
      );

    // Build 7-day series per user (fill missing days with 0)
    const days7: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600_000);
      days7.push(d.toISOString().slice(0, 10));
    }

    const dailyByUser: Record<string, Record<string, number>> = {};
    for (const r of dailyRows) {
      if (!dailyByUser[r.userId]) dailyByUser[r.userId] = {};
      dailyByUser[r.userId][r.day] = parseInt(r.cnt, 10);
    }

    // Group features by user, keep top 5
    const featByUser: Record<string, Array<{ eventName: string; count: number }>> = {};
    for (const r of featRows) {
      if (!featByUser[r.userId]) featByUser[r.userId] = [];
      if (featByUser[r.userId].length < 5) {
        featByUser[r.userId].push({ eventName: r.eventName, count: parseInt(r.cnt, 10) });
      }
    }

    return userRows.map((r) => ({
      userId: r.userId,
      name: nameMap[r.userId]?.name ?? 'ناشناس',
      username: nameMap[r.userId]?.username ?? null,
      totalEvents: parseInt(r.totalEvents, 10),
      lastSeen: r.lastSeen,
      firstSeen: r.firstSeen,
      topFeatures: featByUser[r.userId] ?? [],
      // 7-day sparkline: array of { day: 'YYYY-MM-DD', count: N }
      daily7: days7.map((day) => ({ day, count: dailyByUser[r.userId]?.[day] ?? 0 })),
    }));
  }

  private applyFilters(
    qb: any,
    from?: string,
    to?: string,
    profileId?: string | null,
    skipProfile = false,
  ) {
    if (from) qb.andWhere('e.created_at >= :from', { from: new Date(from) });
    if (to) qb.andWhere('e.created_at <= :to', { to: new Date(to) });
    if (!skipProfile && profileId) qb.andWhere('e.profile_id = :pid', { pid: profileId });
  }
}
