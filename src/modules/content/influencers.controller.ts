import { Controller, Get, Query } from '@nestjs/common';
import { ContentService } from './content.service';

@Controller('influencers')
export class InfluencersController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  getInfluencers(@Query('limit') limit?: string) {
    return this.contentService.getInfluencers(limit ? parseInt(limit, 10) : 10);
  }
}
