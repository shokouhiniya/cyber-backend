import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DataSourceApiService } from '../data-source/data-source-api.service';
import { PlatformTotal } from './platform-total.entity';

// ── Sources to count ──────────────────────────────────────────────────────────
// Skip eitaa (no useful metrics) and comments (not a real source)
const COUNT_SOURCES = [
  'telegram', 'twitter', 'instagram',
  'news', 'newspaper', 'media',
  'rubika', 'bale', 'forum', 'aparat',
];

// ── Timeframes to capture ─────────────────────────────────────────────────────
const TIMEFRAMES: Array<{ key: string; range: string; since?: () => number; max?: () => number }> = [
  { key: 'day',     range: 'day' },
  { key: 'week',    range: 'week' },
  { key: 'month',   range: 'month' },
  { key: 'quarter', range: 'custom',
    since: () => Math.floor((Date.now() - 90 * 86400_000) / 1000),
    max:   () => Math.floor(Date.now() / 1000),
  },
];

@Injectable()
export class PlatformTotalsService {
  private readonly logger = new Logger(PlatformTotalsService.name);

  constructor(
    @InjectRepository(PlatformTotal)
    private readonly repo: Repository<PlatformTotal>,
    private readonly apiService: DataSourceApiService,
  ) {}

  /**
   * Fetches total post counts from 8tag for all sources × all timeframes
   * for a given profile, and upserts into platform_totals.
   *
   * Runs in batches of 5 with a 500ms delay between batches to avoid
   * rate limiting. Only upserts when total > 0 — never overwrites a
   * valid count with a failed-call zero.
   *
   * Total calls: 10 sources × 4 timeframes = 40 calls per profile.
   */
  async captureForProfile(
    credentials: { username: string; password: string },
    profileId: string,
    keywords: { or: string; not?: string },
  ): Promise<void> {
    const tasks: Array<{ source: string; timeframe: string }> = [];

    for (const tf of TIMEFRAMES) {
      for (const source of COUNT_SOURCES) {
        tasks.push({ source, timeframe: tf.key });
      }
    }

    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 600;
    let saved = 0;

    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(({ source, timeframe }) => {
          const tf = TIMEFRAMES.find((t) => t.key === timeframe)!;
          return this.fetchTotal(credentials, source, tf, keywords)
            .then((total) => ({ source, timeframe, total }));
        }),
      );

      const now = new Date();

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const { source, timeframe, total } = result.value;

        // Never overwrite a valid count with 0 — skip failed calls
        if (total <= 0) continue;

        await this.repo
          .createQueryBuilder()
          .insert()
          .into(PlatformTotal)
          .values({ profileId, sourceType: source, timeframe, total, fetchedAt: now })
          .orUpdate(['total', 'fetched_at'], ['profile_id', 'source_type', 'timeframe'])
          .execute();

        saved++;
      }

      // Delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < tasks.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    this.logger.log(`PlatformTotals: saved ${saved}/${tasks.length} entries for profile ${profileId}`);
  }

  private async fetchTotal(
    credentials: { username: string; password: string },
    source: string,
    tf: typeof TIMEFRAMES[number],
    keywords: { or: string; not?: string },
  ): Promise<number> {
    try {
      const params: any = {
        source,
        or: keywords.or,
        not: keywords.not,
        range: tf.range,
        sort: 'recent',
        size: 1,
        lang: 'fa',
        forward: 'false',
        retweet: 'false',
        maxHashtags: 10,
      };

      if (tf.since) params.since = tf.since();
      if (tf.max) params.max = tf.max();

      const res = await this.apiService.search8tag(credentials, params);
      return res.total || 0;
    } catch {
      return 0;
    }
  }
}
