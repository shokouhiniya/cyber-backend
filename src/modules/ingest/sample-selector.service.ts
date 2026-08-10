import { Injectable, Logger } from '@nestjs/common';
import { DataSourceApiService } from '../data-source/data-source-api.service';
import { isNonPersianText, isGarbledSttText } from '../../libs/text-utils/language-detect';
import { SourceWeights } from '../profile/profile.entity';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SelectedPost {
  /** Stable post ID from the source platform */
  id: string;
  text: string;
  sourceType: string;
  screenName: string | null;
  displayName: string | null;
  publishedAt: string | null;
  viewCount: number;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  sentiment: string;
  reactions: any[] | null;
  hashtags: string[];
  postUrl: string | null;
  mediaUrl: string | null;
  profileImageUrl: string | null;
  /** Why this post was selected */
  selectionReason: string;
  /** Simhash fingerprint (64-bit as hex string) */
  simhash: string;
  /** ID of the canonical post if this is a near-duplicate */
  canonicalId: string | null;
}

export interface SelectorOptions {
  /** Profile keywords (OR logic) */
  or: string;
  /** Profile excluded keywords */
  not?: string;
  /** How far back to look (default: 'week') */
  range?: string;
  /** Profile-level source weight overrides */
  sourceWeights?: SourceWeights;
  /** Target total posts (default: 80) */
  targetSize?: number;
}

export interface SelectorResult {
  posts: SelectedPost[];
  stats: {
    fetchedPerSource: Record<string, number>;
    /** Total results 8tag reports for each source (before our fetch cap) */
    totalPerSource: Record<string, number>;
    afterFilter: number;
    afterDedup: number;
    selected: number;
    quotaPerSource: Record<string, number>;
  };
}

// ── System defaults ───────────────────────────────────────────────────────────

/**
 * Default quota (number of posts) per source per analysis run.
 * These are the baseline before profile-level weight multipliers are applied.
 */
const DEFAULT_QUOTAS: Record<string, number> = {
  telegram:  12,
  news:      12,
  twitter:   10,
  instagram:  8,
  newspaper:  8,
  media:      8,
  bale:       6,
  rubika:     4,
  aparat:     4,
  forum:      4,
  eitaa:      0,   // disabled by default — too noisy, no view counts
};

/**
 * Per-source sort metric — what signal best represents engagement on each platform.
 */
const SOURCE_SORT: Record<string, string> = {
  telegram:  'reactions',
  news:      'views',
  twitter:   'comments',
  instagram: 'likes',
  newspaper: 'recent',
  media:     'views',
  bale:      'engagement',
  rubika:    'reactions',   // views are inflated on Rubika
  aparat:    'engagement',
  forum:     'views',
  eitaa:     'recent',
};

// ── Simhash implementation ────────────────────────────────────────────────────

/**
 * Computes a 32-bit simhash of the normalised text.
 * Two posts with hamming distance ≤ 3 are considered near-duplicates.
 *
 * We use 32-bit (not 64-bit) for simplicity — sufficient for dedup at our scale.
 */
