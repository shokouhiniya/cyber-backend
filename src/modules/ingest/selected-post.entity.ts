import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { IngestRun } from './ingest-run.entity';
import { Profile } from '../profile/profile.entity';

@Entity('selected_posts')
@Index(['profileId', 'publishedAt'])
@Index(['externalId', 'sourceType', 'profileId'], { unique: true })
export class SelectedPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'ingest_run_id' })
  ingestRunId: string;

  @ManyToOne(() => IngestRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ingest_run_id' })
  ingestRun: IngestRun;

  @Column({ name: 'profile_id' })
  profileId: string;

  @ManyToOne(() => Profile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'profile_id' })
  profile: Profile;

  // ── Source identity ──────────────────────────────────────────────────────

  @Column({ name: 'external_id' })
  externalId: string;

  @Column({ name: 'source_type', length: 30 })
  sourceType: string;

  @Column({ name: 'screen_name', type: 'varchar', nullable: true })
  screenName: string | null;

  @Column({ name: 'display_name', type: 'varchar', nullable: true })
  displayName: string | null;

  @Column({ name: 'profile_image_url', type: 'text', nullable: true })
  profileImageUrl: string | null;

  // ── Content ──────────────────────────────────────────────────────────────

  @Column({ type: 'text', nullable: true })
  text: string | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'post_url', type: 'text', nullable: true })
  postUrl: string | null;

  @Column({ name: 'media_url', type: 'text', nullable: true })
  mediaUrl: string | null;
  // ── Engagement ───────────────────────────────────────────────────────────

  @Column({ name: 'view_count', default: 0 })
  viewCount: number;

  @Column({ name: 'like_count', default: 0 })
  likeCount: number;

  @Column({ name: 'retweet_count', default: 0 })
  retweetCount: number;

  @Column({ name: 'reply_count', default: 0 })
  replyCount: number;

  // ── LLM classification (filled after sentiment_analysis prompt) ──────────

  @Column({ type: 'varchar', length: 20, nullable: true })
  sentiment: string | null;

  @Column({ name: 'political_spectrum', type: 'varchar', length: 30, nullable: true })
  politicalSpectrum: string | null;

  @Column({ name: 'relevance_score', type: 'smallint', nullable: true })
  relevanceScore: number | null;

  @Column({ name: 'bot_probability', type: 'smallint', nullable: true })
  botProbability: number | null;

  @Column({ name: 'reasoning_brief', type: 'text', nullable: true })
  reasoningBrief: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  simhash: string | null;

  @Column({ name: 'canonical_id', type: 'uuid', nullable: true })
  canonicalId: string | null;

  @Column({ name: 'selection_reason', type: 'text', nullable: true })
  selectionReason: string | null;

  @Column({ type: 'text', array: true, nullable: true })
  hashtags: string[] | null;

  @Column({ name: 'ai_topics', type: 'text', array: true, nullable: true })
  aiTopics: string[] | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
