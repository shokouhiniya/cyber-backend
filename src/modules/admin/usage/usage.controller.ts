import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
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
 * Read path — super_admin sees everything; client_admin only the profiles they
 * can access (enforced in UsageService.resolveScope). Aggregates for dashboards/rankings.
 */
@Controller('admin/usage')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin', 'client_admin')
export class UsageReadController {
  constructor(private readonly service: UsageService) {}

  @Get('summary')
  summary(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('profileId') profileId?: string,
  ) {
    const s = this.service.resolveScope(req.user, profileId);
    return this.service.summary(from, to, s.profileId, s.scope);
  }

  @Get('profiles-ranking')
  profilesRanking(@Req() req: any, @Query('from') from?: string, @Query('to') to?: string) {
    const s = this.service.resolveScope(req.user);
    return this.service.profilesRanking(from, to, s.scope);
  }

  @Get('features-ranking')
  featuresRanking(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('profileId') profileId?: string,
  ) {
    const s = this.service.resolveScope(req.user, profileId);
    return this.service.featuresRanking(from, to, s.profileId, s.scope);
  }

  @Get('daily')
  daily(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('profileId') profileId?: string,
  ) {
    const s = this.service.resolveScope(req.user, profileId);
    return this.service.daily(from, to, s.profileId, s.scope);
  }

  /**
   * Per-user breakdown for a specific profile.
   * Returns each user's event count, last seen, and top features.
   */
  @Get('by-profile/:profileId')
  byProfile(
    @Req() req: any,
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const s = this.service.resolveScope(req.user, profileId);
    return this.service.byProfile(profileId, from, to, s.scope !== null);
  }
}
