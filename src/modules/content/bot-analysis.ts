/**
 * Account-level bot analysis («درصد مشکوک بودن حساب‌ها»).
 *
 * Posts are grouped by account (screen_name + source_type). Each account gets
 * a 0–100 suspicion score from independent, explainable signals:
 *
 *   llm         mean of the per-post `bot_probability` the LLM gave (0–100)
 *   duplicate   share of its posts whose text also appears under OTHER accounts
 *               (simhash near-duplicates or identical normalised text)
 *   burst       share of its posts published ≤ 2 minutes after its previous one
 *   rate        posts per active day in the collected sample
 *   handle      auto-generated-looking handle (long digit tails, user123…)
 *   profile     no display name (or display name = handle) and no avatar
 *   followers   very few followers, where the platform reports them
 *
 * Each signal i has a value v_i ∈ [0,1] and a reliability r_i (its maximum
 * contribution). Signals are combined as independent evidence (noisy-OR):
 *
 *   score = 100 × (1 − Π (1 − r_i · v_i))
 *
 * so a missing signal never lowers the score, and two moderate signals count
 * more than one. Each signal's r_i · v_i is its contribution, and the largest
 * contributions are the reasons shown in the UI.
 *
 * Classes (calibrated so a single weak heuristic never makes a «ربات»):
 *   bot         score ≥ 60 AND (≥ 2 fired signals incl. a strong one,
 *               OR the LLM alone averages ≥ 75 over ≥ 4 scored posts)
 *   suspicious  score ≥ 35, or a bot score without that corroboration
 *   human       score < 35
 *   unscored    no LLM score and no fired signal — not enough evidence
 */

export const BOT_MIN = 60;
export const SUSPICIOUS_MIN = 35;
/** LLM-only bot verdict needs this average over at least LLM_ONLY_MIN_POSTS scored posts. */
export const LLM_ONLY_BOT_AVG = 75;
export const LLM_ONLY_MIN_POSTS = 4;
export const TOP_SUSPICIOUS_LIMIT = 8;

export type BotClass = 'bot' | 'suspicious' | 'human' | 'unscored';
export type Confidence = 'high' | 'medium' | 'low';
export type SignalKey = 'llm' | 'duplicate' | 'burst' | 'rate' | 'handle' | 'profile' | 'followers';

