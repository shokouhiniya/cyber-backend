import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Content } from './content.entity';

// ----------------------------------------------------------------------

function normalizeEmotion(label?: string): string | null {
  if (!label || label === 'invalid') return null;
  return label.toUpperCase();
}

function normalizeSentiment(label?: string): string | null {
  if (!label || label === 'invalid') return null;
  const lower = label.toLowerCase();
  if (['positive', 'negative', 'neutral'].includes(lower)) return lower;
  return null;
}

function parseDate(val?: string | number): Date | null {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

// ----------------------------------------------------------------------

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    @InjectRepository(Content)
    private readonly repo: Repository<Content>,
  ) {}

  async importJson(buffer: Buffer): Promise<{ inserted: number; skipped: number; total: number }> {
    const raw = JSON.parse(buffer.toString('utf8'));
    const docs: any[] = raw.documents || raw;

    if (!Array.isArray(docs)) {
      throw new Error('فرمت JSON نامعتبر است. باید آرایه documents داشته باشد.');
    }

    const BATCH_SIZE = 500;
    let inserted = 0;
    let skipped = 0;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);
      const entities = batch
        .filter((doc) => doc.id || doc._id)
        .map((doc) => this.mapDocument(doc));

      try {
        const result = await this.repo
          .createQueryBuilder()
          .insert()
          .into(Content)
          .values(entities)
          .orIgnore()
          .execute();

        const batchInserted = result.identifiers?.length || 0;
        inserted += batchInserted;
        skipped += batch.length - batchInserted;
      } catch (err) {
        // Fallback: insert one by one
        for (const entity of entities) {
          try {
            await this.repo
              .createQueryBuilder()
              .insert()
              .into(Content)
              .values(entity)
              .orIgnore()
              .execute();
            inserted++;
          } catch {
            skipped++;
          }
        }
      }

      this.logger.log(
        `Import progress: ${Math.min(i + BATCH_SIZE, docs.length)}/${docs.length}`,
      );
    }

    return { inserted, skipped, total: docs.length };
  }

  private mapDocument(doc: any): Partial<Content> {
    return {
      id: String(doc.id || doc._id),
      text: doc.text || '',
      sourceType: doc.source || undefined,
      type: doc.type || undefined,
      screenName: doc.screen_name || undefined,
      userId: doc.user_id ? String(doc.user_id) : undefined,
      userFollowers: parseInt(doc['user.followers']) || 0,
      userFollowing: parseInt(doc['user.following']) || 0,
      userPostCount: parseInt(doc['user.post']) || 0,
      viewCount: parseInt(doc.view_count) || 0,
      likeCount: parseInt(doc.like_count) || 0,
      retweetCount: parseInt(doc.retweet_count) || 0,
      replyCount: parseInt(doc.reply_count) || 0,
      quoteCount: parseInt(doc.quote_count) || 0,
      bookmarkCount: parseInt(doc.bookmark_count) || 0,
      sentiment: normalizeSentiment(doc.Sentiment?.label) || undefined,
      sentimentScore: doc.Sentiment?.score || undefined,
      emotion: normalizeEmotion(doc.Emotion?.label) || undefined,
      emotionScore: doc.Emotion?.score || undefined,
      lang: doc.lang || undefined,
      publishedAt: parseDate(doc.published_at) || undefined,
      conversationId: doc.conversation_id ? String(doc.conversation_id) : undefined,
      inReplyToId: doc.in_reply_to_id ? String(doc.in_reply_to_id) : undefined,
      hashtags: doc.hashtags?.length > 0 ? doc.hashtags : undefined,
      userMentions: doc.user_mentions?.length > 0 ? doc.user_mentions : undefined,
    };
  }
}
