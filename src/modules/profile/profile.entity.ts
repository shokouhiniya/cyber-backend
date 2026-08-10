import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Ingest tier — controls fetch cadence and LLM sample size.
 *   heavy  : >10k posts/day  → fetch 4×/day, 100 posts/run
 *   medium : 500–10k/day     → fetch daily,  80 posts/run
 *   light  : <500/day        → fetch every 3 days, 60 posts/run
 */
export type ProfileTier = 'heavy' | 'medium' | 'light';

/**
 * Per-source weight multiplier for the sample selector.
 * Keys are source identifiers (telegram, twitter, instagram, …).
 * Values are floats: 1.0 = neutral, >1 boosts quota, <1 demotes.
 * Missing keys fall back to system defaults.
 */
export type SourceWeights = Partial<Record<
  'telegram' | 'twitter' | 'instagram' | 'news' | 'newspaper' |
  'media' | 'bale' | 'rubika' | 'aparat' | 'forum' | 'eitaa',
  number
>>;

@Entity('profiles')
export class Profile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  role: string;

  @Column({ nullable: true })
  organization: string;

  @Column({ nullable: true })
  avatar: string;

  @Column('text', { array: true, nullable: true })
  keywords: string[];

  @Column('text', { array: true, nullable: true, name: 'excluded_keywords' })
  excludedKeywords: string[];

  @Column({ name: 'sort_criteria', nullable: true })
  sortCriteria: string;

  @Column({ nullable: true })
  plan: string;

  @Column({ name: 'expires_at', type: 'timestamp', nullable: true })
  expiresAt: Date;

  @Column({ name: 'primary_color', nullable: true })
  primaryColor: string;

  @Column({ name: 'logo_url', type: 'text', nullable: true })
  logoUrl: string;

  @Column({ name: 'promtic_identifier', type: 'jsonb', nullable: true })
  promticIdentifier: {
    external_id: string;
    name?: string;
    type?: string;
  };

  /**
   * Official social/web channels for this profile.
   * Array of OfficialChannel objects (see type below).
   * Stored as jsonb so we can add new platforms without schema changes.
   */
  @Column({ name: 'official_channels', type: 'jsonb', nullable: true })
  officialChannels: Array<{
    platform: 'web' | 'telegram' | 'x' | 'instagram' | 'bale' | 'eitaa' | 'rubika';
    handle: string;      // username / URL / channel id
    url?: string;        // full URL if different from handle
    followers?: number;
    posts?: number;
    verified?: boolean;
    active?: boolean;
  }>;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /**
   * Ingest tier — auto-derived from daily_avg_posts but manually overridable.
   * Defaults to 'medium' for new profiles until first ingest run computes real volume.
   */
  @Column({ type: 'varchar', default: 'medium' })
  tier: ProfileTier;

  /**
   * Observed daily average post count (updated by the ingest worker after each run).
   * Used to auto-suggest tier; admin can override tier independently.
   */
  @Column({ name: 'daily_avg_posts', type: 'float', nullable: true })
  dailyAvgPosts: number | null;

  /**
   * Per-source weight multipliers for the sample selector.
   * {} means "use system defaults for all sources".
   * Example: { telegram: 1.5, eitaa: 0 } boosts Telegram and silences Eitaa.
   */
  @Column({ name: 'source_weights', type: 'jsonb', default: '{}' })
  sourceWeights: SourceWeights;

  /** Public promises made by this profile. Each item: { text, status, addedAt } */
  @Column({ type: 'jsonb', default: '[]' })
  promises: Array<{ text: string; status: 'pending' | 'fulfilled' | 'broken'; addedAt: string }>;

  /**
   * Family name used for alphabetical sorting.
   * Populated by seed-sort-names.js. Compound family names (e.g. حداد عادل) are stored in full.
   */
  @Column({ name: 'sort_name', nullable: true })
  sortName: string;

  /**
   * Per-profile context for AI prompts.
   * Keys: 'default' (base context), plus optional per-prompt overrides
   * (e.g. 'dashboard_ai_summary', 'batch_sentiment', etc.)
   * If a prompt-specific key exists, it replaces 'default' for that prompt.
   */
  @Column({ name: 'profile_contexts', type: 'jsonb', default: '{}' })
  profileContexts: Record<string, string>;

  /**
   * Widget keys that are hidden for this profile's clients.
   * Empty array = all widgets visible (default).
   */
  @Column({ name: 'hidden_widgets', type: 'text', array: true, default: '{}' })
  hiddenWidgets: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
