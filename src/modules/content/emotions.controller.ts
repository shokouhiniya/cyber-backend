import { Controller, Get } from '@nestjs/common';
import { ContentService } from './content.service';

@Controller('emotions')
export class EmotionsController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  getEmotions() {
    return this.contentService.getEmotions();
  }
}
