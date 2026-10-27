/**
 * Weekly buckets for the official-pages activity chart.
 *
 * Weeks run Saturday → Friday on Tehran wall-clock dates. The SQL side groups
 * posts by Tehran calendar day; this module turns those day rows into a
 * continuous run of weeks (oldest first), with zero rows for empty weeks.
 */

export const WEEKLY_TIMEZONE = 'Asia/Tehran';
export const DEFAULT_WEEKS = 12;
export const MAX_WEEKS = 52;

const DAY_MS = 86_400_000;

export interface DayRow {
  /** Tehran calendar day, YYYY-MM-DD */
  day: string;
  posts: number;
  views: number;
  likes: number;
  shares: number;
}

export interface WeekBucket {
  /** Saturday, YYYY-MM-DD (Tehran) */
  weekStart: string;
  /** Friday, YYYY-MM-DD (Tehran) */
  weekEnd: string;
  posts: number;
  views: number;
  likes: number;
  shares: number;
}

/** Clamp a caller-supplied week count; junk falls back to the default. */
export function clampWeeks(weeks: unknown): number {
  const n = Number(weeks);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_WEEKS) : DEFAULT_WEEKS;
}

/** Calendar date (YYYY-MM-DD) of `at` in the given time zone. */
export function zonedDate(at: Date, timeZone = WEEKLY_TIMEZONE): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

const toUtcMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const fromUtcMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The Saturday on or before the given calendar date. */
export function weekStartOf(ymd: string): string {
  const ms = toUtcMs(ymd);
  const dow = new Date(ms).getUTCDay(); // 0 = Sunday … 6 = Saturday
  return fromUtcMs(ms - ((dow + 1) % 7) * DAY_MS);
}

/**
 * Week windows ending with the current (possibly partial) week, oldest first.
 * `firstDay` is the Saturday the SQL query should start from.
 */
export function weekWindows(weeks: number, now = new Date()): { firstDay: string; starts: string[] } {
  const current = toUtcMs(weekStartOf(zonedDate(now)));
  const starts = Array.from({ length: weeks }, (_, i) => fromUtcMs(current - (weeks - 1 - i) * 7 * DAY_MS));
  return { firstDay: starts[0], starts };
}

/** Fold Tehran-day rows into Saturday-start weeks; weeks without posts stay zero. */
export function bucketWeekly(rows: DayRow[], weeks: number, now = new Date()): WeekBucket[] {
  const { starts } = weekWindows(weeks, now);
  const buckets = new Map<string, WeekBucket>(
    starts.map((s) => [s, { weekStart: s, weekEnd: fromUtcMs(toUtcMs(s) + 6 * DAY_MS), posts: 0, views: 0, likes: 0, shares: 0 }]),
  );
  for (const r of rows) {
    const b = buckets.get(weekStartOf(r.day));
    if (!b) continue;
    b.posts += Number(r.posts) || 0;
    b.views += Number(r.views) || 0;
    b.likes += Number(r.likes) || 0;
    b.shares += Number(r.shares) || 0;
  }
  return [...buckets.values()];
}
