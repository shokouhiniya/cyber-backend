import { Controller, Get, Query } from '@nestjs/common';
import { ContentService } from './content.service';

@Controller('stats')
export class StatsController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  getStats() {
    return this.contentService.getStats();
  }

  @Get('top-posts')
  getTopPosts(@Query('limit') limit?: string) {
    return this.contentService.getTopPosts(limit ? parseInt(limit, 10) : 5);
  }

  @Get('hashtags')
  getHashtagStats(@Query('limit') limit?: string) {
    return this.contentService.getHashtagStats(limit ? parseInt(limit, 10) : 10);
  }

  @Get('sources')
  getSourceStats() {
    return this.contentService.getSourceStats();
  }

  @Get('user-distribution')
  getUserDistribution() {
    return this.contentService.getUserDistribution();
  }
}
