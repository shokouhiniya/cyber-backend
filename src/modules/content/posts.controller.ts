import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ContentService } from './content.service';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

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
    @Query('since') since?: string,
    @Query('source') source?: string,
  ) {
    return this.contentService.getPosts(
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
      emotion,
      keyword,
      username,
      since,
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
  ) {
    return this.contentService.getOfficialPosts(
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
      source,
      profileId,
    );
  }

  @Get('categories')
  getCategoryStats(@CurrentProfile() profileId: string | null) {
    return this.contentService.getCategoryStats(profileId);
  }
}