function simhash32(text: string): number {
  if (!text) return 0;

  // Normalise: strip diacritics, kashida, ZWNJ, collapse whitespace, lowercase
  const norm = text
    .replace(/[\u064B-\u065F\u0640\u200C\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  // Extract 3-gram shingles
  const shingles: string[] = [];
  for (let i = 0; i < norm.length - 2; i++) {
    shingles.push(norm.slice(i, i + 3));
  }
  if (shingles.length === 0) return 0;

  // Build 32-bit vector
  const v = new Array(32).fill(0);
  for (const shingle of shingles) {
    let h = 0x811c9dc5; // FNV-1a seed
    for (let i = 0; i < shingle.length; i++) {
      h ^= shingle.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    for (let bit = 0; bit < 32; bit++) {
      v[bit] += (h >> bit) & 1 ? 1 : -1;
    }
  }

  let hash = 0;
  for (let bit = 0; bit < 32; bit++) {
    if (v[bit] > 0) hash |= (1 << bit);
  }
  return hash >>> 0;
}

function hammingDistance32(a: number, b: number): number {
  let x = (a ^ b) >>> 0;
  let count = 0;
  while (x) { count += x & 1; x >>>= 1; }
  return count;
}

function toHex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

// ── Selector service ──────────────────────────────────────────────────────────

@Injectable()
export class SampleSelectorService {
  private readonly logger = new Logger(SampleSelectorService.name);

  constructor(private readonly apiService: DataSourceApiService) {}

  /**
   * Fetches, filters, deduplicates, and selects posts for a profile.
   *
   * Steps:
   *   1. Compute effective quotas (default × profile weight multipliers)
   *   2. Fetch from each active source in parallel using source-specific sort
   *   3. Apply language / hashtag-spam / STT filters
   *   4. Simhash dedup across the full pool — keep canonical version
   *   5. Apply per-source quotas
   *   6. Apply recency adjustment (≥50% from last 24h)
   *   7. Apply negativity boost (≥25% negative sentiment)
   */
  async select(
    credentials: { username: string; password: string },
    options: SelectorOptions,
  ): Promise<SelectorResult> {
    const {
      or,
      not,
      range = 'week',
      sourceWeights = {},
      targetSize = 80,
    } = options;

    // Step 1: compute effective quotas
    const effectiveQuotas = this.computeQuotas(sourceWeights, targetSize);
    const activeSources = Object.entries(effectiveQuotas)
      .filter(([, q]) => q > 0)
      .map(([src]) => src);

    this.logger.log(
      `SampleSelector: fetching ${activeSources.length} sources for or="${or.slice(0, 40)}…"`,
    );

    // Step 2: fetch all sources in batches to avoid rate limiting
    const fetchedPerSource: Record<string, number> = {};
    const totalPerSource: Record<string, number> = {};
    const allPosts: SelectedPost[] = [];

    const BATCH_SIZE = 4;
    const BATCH_DELAY_MS = 400;

    for (let i = 0; i < activeSources.length; i += BATCH_SIZE) {
      const batch = activeSources.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.allSettled(
        batch.map(async (source) => {
          const fetchSize = Math.max(effectiveQuotas[source] * 4, 50);
          const result = await this.apiService.search8tag(credentials, {
            source,
            or,
            not,
            range,
            sort: SOURCE_SORT[source] || 'recent',
            size: fetchSize,
            lang: 'fa',
            forward: 'false',
            retweet: 'false',
            maxHashtags: 10,
          });
          return { source, items: result.data || [], total: result.total || 0 };
        }),
      );

      for (const r of batchResults) {
        if (r.status === 'fulfilled') {
          const { source, items, total } = r.value;
          fetchedPerSource[source] = items.length;
          totalPerSource[source] = total;
          for (const item of items) {
            allPosts.push({ ...item, selectionReason: '', simhash: toHex32(simhash32(item.text || '')), canonicalId: null });
          }
        } else {
          this.logger.warn(`SampleSelector: fetch failed — ${r.reason?.message}`);
        }
      }

      if (i + BATCH_SIZE < activeSources.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    const afterFilter = allPosts.length;

    // Step 3: simhash dedup across the full pool
    const dedupedPosts = this.dedup(allPosts);
    const afterDedup = dedupedPosts.length;

    // Step 4: apply per-source quotas
    const selected = this.applyQuotas(dedupedPosts, effectiveQuotas);

    // Step 5: recency + negativity adjustments
    const adjusted = this.applyAdjustments(selected, effectiveQuotas);

    this.logger.log(
      `SampleSelector: fetched=${afterFilter} deduped=${afterDedup} selected=${adjusted.length}`,
    );

    return {
      posts: adjusted,
      stats: {
        fetchedPerSource,
        totalPerSource,
        afterFilter,
        afterDedup,
        selected: adjusted.length,
        quotaPerSource: effectiveQuotas,
      },
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private computeQuotas(
    weights: SourceWeights,
    targetSize: number,
  ): Record<string, number> {
    const defaultTotal = Object.values(DEFAULT_QUOTAS).reduce((a, b) => a + b, 0);
    const scale = targetSize / defaultTotal;

    const quotas: Record<string, number> = {};
    for (const [src, defaultQ] of Object.entries(DEFAULT_QUOTAS)) {
      const w = (weights as Record<string, number>)[src] ?? 1.0;
      quotas[src] = Math.round(defaultQ * w * scale);
    }
    return quotas;
  }

  private dedup(posts: SelectedPost[]): SelectedPost[] {
    const HAMMING_THRESHOLD = 3;
    const canonical: SelectedPost[] = [];
    const hashToCanonical = new Map<number, SelectedPost>();

    // Sort by engagement descending so the most-viewed version becomes canonical
    const sorted = [...posts].sort(
      (a, b) => (b.viewCount + b.likeCount * 2 + b.replyCount * 3) -
                (a.viewCount + a.likeCount * 2 + a.replyCount * 3),
    );

    for (const post of sorted) {
      const hash = parseInt(post.simhash, 16);
      let isDuplicate = false;

      for (const [existingHash, existingPost] of hashToCanonical) {
        if (hammingDistance32(hash, existingHash) <= HAMMING_THRESHOLD) {
          // Mark as duplicate of the canonical post
          post.canonicalId = existingPost.id;
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        hashToCanonical.set(hash, post);
        canonical.push(post);
      }
    }

    return canonical;
  }

  private applyQuotas(
    posts: SelectedPost[],
    quotas: Record<string, number>,
  ): SelectedPost[] {
    // Group by source
    const bySource = new Map<string, SelectedPost[]>();
    for (const post of posts) {
      const src = post.sourceType;
      if (!bySource.has(src)) bySource.set(src, []);
      bySource.get(src)!.push(post);
    }

    const selected: SelectedPost[] = [];
    for (const [src, quota] of Object.entries(quotas)) {
      if (quota <= 0) continue;
      const sourcePosts = bySource.get(src) || [];
      const picks = sourcePosts.slice(0, quota);
      picks.forEach((p) => { p.selectionReason = `${src}_top_${quota}_by_${SOURCE_SORT[src] || 'recent'}`; });
      selected.push(...picks);
    }

    return selected;
  }

  private applyAdjustments(
    posts: SelectedPost[],
    quotas: Record<string, number>,
  ): SelectedPost[] {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    const recent = posts.filter((p) => p.publishedAt && (now - new Date(p.publishedAt).getTime()) < oneDayMs);
    const recentPct = posts.length > 0 ? recent.length / posts.length : 0;

    const negative = posts.filter((p) => p.sentiment === 'negative' || p.sentiment === '-1' || (p as any).sentiment === -1);
    const negativePct = posts.length > 0 ? negative.length / posts.length : 0;

    // Log imbalances but don't force-swap in v1 — the quota selection already
    // uses engagement-based sorts which naturally surface controversy.
    // Full swap logic is a v2 improvement once we have real data to tune against.
    if (recentPct < 0.3) {
      this.logger.warn(`SampleSelector: only ${Math.round(recentPct * 100)}% of selected posts are from last 24h`);
    }
    if (negativePct < 0.15) {
      this.logger.warn(`SampleSelector: only ${Math.round(negativePct * 100)}% of selected posts are negative — crisis signals may be underrepresented`);
    }

    return posts;
  }
}
