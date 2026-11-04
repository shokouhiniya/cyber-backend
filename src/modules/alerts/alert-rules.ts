import { AlertSettings } from './alert-settings';

export const SOURCE_LABELS: Record<string, string> = {
  twitter: 'ایکس',
  telegram: 'تلگرام',
  instagram: 'اینستاگرام',
  news: 'خبرگزاری‌ها',
  newspaper: 'روزنامه‌ها',
  media: 'رسانه‌ها',
  bale: 'بله',
  rubika: 'روبیکا',
  eitaa: 'ایتا',
  aparat: 'آپارات',
  forum: 'انجمن‌ها',
};

export const sourceLabel = (s: string) => SOURCE_LABELS[s] ?? s;

export interface RunSnapshot {
  status: 'running' | 'completed' | 'failed';
  errorMessage?: string | null;
  postsSelected?: number | null;
  stats?: {
    fetchedPerSource?: Record<string, number>;
    quotaPerSource?: Record<string, number>;
  } | null;
}

export interface IngestVerdict {
  event: 'ingest_failed' | 'ingest_partial';
  reason: string;
  emptySources?: string[];
  sourcesWithData?: string[];
}

/**
 * (a) Decides whether a finished ingest run deserves an alert.
 *
 * - failed → ingest_failed with the error.
 * - completed but nothing fetched at all → ingest_partial.
 * - completed while most queried sources came back empty → ingest_partial.
 *   A source is "queried" when its quota was > 0, and "empty" when it
 *   returned no posts or is missing from fetchedPerSource (the selector
 *   leaves failed fetches out). This is the 13 Aban pattern: the run
 *   "completed" with data only from bale/rubika and no error recorded.
 */
export function evaluateIngestRun(run: RunSnapshot, settings: Pick<AlertSettings, 'emptySourceShare' | 'minActiveSources'>): IngestVerdict | null {
  if (run.status === 'failed') {
    return { event: 'ingest_failed', reason: (run.errorMessage || 'خطای نامشخص').slice(0, 300) };
  }
  if (run.status !== 'completed') return null;

  const quotas = run.stats?.quotaPerSource ?? {};
  const fetched = run.stats?.fetchedPerSource ?? {};
  const active = Object.keys(quotas).filter((s) => Number(quotas[s]) > 0);
  const empty = active.filter((s) => !(Number(fetched[s]) > 0));
  const withData = active.filter((s) => Number(fetched[s]) > 0);
  const totalFetched = Object.values(fetched).reduce((a, b) => a + (Number(b) || 0), 0);

  if (active.length === 0 ? Number(run.postsSelected) === 0 : totalFetched === 0) {
    return {
      event: 'ingest_partial',
      reason: 'جمع‌آوری کامل شد اما از هیچ منبعی پستی دریافت نشد',
      emptySources: empty,
      sourcesWithData: [],
    };
  }

  if (active.length >= settings.minActiveSources && empty.length / active.length >= settings.emptySourceShare) {
    const fa = (n: number) => n.toLocaleString('fa-IR');
    return {
      event: 'ingest_partial',
      reason:
        `${fa(empty.length)} از ${fa(active.length)} منبع خالی برگشت؛ ` +
        `داده فقط از ${withData.map(sourceLabel).join('، ') || '—'} آمد ` +
        `(خالی: ${empty.map(sourceLabel).join('، ')})`,
      emptySources: empty,
      sourcesWithData: withData,
    };
  }
  return null;
}

const LEVEL_RANK = { safe: 0, warning: 1, critical: 2 } as const;
export type Level = keyof typeof LEVEL_RANK;

/** (c) True when a profile moves from below the threshold to at/above it. */
export function entersCrisis(previous: Level | undefined, current: Level, threshold: 'warning' | 'critical'): boolean {
  const min = LEVEL_RANK[threshold];
  if (LEVEL_RANK[current] === undefined || LEVEL_RANK[current] < min) return false;
  return previous === undefined || LEVEL_RANK[previous] < min || LEVEL_RANK[current] > LEVEL_RANK[previous];
}

/** (b) Hours since the last successful collection, or null when it is still fresh. */
export function staleHours(lastSuccessAt: Date | string | null, thresholdHours: number, now = new Date()): number | null {
  if (!lastSuccessAt) return null;
  const age = (now.getTime() - new Date(lastSuccessAt).getTime()) / 3_600_000;
  return age > thresholdHours ? Math.floor(age) : null;
}
