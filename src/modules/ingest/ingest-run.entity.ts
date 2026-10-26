import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { Profile } from '../profile/profile.entity';

/** Pipeline steps in order; progress values are the percentage reached when a step starts. */
export const INGEST_STAGES = {
  queued: 0,
  fetch: 5,
  dedup: 30,
  store: 40,
  totals: 45,
  feeds: 55,
  sentiment: 70,
  ai: 85,
  done: 100,
} as const;

export type IngestStage = keyof typeof INGEST_STAGES;

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

  /** Current pipeline step (see IngestStage); kept on failure to show where it stopped. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  stage: IngestStage | null;

  /** 0–100, advanced by the worker at each pipeline step. */
  @Column({ type: 'smallint', default: 0 })
  progress: number;

  @Column({ type: 'jsonb', nullable: true })
  stats: Record<string, any> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
