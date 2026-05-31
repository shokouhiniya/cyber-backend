import { Controller, Get, Post, Query, Body, UseGuards, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiContentService, SampleOptions } from './ai-content.service';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Profile } from '../profile/profile.entity';
import { AdminAuditLogService } from '../admin/audit-log/admin-audit-log.service';

@Controller('ai-content')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin', 'client_admin', 'client_viewer')
export class AiContentController {
  private readonly logger = new Logger(AiContentController.name);

  constructor(
    private readonly aiContent: AiContentService,
    @InjectRepository(Profile)
    private readonly profileRepo: Repository<Profile>,
    private readonly auditLog: AdminAuditLogService,
  ) {}

  /**
   * Force-regenerate all AI sections for the current profile, bypassing the cache.
   * Runs synchronously so the caller knows when it's done.
   * Writes an entry to admin_audit_log for traceability.
   */
  @Post('regenerate-all')
  @Roles('super_admin', 'client_admin')
  async regenerateAll(
    @CurrentProfile() profileId: string | null = null,
    @Body() body?: { sources?: string[]; limit?: number; sortBy?: string },
  ) {
    if (!profileId) return { error: 'پروفایل مشخص نشده است' };

    const profile = await this.profileRepo.findOne({ where: { id: profileId } });
    if (!profile) return { error: 'پروفایل یافت نشد' };

    const orgId = profile.promticIdentifier?.external_id || profileId;

    // Build sample options from request body
    const sampleOpts: SampleOptions | undefined = (body?.sources || body?.limit || body?.sortBy) ? {
      sources: body?.sources?.length ? body.sources : undefined,
      limit: body?.limit ?? undefined,
      sortBy: (body?.sortBy as SampleOptions['sortBy']) ?? undefined,
    } : undefined;

    this.logger.log(`regenerate-all: starting for ${profile.name} (orgId=${orgId}, profileId=${profileId}, sampleOpts=${JSON.stringify(sampleOpts)})`);

    // Record the exact posts being sent to the prompts so the CSV export is faithful.
    const snapshotCount = await this.aiContent.recordSamplePostSnapshot(profileId, sampleOpts);
    this.logger.log(`regenerate-all: recorded sample snapshot of ${snapshotCount} posts`);

    const startedAt = new Date();
    const results: Record<string, string> = {};
    let errorCount = 0;

    // Run synchronously so we can report actual results
    const sections = ['ai_summary', 'macro_context', 'recommendations', 'narrative_gap'];
    for (const key of sections) {
      try {
        const methodMap: Record<string, () => Promise<any>> = {
          ai_summary:         () => this.aiContent.generateAiSummary(orgId, profileId, true, sampleOpts),
          macro_context:      () => this.aiContent.generateMacroContext(orgId, profileId, true, sampleOpts),
          recommendations:    () => this.aiContent.generateRecommendations(orgId, profileId, true, sampleOpts),
          narrative_gap:      () => this.aiContent.generateNarrativeGap(orgId, profileId, true, sampleOpts),
        };
        const result = await methodMap[key]();
        results[key] = result.meta?.cached ? 'cached (not refreshed)' : 'ok';
        this.logger.log(`regenerate-all: ${key} = ${results[key]}`);
      } catch (err) {
        results[key] = `error: ${err?.message}`;
        errorCount++;
        this.logger.error(`regenerate-all: ${key} failed — ${err?.message}`);
      }
    }

    const durationMs = Date.now() - startedAt.getTime();

    // Write to audit log
    await this.auditLog.write({
      profileId,
      action: 'ai-content.regenerate-all',
      entityType: 'ai_result_cache',
      entityId: profileId,
      diff: { orgId, results, durationMs, errorCount, sampleOpts },
    });

    this.logger.log(`regenerate-all: done for ${profile.name} in ${durationMs}ms, errors=${errorCount}`);

    return {
      status: errorCount === 0 ? 'completed' : 'partial',
      profile: profile.name,
      orgId,
      durationMs,
      results,
      errorCount,
    };
  }

  @Get('generate')
  async generateSection(
    @Query('section') section: string,
    @Query('org_id') orgId = 'ghalibaf',
    @CurrentProfile() profileId: string | null = null,
  ) {
    const generators: Record<string, () => Promise<{ text: string; meta: any }>> = {
      ai_summary:        () => this.aiContent.generateAiSummary(orgId, profileId),
      macro_context:     () => this.aiContent.generateMacroContext(orgId, profileId),
      recommendations:   () => this.aiContent.generateRecommendations(orgId, profileId),
      narrative_gap:     () => this.aiContent.generateNarrativeGap(orgId, profileId),
      political_spectrum:() => this.aiContent.generatePoliticalSpectrum(orgId, profileId),
    };

    if (!section || !generators[section]) {
      return { error: 'Invalid section. Available: ' + Object.keys(generators).join(', ') };
    }

    try {
      const result = await generators[section]();
      const raw = result.text || '';
      const trimmed = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      let llm_parsed: any = null;
      try { llm_parsed = JSON.parse(trimmed); } catch { llm_parsed = raw || null; }

      // Return in the shape the frontend expects: { section, debug: { llm_parsed } }
      // Kept for backward compat with useAiContent hook which reads aiData?.llm_parsed
      return { section, debug: { llm_parsed, error: null } };
    } catch (err) {
      return { section, debug: { llm_parsed: null, error: err.message } };
    }
  }

  @Post('generate-all')
  async generateAll(
    @Query('org_id') orgId = 'ghalibaf',
    @CurrentProfile() profileId: string | null = null,
  ) {
    const results = await this.aiContent.generateAll(orgId, profileId);
    const sections: Record<string, any> = {};

    for (const [key, result] of Object.entries(results)) {
      const raw = typeof result === 'object' && 'text' in result ? result.text : String(result);
      let llm_parsed: any = null;
      if (raw && !raw.startsWith('[ERROR]')) {
        const trimmed = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
        try { llm_parsed = JSON.parse(trimmed); } catch { llm_parsed = raw; }
      }
      sections[key] = { llm_parsed };
    }

    return { sections };
  }

  @Get('prompts')
  listPrompts() {
    return {
      prompts: [
        { section: 'ai_summary',        prompt_name: 'dashboard_ai_summary' },
        { section: 'macro_context',      prompt_name: 'macro_context_analysis' },
        { section: 'recommendations',    prompt_name: 'smart_recommendations' },
        { section: 'narrative_gap',      prompt_name: 'narrative_gap_analysis' },
        { section: 'political_spectrum', prompt_name: 'political_spectrum' },
        { section: 'scenario',           prompt_name: 'scenario_simulator' },
      ],
    };
  }

  /**
   * Scenario simulator — analyses a "what if" question for the current profile.
   * POST /api/ai-content/scenario
   * Body: { scenario: string, org_id?: string }
   */
  @Post('scenario')
  async analyseScenario(
    @Body('scenario') scenario: string,
    @Query('org_id') orgId = 'ghalibaf',
    @CurrentProfile() profileId: string | null = null,
  ) {
    if (!scenario?.trim()) {
      return { error: 'scenario is required' };
    }
    try {
      const result = await this.aiContent.generateScenario(scenario.trim(), orgId, profileId);
      const raw = result.text || '';
      const trimmed = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      let llm_parsed: any = null;
      try { llm_parsed = JSON.parse(trimmed); } catch { llm_parsed = { summary: raw }; }
      return { scenario, analysis: llm_parsed };
    } catch (err) {
      return { scenario, error: err.message };
    }
  }
}
