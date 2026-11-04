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
import { PERMISSIONS } from '../../auth/roles';
import { AdminUsersService } from '../users/admin-users.service';
import { UserSessionsService } from './user-sessions.service';

/** Sign-out hook: the frontend calls it right before dropping the token. */
@Controller('usage/sessions')
@UseGuards(AuthGuard('jwt'))
export class UsageSessionController {
  constructor(private readonly sessions: UserSessionsService) {}

  @Post('end')
  end(@Req() req: any) {
    return this.sessions.end(req.user.sub);
  }
}

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
@Roles(...PERMISSIONS['usage.read'])
export class UsageReadController {
  constructor(
    private readonly service: UsageService,
    private readonly sessions: UserSessionsService,
    private readonly users: AdminUsersService,
  ) {}

  /**
   * Login sessions per user: count, total / average time, last login, last
   * logout, last seen. client_admin: only the users it manages (never super_admin).
   */
  @Get('sessions')
  async sessionReport(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userId', new ParseUUIDPipe({ optional: true })) userId?: string,
  ) {
    const ids = await this.users.visibleUserIds(req.user);
    return this.sessions.report({ from, to, userId }, ids);
  }

  /** The individual sessions behind the report (newest first, max 200). */
  @Get('sessions/list')
  async sessionList(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userId', new ParseUUIDPipe({ optional: true })) userId?: string,
  ) {
    const ids = await this.users.visibleUserIds(req.user);
    return this.sessions.list({ from, to, userId }, ids);
  }

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
