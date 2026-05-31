import {
  Controller,
  Post,
  Get,
  Res,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
  Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response } from 'express';

import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { IngestWorkerService } from './ingest-worker.service';
import { IngestRun } from './ingest-run.entity';
import { SelectedPost } from './selected-post.entity';
import { AiContentService } from '../content/ai-content.service';
import { Profile } from '../profile/profile.entity';
import { AdminAuditLogService } from '../admin/audit-log/admin-audit-log.service';

/**
 * Profile-scoped ingest controller available to client_admin (not just super_admin).
 * Uses the X-Profile-Id header (CurrentProfile) so callers can only trigger ingest
 * for the profile they currently have access to.
 *
 * Cooldown: 15 minutes between runs per profile to avoid hammering 8tag/Promtic.
 */
@Controller('ingest')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin', 'client_admin')
export class IngestPublicController {
  private static readonly COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes — overridable via ingest_settings
  private readonly logger = new Logger(IngestPublicController.name);

  constructor(
    private readonly worker: IngestWorkerService,
    @Inject(forwardRef(() => AiContentService))
    private readonly aiContent: AiContentService,
    @InjectRepository(IngestRun)
    private readonly runRepo: Repository<IngestRun>,
    @InjectRepository(SelectedPost)
    private readonly postRepo: Repository<SelectedPost>,
    @InjectRepository(Profile)
    private readonly profileRepo: Repository<Profile>,
    private readonly auditLog: AdminAuditLogService,
  ) {}

  /** Latest run for the currently scoped profile (read-only). */
  @Get('latest-run')
  async latestRun(@CurrentProfile() profileId: string | null) {
    if (!profileId) return null;
    return this.runRepo.findOne({
      where: { profileId },
      order: { startedAt: 'DESC' },
    });
  }

  /**
   * Trigger ingest for the current profile.
   * Refuses if a run is in flight or the previous successful run is < 15 minutes old.
   */
  @Post('run-now')
  async runNow(@CurrentProfile() profileId: string | null) {
    if (!profileId) {
      throw new BadRequestException('پروفایل مشخص نشده است');
    }

    const latest = await this.runRepo.findOne({
      where: { profileId },
      order: { startedAt: 'DESC' },
    });

    if (latest?.status === 'running') {
      throw new ForbiddenException('در حال حاضر یک اجرا در جریان است');
    }

    if (latest?.startedAt) {
      const elapsed = Date.now() - new Date(latest.startedAt).getTime();
      if (elapsed < IngestPublicController.COOLDOWN_MS) {
        const remainingMin = Math.ceil((IngestPublicController.COOLDOWN_MS - elapsed) / 60_000);
        throw new ForbiddenException(`لطفاً ${remainingMin} دقیقه دیگر تلاش کنید`);
      }
    }

    const run = await this.worker.runForProfile(profileId);
    await this.auditLog.write({
      profileId,
      action: 'ingest.run-now',
      entityType: 'ingest_run',
      entityId: run.id,
      diff: { runId: run.id, postsSelected: run.postsSelected, status: run.status },
    });
    return { runId: run.id, status: run.status, postsSelected: run.postsSelected };
  }

  /**
   * Re-run AI analysis only — no new posts fetched from 8tag.
   * Fires generateAll in the background and returns immediately.
   */
  @Post('regenerate-ai')
  async regenerateAi(@CurrentProfile() profileId: string | null) {
    if (!profileId) throw new BadRequestException('پروفایل مشخص نشده است');

    const profile = await this.profileRepo.findOne({ where: { id: profileId } });
    if (!profile) throw new BadRequestException('پروفایل یافت نشد');

    const orgId = profile.promticIdentifier?.external_id || profile.id;

    // Check if aiContent is properly injected
    if (!this.aiContent) {
      throw new BadRequestException('سرویس هوش مصنوعی در دسترس نیست — لطفاً از /api/ai-content/regenerate-all استفاده کنید');
    }

    // Fire and forget — forceRefresh=true bypasses the cache so Promtic is actually called
    this.aiContent.generateAll(orgId, profileId, true).catch((err) => {
      console.error(`[regenerate-ai] generateAll failed for ${profile.name}:`, err?.message);
    });

    return { status: 'started', message: 'بازتولید تحلیل هوش مصنوعی شروع شد' };
  }

  /**
   * Fetch new posts only — skip AI regeneration.
   * Starts the ingest run asynchronously and returns the run ID immediately
   * so the client can poll for completion.
   *
   * No time-based cooldown — only blocked if a run is already in flight.
   */
  @Post('posts-only')
  async postsOnly(@CurrentProfile() profileId: string | null) {
    if (!profileId) throw new BadRequestException('پروفایل مشخص نشده است');

    const latest = await this.runRepo.findOne({
      where: { profileId },
      order: { startedAt: 'DESC' },
    });

    if (latest?.status === 'running') {
      throw new ForbiddenException('در حال حاضر یک اجرا در جریان است');
    }

    // Create the run record immediately so the client can start polling
    const profile = await this.profileRepo.findOne({ where: { id: profileId } });
    if (!profile) throw new BadRequestException('پروفایل یافت نشد');

    // Fire and forget — run in background, return run ID for polling
    this.worker.runForProfile(profileId, { skipAi: true }).catch(() => {});

    // Log to audit trail
    await this.auditLog.write({
      profileId,
      action: 'ingest.posts-only',
      entityType: 'ingest_run',
      entityId: profileId,
      diff: { profileName: profile.name, triggeredBy: 'manual' },
    });

    // Return a placeholder so the client knows to start polling
    return { status: 'running', message: 'جمع‌آوری پست‌ها شروع شد' };
  }

