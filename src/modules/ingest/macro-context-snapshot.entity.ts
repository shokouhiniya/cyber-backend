import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

/** One «وضعیت کلان کشور» generation attempt (scripts/020-macro-context-bot-signals.sql). */
@Entity('macro_context_snapshots')
export class MacroContextSnapshot {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** 'ok' | 'failed' */
  @Column({ type: 'varchar', length: 16 })
  status: 'ok' | 'failed';

  /** 'cron' | 'manual' */
  @Column({ type: 'varchar', length: 16, default: 'cron' })
  trigger: string;

  @Column({ type: 'jsonb', nullable: true })
  briefing: any;

  @Column({ type: 'jsonb', nullable: true })
  stats: any;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'model_name', type: 'varchar', length: 120, nullable: true })
  modelName: string | null;
}
