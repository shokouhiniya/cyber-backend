import { Controller, Get, Post, Query, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AiContentService } from './ai-content.service';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

@Controller('ai-content')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin', 'client_admin', 'client_viewer')
export class AiContentController {
  constructor(private readonly aiContent: AiContentService) {}

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
