import { SelectQueryBuilder } from 'typeorm';

/**
 * Shared data-quality filters for every user-facing list / stat over
 * `selected_posts`:
 *
 *  - relevance: the LLM scored the post ≥ 3, or it is not scored yet (NULL)
 *    AND its text mentions one of the profile's keywords. Unscored posts that
 *    don't mention the profile at all (ads, proxy channels, off-topic) are dropped.
 *  - blocklist: accounts admins listed in global_context `blocked_accounts`,
 *    plus any handle / display name that looks like a proxy / VPN ad channel.
 */

/** global_context key holding the admin-editable account blocklist. */
export const BLOCKED_ACCOUNTS_KEY = 'blocked_accounts';

/** Handles / display names matching this (case-insensitive) are always excluded. */
export const PROXY_NAME_PATTERN = '(proxy|vpn|v2ray|فیلتر ?شکن|پروکسی|پراکسی)';

/** Appends a value to the query's parameters and returns its placeholder. */
export type Bind = (value: unknown) => string;

/** Binder for raw `repo.query(sql, params)` calls ($1, $2, …). */
export function rawBinder(params: unknown[]): Bind {
  return (value) => {
    params.push(value);
    return `$${params.length}`;
  };
}

/** Binder for TypeORM query builders (named parameters). */
export function qbBinder(qb: SelectQueryBuilder<any>, prefix = 'pq'): Bind {
  let i = 0;
  return (value) => {
    const name = `${prefix}${i++}`;
    qb.setParameter(name, value);
    return `:${name}`;
  };
}

/**
 * Relevance condition. `alias` qualifies the selected_posts columns
 * ('selected_posts' for raw queries, the builder alias otherwise).
 * LIKE wildcards inside keywords are escaped so they match literally.
 */
export function relevanceSql(alias = 'selected_posts'): string {
  return `(${alias}.relevance_score >= 3 OR (${alias}.relevance_score IS NULL AND EXISTS (
      SELECT 1 FROM profiles rel_p
      WHERE rel_p.id = ${alias}.profile_id
        AND ${alias}.text ILIKE ANY (
          SELECT '%' || replace(replace(replace(btrim(k), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
          FROM unnest(rel_p.keywords) AS k
          WHERE btrim(k) <> ''
        )
    )))`;
}

/** Blocklist condition: not an admin-blocked handle, not a proxy/VPN-looking account. */
export function blockedSql(alias: string, blocked: string[], bind: Bind): string {
  const pattern = bind(PROXY_NAME_PATTERN);
  const handles = blocked.length > 0 ? ` AND LOWER(${alias}.screen_name) <> ALL(${bind(blocked)})` : '';
  return `(${alias}.screen_name IS NULL OR (${alias}.screen_name !~* ${pattern}${handles}))
    AND COALESCE(${alias}.display_name, '') !~* ${pattern}`;
}

/** Normalise a handle for comparison: trim, drop a leading @ and any t.me/x.com URL prefix, lowercase. */
export function normaliseHandle(h: string): string {
  return h
    .trim()
    .replace(/^https?:\/\/(www\.)?[^/]+\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Parse the stored blocklist. Canonical format is a JSON array of handles
 * (`["proxy_channel", "@vpn_free"]`); newline / comma separated text is accepted
 * too so the raw global-context editor can't break it.
 */
export function parseBlockedAccounts(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  let items: unknown[];
  try {
    const parsed = JSON.parse(value);
    items = Array.isArray(parsed) ? parsed : [];
  } catch {
    items = value.split(/[\n,،]+/);
  }
  const out = new Set<string>();
  for (const it of items) {
    if (typeof it !== 'string') continue;
    const h = normaliseHandle(it);
    if (h) out.add(h);
  }
  return [...out];
}
