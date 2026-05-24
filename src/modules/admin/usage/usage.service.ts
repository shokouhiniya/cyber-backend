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
