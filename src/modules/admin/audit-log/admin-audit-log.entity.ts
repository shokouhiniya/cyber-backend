import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Admin-panel audit trail — distinct from the legacy audit_logs table.
 * Written from the admin interceptor for every mutating super_admin /
 * client_admin action.
 */
@Entity('admin_audit_log')
export class AdminAuditLog {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string;

  @Column({ name: 'profile_id', type: 'uuid', nullable: true })
  profileId: string;

  @Column({ length: 100 })
  action: string;

  @Column({ name: 'entity_type', length: 100, nullable: true })
  entityType: string;

  @Column({ name: 'entity_id', length: 255, nullable: true })
  entityId: string;

  @Column({ type: 'jsonb', nullable: true })
  diff: Record<string, any>;

  @Column({ length: 64, nullable: true })
  ip: string;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string;

  @Index()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
