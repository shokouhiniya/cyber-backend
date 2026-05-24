import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('data_sources')
export class DataSource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column()
  type: string;

  @Column({ name: 'api_endpoint', nullable: true, type: 'text' })
  apiEndpoint: string;

  @Column({ type: 'jsonb', nullable: true })
  credentials: {
    username?: string;
    password?: string;
    apiKey?: string;
    [key: string]: any;
  };

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'profile_id', type: 'uuid', nullable: true })
  profileId: string;

  @Column({ type: 'jsonb', nullable: true })
  params: Record<string, any>;

  @Column({ name: 'schedule_cron', nullable: true })
  scheduleCron: string;

  @Column({ name: 'last_run_status', nullable: true })
  lastRunStatus: string;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string;

  @Column({ name: 'last_fetch_at', nullable: true, type: 'timestamp' })
  lastFetchAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
