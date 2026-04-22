import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from './data-source.entity';
import { DataSourceService } from './data-source.service';
import { DataSourceApiService } from './data-source-api.service';
import { DataSourceController } from './data-source.controller';

@Module({
  imports: [TypeOrmModule.forFeature([DataSource])],
  controllers: [DataSourceController],
  providers: [DataSourceService, DataSourceApiService],
  exports: [DataSourceService],
})
export class DataSourceModule {}
