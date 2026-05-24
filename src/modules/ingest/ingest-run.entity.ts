import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { Profile } from '../profile/profile.entity';

@Entity('ingest_runs')
export class IngestRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'profile_id' })
  profileId: string;

  @ManyToOne(() => Profile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'profile_id' })
  profile: Profile;

  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'NOW()' })
  startedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @Column({ default: 'running' })
  status: 'running' | 'completed' | 'failed';

  @Column({ name: 'posts_fetched', default: 0 })
  postsFetched: number;

  @Column({ name: 'posts_after_dedup', default: 0 })
  postsAfterDedup: number;

  @Column({ name: 'posts_selected', default: 0 })
  postsSelected: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;
  @Column({ type: 'jsonb', nullable: true })
  stats: Record<string, any> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
