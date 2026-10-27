/**
 * Account-level bot analysis.
 *
 * Batch sentiment stores the LLM's per-post `bot_probability` (0–100) on
 * selected_posts. Posts are grouped by account (screen_name + source_type);
 * each account's average probability decides its class:
 *   bot        ≥ 60  «احتمالاً ربات»
 *   suspicious 30–59 «مشکوک»
 *   human      < 30  «انسانی»
 *   unscored   no scored post in the period «تحلیل‌نشده»
 */

export const BOT_MIN = 60;
export const SUSPICIOUS_MIN = 30;
export const TOP_SUSPICIOUS_LIMIT = 8;

export type BotClass = 'bot' | 'suspicious' | 'human' | 'unscored';

export const BOT_CLASS_LABELS: Record<BotClass, string> = {
  bot: 'احتمالاً ربات',
  suspicious: 'مشکوک',
  human: 'انسانی',
  unscored: 'تحلیل‌نشده',
};

const CLASS_ORDER: BotClass[] = ['bot', 'suspicious', 'human', 'unscored'];

/** One row per account from the grouping query. */
export interface AccountRow {
  handle: string;
  displayName?: string | null;
  platform: string;
  posts: number;
  scoredPosts: number;
  /** Mean bot_probability over scored posts; null when none are scored. */
  avgProbability: number | null;
}

export function classifyAccount(avg: number | null | undefined, scoredPosts = 1): BotClass {
  if (avg === null || avg === undefined || !Number.isFinite(Number(avg)) || scoredPosts <= 0) return 'unscored';
  const v = Number(avg);
  if (v >= BOT_MIN) return 'bot';
  if (v >= SUSPICIOUS_MIN) return 'suspicious';
  return 'human';
}

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

export function summariseBotAnalysis(rows: AccountRow[], topLimit = TOP_SUSPICIOUS_LIMIT) {
  const counts = Object.fromEntries(CLASS_ORDER.map((k) => [k, { accounts: 0, posts: 0 }])) as Record<
    BotClass,
    { accounts: number; posts: number }
  >;
  let totalPosts = 0;
  const flagged: Array<AccountRow & { avgProbability: number; class: BotClass }> = [];

  for (const r of rows) {
    const posts = Number(r.posts) || 0;
    const scored = Number(r.scoredPosts) || 0;
    const avg = r.avgProbability === null || r.avgProbability === undefined ? null : Number(r.avgProbability);
    const cls = classifyAccount(avg, scored);
    counts[cls].accounts += 1;
    counts[cls].posts += posts;
    totalPosts += posts;
    if ((cls === 'bot' || cls === 'suspicious') && avg !== null) {
      flagged.push({ ...r, posts, scoredPosts: scored, avgProbability: avg, class: cls });
    }
  }

  const totalAccounts = rows.length;
  const topSuspicious = flagged
    .sort((a, b) => b.avgProbability - a.avgProbability || b.posts - a.posts || a.handle.localeCompare(b.handle))
    .slice(0, topLimit)
    .map((a) => ({
      handle: a.handle,
      displayName: a.displayName ?? null,
      platform: a.platform,
      avgProbability: Math.round(a.avgProbability),
      postCount: a.posts,
      scoredPosts: a.scoredPosts,
      class: a.class,
    }));

  return {
    criterion: { botMin: BOT_MIN, suspiciousMin: SUSPICIOUS_MIN },
    totalAccounts,
    totalPosts,
    classes: CLASS_ORDER.map((key) => ({
      key,
      label: BOT_CLASS_LABELS[key],
      accounts: counts[key].accounts,
      posts: counts[key].posts,
      accountPercent: pct(counts[key].accounts, totalAccounts),
      postPercent: pct(counts[key].posts, totalPosts),
    })),
    topSuspicious,
  };
}

export type BotAnalysis = ReturnType<typeof summariseBotAnalysis>;
