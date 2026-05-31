/**
 * Default ingest settings — used when no custom settings are stored in global_context.
 * These can be overridden via PUT /api/admin/global-context/ingest-settings.
 */
export interface TierSettings {
  /** Number of posts to select per run */
  sampleSize: number;
  /** 8tag time range: 'day' | 'week' | 'month' */
  range: string;
  /** Cron expression for scheduled runs */
  cron: string;
  /** Human-readable description */
  description: string;
}

export interface IngestSettings {
  heavy: TierSettings;
  medium: TierSettings;
  light: TierSettings;
  /** Cooldown between manual runs (minutes) */
  manualCooldownMinutes: number;
  /** Data retention for selected_posts (days) */
  retentionDays: number;
}

export const DEFAULT_INGEST_SETTINGS: IngestSettings = {
  heavy: {
    sampleSize: 100,
    range: 'day',
    cron: '0 0,6,12,18 * * *',
    description: 'هر ۶ ساعت (۴ بار در روز)',
  },
  medium: {
    sampleSize: 80,
    range: 'week',
    cron: '0 3 * * *',
    description: 'یک بار در روز (ساعت ۳ بامداد)',
  },
  light: {
    sampleSize: 60,
    range: 'week',
    cron: '0 4 */3 * *',
    description: 'هر ۳ روز یک بار (ساعت ۴ بامداد)',
  },
  manualCooldownMinutes: 15,
  retentionDays: 90,
};
