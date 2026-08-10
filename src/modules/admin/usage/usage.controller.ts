import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { UsageService } from './usage.service';
import { WriteUsageEventDto } from '../admin.dto';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { CurrentProfile } from '../../auth/current-profile.decorator';

/**
 * Write path — any authenticated user can record events from the frontend.
 */
@Controller('usage/events')
@UseGuards(AuthGuard('jwt'))
export class UsageWriteController {
  constructor(private readonly service: UsageService) {}

  @Post()
  record(
    @Body() dto: WriteUsageEventDto,
    @Req() req: any,
    @CurrentProfile() profileId: string | null,
  ) {
    return this.service.record({
      userId: req.user?.sub ?? undefined,
      profileId: profileId ?? undefined,
      eventType: dto.eventType,
      eventName: dto.eventName,
      metadata: dto.metadata,
    });
  }
}

/**
 * Read path — super_admin only. Aggregates for dashboards/rankings.
 */
@Controller('admin/usage')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin')
export class UsageReadController {
  constructor(private readonly service: UsageService) {}

  @Get('summary')
  summary(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('profileId') profileId?: string,
  ) {
    return this.service.summary(from, to, profileId || null);
  }

  @Get('profiles-ranking')
  profilesRanking(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.profilesRanking(from, to);
  }

  @Get('features-ranking')
  featuresRanking(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('profileId') profileId?: string,
  ) {
    return this.service.featuresRanking(from, to, profileId || null);
  }

  @Get('daily')
  daily(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('profileId') profileId?: string,
  ) {
    return this.service.daily(from, to, profileId || null);
  }

  /**
   * Per-user breakdown for a specific profile.
   * Returns each user's event count, last seen, and top features.
   */
  @Get('by-profile/:profileId')
  byProfile(
    @Param('profileId') profileId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.byProfile(profileId, from, to);
  }
}
