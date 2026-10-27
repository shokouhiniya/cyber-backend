import { ProfileTier } from './profile.entity';

/**
 * Suggested ingest tier from the 8tag mention volume stored in platform_totals.
 *   heavy  : > 10,000 mentions/day
 *   medium : 500 – 10,000
 *   light  : < 500
 * The admin still picks the tier; this is only shown next to the select.
 */
export const TIER_HEAVY_ABOVE = 10_000;
export const TIER_LIGHT_BELOW = 500;

/** Days covered by each platform_totals timeframe, in order of preference. */
const BASIS_DAYS: Array<{ timeframe: 'week' | 'month'; days: number }> = [
  { timeframe: 'week', days: 7 },
  { timeframe: 'month', days: 30 },
];

export interface TotalsRow {
  timeframe: string;
  total: number | string;
  fetchedAt?: Date | string | null;
}

export interface TierSuggestion {
  suggested: ProfileTier | null;
  avgDailyMentions: number | null;
  basis: 'week' | 'month' | null;
  fetchedAt: string | null;
}

export function suggestTier(avgDaily: number | null | undefined): ProfileTier | null {
  if (avgDaily === null || avgDaily === undefined || !Number.isFinite(avgDaily) || avgDaily < 0) return null;
  if (avgDaily > TIER_HEAVY_ABOVE) return 'heavy';
  if (avgDaily >= TIER_LIGHT_BELOW) return 'medium';
  return 'light';
}

/**
 * `rows` are per-timeframe sums over all sources for one profile. The week
 * total is preferred (closest to the current pace); month is the fallback.
 */
export function tierSuggestionFromTotals(rows: TotalsRow[]): TierSuggestion {
  for (const { timeframe, days } of BASIS_DAYS) {
    const row = rows.find((r) => r.timeframe === timeframe);
    const total = Number(row?.total);
    if (!row || !Number.isFinite(total) || total <= 0) continue;
    const avg = Math.round(total / days);
    return {
      suggested: suggestTier(avg),
      avgDailyMentions: avg,
      basis: timeframe,
      fetchedAt: row.fetchedAt ? new Date(row.fetchedAt).toISOString() : null,
    };
  }
  return { suggested: null, avgDailyMentions: null, basis: null, fetchedAt: null };
}

type Query = (sql: string, params: unknown[]) => Promise<any[]>;

/** Suggestions for many profiles in one query (profiles without totals get an empty suggestion). */
export async function loadTierSuggestions(query: Query, profileIds: string[]): Promise<Record<string, TierSuggestion>> {
  const out: Record<string, TierSuggestion> = {};
  if (profileIds.length === 0) return out;
  const rows = await query(
    `SELECT profile_id, timeframe, SUM(total) AS total, MAX(fetched_at) AS "fetchedAt"
     FROM platform_totals
     WHERE profile_id = ANY($1) AND timeframe IN ('week', 'month')
     GROUP BY profile_id, timeframe`,
    [profileIds],
  );
  for (const id of profileIds) {
    out[id] = tierSuggestionFromTotals(rows.filter((r: any) => r.profile_id === id));
  }
  return out;
}
