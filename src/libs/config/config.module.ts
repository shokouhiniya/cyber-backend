// libs/config/src/config.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import configuration from './configuration';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      load: [configuration], // 👈 load config functions
      envFilePath: '.env',
    }),
  ],
})
export class ConfigModule {}
