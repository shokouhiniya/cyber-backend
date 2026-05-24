import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { AdminAuditLogService } from './admin-audit-log.service';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';

@Controller('admin/audit-log')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin')
export class AdminAuditLogController {
  constructor(private readonly service: AdminAuditLogService) {}

  @Get()
  list(
    @Query('userId') userId?: string,
    @Query('profileId') profileId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.list({
      userId,
      profileId,
      action,
      from,
      to,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }
}
