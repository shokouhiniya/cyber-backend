/**
 * Crisis radar formula (GET /api/stats/crisis).
 *
 * Every axis compares the LAST 7 DAYS against the PREVIOUS 4 WEEKS (days 8–35
 * back) using the same per-day or per-post metric on both sides, and maps the
 * ratio to 0–100 where 50 = normal:
 *
 *   score = clamp(50 + 50 · log2(ratio), 0, 100)
 *
 *   ratio ×2   → 100     ratio ×1.5 → ~79     ratio ×1.25 → ~66
 *   ratio ×1   →  50     ratio ×0.75 → ~29    ratio ×0.5  →   0
 *
 * Axes:
 *   negativeSentiment — share of negative posts (final LLM sentiment).
 *       The recent share is shrunk toward the baseline with a prior of
 *       NEG_PRIOR_POSTS posts, so a handful of recent posts can't swing it:
 *       p7 = (neg7 + K·p28) / (n7 + K); ratio = (p7 + ε) / (p28 + ε).
 *   spreadVelocity    — 8tag total mentions per day (platform_totals):
 *       recent = week / 7, baseline = (month − week) / 23 (the 23 days before
 *       the last week — the closest window 8tag totals allow to 4 weeks).
 *   officialReach     — typical views per official-page post.
 *   influence         — typical views per post.
 *   interactions      — typical (likes + replies + forwards) per post.
 *       "Typical" = geometric mean of (x + 1), i.e. exp(avg(ln(x + 1))). View
 *       counts are heavy-tailed (log-normal, and very different per source), so
 *       a plain median jumps with the source mix of a small sample; the
 *       geometric mean is the robust centre of a log-normal and the +1 keeps
 *       zeros safe. These three axes only use posts OLDER THAN 48 HOURS on both
 *       sides, because fresh posts haven't accumulated views yet.
 *
 * An axis has data only when both windows have at least MIN_RECENT /
 * MIN_BASELINE posts (or non-zero totals). The overall score is the weighted
 * mean of axes with data; level: ≥70 critical, ≥55 warning, else safe.
 */

export const CRISIS_RECENT_DAYS = 7;
export const CRISIS_BASELINE_DAYS = 28;
/** Posts younger than this are excluded from the view/interaction medians. */
export const CRISIS_MIN_POST_AGE_HOURS = 48;
export const MIN_RECENT = 5;
export const MIN_BASELINE = 10;
export const NEG_PRIOR_POSTS = 20;

export const CRISIS_WEIGHTS = {
  negativeSentiment: 0.40,
  spreadVelocity: 0.20,
  officialReach: 0.10,
  influence: 0.15,
  interactions: 0.15,
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 50 + 50·log2(ratio), clamped to 0–100. Non-finite or non-positive ratios map to 0/100 edges. */
export function ratioToScore(ratio: number): number {
  if (!Number.isFinite(ratio)) return ratio > 0 ? 100 : 50;
  if (ratio <= 0) return 0;
  return Math.round(clamp(50 + 50 * Math.log2(ratio), 0, 100));
}

/** Negative-share axis with shrinkage toward the baseline share. */
export function negativeShareScore(
  recent: { neg: number; total: number },
  baseline: { neg: number; total: number },
): number | null {
  if (recent.total < MIN_RECENT || baseline.total < MIN_BASELINE) return null;
  const p28 = baseline.neg / baseline.total;
  const p7 = (recent.neg + NEG_PRIOR_POSTS * p28) / (recent.total + NEG_PRIOR_POSTS);
  const eps = 0.02;
  return ratioToScore((p7 + eps) / (p28 + eps));
}

/** Per-post axis (views, interactions): ratio of the geometric means of (x + 1). */
export function perPostScore(
  recent: { geoMean: number; n: number },
  baseline: { geoMean: number; n: number },
): number | null {
  if (recent.n < MIN_RECENT || baseline.n < MIN_BASELINE) return null;
  if (!(recent.geoMean > 0) || !(baseline.geoMean > 0)) return null;
  return ratioToScore(recent.geoMean / baseline.geoMean);
}

/** exp(mean(ln(x + 1))) — JS twin of the SQL aggregate used by the crisis endpoint. */
export function geoMeanPlusOne(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.exp(values.reduce((s, v) => s + Math.log(Math.max(0, v) + 1), 0) / values.length);
}

/** Per-day volume axis from 8tag totals: week (last 7d) vs month−week (previous 23d). */
export function spreadScore(weekTotal: number, monthTotal: number): number | null {
  const baselineDays = 30 - CRISIS_RECENT_DAYS;
  const baselineTotal = monthTotal - weekTotal;
  if (weekTotal <= 0 || baselineTotal <= 0) return null;
  return ratioToScore((weekTotal / CRISIS_RECENT_DAYS) / (baselineTotal / baselineDays));
}

export interface CrisisDimension {
  key: keyof typeof CRISIS_WEIGHTS;
  label: string;
  value: number | null;
}

/** Weighted mean over axes with data (50 when none) and the level for it. */
export function combineCrisis(dims: CrisisDimension[]): { score: number; level: 'safe' | 'warning' | 'critical' } {
  const active = dims.filter((d) => d.value !== null);
  const totalWeight = active.reduce((s, d) => s + CRISIS_WEIGHTS[d.key], 0);
  const score = totalWeight > 0
    ? Math.round(active.reduce((s, d) => s + (d.value as number) * CRISIS_WEIGHTS[d.key], 0) / totalWeight)
    : 50;
  const level = score >= 70 ? 'critical' : score >= 55 ? 'warning' : 'safe';
  return { score, level };
}
