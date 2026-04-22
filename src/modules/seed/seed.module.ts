import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from '../user/user.module';
import { DataSourceModule } from '../data-source/data-source.module';
import { ConfigModule } from '../../libs/config/config.module';
import { Content } from '../content/content.entity';
import { Profile } from '../profile/profile.entity';
import { SeedService } from './seed.service';

@Module({
  imports: [
    UserModule,
    DataSourceModule,
    ConfigModule,
    TypeOrmModule.forFeature([Content, Profile]),
  ],
  providers: [SeedService],
})
export class SeedModule {}
