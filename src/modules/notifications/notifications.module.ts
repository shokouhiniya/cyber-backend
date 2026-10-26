import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Notification } from './notification.entity';
import { AppEvents } from './app-events';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { StaleDataScheduler } from './stale-data.scheduler';

/**
 * Global so any module can inject AppEvents (to emit) or NotificationsService
 * (to notify directly) without importing this module.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Notification])],
  controllers: [NotificationsController],
  providers: [AppEvents, NotificationsService, StaleDataScheduler],
  exports: [AppEvents, NotificationsService],
})
export class NotificationsModule {}
