import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Profile } from '../profile/profile.entity';
import { User } from '../user/user.entity';
import { UserProfile } from '../user/user-profile.entity';
import { Content } from '../content/content.entity';
import { DataSource } from '../data-source/data-source.entity';
import { IngestRun } from '../ingest/ingest-run.entity';

import { AuthModule } from '../auth/auth.module';
import { DataSourceModule } from '../data-source/data-source.module';

import { AdminProfilesService } from './profiles/admin-profiles.service';
import {
  AdminProfilesController,
  AccessibleProfilesController,
} from './profiles/admin-profiles.controller';
import { AdminUsersService } from './users/admin-users.service';
import { AdminUsersController } from './users/admin-users.controller';
import { AdminDataSourcesController } from './data-sources/admin-data-sources.controller';

import { GlobalContext } from './global-context/global-context.entity';
import { GlobalContextService } from './global-context/global-context.service';
import { GlobalContextController } from './global-context/global-context.controller';

import { AdminAuditLog } from './audit-log/admin-audit-log.entity';
import { AdminAuditLogService } from './audit-log/admin-audit-log.service';
import { AdminAuditLogController } from './audit-log/admin-audit-log.controller';
import { AdminAuditLogInterceptor } from './audit-log/admin-audit-log.interceptor';

import { UsageEvent } from './usage/usage-event.entity';
import { UsageService } from './usage/usage.service';
import {
  UsageReadController,
  UsageWriteController,
} from './usage/usage.controller';

@Module({
  imports: [
    AuthModule,
    DataSourceModule,
    TypeOrmModule.forFeature([
      Profile,
      User,
      UserProfile,
      Content,
      DataSource,
      GlobalContext,
      AdminAuditLog,
      UsageEvent,
      IngestRun,
    ]),
  ],
  controllers: [
    AdminProfilesController,
    AccessibleProfilesController,
    AdminUsersController,
    AdminDataSourcesController,
    GlobalContextController,
    AdminAuditLogController,
    UsageReadController,
    UsageWriteController,
  ],
  providers: [
    AdminProfilesService,
    AdminUsersService,
    GlobalContextService,
    AdminAuditLogService,
    UsageService,
    {
      provide: APP_INTERCEPTOR,
      useClass: AdminAuditLogInterceptor,
    },
  ],
  exports: [GlobalContextService, AdminAuditLogService],
})
export class AdminModule {}
