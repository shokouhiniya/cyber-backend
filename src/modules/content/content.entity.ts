import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('content')
export class Content {
  @PrimaryColumn()
  id: string;

  @Column('text')
  text: string;

  @Column({ name: 'source_type', nullable: true })
  sourceType: string;

  @Column({ nullable: true })
  type: string;

  @Column({ name: 'screen_name', nullable: true })
  screenName: string;

  @Column({ name: 'user_id', nullable: true })
  userId: string;

  @Column({ name: 'user_followers', default: 0 })
  userFollowers: number;

  @Column({ name: 'user_following', default: 0 })
  userFollowing: number;

  @Column({ name: 'user_post_count', default: 0 })
  userPostCount: number;

  @Column({ name: 'view_count', default: 0 })
  viewCount: number;

  @Column({ name: 'like_count', default: 0 })
  likeCount: number;

  @Column({ name: 'retweet_count', default: 0 })
  retweetCount: number;

  @Column({ name: 'reply_count', default: 0 })
  replyCount: number;

  @Column({ name: 'quote_count', default: 0 })
  quoteCount: number;

  @Column({ name: 'bookmark_count', default: 0 })
  bookmarkCount: number;

  @Column({ nullable: true })
  sentiment: string;

  @Column({ name: 'sentiment_score', type: 'decimal', precision: 5, scale: 4, nullable: true })
  sentimentScore: number;

  @Column({ nullable: true })
  emotion: string;

  @Column({ name: 'emotion_score', type: 'decimal', precision: 5, scale: 4, nullable: true })
  emotionScore: number;

  @Column({ nullable: true })
  category: string;

  @Column({ nullable: true })
  subcategory: string;

  @Column({ nullable: true })
  lang: string;

  @Column({ name: 'published_at', nullable: true })
  publishedAt: Date;

  @Column({ name: 'conversation_id', nullable: true })
  conversationId: string;

  @Column({ name: 'in_reply_to_id', nullable: true })
  inReplyToId: string;

  @Column('text', { array: true, nullable: true })
  hashtags: string[];

  @Column('text', { array: true, nullable: true, name: 'user_mentions' })
  userMentions: string[];

  @Column({ name: 'is_verified', default: false })
  isVerified: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
