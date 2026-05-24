import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { AdminAuditLog } from './admin-audit-log.entity';

export interface AuditWrite {
  userId?: string;
  profileId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  diff?: Record<string, any>;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AdminAuditLogService {
  private readonly logger = new Logger(AdminAuditLogService.name);

  constructor(
    @InjectRepository(AdminAuditLog)
    private readonly repo: Repository<AdminAuditLog>,
  ) {}

  async write(entry: AuditWrite) {
    try {
      await this.repo.save(this.repo.create(entry));
    } catch (err: any) {
      // Audit is best-effort — never break a request because logging failed
      this.logger.warn(`admin_audit_log write failed: ${err?.message}`);
    }
  }

  async list(filters: {
    userId?: string;
    profileId?: string;
    action?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const qb = this.repo
      .createQueryBuilder('a')
      .orderBy('a.created_at', 'DESC')
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0);

    if (filters.userId) qb.andWhere('a.user_id = :u', { u: filters.userId });
    if (filters.profileId) qb.andWhere('a.profile_id = :p', { p: filters.profileId });
    if (filters.action) qb.andWhere('a.action ILIKE :a', { a: `%${filters.action}%` });
    if (filters.from && filters.to) {
      qb.andWhere('a.created_at BETWEEN :f AND :t', {
        f: new Date(filters.from),
        t: new Date(filters.to),
      });
    } else if (filters.from) {
      qb.andWhere('a.created_at >= :f', { f: new Date(filters.from) });
    } else if (filters.to) {
      qb.andWhere('a.created_at <= :t', { t: new Date(filters.to) });
    }

    const [data, total] = await qb.getManyAndCount();
    return {
      data,
      pagination: {
        total,
        limit: filters.limit ?? 50,
        offset: filters.offset ?? 0,
        hasMore: (filters.offset ?? 0) + data.length < total,
      },
    };
  }
}
