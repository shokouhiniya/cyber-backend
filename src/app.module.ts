import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { ConfigModule } from './libs/config/config.module';
import { DatabaseModule } from './libs/database/database.module';
import { LoggerMiddleware } from './libs/logger/logger.middleware';
import { ResponseInterceptor } from './libs/interceptors/response.interceptor';

import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { ContentModule } from './modules/content/content.module';
import { ProfileModule } from './modules/profile/profile.module';
import { DataSourceModule } from './modules/data-source/data-source.module';
import { SeedModule } from './modules/seed/seed.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    UserModule,
    ContentModule,
    ProfileModule,
    DataSourceModule,
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
  }
}
