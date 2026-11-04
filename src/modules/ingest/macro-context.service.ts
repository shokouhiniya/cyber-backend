import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';

import { PromticService } from '../../libs/promtic';
import { GlobalContext } from '../admin/global-context/global-context.entity';
import { Profile } from '../profile/profile.entity';
import { normalizePersianText } from '../content/persian-text';
import { SelectedPost } from './selected-post.entity';
import { MacroContextSnapshot } from './macro-context-snapshot.entity';
import {
  MACRO_SECTIONS, MAX_EVENTS_PER_SECTION, MacroBriefing, briefingHeadlines, buildMacroPromptVars, countEvents,
  headlineSimilarity, legacyToBriefing, parseMacroReply, rankForProfile, tehranDay, tehranJalali,
} from './macro-events';

/** A briefing older than this is shown as stale (the cron runs every 12 h). */
export const MACRO_STALE_AFTER_MS = 14 * 3600_000;
const TREND_DAYS = 7;
const PROFILE_EVENTS_HOURS = 48;
const PROFILE_EVENTS_MAX = 5;

export interface MacroGenerateResult {
  ok: boolean;
  events: number;
  error?: string;
  stats?: any;
}

/**
 * «وضعیت کلان کشور». One shared briefing (search-enabled LLM, macro_politics
 * prompt) twice a day, in four sections with today's and yesterday's events
 * only. Every attempt is stored in macro_context_snapshots; on failure the
 * last good briefing stays and is served as stale. The API ranks the shared
 * briefing per profile and adds the profile's own recent official posts.
 *
 * The latest good briefing is also kept in global_context
 * (macro_political_context + a rolling 7-day copy), which the other prompts
 * receive as {{global_macro_political_context}}.
 */
@Injectable()
export class MacroContextService {
  private readonly logger = new Logger(MacroContextService.name);

  constructor(
    private readonly promtic: PromticService,
    @InjectRepository(GlobalContext)
    private readonly contextRepo: Repository<GlobalContext>,
    @InjectRepository(MacroContextSnapshot)
    private readonly snapshotRepo: Repository<MacroContextSnapshot>,
    @InjectRepository(SelectedPost)
    private readonly postRepo: Repository<SelectedPost>,
    @InjectRepository(Profile)
    private readonly profileRepo: Repository<Profile>,
  ) {}

  /**
   * Runs twice daily at 07:00 and 19:00 Tehran time.
   */
  @Cron('0 7,19 * * *', { name: 'macro_context_generation', timeZone: 'Asia/Tehran' })
  async generateDaily() {
    // Same switch as the ingest crons: pausing automatic collection also pauses
    // this scheduled LLM call. Manual POST macro-context/generate still works.
    const settings = await this.contextRepo.findOne({ where: { key: 'ingest_settings' } });
    try {
      if (settings?.value && JSON.parse(settings.value).automaticCollectionEnabled === false) {
        this.logger.log('MacroContext: automatic collection is disabled; skipping');
        return;
      }
    } catch { /* malformed settings → keep default (enabled) */ }

    this.logger.log('MacroContext: generating daily briefing...');
    const res = await this.generate('cron');
    if (res.ok) this.logger.log(`MacroContext: briefing stored (${res.events} events)`);
    else this.logger.error(`MacroContext: generation failed — ${res.error}; serving the last good briefing as stale`);
  }

  /** Headlines of the good briefings from the previous days (the 7-day trend). */
  private async previousHeadlines(now: Date): Promise<string[]> {
    const today = tehranDay(now);
    const rows = await this.snapshotRepo.find({
      where: { status: 'ok', createdAt: MoreThanOrEqual(new Date(now.getTime() - TREND_DAYS * 86400_000)) },
      order: { createdAt: 'DESC' },
      take: 20,
    });
    return rows
      .filter((r) => tehranDay(new Date(r.createdAt)) < today)
      .flatMap((r) => briefingHeadlines(r.briefing))
      .slice(0, 60);
  }

