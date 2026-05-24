import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Unique, Index,
} from 'typeorm';
import { Profile } from '../profile/profile.entity';

@Entity('hourly_aggregates')
@Unique(['profileId', 'hour', 'sourceType', 'sentiment'])
@Index(['profileId', 'hour'])
export class HourlyAggregate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'profile_id' })
  profileId: string;

  @ManyToOne(() => Profile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'profile_id' })
  profile: Profile;

  @Column({ type: 'timestamptz' })
  hour: Date;

  @Column({ name: 'source_type', length: 30 })
  sourceType: string;

  /** 'Positive' | 'Negative' | 'Neutral' | 'all' */
  @Column({ length: 20 })
  sentiment: string;

  @Column({ name: 'post_count', default: 0 })
  postCount: number;

  @Column({ name: 'total_views', type: 'bigint', default: 0 })
  totalViews: number;

  @Column({ name: 'total_likes', default: 0 })
  totalLikes: number;

  @Column({ name: 'total_replies', default: 0 })
  totalReplies: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
