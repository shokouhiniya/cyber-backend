import { Controller, Get, Query } from '@nestjs/common';
import { ContentService } from './content.service';

@Controller('posts')
export class PostsController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  getPosts(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('emotion') emotion?: string,
    @Query('keyword') keyword?: string,
    @Query('username') username?: string,
    @Query('since') since?: string,
  ) {
    return this.contentService.getPosts(
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
      emotion,
      keyword,
      username,
      since,
    );
  }

  @Get('categories')
  getCategoryStats() {
    return this.contentService.getCategoryStats();
  }
}