  /**
   * Generate and store a briefing. Never throws: a failure is recorded as a
   * 'failed' snapshot so the UI can flag the last good one as stale.
   */
  async generate(trigger: 'cron' | 'manual' = 'manual'): Promise<MacroGenerateResult> {
    const now = new Date();
    let modelName: string | null = null;
    try {
      const previous = await this.previousHeadlines(now);
      const result = await this.promtic.invokeWithMeta({
        promptName: 'macro_politics',
        inputVars: buildMacroPromptVars(now, previous),
        params: { temperature: 0.1, max_tokens: 1500 },
      });
      modelName = result.modelName || null;
      const { briefing, stats } = parseMacroReply(result.result, now, previous);
      const events = countEvents(briefing);
      if (!events) {
        const why = stats.received
          ? `no event from today or yesterday survived the filters (${JSON.stringify(stats)})`
          : 'the reply had no parsable events';
        await this.recordFailure(trigger, why, modelName, stats);
        return { ok: false, events: 0, error: why, stats };
      }
      await this.snapshotRepo.save(this.snapshotRepo.create({ status: 'ok', trigger, briefing, stats, modelName }));
      await this.upsertContext('macro_political_context', JSON.stringify(briefing));
      await this.updateRollingContext(now, briefing);
      return { ok: true, events, stats };
    } catch (err) {
      const msg = err?.message || String(err);
      await this.recordFailure(trigger, msg, modelName, null);
      return { ok: false, events: 0, error: msg };
    }
  }

  private async recordFailure(trigger: string, error: string, modelName: string | null, stats: any) {
    try {
      await this.snapshotRepo.save(this.snapshotRepo.create({ status: 'failed', trigger, error: error.slice(0, 2000), modelName, stats }));
    } catch (e) {
      this.logger.warn(`MacroContext: could not record the failure — ${e?.message}`);
    }
  }

  private async upsertContext(key: string, value: string): Promise<void> {
    const existing = await this.contextRepo.findOne({ where: { key } });
    if (existing) {
      existing.value = value;
      await this.contextRepo.save(existing);
    } else {
      await this.contextRepo.save(this.contextRepo.create({ key, value }));
    }
  }

  /**
   * 'macro_political_context_7d' (prompt input only): one compact line set per
   * Jalali day, newest last, at most 7 days.
   */
  private async updateRollingContext(now: Date, briefing: MacroBriefing): Promise<void> {
    const key = 'macro_political_context_7d';
    const existing = await this.contextRepo.findOne({ where: { key } });
    const header = `--- ${tehranJalali(now)} ---`;
    const compact = {
      version: 2,
      sections: Object.fromEntries(
        MACRO_SECTIONS.map(({ key: k }) => [k, (briefing.sections[k] || []).map((e) => ({ title: e.title, date: e.date, severity: e.severity }))]),
      ),
    };
    const allEntries = existing?.value
      ? existing.value
          .split(/(?=--- [\d۰-۹]{4}\/[\d۰-۹]{2}\/[\d۰-۹]{2} ---)/)
          .map((e) => e.trim())
          .filter((e) => e && !e.startsWith(header))
          .slice(-6)
      : [];
    allEntries.push(`${header}\n${JSON.stringify(compact)}`);
    await this.upsertContext(key, allEntries.join('\n'));
  }

  // ── Read side ───────────────────────────────────────────────────────────────

