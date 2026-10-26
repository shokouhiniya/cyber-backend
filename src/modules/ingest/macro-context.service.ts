import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PromticService } from '../../libs/promtic';
import { GlobalContext } from '../admin/global-context/global-context.entity';

/**
 * Generates a daily macro political context briefing using a search-enabled LLM.
 * The output is stored in global_context and injected into all profile-specific
 * AI prompts as {{global_macro_political_context}}.
 *
 * Also maintains a rolling 7-day history so prompts have broader context.
 */
@Injectable()
export class MacroContextService {
  private readonly logger = new Logger(MacroContextService.name);

  constructor(
    private readonly promtic: PromticService,
    @InjectRepository(GlobalContext)
    private readonly contextRepo: Repository<GlobalContext>,
  ) {}

  /**
   * Runs twice daily at 07:00 and 19:00 (Iran time ≈ UTC+3:30).
   * Generates the macro political context and stores it.
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
    try {
      await this.generate();
      this.logger.log('MacroContext: briefing stored successfully');
    } catch (err) {
      this.logger.error(`MacroContext: generation failed — ${err.message}`);
    }
  }

  /**
   * Generate and store the macro context. Can be called manually or by cron.
   */
  async generate(): Promise<string> {
    // Get today's Jalali date
    const today = new Date().toLocaleDateString('fa-IR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    // Call the Promtic prompt
    const result = await this.promtic.invoke({
      promptName: 'macro_politics',
      inputVars: { date: today },
      params: { temperature: 0.2, max_tokens: 600 },
    });

    // Strip reference brackets and parse/re-serialize JSON for clean storage
    const stripped = result.replace(/\[\d+\]/g, '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let cleaned: string;
    try {
      const parsed = JSON.parse(stripped);
      cleaned = JSON.stringify(parsed); // compact, no whitespace artifacts
    } catch {
      // Fallback to plain text if JSON parse fails
      cleaned = stripped.replace(/\s{2,}/g, ' ').trim();
    }

    // Store today's briefing
    await this.upsertContext('macro_political_context', cleaned);

    // Update rolling 7-day context (append today, trim old entries)
    await this.updateRollingContext(today, cleaned);

    return cleaned;
  }

  private async upsertContext(key: string, value: string): Promise<void> {
    const existing = await this.contextRepo.findOne({ where: { key } });
    if (existing) {
      existing.value = value;
      await this.contextRepo.save(existing);
    } else {
      await this.contextRepo.save(
        this.contextRepo.create({ key, value }),
      );
    }
  }

  /**
   * Maintains a rolling 7-day context in global_context with key
   * 'macro_political_context_7d'. Each day's briefing is appended
   * with a date header, and entries older than 7 days are trimmed.
   */
  private async updateRollingContext(date: string, briefing: string): Promise<void> {
    const key = 'macro_political_context_7d';
    const existing = await this.contextRepo.findOne({ where: { key } });

    const header = `--- ${date} ---`;
    const entry = `${header}\n${briefing}`;

    // Dates are written with Persian digits (fa-IR), so match both digit sets.
    // Drop any earlier entry for the same date (the cron runs twice a day),
    // then keep the last 6 + today = 7 days.
    const allEntries = existing?.value
      ? existing.value
          .split(/(?=--- [\d۰-۹]{4}\/[\d۰-۹]{2}\/[\d۰-۹]{2} ---)/)
          .map((e) => e.trim())
          .filter((e) => e && !e.startsWith(header))
          .slice(-6)
      : [];
    allEntries.push(entry);

    const combined = allEntries.join('\n');

    await this.upsertContext(key, combined);
  }
}
