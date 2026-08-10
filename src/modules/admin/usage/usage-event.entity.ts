import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Raw event stream for usage analytics.
 * Aggregated on read — no rollup table in v1.
 */
@Entity('usage_event')
export class UsageEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string;

  @Column({ name: 'profile_id', type: 'uuid', nullable: true })
  profileId: string;

  @Column({ name: 'event_type', length: 50 })
  eventType: string;

  @Index()
  @Column({ name: 'event_name', length: 100 })
  eventName: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Index()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