  /**
   * Widget payload. `today` / `rolling7d` / `updatedAt` keep their old meaning
   * for the admin view and the scenario starters.
   */
  async getForProfile(profileId: string | null) {
    const now = new Date();
    const [lastOk, lastAttempt, today, rolling] = await Promise.all([
      this.snapshotRepo.findOne({ where: { status: 'ok' }, order: { createdAt: 'DESC' } }),
      this.snapshotRepo.findOne({ where: {}, order: { createdAt: 'DESC' } }),
      this.contextRepo.findOne({ where: { key: 'macro_political_context' } }),
      this.contextRepo.findOne({ where: { key: 'macro_political_context_7d' } }),
    ]);

    // Before the first v2 generation: show the old global row, flagged legacy
    const briefing: MacroBriefing | null = lastOk?.briefing ?? legacyToBriefing(today?.value ?? null, today?.updatedAt ?? null);
    const lastSuccessAt: Date | null = lastOk?.createdAt ?? (briefing ? today?.updatedAt ?? null : null);
    const lastFailed = lastAttempt?.status === 'failed' && (!lastSuccessAt || lastAttempt.createdAt > lastSuccessAt);
    const tooOld = !!lastSuccessAt && now.getTime() - new Date(lastSuccessAt).getTime() > MACRO_STALE_AFTER_MS;
    const staleReason = lastFailed ? 'last_attempt_failed' : tooOld ? 'outdated' : null;

    const profile = profileId
      ? await this.profileRepo.findOne({ where: { id: profileId }, select: ['id', 'name', 'role', 'organization', 'keywords'] })
      : null;
    const sections = briefing
      ? profile
        ? rankForProfile(briefing, profile)
        : MACRO_SECTIONS.map(({ key, label }) => ({
            key, label, priority: false,
            events: (briefing.sections[key] || []).slice(0, MAX_EVENTS_PER_SECTION).map((e) => ({ ...e, relevance: 0, relevant: false, matched: [] })),
          }))
      : [];

    const [trend, profileEvents] = await Promise.all([
      this.getTrend(now),
      profileId ? this.getProfileEvents(profileId, now) : Promise.resolve([]),
    ]);

    return {
      // legacy fields
      today: today?.value || null,
      updatedAt: lastSuccessAt,
      rolling7d: rolling?.value || null,
      // v2
      briefing: briefing ? { window: briefing.window, legacy: !!briefing.legacy, sections } : null,
      stale: !!staleReason,
      staleReason,
      lastSuccessAt,
      lastAttemptAt: lastAttempt?.createdAt ?? null,
      profile: profile ? { id: profile.id, name: profile.name } : null,
      profileEvents,
      trend,
    };
  }

  /**
   * The previous days' headlines (newest day first), today excluded so the
   * trend never repeats the current sections.
   */
  private async getTrend(now: Date) {
    const today = tehranDay(now);
    const rows = await this.snapshotRepo.find({
      where: { status: 'ok', createdAt: MoreThanOrEqual(new Date(now.getTime() - TREND_DAYS * 86400_000)) },
      order: { createdAt: 'DESC' },
      take: 20,
    });
    const byDay = new Map<string, MacroContextSnapshot>();
    for (const r of rows) {
      const day = tehranDay(new Date(r.createdAt));
      if (day < today && !byDay.has(day)) byDay.set(day, r); // newest run of each day
    }
    return [...byDay.entries()].map(([day, r]) => ({
      day,
      jalali: tehranJalali(new Date(r.createdAt)),
      events: MACRO_SECTIONS.flatMap(({ key, label }) =>
        (r.briefing?.sections?.[key] || []).map((e: any) => ({ title: e.title, section: key, sectionLabel: label, severity: e.severity })),
      ).slice(0, 8),
    }));
  }

  /**
   * «رویدادهای مرتبط با شخصیت»: the profile's own official posts from the last
   * 48 hours, one line each (no web search, no LLM).
   */
  private async getProfileEvents(profileId: string, now: Date) {
    const rows: Array<{ text: string; source: string; publishedAt: Date; url: string | null; views: number }> =
      await this.postRepo.query(
        `SELECT text, source_type AS source, published_at AS "publishedAt", post_url AS url, view_count AS views
         FROM selected_posts
         WHERE profile_id = $1 AND canonical_id IS NULL AND selection_reason LIKE 'official_page_%'
           AND published_at >= $2 AND published_at <= $3 AND text IS NOT NULL AND btrim(text) <> ''
         ORDER BY published_at DESC LIMIT 30`,
        [profileId, new Date(now.getTime() - PROFILE_EVENTS_HOURS * 3600_000), now],
      );
    const out: Array<{ title: string; source: string; publishedAt: Date; url: string | null; views: number }> = [];
    for (const r of rows || []) {
      const first = normalizePersianText(String(r.text).split(/(?<=[.!؟?])\s|\n/)[0] || '');
      const title = first.length > 140 ? `${first.slice(0, 140)}…` : first;
      if (!title || out.some((o) => headlineSimilarity(o.title, title) >= 0.5)) continue;
      out.push({ title, source: r.source, publishedAt: r.publishedAt, url: r.url, views: Number(r.views) || 0 });
      if (out.length >= PROFILE_EVENTS_MAX) break;
    }
    return out;
  }
}
