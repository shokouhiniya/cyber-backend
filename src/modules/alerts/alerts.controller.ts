import { Body, Controller, Get, HttpCode, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsIn, IsOptional } from 'class-validator';

import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ALERT_EVENTS, ALERT_EVENT_LABELS, DEFAULT_ALERT_SETTINGS } from './alert-settings';
import { AlertsService } from './alerts.service';

class AlertTestDto {
  @IsOptional()
  @IsIn(['sms', 'bale', 'all'])
  channel?: 'sms' | 'bale' | 'all';
}

/** «هشدارهای خارج از سامانه» — super_admin only. */
@Controller('admin/alerts')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get('settings')
  async getSettings() {
    return {
      settings: await this.alerts.getSettings(),
      defaults: DEFAULT_ALERT_SETTINGS,
      events: ALERT_EVENTS.map((key) => ({ key, label: ALERT_EVENT_LABELS[key] })),
      channels: this.alerts.channelStatus(),
    };
  }

  /** Body is the whole settings object; validated/normalised by sanitizeAlertSettings. */
  @Put('settings')
  saveSettings(@Body() body: Record<string, any>, @Req() req: any) {
    return this.alerts.saveSettings(body, req.user?.sub);
  }

  @Post('test')
  @HttpCode(200)
  test(@Body() dto: AlertTestDto, @Req() req: any) {
    return this.alerts.sendTest(dto.channel ?? 'all', req.user?.username);
  }

  @Get('deliveries')
  deliveries(@Query('limit') limit?: string) {
    return this.alerts.recentDeliveries(Number(limit) || 30);
  }
}
