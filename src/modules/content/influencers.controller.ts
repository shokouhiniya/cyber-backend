import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ContentService } from './content.service';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PostFilter, PostFilterQuery } from './post-filter';

@Controller('influencers')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin', 'client_admin', 'client_viewer')
export class InfluencersController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  getInfluencers(
    @Query('limit') limit: string | undefined,
    @CurrentProfile() profileId: string | null,
    @PostFilterQuery() filter: PostFilter,
  ) {
    return this.contentService.getInfluencers(limit ? parseInt(limit, 10) : 10, profileId, filter);
  }

  /**
   * Influencer map: top accounts by reach with sentiment-based stance classification.
   * Stance: ≥60% positive posts → supporter (موافق)
   *         ≥60% negative posts → critic (مخالف)
   *         otherwise           → neutral (خنثی)
   */
  @Get('map')
  getInfluencerMap(
    @Query('limit') limit: string | undefined,
    @PostFilterQuery() filter: PostFilter,
    @CurrentProfile() profileId: string | null,
  ) {
    return this.contentService.getInfluencerMap(limit ? parseInt(limit, 10) : 20, profileId, filter);
  }

  /**
   * Top supporters / critics by stance toward the profile over the period
   * (used by the PDF reports). News outlets and official channels excluded.
   */
  @Get('stance')
  getStanceLeaders(
    @Query('limit') limit: string | undefined,
    @PostFilterQuery() filter: PostFilter,
    @CurrentProfile() profileId: string | null,
  ) {
    return this.contentService.getStanceLeaders(limit ? parseInt(limit, 10) : 6, profileId, filter);
  }
}