export const BOT_CLASS_LABELS: Record<BotClass, string> = {
  bot: 'احتمالاً ربات',
  suspicious: 'مشکوک',
  human: 'انسانی',
  unscored: 'تحلیل‌نشده',
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = { high: 'بالا', medium: 'متوسط', low: 'پایین' };

/** Reliability (max contribution), strength and Persian name of each signal. */
export const SIGNALS: Record<SignalKey, { reliability: number; strong: boolean; label: string }> = {
  llm: { reliability: 0.85, strong: true, label: 'امتیاز هوش مصنوعی' },
  duplicate: { reliability: 0.7, strong: true, label: 'متن تکراری با حساب‌های دیگر' },
  burst: { reliability: 0.6, strong: true, label: 'انتشار رگباری' },
  rate: { reliability: 0.5, strong: false, label: 'حجم بالای انتشار' },
  handle: { reliability: 0.3, strong: false, label: 'الگوی نام کاربری' },
  profile: { reliability: 0.25, strong: false, label: 'پروفایل ناقص' },
  followers: { reliability: 0.45, strong: false, label: 'دنبال‌کننده بسیار کم' },
};

/** A signal counts as "fired" (a reason) at this value. */
const FIRE_AT = 0.5;

const CLASS_ORDER: BotClass[] = ['bot', 'suspicious', 'human', 'unscored'];

/** Platforms where a person's handle / avatar / followers mean something. */
const PERSONAL_PLATFORMS = new Set(['twitter', 'instagram', 'telegram', 'eitaa', 'bale', 'rubika', 'forum']);
const FOLLOWER_PLATFORMS = new Set(['twitter', 'instagram', 'forum']);
const PROFILE_PLATFORMS = new Set(['twitter', 'instagram']);

/** One row per account from the grouping query. */
export interface AccountRow {
  handle: string;
  displayName?: string | null;
  platform: string;
  posts: number;
  scoredPosts: number;
  /** Mean bot_probability over scored posts; null when none are scored. */
  avgProbability: number | null;
  /** Posts whose text also appears under another account */
  dupPosts?: number;
  /** Posts ≤ 2 minutes after the account's previous post */
  burstPosts?: number;
  /** Distinct Tehran days with a post */
  activeDays?: number;
  hasAvatar?: boolean | null;
  /** Max follower count reported for the author; null = unknown */
  followers?: number | null;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** 0–1: how machine-generated a handle looks. Latin handles only. */
export function handlePatternScore(handle: string | null | undefined): number {
  const h = String(handle || '').trim().replace(/^@/, '').toLowerCase();
  if (!h || !/^[a-z0-9_.]+$/.test(h)) return 0;
  if (/^(user|usr|u|id)[_.]?\d{4,}$/.test(h)) return 1;
  if (/^[a-z]+[_.]?[a-z]*\d{7,}$/.test(h)) return 1; // name + 7+ digit tail (default X handles)
  if (/\d{5,}$/.test(h)) return 0.8;
  const digits = (h.match(/\d/g) || []).length;
  if (h.length >= 10 && digits / h.length >= 0.4) return 0.7;
  if (/[bcdfghjklmnpqrstvwxz]{6,}/.test(h.replace(/[\d_.]/g, ''))) return 0.6; // no vowels: random string
  if (/\d{3,4}$/.test(h)) return 0.3;
  return 0;
}

export interface SignalResult {
  key: SignalKey;
  value: number;
  contribution: number;
  fired: boolean;
  /** Raw measurement for the reason text */
  measure: number;
}

/** All signals that are measurable for this account. */
export function accountSignals(r: AccountRow): SignalResult[] {
  const out: SignalResult[] = [];
  const posts = Math.max(0, Number(r.posts) || 0);
  const platform = String(r.platform || '').toLowerCase();
  const push = (key: SignalKey, value: number, measure: number, fired?: boolean) => {
    const v = clamp01(value);
    out.push({ key, value: v, measure, contribution: SIGNALS[key].reliability * v, fired: fired ?? v >= FIRE_AT });
  };

  if (Number(r.scoredPosts) > 0 && r.avgProbability !== null && r.avgProbability !== undefined) {
    const avg = Number(r.avgProbability);
    push('llm', avg / 100, Math.round(avg), avg >= BOT_MIN);
  }
  const dup = Number(r.dupPosts) || 0;
  // Outlets (news, newspapers, Aparat channels) syndicate text by design
  if (posts >= 1 && r.dupPosts !== undefined && PERSONAL_PLATFORMS.has(platform)) {
    const share = dup / posts;
    // a single shared headline is common among humans; repeated copying is not
    const value = clamp01((share - 0.1) / 0.5) * Math.min(1, dup / 3);
    push('duplicate', value, Math.round(share * 100), dup >= 2 && share >= 0.3);
  }
  const burst = Number(r.burstPosts) || 0;
  if (posts >= 3 && r.burstPosts !== undefined) {
    const share = burst / (posts - 1);
    push('burst', share / 0.5, burst, burst >= 2 && share >= 0.3);
  }
  if (posts >= 3 && Number(r.activeDays) > 0) {
    const perDay = posts / Number(r.activeDays);
    push('rate', (perDay - 10) / 30, Math.round(perDay * 10) / 10);
  }
  if (PERSONAL_PLATFORMS.has(platform)) {
    const s = handlePatternScore(r.handle);
    push('handle', s, s, s >= 0.6);
  }
  if (PROFILE_PLATFORMS.has(platform) && r.hasAvatar !== undefined && r.hasAvatar !== null) {
    const name = String(r.displayName || '').trim().toLowerCase();
    const noName = !name || name === String(r.handle || '').trim().toLowerCase();
    const missing = (noName ? 0.5 : 0) + (r.hasAvatar ? 0 : 0.5);
    push('profile', missing, missing, missing >= 1);
  }
  if (FOLLOWER_PLATFORMS.has(platform) && r.followers !== null && r.followers !== undefined && Number(r.followers) > 0) {
    const f = Number(r.followers);
    push('followers', f < 10 ? 1 : f < 50 ? 0.6 : f < 200 ? 0.2 : 0, f);
  }
  return out;
}

const fa = (n: number) => String(n);

/** Persian reason text (Latin digits; the UI converts them). */
export function reasonLabel(s: SignalResult, r: AccountRow): string {
  switch (s.key) {
    case 'llm': return `میانگین امتیاز ربات‌بودن هوش مصنوعی ${fa(s.measure)}٪ (${fa(Number(r.scoredPosts) || 0)} پست)`;
    case 'duplicate': return `${fa(s.measure)}٪ پست‌ها هم‌متن با حساب‌های دیگر`;
    case 'burst': return `${fa(s.measure)} پست با فاصلهٔ کمتر از ۲ دقیقه`;
    case 'rate': return `${fa(s.measure)} پست در هر روز فعالیت`;
    case 'handle': return 'نام کاربری شبیه حساب‌های ساخته‌شدهٔ خودکار';
    case 'profile': return 'بدون نام نمایشی و تصویر پروفایل';
    case 'followers': return `فقط ${fa(s.measure)} دنبال‌کننده`;
  }
  return '';
}

export interface AccountScore {
  score: number;
  class: BotClass;
  confidence: Confidence;
  reasons: Array<{ key: SignalKey; label: string; contribution: number }>;
  signals: SignalResult[];
}

export function scoreAccount(r: AccountRow): AccountScore {
  const signals = accountSignals(r);
  const score = Math.round(100 * (1 - signals.reduce((p, s) => p * (1 - s.contribution), 1)));
  const fired = signals.filter((s) => s.fired);
  const strongFired = fired.filter((s) => SIGNALS[s.key].strong);
  const llm = signals.find((s) => s.key === 'llm');
  const scored = Number(r.scoredPosts) || 0;

  let cls: BotClass;
  if (!llm && fired.length === 0) cls = 'unscored';
  else if (score >= BOT_MIN) {
    const corroborated = fired.length >= 2 && strongFired.length >= 1;
    const llmAlone = !!llm && llm.measure >= LLM_ONLY_BOT_AVG && scored >= LLM_ONLY_MIN_POSTS;
    cls = corroborated || llmAlone ? 'bot' : 'suspicious';
  } else if (score >= SUSPICIOUS_MIN) cls = 'suspicious';
  else cls = 'human';

  // Confidence: how much evidence stands behind the verdict
  const posts = Number(r.posts) || 0;
  const measurable = signals.length / Object.keys(SIGNALS).length;
  let c = 0.4 * Math.min(1, scored / 5) + 0.3 * Math.min(1, posts / 8) + 0.3 * measurable;
  if (cls === 'bot' && fired.length >= 3) c += 0.1;
  const confidence: Confidence = c >= 0.7 ? 'high' : c >= 0.4 ? 'medium' : 'low';

  const reasons = [...signals]
    .filter((s) => s.fired || s.contribution >= 0.15)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map((s) => ({ key: s.key, label: reasonLabel(s, r), contribution: Math.round(s.contribution * 100) }));

  return { score, class: cls, confidence, reasons, signals };
}

/** Kept for callers that only have an LLM average (and the old tests). */
export function classifyAccount(avg: number | null | undefined, scoredPosts = 1): BotClass {
  if (avg === null || avg === undefined || !Number.isFinite(Number(avg)) || scoredPosts <= 0) return 'unscored';
  return scoreAccount({ handle: '', platform: '', posts: scoredPosts, scoredPosts, avgProbability: Number(avg) }).class;
}

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

export function summariseBotAnalysis(rows: AccountRow[], topLimit = TOP_SUSPICIOUS_LIMIT) {
  const counts = Object.fromEntries(CLASS_ORDER.map((k) => [k, { accounts: 0, posts: 0 }])) as Record<
    BotClass,
    { accounts: number; posts: number }
  >;
  const confidence = { high: 0, medium: 0, low: 0 } as Record<Confidence, number>;
  const reasonCounts = Object.fromEntries(Object.keys(SIGNALS).map((k) => [k, 0])) as Record<SignalKey, number>;
  let totalPosts = 0;
  const flagged: Array<{ row: AccountRow; s: AccountScore }> = [];

  for (const r of rows) {
    const posts = Number(r.posts) || 0;
    const s = scoreAccount({ ...r, posts, scoredPosts: Number(r.scoredPosts) || 0 });
    counts[s.class].accounts += 1;
    counts[s.class].posts += posts;
    totalPosts += posts;
    if (s.class === 'bot' || s.class === 'suspicious') {
      flagged.push({ row: { ...r, posts }, s });
      confidence[s.confidence] += 1;
      for (const sig of s.signals) if (sig.fired) reasonCounts[sig.key] += 1;
    }
  }

  const totalAccounts = rows.length;
  const topSuspicious = flagged
    .sort((a, b) => b.s.score - a.s.score || b.row.posts - a.row.posts || a.row.handle.localeCompare(b.row.handle))
    .slice(0, topLimit)
    .map(({ row, s }) => ({
      handle: row.handle,
      displayName: row.displayName ?? null,
      platform: row.platform,
      score: s.score,
      avgProbability: row.avgProbability === null || row.avgProbability === undefined ? null : Math.round(Number(row.avgProbability)),
      postCount: row.posts,
      scoredPosts: Number(row.scoredPosts) || 0,
      class: s.class,
      confidence: s.confidence,
      confidenceLabel: CONFIDENCE_LABELS[s.confidence],
      reasons: s.reasons,
    }));

  return {
    criterion: {
      botMin: BOT_MIN,
      suspiciousMin: SUSPICIOUS_MIN,
      method: 'signals',
      signals: (Object.keys(SIGNALS) as SignalKey[]).map((key) => ({ key, label: SIGNALS[key].label, reliability: SIGNALS[key].reliability })),
    },
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
    /** Confidence of the bot / suspicious verdicts */
    flaggedConfidence: confidence,
    /** How often each signal fired among bot / suspicious accounts */
    reasonCounts: (Object.keys(SIGNALS) as SignalKey[])
      .map((key) => ({ key, label: SIGNALS[key].label, accounts: reasonCounts[key] }))
      .filter((r) => r.accounts > 0)
      .sort((a, b) => b.accounts - a.accounts),
    topSuspicious,
  };
}

export type BotAnalysis = ReturnType<typeof summariseBotAnalysis>;
