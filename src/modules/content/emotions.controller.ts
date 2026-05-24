import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ContentService } from './content.service';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

@Controller('emotions')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin', 'client_admin', 'client_viewer')
export class EmotionsController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  getEmotions(
    @CurrentProfile() profileId: string | null,
    @Query('since') since?: string,
  ) {
    return this.contentService.getEmotions(profileId, since);
  }
}
