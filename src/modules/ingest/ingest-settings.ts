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
  /** Whether cron-triggered collection runs are enabled. Manual runs always bypass this. */
  automaticCollectionEnabled: boolean;
  heavy: TierSettings;
  medium: TierSettings;
  light: TierSettings;
  /** Cooldown between manual runs (minutes) */
  manualCooldownMinutes: number;
  /** Data retention for selected_posts (days) */
  retentionDays: number;
}

export const DEFAULT_INGEST_SETTINGS: IngestSettings = {
  automaticCollectionEnabled: true,
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

/** All scheduled ingest jobs run on Tehran wall-clock time. */
export const INGEST_TIMEZONE = 'Asia/Tehran';

export const INGEST_TIERS = ['heavy', 'medium', 'light'] as const;
export type IngestTier = (typeof INGEST_TIERS)[number];

/**
 * Merges stored settings over the defaults. Tier objects are merged field by
 * field so a stored tier without `cron` (older saves) keeps the default cron.
 */
export function mergeIngestSettings(stored: Partial<Record<keyof IngestSettings, any>> | null | undefined): IngestSettings {
  const s = stored && typeof stored === 'object' ? stored : {};
  const merged: IngestSettings = { ...DEFAULT_INGEST_SETTINGS, ...s } as IngestSettings;
  for (const tier of INGEST_TIERS) {
    merged[tier] = { ...DEFAULT_INGEST_SETTINGS[tier], ...(s[tier] || {}) };
  }
  const retention = Number(merged.retentionDays);
  merged.retentionDays = Number.isFinite(retention) && retention >= 1 ? Math.round(retention) : DEFAULT_INGEST_SETTINGS.retentionDays;
  const cooldown = Number(merged.manualCooldownMinutes);
  merged.manualCooldownMinutes = Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : DEFAULT_INGEST_SETTINGS.manualCooldownMinutes;
  return merged;
}

// ── Persian cron description ─────────────────────────────────────────────────

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const faNum = (n: number | string) => String(n).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
const faTime = (h: number, m: number) => faNum(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
const faList = (items: string[]) => items.join('، ');
const WEEKDAYS_FA = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];

const isInt = (v: string) => /^\d+$/.test(v);
const intList = (v: string) => (/^\d+(,\d+)*$/.test(v) ? v.split(',').map(Number) : null);
const step = (v: string) => (/^\*\/\d+$/.test(v) ? Number(v.slice(2)) : null);

/**
 * Human-readable Persian description of the common cron shapes used for ingest
 * (5-field or 6-field with seconds). Unknown shapes fall back to the raw expression.
 * Times are Tehran local time (INGEST_TIMEZONE).
 */
export function describeCron(expr: string): string {
  const parts = (expr || '').trim().split(/\s+/);
  if (parts.length === 6) parts.shift(); // drop seconds
  if (parts.length !== 5) return `زمان‌بندی سفارشی (${expr})`;
  const [min, hour, dom, mon, dow] = parts;
  const custom = `زمان‌بندی سفارشی (${expr})`;
  if (mon !== '*') return custom;

  const minStep = step(min);
  if (minStep && hour === '*' && dom === '*' && dow === '*') return `هر ${faNum(minStep)} دقیقه`;
  if (!isInt(min)) return custom;
  const m = Number(min);

  const hourStep = step(hour);
  if (hourStep && dom === '*' && dow === '*') {
    return hourStep === 1 ? 'هر ساعت' : `هر ${faNum(hourStep)} ساعت`;
  }
  if (hour === '*' && dom === '*' && dow === '*') return 'هر ساعت';

  const hours = intList(hour);
  if (!hours) return custom;
  const at = faList(hours.map((h) => faTime(h, m)));

  if (dom === '*' && dow === '*') {
    if (hours.length === 1) return `هر روز ساعت ${at}`;
    const gaps = hours.slice(1).map((h, i) => h - hours[i]);
    const even = gaps.every((g) => g === gaps[0]) && gaps[0] * hours.length === 24;
    return even
      ? `هر ${faNum(gaps[0])} ساعت (ساعت ${at})`
      : `روزانه ${faNum(hours.length)} بار (ساعت ${at})`;
  }

  const domStep = step(dom);
  if (domStep && dow === '*') return `هر ${faNum(domStep)} روز یک بار، ساعت ${at}`;

  const days = intList(dow);
  if (dom === '*' && days && days.every((d) => d >= 0 && d <= 7)) {
    return `هفتگی، ${faList(days.map((d) => WEEKDAYS_FA[d % 7]))} ساعت ${at}`;
  }
  return custom;
}