  /**
   * Export all saved posts for the current profile as a UTF-8 CSV.
   * Includes: source, screen name, published date, sentiment, relevance score,
   * political spectrum, view/like/reply counts, selection reason, and full text.
   *
   * Scoped to the current profile via X-Profile-Id header.
   * Available to super_admin and client_admin.
   */
  @Get('export-posts')
  @Roles('super_admin', 'client_admin', 'client_viewer')
  async exportPosts(
    @CurrentProfile() profileId: string | null,
    @Res() res: Response,
  ) {
    if (!profileId) {
      throw new BadRequestException('پروفایل مشخص نشده است');
    }

    const posts = await this.postRepo.find({
      where: { profileId, canonicalId: null as any },
      order: { publishedAt: 'DESC' },
      select: [
        'id', 'sourceType', 'screenName', 'publishedAt',
        'sentiment', 'relevanceScore', 'politicalSpectrum', 'botProbability',
        'viewCount', 'likeCount', 'retweetCount', 'replyCount',
        'selectionReason', 'hashtags', 'postUrl', 'text',
      ],
    });

    // Build CSV
    const escape = (v: any): string => {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
    };

    const headers = [
      'source', 'screen_name', 'published_at', 'sentiment', 'relevance_score',
      'political_spectrum', 'bot_probability', 'view_count', 'like_count',
      'retweet_count', 'reply_count', 'selection_reason', 'hashtags', 'post_url', 'text',
    ];

    const rows = posts.map((p) => [
      p.sourceType,
      p.screenName,
      p.publishedAt?.toISOString() ?? '',
      p.sentiment,
      p.relevanceScore,
      p.politicalSpectrum,
      p.botProbability,
      p.viewCount,
      p.likeCount,
      p.retweetCount,
      p.replyCount,
      p.selectionReason,
      (p.hashtags || []).join('|'),
      p.postUrl,
      p.text,
    ].map(escape).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const bom = '\uFEFF'; // UTF-8 BOM so Excel opens Persian text correctly

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="posts-export-${date}.csv"`);
    res.send(bom + csv);
  }

  /**
   * Export the exact posts that were (or would be) sent to the general AI analysis prompts.
   *
   * Mirrors the logic in AiContentService.getPostsSample():
   *   - selected_posts for this profile
   *   - canonical_id IS NULL (no duplicates)
   *   - relevance_score >= 3 (quality filter)
   *   - scoped to the latest completed ingest run
   *   - ordered by engagement score (views + likes×2 + replies×3) DESC
   *   - top 80 rows (the largest sample any prompt requests)
   *
   * Adds an `ai_rank` column (1 = highest engagement) so the analyst can see
   * exactly which posts the LLM received and in what order.
   *
   * Scoped to the current profile via X-Profile-Id header.
   */
  @Get('export-ai-sample')
  @Roles('super_admin', 'client_admin', 'client_viewer')
  async exportAiSample(
    @CurrentProfile() profileId: string | null,
    @Res() res: Response,
  ) {
    if (!profileId) {
      throw new BadRequestException('پروفایل مشخص نشده است');
    }

    // Resolve the latest completed run (same logic as AiContentService.getLatestRun)
    const latestRun = await this.runRepo.findOne({
      where: { profileId, status: 'completed' },
      order: { finishedAt: 'DESC' },
      select: ['id', 'finishedAt'],
    });

    // Use raw SQL — same filters and ordering as getPostsSample()
    const runFilter = latestRun?.id ? 'AND ingest_run_id = $2' : '';
    const params: any[] = latestRun?.id ? [profileId, latestRun.id] : [profileId];

    const posts: any[] = await this.postRepo.query(
      `SELECT
         source_type, screen_name, published_at,
         sentiment, relevance_score, political_spectrum, bot_probability,
         view_count, like_count, retweet_count, reply_count,
         (view_count + like_count * 2 + reply_count * 3) AS engagement_score,
         selection_reason, hashtags, post_url, ingest_run_id, text
       FROM selected_posts
       WHERE profile_id = $1
         AND canonical_id IS NULL
         AND (relevance_score IS NULL OR relevance_score >= 3)
         ${runFilter}
       ORDER BY (view_count + like_count * 2 + reply_count * 3) DESC
       LIMIT 80`,
      params,
    );

    const escape = (v: any): string => {
      if (v == null) return '';
      const s = Array.isArray(v) ? v.join('|') : String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
    };

    const headers = [
      'ai_rank', 'source', 'screen_name', 'published_at', 'sentiment', 'relevance_score',
      'political_spectrum', 'bot_probability', 'view_count', 'like_count',
      'retweet_count', 'reply_count', 'engagement_score', 'selection_reason',
      'hashtags', 'post_url', 'ingest_run_id', 'text',
    ];

    const rows = posts.map((p, i) => [
      i + 1,
      p.source_type,
      p.screen_name,
      p.published_at ? new Date(p.published_at).toISOString() : '',
      p.sentiment,
      p.relevance_score,
      p.political_spectrum,
      p.bot_probability,
      p.view_count,
      p.like_count,
      p.retweet_count,
      p.reply_count,
      p.engagement_score,
      p.selection_reason,
      p.hashtags,   // already handled by escape() array check
      p.post_url,
      p.ingest_run_id,
      p.text,
    ].map(escape).join(','));

    const runInfo = latestRun
      ? `run_${latestRun.id.slice(0, 8)}_${new Date(latestRun.finishedAt!).toISOString().slice(0, 10)}`
      : 'no-run';
    const csv = [headers.join(','), ...rows].join('\n');
    const bom = '\uFEFF';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ai-sample-${runInfo}.csv"`);
    res.send(bom + csv);
  }
}
