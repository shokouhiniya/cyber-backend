import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** One login session per row (migration 022). See UserSessionsService for the lifecycle. */
@Entity('user_sessions')
export class UserSession {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  @Column({ name: 'last_activity_at', type: 'timestamptz' })
  lastActivityAt: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({ name: 'start_reason', length: 16 })
  startReason: string;

  @Column({ name: 'end_reason', type: 'varchar', length: 16, nullable: true })
  endReason: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;
}
