import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from './data-source.entity';
import { DataSourceService } from './data-source.service';
import { DataSourceApiService } from './data-source-api.service';

@Module({
  imports: [TypeOrmModule.forFeature([DataSource])],
  providers: [DataSourceService, DataSourceApiService],
  exports: [DataSourceService, DataSourceApiService],
})
export class DataSourceModule {}
