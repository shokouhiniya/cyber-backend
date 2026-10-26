import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export type NotificationAudience = 'all' | 'admin';

/**
 * In-app notification (migration 016).
 *   userId set              → only that user
 *   userId null, profileId  → every user with access to that profile
 *   both null               → broadcast
 * audience 'admin' limits shared rows to super_admin users.
 * readAt only applies to single-user rows; shared rows track reads per user
 * in notification_reads.
 */
@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'profile_id', type: 'uuid', nullable: true })
  profileId: string | null;

  @Column({ type: 'varchar', length: 16, default: 'all' })
  audience: NotificationAudience;

  @Column({ type: 'varchar', length: 64 })
  type: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'text', nullable: true })
  link: string | null;

  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, any> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt: Date | null;
}
