import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { ConfigModule } from './libs/config/config.module';
import { DatabaseModule } from './libs/database/database.module';
import { LoggerMiddleware } from './libs/logger/logger.middleware';
import { ResponseInterceptor } from './libs/interceptors/response.interceptor';
import { PromticModule } from './libs/promtic';

import { AuthModule } from './modules/auth/auth.module';
import { ProfileScopeMiddleware } from './modules/auth/profile-scope.middleware';
import { UserModule } from './modules/user/user.module';
import { ContentModule } from './modules/content/content.module';
import { ProfileModule } from './modules/profile/profile.module';
import { DataSourceModule } from './modules/data-source/data-source.module';
import { SeedModule } from './modules/seed/seed.module';
import { AdminModule } from './modules/admin/admin.module';
import { IngestModule } from './modules/ingest/ingest.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    PromticModule,
    AuthModule,
    UserModule,
    ContentModule,
    ProfileModule,
    DataSourceModule,
    AdminModule,
    IngestModule,
    SeedModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*');
    // Resolves profile scope for dashboard + admin-view routes.
    // Admin-CRUD routes under /admin/* don't need scoping; they operate cross-profile.
    consumer
      .apply(ProfileScopeMiddleware)
      .forRoutes(
        'stats',
        'stats/(.*)',
        'posts',
        'posts/(.*)',
        'emotions',
        'emotions/(.*)',
        'influencers',
        'influencers/(.*)',
        'ai-content',
        'ai-content/(.*)',
        'profile',
        'profile/(.*)',
        'ingest',
        'ingest/(.*)',
        'usage/events',
      );
  }
}
