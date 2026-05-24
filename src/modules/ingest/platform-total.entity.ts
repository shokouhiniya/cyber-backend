import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Stores the 8tag total post count per (profile, source, timeframe).
 * Updated during each ingest run so the platform summary widget
 * can render instantly from the DB without live API calls.
 */
@Entity('platform_totals')
@Index(['profileId', 'fetchedAt'])
export class PlatformTotal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'profile_id' })
  profileId: string;

  @Column({ name: 'source_type', length: 30 })
  sourceType: string;

  @Column({ length: 20 })
  timeframe: string;

  @Column({ type: 'bigint', default: 0 })
  total: number;

  @Column({ name: 'fetched_at', type: 'timestamptz', default: () => 'NOW()' })
  fetchedAt: Date;
}
