import {
  Controller,
  Post,
  Get,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { IngestWorkerService } from './ingest-worker.service';
import { IngestRun } from './ingest-run.entity';

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
  private static readonly COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

  constructor(
    private readonly worker: IngestWorkerService,
    @InjectRepository(IngestRun)
    private readonly runRepo: Repository<IngestRun>,
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
    return { runId: run.id, status: run.status, postsSelected: run.postsSelected };
  }
}
