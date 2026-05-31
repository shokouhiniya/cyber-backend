import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PromticService } from '../../libs/promtic';
import { GlobalContextService } from '../admin/global-context/global-context.service';
import { Profile } from '../profile/profile.entity';
import { SelectedPost } from './selected-post.entity';

const BATCH_SIZE = 25;
const PROMPT_NAME = 'batch_sentiment';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PostInput {
  id: string;
  text: string;
}

interface SentimentResult {
  id: number;           // 1-based index within the batch
  sentiment: string;
  political_spectrum: string;
  relevance_score: number;
  bot_probability: number;
  reasoning_brief: string;
  keywords: string[];
  outlook: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class BatchSentimentService {
  private readonly logger = new Logger(BatchSentimentService.name);

  constructor(
    @InjectRepository(SelectedPost)
    private readonly postRepo: Repository<SelectedPost>,
    @InjectRepository(Profile)
    private readonly profileRepo: Repository<Profile>,
    private readonly promtic: PromticService,
    private readonly globalContext: GlobalContextService,
  ) {}

  /**
   * Classify sentiment for a set of posts belonging to one profile.
   * Sends posts in batches of BATCH_SIZE to the `batch_sentiment` prompt.
   * Writes results back to selected_posts.
   *
   * Designed to run fire-and-forget after ingest — failures are logged
   * but never propagate to the caller.
   */
  async classifyForProfile(
    posts: PostInput[],
    profileIdentifier: { external_id: string; name: string },
    profileId?: string,
  ): Promise<void> {
    if (posts.length === 0) return;

    const identifier = {
      external_id: profileIdentifier.external_id,
      name: profileIdentifier.name,
      type: 'political_figure',
    };

    // Resolve profile context for batch_sentiment
    let profileContext = '';
    if (profileId) {
      const profile = await this.profileRepo.findOne({ where: { id: profileId }, select: ['id', 'profileContexts'] });
      const contexts = profile?.profileContexts || {};
      profileContext = contexts[PROMPT_NAME] || contexts['default'] || '';
    }

    // Get global context
    const globals = await this.globalContext.asInputVars();

    let classified = 0;
    let errors = 0;

    for (let i = 0; i < posts.length; i += BATCH_SIZE) {
      const batch = posts.slice(i, i + BATCH_SIZE);

      try {
        const results = await this.callBatch(batch, identifier, profileContext, globals);
        await this.persistResults(batch, results);
        classified += results.length;

        // Retry missing posts (LLM sometimes skips items)
        if (results.length < batch.length) {
          const returnedIds = new Set(results.map(r => r.id));
          const missing = batch.filter((_, idx) => !returnedIds.has(idx + 1));
          if (missing.length > 0 && missing.length < batch.length) {
            this.logger.log(`BatchSentiment: retrying ${missing.length} missed posts`);
            try {
              const retryResults = await this.callBatch(missing, identifier, profileContext, globals);
              // Remap IDs back to the original batch indices
              const remapped = retryResults.map((r, idx) => ({ ...r, id: idx + 1 }));
              // Persist with the correct post IDs from the missing array
              await this.persistResults(missing, remapped);
              classified += retryResults.length;
            } catch { /* retry is best-effort */ }
          }
        }
      } catch (err) {
        errors++;
        this.logger.warn(
          `BatchSentiment: batch ${Math.floor(i / BATCH_SIZE) + 1} failed for ${profileIdentifier.name} — ${err.message}`,
        );
      }
    }

    this.logger.log(
      `BatchSentiment: ${profileIdentifier.name} — ${classified}/${posts.length} classified, ${errors} batch errors`,
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private formatBatch(posts: PostInput[]): string {
    return posts
      .map((p, i) => `[${i + 1}] ${(p.text || '').replace(/\n+/g, ' ').slice(0, 500)}`)
      .join('\n\n');
  }

  private async callBatch(
    posts: PostInput[],
    identifier: { external_id: string; name: string; type: string },
    profileContext: string,
    globals: Record<string, string>,
  ): Promise<SentimentResult[]> {
    const postsBatch = this.formatBatch(posts);

    const raw = await this.promtic.invoke({
      promptName: PROMPT_NAME,
      inputVars: { ...globals, profile_context: profileContext, posts_batch: postsBatch },
      identifier,
      params: { temperature: 0.2, max_tokens: 8192 },
    });

    // Strip markdown fences if present
    const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(clean);

    // Handle {"results": [...]} wrapper (DeepSeek json_object mode)
    let results: any[];
    if (Array.isArray(parsed)) {
      results = parsed;
    } else if (Array.isArray(parsed.results)) {
      results = parsed.results;
    } else if (parsed.id !== undefined) {
      results = [parsed]; // single object fallback
    } else {
      throw new Error(`Expected JSON array or {results:[...]}, got: ${typeof parsed}`);
    }

    // Log if the LLM returned fewer results than posts sent
    if (results.length < posts.length) {
      this.logger.warn(
        `BatchSentiment: LLM returned ${results.length}/${posts.length} results — some posts were not classified`,
      );
    }

    return results as SentimentResult[];
  }

  private async persistResults(
    batch: PostInput[],
    results: SentimentResult[],
  ): Promise<void> {
    if (results.length === 0) return;

    // Build update values — match by 1-based id back to batch index
    const updates: Array<{
      id: string;
      sentiment: string | null;
      politicalSpectrum: string | null;
      relevanceScore: number | null;
      botProbability: number | null;
      reasoningBrief: string | null;
      aiTopics: string[] | null;
      outlook: string | null;
    }> = [];

    for (const item of results) {
      const idx = item.id - 1;
      if (idx < 0 || idx >= batch.length) continue;

      updates.push({
        id:               batch[idx].id,
        sentiment:        item.sentiment         || null,
        politicalSpectrum: item.political_spectrum || null,
        relevanceScore:   item.relevance_score    ?? null,
        botProbability:   item.bot_probability    ?? null,
        reasoningBrief:   item.reasoning_brief    || null,
        aiTopics:         Array.isArray(item.keywords) && item.keywords.length > 0 ? item.keywords : null,
        outlook:          item.outlook            || null,
      });
    }

    if (updates.length === 0) return;

    // Batch update via unnest — single round-trip for the whole batch
    const ids              = updates.map(u => u.id);
    const sentiments       = updates.map(u => u.sentiment);
    const spectrums        = updates.map(u => u.politicalSpectrum);
    const relevanceScores  = updates.map(u => u.relevanceScore);
    const botProbabilities = updates.map(u => u.botProbability);
    const reasonings       = updates.map(u => u.reasoningBrief);
    const outlooks         = updates.map(u => u.outlook);
    const topics           = updates.map(u => u.aiTopics ? `{${u.aiTopics.map(t => `"${t.replace(/"/g, '\\"')}"`).join(',')}}` : null);

    await this.postRepo.query(
      `UPDATE selected_posts AS sp
       SET sentiment          = COALESCE(u.sentiment, sp.sentiment),
           political_spectrum = COALESCE(u.spectrum, sp.political_spectrum),
           relevance_score    = COALESCE(u.relevance::smallint, sp.relevance_score),
           bot_probability    = COALESCE(u.bot::smallint, sp.bot_probability),
           reasoning_brief    = COALESCE(u.reasoning, sp.reasoning_brief),
           outlook            = COALESCE(u.outlook, sp.outlook),
           ai_topics          = COALESCE(u.topics::text[], sp.ai_topics)
       FROM unnest(
         $1::uuid[],
         $2::text[],
         $3::text[],
         $4::text[],
         $5::text[],
         $6::text[],
         $7::text[],
         $8::text[]
       ) AS u(id, sentiment, spectrum, relevance, bot, reasoning, outlook, topics)
       WHERE sp.id = u.id::uuid`,
      [ids, sentiments, spectrums,
       relevanceScores.map(v => v?.toString() ?? null),
       botProbabilities.map(v => v?.toString() ?? null),
       reasonings,
       outlooks,
       topics],
    );
  }
}
