import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Shared context values that get injected into prompts across all profiles.
 * One row per topic key (e.g. 'political_climate', 'major_events').
 */
@Entity('global_context')
export class GlobalContext {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  key: string;

  @Column({ type: 'text', nullable: true })
  value: string;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
