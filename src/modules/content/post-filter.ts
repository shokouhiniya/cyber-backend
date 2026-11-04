import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Bind } from './post-quality';

/**
 * Dashboard-wide post filter: a set of platforms and a date range.
 *
 * Every stats / content endpoint the dashboard and the reports use accepts the
 * same query parameters:
 *
 *   platforms | sources   comma list, e.g. `bale,eitaa,x` (x → twitter,
 *                         youtube → aparat, the stored source types)
 *   from, to              ISO timestamps, at most MAX_RANGE_DAYS apart
 *   since                 ISO timestamp (older callers; `from` wins)
 *   days | hours          a window ending now (clamped to MAX_RANGE_DAYS)
 *
 * Precedence for the start: from > since > days > hours.
 */

/** Longest custom range: the post retention period. */
export const MAX_RANGE_DAYS = 90;

/** Source types stored in selected_posts / hourly_aggregates. */
export const KNOWN_PLATFORMS = [
  'telegram', 'instagram', 'twitter', 'bale', 'rubika', 'eitaa',
  'aparat', 'news', 'newspaper', 'media', 'forum',
] as const;

/** UI / URL names → stored source type. */
const PLATFORM_ALIASES: Record<string, string> = {
  x: 'twitter',
  eita: 'eitaa',
  // YouTube videos are collected under the 'aparat' source
  youtube: 'aparat',
};

export interface PostFilter {
  /** Inclusive start */
  from?: Date;
  /** Exclusive end */
  to?: Date;
  /** Stored source types; undefined = every platform */
  platforms?: string[];
}

const DAY_MS = 86_400_000;

function parseDate(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(String(value));
  if (isNaN(d.getTime())) throw new BadRequestException(`پارامتر ${name} تاریخ معتبری نیست`);
  return d;
}

/** `bale,eitaa,x` (or an array of those) → sorted, de-duplicated stored source types. */
export function normalisePlatforms(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const out = new Set<string>();
  for (const p of parts) {
    const key = PLATFORM_ALIASES[p] ?? p;
    if (!(KNOWN_PLATFORMS as readonly string[]).includes(key)) {
      throw new BadRequestException(`سکوی ناشناخته: ${p}`);
    }
    out.add(key);
  }
  return [...out].sort();
}

/** Query object → PostFilter. Throws 400 on malformed dates, unknown platforms or a too-long range. */
export function parsePostFilter(q: Record<string, unknown> = {}, now = new Date()): PostFilter {
  const filter: PostFilter = {};
  const platforms = normalisePlatforms(q.platforms ?? q.sources);
  if (platforms) filter.platforms = platforms;

  const from = parseDate(q.from, 'from');
  const to = parseDate(q.to, 'to');
  if (from && to) {
    if (from.getTime() >= to.getTime()) throw new BadRequestException('ابتدای بازه باید پیش از انتهای آن باشد');
    if (to.getTime() - from.getTime() > (MAX_RANGE_DAYS + 1) * DAY_MS) {
      throw new BadRequestException(`بازه زمانی حداکثر ${MAX_RANGE_DAYS} روز است`);
    }
  }
  if (to) filter.to = to;

  if (from) {
    filter.from = from;
  } else if (q.since) {
    filter.from = parseDate(q.since, 'since');
  } else {
    const end = to ?? now;
    const days = Number(q.days);
    const hours = Number(q.hours);
    if (Number.isFinite(days) && days > 0) {
      filter.from = new Date(end.getTime() - Math.min(days, MAX_RANGE_DAYS) * DAY_MS);
    } else if (Number.isFinite(hours) && hours > 0) {
      filter.from = new Date(end.getTime() - Math.min(hours, MAX_RANGE_DAYS * 24) * 3_600_000);
    }
  }
  return filter;
}

/** True when the filter narrows anything (platforms or an explicit range). */
export function hasPostFilter(f?: PostFilter | null): boolean {
  return !!f && (!!f.platforms?.length || !!f.from || !!f.to);
}

/**
 * `AND …` fragment for the filter over selected_posts (or any table with
 * `published_at` / `source_type`; pass `dateColumn = 'hour'` for
 * hourly_aggregates). `alias` qualifies the columns.
 */
export function postFilterSql(
  f: PostFilter | undefined,
  bind: Bind,
  alias?: string,
  dateColumn = 'published_at',
): string {
  if (!f) return '';
  const col = (c: string) => (alias ? `${alias}.${c}` : c);
  let sql = '';
  if (f.from) sql += ` AND ${col(dateColumn)} >= ${bind(f.from)}`;
  if (f.to) sql += ` AND ${col(dateColumn)} < ${bind(f.to)}`;
  if (f.platforms?.length) sql += ` AND LOWER(${col('source_type')}) = ANY(${bind(f.platforms)}::text[])`;
  return sql;
}

/**
 * Stable cache-key suffix for results computed under a filter ('' when there
 * is none), e.g. `p=bale,eitaa;r=2026-10-01T00:00..2026-10-31T00:00`.
 * Times are cut to the minute so the same picker selection reuses the entry.
 */
export function postFilterKey(f?: PostFilter | null): string {
  if (!hasPostFilter(f)) return '';
  const t = (d?: Date) => (d ? d.toISOString().slice(0, 16) : '');
  const parts: string[] = [];
  if (f!.platforms?.length) parts.push(`p=${f!.platforms.join(',')}`);
  if (f!.from || f!.to) parts.push(`r=${t(f!.from)}..${t(f!.to)}`);
  return parts.join(';');
}

/** `@PostFilterQuery() filter: PostFilter` — parsed from the request's query string. */
export const PostFilterQuery = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PostFilter => {
    const req = ctx.switchToHttp().getRequest();
    return parsePostFilter(req.query ?? {});
  },
);
