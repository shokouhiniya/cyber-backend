import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ContentService } from './content.service';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PostFilter, PostFilterQuery } from './post-filter';

@Controller('posts')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin', 'client_admin', 'client_viewer')
export class PostsController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  getPosts(
    @CurrentProfile() profileId: string | null,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('emotion') emotion?: string,
    @Query('keyword') keyword?: string,
    @Query('username') username?: string,
    @Query('source') source?: string,
    @PostFilterQuery() filter?: PostFilter,
  ) {
    return this.contentService.getPosts(
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
      emotion,
      keyword,
      username,
      filter,
      profileId,
      source,
    );
  }

  /** Posts published FROM the profile's official pages (not about them) */
  @Get('official')
  getOfficialPosts(
    @CurrentProfile() profileId: string | null,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('source') source?: string,
    @PostFilterQuery() filter?: PostFilter,
  ) {
    return this.contentService.getOfficialPosts(
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
      source,
      profileId,
      filter,
    );
  }

  /**
   * Weekly post count / views / likes / shares of the official pages,
   * Saturday–Friday (Tehran), oldest first. ?weeks=12 (1–52).
   */
  @Get('official/weekly')
  getOfficialWeekly(
    @CurrentProfile() profileId: string | null,
    @Query('weeks') weeks?: string,
    @PostFilterQuery() filter?: PostFilter,
  ) {
    return this.contentService.getOfficialWeekly(profileId, weeks, new Date(), filter?.platforms);
  }

  /** Latest post date per official channel — drives the «فعال» badge */
  @Get('official/status')
  getOfficialStatus(@CurrentProfile() profileId: string | null) {
    return this.contentService.getOfficialStatus(profileId);
  }

  /** Configured official accounts with status + reason (collecting / no_data / inactive) */
  @Get('official/accounts')
  getOfficialAccounts(@CurrentProfile() profileId: string | null) {
    return this.contentService.getOfficialAccounts(profileId);
  }

  @Get('categories')
  getCategoryStats(@CurrentProfile() profileId: string | null, @PostFilterQuery() filter?: PostFilter) {
    return this.contentService.getCategoryStats(profileId, filter);
  }
}
