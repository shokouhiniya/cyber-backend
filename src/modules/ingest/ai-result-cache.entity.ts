import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Unique, Index,
} from 'typeorm';
import { Profile } from '../profile/profile.entity';
import { IngestRun } from './ingest-run.entity';

@Entity('ai_result_cache')
@Unique(['profileId', 'ingestRunId', 'promptName'])
@Index(['profileId', 'promptName', 'createdAt'])
export class AiResultCache {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'profile_id' })
  profileId: string;

  @ManyToOne(() => Profile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'profile_id' })
  profile: Profile;

  @Column({ name: 'ingest_run_id', type: 'uuid', nullable: true })
  ingestRunId: string | null;

  @ManyToOne(() => IngestRun, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'ingest_run_id' })
  ingestRun: IngestRun | null;

  @Column({ name: 'prompt_name', length: 60 })
  promptName: string;

  @Column({ type: 'text' })
  result: string;

  @Column({ name: 'token_usage', type: 'jsonb', nullable: true })
  tokenUsage: Record<string, any> | null;

  @Column({ name: 'model_name', type: 'varchar', length: 60, nullable: true })
  modelName: string | null;

  @Column({ name: 'latency_ms', type: 'int', nullable: true })
  latencyMs: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
