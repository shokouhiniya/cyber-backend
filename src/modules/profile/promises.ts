import { Bind } from '../content/post-quality';
import { zonedDate } from '../content/weekly-buckets';

/**
 * A public promise stored on `profiles.promises` (jsonb).
 * `position`, `validFrom` and `validUntil` are optional: older promises have
 * none of them and keep counting every collected post.
 * Dates are Gregorian calendar days (YYYY-MM-DD) read as Tehran days; the
 * admin form shows and accepts them as Jalali.
 */
export interface ProfilePromise {
  text: string;
  status: 'pending' | 'fulfilled' | 'broken';
  addedAt: string;
  /** Role the promise was made in, e.g. «رئیس مجلس» */
  position?: string;
  validFrom?: string;
  validUntil?: string;
}

const STATUSES = ['pending', 'fulfilled', 'broken'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Accept YYYY-MM-DD or an ISO timestamp; anything else is dropped (undefined). */
export function normalisePromiseDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (!YMD.test(trimmed.slice(0, 10)) || !/^.{10}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) return undefined;
  const v = trimmed.slice(0, 10);
  const d = new Date(`${v}T00:00:00Z`);
  // Reject overflowed dates such as 2026-02-31
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : undefined;
}

/**
 * Cleans promises coming from the admin form / CSV import: trims text,
 * keeps known statuses, normalises dates and swaps a reversed window.
 * Unknown keys are dropped so the jsonb stays predictable.
 */
export function sanitisePromises(input: unknown): ProfilePromise[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((p) => p && typeof p === 'object' && typeof (p as any).text === 'string')
    .map((raw: any) => {
      const out: ProfilePromise = {
        text: raw.text.trim(),
        status: STATUSES.includes(raw.status) ? raw.status : 'pending',
        addedAt: typeof raw.addedAt === 'string' && raw.addedAt ? raw.addedAt : new Date().toISOString(),
      };
      const position = typeof raw.position === 'string' ? raw.position.trim() : '';
      if (position) out.position = position;
      let from = normalisePromiseDate(raw.validFrom);
      let until = normalisePromiseDate(raw.validUntil);
      if (from && until && from > until) [from, until] = [until, from];
      if (from) out.validFrom = from;
      if (until) out.validUntil = until;
      return out;
    });
}

/** True once the promise's validity window has ended (its last day is before today in Tehran). */
export function isPromiseExpired(p: Pick<ProfilePromise, 'validUntil'>, now = new Date()): boolean {
  const until = normalisePromiseDate(p.validUntil);
  return !!until && until < zonedDate(now);
}

/**
 * SQL condition limiting `published_at` to the promise's validity window
 * (Tehran days, `validUntil` inclusive). Combined with the caller's `since`
 * condition this gives the intersection. Returns '' when the promise has no
 * window (all posts count, as before).
 */
export function promiseWindowSql(p: Pick<ProfilePromise, 'validFrom' | 'validUntil'>, bind: Bind, column = 'published_at'): string {
  const parts: string[] = [];
  const from = normalisePromiseDate(p.validFrom);
  const until = normalisePromiseDate(p.validUntil);
  if (from) parts.push(`${column} >= (${bind(from)}::date)::timestamp AT TIME ZONE 'Asia/Tehran'`);
  if (until) parts.push(`${column} < ((${bind(until)}::date + 1)::timestamp AT TIME ZONE 'Asia/Tehran')`);
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}
