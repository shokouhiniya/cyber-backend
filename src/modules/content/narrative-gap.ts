/**
 * Narrative gap («تحلیل شکاف روایت»), computed from data.
 *
 * 1. The profile's official narratives = clusters of its official accounts'
 *    posts in the period (shared words, hashtags and the per-post AI topics).
 * 2. Every public post in the same period is matched to the official
 *    narrative it addresses (if any) by the same signals.
 * 3. Coverage = share of public posts that address each narrative; the rest
 *    is the gap, broken down into the public's own topics.
 *
 * The LLM only names and explains the clusters; it never produces a number.
 */

import { normalizeArabicLetters, normalizePersianText, parseLlmJson } from './persian-text';

export interface GapPost {
  id: string;
  text: string | null;
  hashtags?: string[] | null;
  topics?: string[] | null;
  sentiment?: string | null;
  viewCount?: number | null;
  publishedAt?: Date | string | null;
}

export type SentimentCounts = { positive: number; negative: number; neutral: number };

export interface NarrativeCluster {
  id: string;
  terms: string[];
  topic: string | null;
  officialPosts: number;
  officialShare: number;
  publicPosts: number;
  publicPercent: number;
  sentiment: SentimentCounts;
  officialSamples: string[];
  publicSamples: string[];
}

export interface GapTopic {
  id: string;
  terms: string[];
  topic: string | null;
  publicPosts: number;
  percent: number;
  sentiment: SentimentCounts;
  samples: string[];
}

export interface NarrativeGapComputation {
  totals: { official: number; public: number; covered: number; coveredPercent: number };
  gapLevel: 'high' | 'medium' | 'low';
  narratives: NarrativeCluster[];
  uncovered: { publicPosts: number; percent: number; topics: GapTopic[]; otherPosts: number; otherPercent: number };
}

// ── Tokenising ────────────────────────────────────────────────────────────────

/** Function words and generic political filler that never identify a topic. */
const STOPWORDS = new Set(
  `و در به از که این را با است برای آن یک تا هم بر شد شده می نمی های ها ای اند هست نیست بود باشد کرد کرده کند کنند کنیم کنم شود شوند
  دارد دارند داشت خواهد خواهند باید نباید اگر یا اما ولی پس چون چرا چه چی چطور کجا کی همه هر هیچ دیگر خود خودش ما من تو او ایشان آنها آن‌ها
  شما اینکه آنکه وقتی حتی فقط نیز بسیار خیلی بیشتر کمتر روی زیر بین پیش پس‌از بعد قبل طی درباره مورد عنوان طور توسط سوی سمت جای همین همان
  امروز دیروز فردا الان اکنون هنوز دیگری کسی چیزی جایی گفت گفته گوید می‌گوید کرد گفتند بودند هستند نیستند داریم دارم شده‌است است. اند.
  ایران کشور مردم آقای آقا جناب دکتر رئیس مسئول سال روز ماه هفته ساعت نفر میلیون میلیارد هزار درصد خبر گزارش ویدیو فیلم عکس کانال لینک
  rt https http www com via amp`
    .split(/\s+/)
    .filter(Boolean),
);

const WORD_RE = /[؀-ۿ‌A-Za-z]+/g;

function normalizeToken(t: string): string {
  return normalizeArabicLetters(t)
    .replace(/[ً-ٰٟـ]/g, '') // harakat, tatweel
    .replace(/‌+$/, '')
    .replace(/^‌+/, '')
    .toLowerCase();
}

/** Words of a post, normalised, without stopwords, plural suffix folded. */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  const words = normalizeArabicLetters(text).replace(/https?:\/\/\S+/g, ' ').match(WORD_RE) || [];
  const out: string[] = [];
  for (const raw of words) {
    let w = normalizeToken(raw);
    // Fold the most common suffixes so «وعده‌ها» matches «وعده»
    w = w.replace(/‌?(ها|های|هایی|ترین)$/, '');
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    out.push(w);
  }
  return out;
}

