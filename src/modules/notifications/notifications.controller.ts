import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(AuthGuard('jwt'))
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  /** GET /api/notifications?unread=true&limit=20&offset=0 */
  @Get()
  list(
    @Req() req: any,
    @Query('unread') unread?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.list(req.user, {
      unread: unread === 'true' || unread === '1',
      limit: Number(limit),
      offset: Number(offset),
    });
  }

  @Post('read-all')
  readAll(@Req() req: any) {
    return this.service.markAllRead(req.user);
  }

  @Post(':id/read')
  read(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.markRead(req.user, id);
  }
}
