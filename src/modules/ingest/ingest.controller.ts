import { Controller, Post, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { IngestWorkerService } from './ingest-worker.service';
import { MacroContextService } from './macro-context.service';
import { TrendService } from './trend.service';
import { IngestRun } from './ingest-run.entity';
import { GlobalContext } from '../admin/global-context/global-context.entity';

@Controller('admin/ingest')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin')
export class IngestController {
  constructor(
    private readonly worker: IngestWorkerService,
    private readonly macroContext: MacroContextService,
    private readonly trend: TrendService,
    @InjectRepository(IngestRun)
    private readonly runRepo: Repository<IngestRun>,
    @InjectRepository(GlobalContext)
    private readonly contextRepo: Repository<GlobalContext>,
  ) {}

  /** Manually trigger ingest for a specific profile */
  @Post('profiles/:id/run')
  async runNow(@Param('id') id: string) {
    const run = await this.worker.runForProfile(id);
    return { runId: run.id, status: run.status, postsSelected: run.postsSelected };
  }

  /** List recent ingest runs for a profile */
  @Get('profiles/:id/runs')
  async listRuns(
    @Param('id') id: string,
    @Query('limit') limit = '10',
  ) {
    return this.runRepo.find({
      where: { profileId: id },
      order: { startedAt: 'DESC' },
      take: Math.min(parseInt(limit, 10) || 10, 50),
      select: ['id', 'status', 'startedAt', 'finishedAt', 'postsFetched', 'postsAfterDedup', 'postsSelected', 'errorMessage'],
    });
  }

  /** Get the latest ingest run for a profile */
  @Get('profiles/:id/runs/latest')
  async latestRun(@Param('id') id: string) {
    return this.runRepo.findOne({
      where: { profileId: id },
      order: { startedAt: 'DESC' },
    });
  }

  /** Get trend data for a profile */
  @Get('profiles/:id/trend')
  @Roles('super_admin', 'client_admin', 'client_viewer')
  async getTrend(
    @Param('id') id: string,
    @Query('hours') hours = '24',
  ) {
    return this.trend.getTrend(id, Math.min(parseInt(hours, 10) || 24, 168));
  }

  /**
   * Aggregates the 8tag `totalPerSource` values from ingest_runs.stats
   * for the current profile within the given time window.
   *
   * Returns the MAX total seen per source across all runs in the window —
   * this is the best proxy for "how many posts exist on 8tag for this profile
   * in this timeframe" without making a live API call.
   */
  @Get('source-totals')
  @Roles('super_admin', 'client_admin', 'client_viewer')
  async getSourceTotals(
    @CurrentProfile() profileId: string | null,
    @Query('since') since?: string,
  ) {
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 7 * 24 * 3600_000);

    const profileFilter = profileId ? `AND profile_id = '${profileId}'` : '';

    const rows = await this.runRepo.query(
      `SELECT
         source_key,
         MAX((stats->'totalPerSource'->source_key)::int) AS max_total,
         SUM((stats->'totalPerSource'->source_key)::int) AS sum_total,
         COUNT(*) AS run_count
       FROM ingest_runs,
            jsonb_object_keys(stats->'totalPerSource') AS source_key
       WHERE status = 'completed'
         AND started_at >= $1
         AND stats->'totalPerSource' IS NOT NULL
         ${profileFilter}
       GROUP BY source_key
       ORDER BY max_total DESC`,
      [sinceDate],
    );

    return rows.map((r: any) => ({
      source: r.source_key,
      total: parseInt(r.max_total) || 0,
      runCount: parseInt(r.run_count) || 0,
    }));
  }

  /** Manually trigger macro context generation */
  @Post('macro-context/generate')
  async generateMacroContext() {
    const result = await this.macroContext.generate();
    return { success: true, length: result.length };
  }

  /** Read the current macro political context (for the frontend widget) */
  @Get('macro-context')
  @Roles('super_admin', 'client_admin', 'client_viewer')
  async getMacroContext() {
    const today = await this.contextRepo.findOne({ where: { key: 'macro_political_context' } });
    const rolling = await this.contextRepo.findOne({ where: { key: 'macro_political_context_7d' } });
    return {
      today: today?.value || null,
      updatedAt: today?.updatedAt || null,
      rolling7d: rolling?.value || null,
    };
  }
}