type Kind = 'w' | 'h' | 't';
const key = (kind: Kind, v: string) => `${kind}:${v}`;
const kindOf = (k: string) => k[0] as Kind;
const valueOf = (k: string) => k.slice(2);

/** Term set of a post: words, hashtags and AI topic tags, each as a typed key. */
export function postTerms(p: GapPost, exclude: Set<string>): Set<string> {
  const terms = new Set<string>();
  for (const w of tokenize(p.text)) if (!exclude.has(w)) terms.add(key('w', w));
  for (const h of p.hashtags || []) {
    const n = normalizeToken(String(h).replace(/^#/, '')).replace(/_/g, ' ').trim();
    if (n.length >= 2 && !exclude.has(n)) terms.add(key('h', n));
  }
  for (const t of p.topics || []) {
    const n = normalizeToken(String(t)).trim();
    if (n) terms.add(key('t', n));
  }
  return terms;
}

/** Terms that must never drive a match: the profile's name and search keywords. */
export function buildExcludeSet(values: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    for (const w of tokenize(v)) out.add(w);
    const whole = normalizeToken(v).trim();
    if (whole) out.add(whole);
  }
  return out;
}

const KIND_WEIGHT: Record<Kind, number> = { w: 1, h: 1.5, t: 2 };

// ── Computation ───────────────────────────────────────────────────────────────

export const MAX_NARRATIVES = 5;
export const MAX_GAP_TOPICS = 4;
/** Official posts join an existing narrative at this cosine similarity. */
const CLUSTER_SIM = 0.18;
/** Words used by more than this share of all posts are too generic to match on. */
const GENERIC_DF = 0.35;

function sentimentKey(s?: string | null): keyof SentimentCounts {
  const v = String(s || '').toLowerCase();
  return v === 'positive' ? 'positive' : v === 'negative' ? 'negative' : 'neutral';
}

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

function excerpt(text: string | null | undefined, max = 220): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function gapLevelFor(coveredPercent: number): 'high' | 'medium' | 'low' {
  if (coveredPercent >= 50) return 'low';
  if (coveredPercent >= 25) return 'medium';
  return 'high';
}

export function computeNarrativeGap(input: {
  official: GapPost[];
  public: GapPost[];
  exclude?: Set<string>;
  maxNarratives?: number;
  maxGapTopics?: number;
}): NarrativeGapComputation {
  const exclude = input.exclude || new Set<string>();
  const maxNarratives = input.maxNarratives ?? MAX_NARRATIVES;
  const maxGapTopics = input.maxGapTopics ?? MAX_GAP_TOPICS;

  const official = input.official.map((p) => ({ p, terms: postTerms(p, exclude) }));
  const pub = input.public.map((p) => ({ p, terms: postTerms(p, exclude) }));
  const all = [...official, ...pub];
  const N = all.length;

  // Document frequency → IDF; very common words are dropped as generic
  const df = new Map<string, number>();
  for (const { terms } of all) for (const t of terms) df.set(t, (df.get(t) || 0) + 1);
  const generic = new Set<string>();
  if (N >= 20) {
    for (const [t, n] of df) if (kindOf(t) === 'w' && n / N > GENERIC_DF) generic.add(t);
  }
  const weight = (t: string) =>
    generic.has(t) ? 0 : KIND_WEIGHT[kindOf(t)] * (Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1);

  // ── 1. Cluster official posts into narratives (greedy, by engagement) ──
  type Cluster = { members: typeof official; weights: Map<string, number> };
  const clusters: Cluster[] = [];
  const sorted = [...official].sort((a, b) => (Number(b.p.viewCount) || 0) - (Number(a.p.viewCount) || 0));
  const cosine = (terms: Set<string>, w: Map<string, number>) => {
    let dot = 0;
    let a = 0;
    for (const t of terms) {
      const x = weight(t);
      a += x * x;
      const y = w.get(t);
      if (y) dot += x * y;
    }
    let b = 0;
    for (const y of w.values()) b += y * y;
    return a && b ? dot / Math.sqrt(a * b) : 0;
  };
  for (const item of sorted) {
    if (!item.terms.size) continue;
    let best: Cluster | null = null;
    let bestSim = 0;
    for (const c of clusters) {
      const s = cosine(item.terms, c.weights);
      if (s > bestSim) {
        bestSim = s;
        best = c;
      }
    }
    const target = best && bestSim >= CLUSTER_SIM ? best : { members: [], weights: new Map<string, number>() };
    if (target !== best) clusters.push(target);
    target.members.push(item);
    for (const t of item.terms) {
      const x = weight(t);
      if (x > 0) target.weights.set(t, (target.weights.get(t) || 0) + x);
    }
  }
  clusters.sort((a, b) => b.members.length - a.members.length);
  const kept = clusters.slice(0, maxNarratives);

  // Signature: terms shared by ≥2 members when the cluster is big enough, top 12 by weight
  const signatures = kept.map((c) => {
    const counts = new Map<string, number>();
    for (const m of c.members) for (const t of m.terms) counts.set(t, (counts.get(t) || 0) + 1);
    const minMembers = c.members.length >= 3 ? 2 : 1;
    const terms = [...c.weights.entries()]
      .filter(([t]) => (counts.get(t) || 0) >= minMembers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([t]) => t);
    const topicCounts = [...counts.entries()].filter(([t]) => kindOf(t) === 't').sort((a, b) => b[1] - a[1]);
    return { terms: new Set(terms), topic: topicCounts[0] ? valueOf(topicCounts[0][0]) : null };
  });

  // ── 2. Match public posts to narratives ──
  const matched: Array<typeof pub> = kept.map(() => []);
  const unmatched: typeof pub = [];
  for (const item of pub) {
    let bestIdx = -1;
    let bestScore = 0;
    signatures.forEach((sig, i) => {
      let words = 0;
      let strong = 0;
      let score = 0;
      for (const t of item.terms) {
        if (!sig.terms.has(t)) continue;
        const w = weight(t);
        if (w <= 0) continue;
        score += w;
        if (kindOf(t) === 'w') words++;
        else strong++;
      }
      // A match needs a shared hashtag / AI topic, or at least two shared distinctive words
      if ((strong >= 1 || words >= 2) && score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0) matched[bestIdx].push(item);
    else unmatched.push(item);
  }

  const totalPublic = pub.length;
  const totalOfficial = official.length;
  const covered = matched.reduce((s, m) => s + m.length, 0);
  const coveredPercent = pct(covered, totalPublic);

  const countSentiment = (items: typeof pub): SentimentCounts => {
    const c: SentimentCounts = { positive: 0, negative: 0, neutral: 0 };
    for (const { p } of items) c[sentimentKey(p.sentiment)]++;
    return c;
  };
  const topSamples = (items: typeof pub, n = 3) =>
    [...items]
      .sort((a, b) => (Number(b.p.viewCount) || 0) - (Number(a.p.viewCount) || 0))
      .slice(0, n)
      .map(({ p }) => excerpt(p.text))
      .filter(Boolean);
  const displayTerms = (terms: Iterable<string>, n = 6) =>
    [...terms].filter((t) => kindOf(t) !== 't').slice(0, n).map(valueOf);

  const narratives: NarrativeCluster[] = kept
    .map((c, i) => ({
      id: `n${i + 1}`,
      terms: displayTerms(signatures[i].terms),
      topic: signatures[i].topic,
      officialPosts: c.members.length,
      officialShare: pct(c.members.length, totalOfficial),
      publicPosts: matched[i].length,
      publicPercent: pct(matched[i].length, totalPublic),
      sentiment: countSentiment(matched[i]),
      officialSamples: topSamples(c.members, 3),
      publicSamples: topSamples(matched[i], 3),
    }));

  // ── 3. Break the gap down into the public's own topics ──
  const groups = new Map<string, typeof pub>();
  const noTopic: typeof pub = [];
  for (const item of unmatched) {
    const topics = [...item.terms].filter((t) => kindOf(t) === 't');
    if (topics.length) {
      const k = topics[0];
      groups.set(k, [...(groups.get(k) || []), item]);
    } else {
      noTopic.push(item);
    }
  }
  // Posts without AI topics are grouped by their most distinctive hashtag / word
  for (const item of noTopic) {
    const best = [...item.terms].sort((a, b) => weight(b) - weight(a))[0];
    const k = best && weight(best) > 0 ? best : '__other';
    groups.set(k, [...(groups.get(k) || []), item]);
  }
  const ranked = [...groups.entries()]
    .filter(([k, items]) => k !== '__other' && items.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxGapTopics);
  const topics: GapTopic[] = ranked.map(([k, items], i) => {
    const counts = new Map<string, number>();
    for (const { terms } of items) for (const t of terms) if (kindOf(t) !== 't') counts.set(t, (counts.get(t) || 0) + weight(t));
    return {
      id: `g${i + 1}`,
      topic: kindOf(k) === 't' ? valueOf(k) : null,
      terms: displayTerms(
        [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t),
      ),
      publicPosts: items.length,
      percent: pct(items.length, totalPublic),
      sentiment: countSentiment(items),
      samples: topSamples(items, 3),
    };
  });
  const inTopics = topics.reduce((s, t) => s + t.publicPosts, 0);
  const otherPosts = unmatched.length - inTopics;

  return {
    totals: { official: totalOfficial, public: totalPublic, covered, coveredPercent },
    gapLevel: gapLevelFor(coveredPercent),
    narratives,
    uncovered: {
      publicPosts: unmatched.length,
      percent: pct(unmatched.length, totalPublic),
      topics,
      otherPosts,
      otherPercent: pct(otherPosts, totalPublic),
    },
  };
}

// ── LLM labelling ─────────────────────────────────────────────────────────────

/** Compact JSON the labelling prompt receives as {{narrative_clusters}}. */
export function buildLabellingInput(c: NarrativeGapComputation): string {
  return JSON.stringify(
    {
      official_narratives: c.narratives.map((n) => ({
        id: n.id,
        keywords: n.terms,
        ai_topic: n.topic,
        official_posts: n.officialSamples,
        public_posts_on_it: n.publicSamples,
      })),
      public_topics_not_in_official_narrative: c.uncovered.topics.map((t) => ({
        id: t.id,
        keywords: t.terms,
        ai_topic: t.topic,
        public_posts: t.samples,
      })),
    },
    null,
    1,
  );
}

/** Coverage figures the model may quote in the insight, as {{coverage_facts}}. */
export function buildCoverageFacts(c: NarrativeGapComputation): string {
  const lines = [
    `پست‌های صفحات رسمی در بازه: ${c.totals.official}`,
    `پست‌های عمومی در بازه: ${c.totals.public}`,
    `پست‌های عمومی که به یکی از روایت‌های رسمی پرداخته‌اند: ${c.totals.covered} (${c.totals.coveredPercent}٪)`,
    `پست‌های عمومی خارج از روایت‌های رسمی: ${c.uncovered.publicPosts} (${c.uncovered.percent}٪)`,
    ...c.narratives.map(
      (n) =>
        `روایت ${n.id}: ${n.officialPosts} پست رسمی (${n.officialShare}٪ پست‌های رسمی) — ${n.publicPosts} پست عمومی (${n.publicPercent}٪)، منفی ${n.sentiment.negative}، مثبت ${n.sentiment.positive}`,
    ),
    ...c.uncovered.topics.map((t) => `موضوع عمومی ${t.id}: ${t.publicPosts} پست (${t.percent}٪)، منفی ${t.sentiment.negative}`),
  ];
  return lines.join('\n');
}

export const NARRATIVE_GAP_OUTPUT_FORMAT = `فقط یک شیء JSON برگردان، بدون هیچ متن دیگر:
{"labels": [{"id": "n1", "label": "عنوان کوتاه ۲ تا ۶ واژه", "summary": "یک جملهٔ کوتاه دربارهٔ محتوای این روایت یا موضوع"}],
 "insight": "دو جمله دربارهٔ شکاف روایت با استفاده از اعداد بخش واقعیت‌ها"}
برای همهٔ idهای داده‌شده (n… و g…) برچسب بده. هیچ عدد یا درصدی برای خوشه‌ها نساز.`;

const SENT_LABEL = (s: SentimentCounts): 'positive' | 'negative' | 'neutral' => {
  if (s.negative > s.positive && s.negative >= s.neutral) return 'negative';
  if (s.positive > s.negative && s.positive >= s.neutral) return 'positive';
  return 'neutral';
};

function fallbackLabel(topic: string | null, terms: string[]): string {
  if (topic) return topic;
  return terms.slice(0, 3).join('، ') || 'بدون عنوان';
}

/**
 * Final widget payload: computed numbers + LLM labels. The legacy fields
 * (official, officialPercent, public[]) are kept for the PDF report.
 */
export function mergeNarrativeGap(
  c: NarrativeGapComputation,
  llmRaw: string | null,
  period: { from: Date | null; to: Date | null },
) {
  const parsed = parseLlmJson(llmRaw);
  const labels = new Map<string, { label?: string; summary?: string }>();
  const list = Array.isArray(parsed?.labels) ? parsed.labels : [];
  for (const l of list) if (l && typeof l.id === 'string') labels.set(l.id, l);
  const labelOf = (id: string, topic: string | null, terms: string[]) => {
    const l = labels.get(id);
    const label = typeof l?.label === 'string' && l.label.trim() ? normalizePersianText(l.label).slice(0, 80) : fallbackLabel(topic, terms);
    const summary = typeof l?.summary === 'string' ? normalizePersianText(l.summary).slice(0, 300) : null;
    return { label, summary, labelSource: l?.label ? 'llm' : 'keywords' };
  };

  const narratives = c.narratives.map((n) => ({
    id: n.id,
    ...labelOf(n.id, n.topic, n.terms),
    terms: n.terms,
    officialPosts: n.officialPosts,
    officialShare: n.officialShare,
    publicPosts: n.publicPosts,
    publicPercent: n.publicPercent,
    sentiment: n.sentiment,
    dominantSentiment: SENT_LABEL(n.sentiment),
  }));
  const gapTopics = c.uncovered.topics.map((t) => ({
    id: t.id,
    ...labelOf(t.id, t.topic, t.terms),
    terms: t.terms,
    publicPosts: t.publicPosts,
    percent: t.percent,
    sentiment: t.sentiment,
    dominantSentiment: SENT_LABEL(t.sentiment),
  }));

  const insight = typeof parsed?.insight === 'string' && parsed.insight.trim() ? normalizePersianText(parsed.insight) : null;
  const top = narratives[0];

  return {
    version: 2,
    period: { from: period.from ? new Date(period.from).toISOString() : null, to: period.to ? new Date(period.to).toISOString() : null },
    totals: c.totals,
    gapLevel: c.gapLevel,
    narratives,
    uncovered: {
      publicPosts: c.uncovered.publicPosts,
      percent: c.uncovered.percent,
      topics: gapTopics,
      otherPosts: c.uncovered.otherPosts,
      otherPercent: c.uncovered.otherPercent,
    },
    insight,
    // Legacy shape (PDF report)
    official: top ? top.label : null,
    officialPercent: top ? top.officialShare : 0,
    public: [
      ...narratives.map((n) => ({ topic: n.label, percent: n.publicPercent, sentiment: n.dominantSentiment })),
      ...gapTopics.map((t) => ({ topic: t.label, percent: t.percent, sentiment: t.dominantSentiment })),
    ],
  };
}

export type NarrativeGapResult = ReturnType<typeof mergeNarrativeGap>;
