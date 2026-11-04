import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AlertsController } from './alerts.controller';
import { AlertsScheduler } from './alerts.scheduler';
import { AlertsService } from './alerts.service';
import { BaleClient } from './bale.client';

@Module({
  imports: [AuthModule],
  controllers: [AlertsController],
  providers: [AlertsService, AlertsScheduler, BaleClient],
  exports: [AlertsService],
})
export class AlertsModule {}
