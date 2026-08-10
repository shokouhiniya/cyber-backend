import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ContentService } from './content.service';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

@Controller('influencers')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin', 'client_admin', 'client_viewer')
export class InfluencersController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  getInfluencers(@Query('limit') limit: string | undefined, @CurrentProfile() profileId: string | null) {
    return this.contentService.getInfluencers(limit ? parseInt(limit, 10) : 10, profileId);
  }

  /**
   * Influencer map: top accounts by reach with sentiment-based stance classification.
   * Stance: ≥60% positive posts → supporter (موافق)
   *         ≥60% negative posts → critic (مخالف)
   *         otherwise           → neutral (خنثی)
   */
  @Get('map')
  getInfluencerMap(@Query('limit') limit: string | undefined, @CurrentProfile() profileId: string | null) {
    return this.contentService.getInfluencerMap(limit ? parseInt(limit, 10) : 20, profileId);
  }
}
