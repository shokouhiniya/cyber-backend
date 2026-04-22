import { Controller, Get, Post, Body, Param, Patch } from '@nestjs/common';
import { DataSourceService } from './data-source.service';
import { DataSource } from './data-source.entity';

@Controller('data-sources')
export class DataSourceController {
  constructor(private readonly dataSourceService: DataSourceService) {}

  @Get()
  async findAll(): Promise<DataSource[]> {
    return this.dataSourceService.findAll();
  }

  @Get('active')
  async findActive(): Promise<DataSource[]> {
    return this.dataSourceService.findActive();
  }

  @Get('type/:type')
  async findByType(@Param('type') type: string): Promise<DataSource[]> {
    return this.dataSourceService.findByType(type);
  }

  @Post()
  async create(@Body() data: Partial<DataSource>): Promise<DataSource> {
    return this.dataSourceService.create(data);
  }

  @Post(':id/test')
  async testConnection(
    @Param('id') id: string,
    @Body() params: any,
  ): Promise<any> {
    return this.dataSourceService.testConnection(id, params);
  }

  @Post(':id/pages')
  async listPages(
    @Param('id') id: string,
  ): Promise<any> {
    return this.dataSourceService.listPages(id);
  }

  @Patch(':id/toggle')
  async toggleActive(
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
  ): Promise<{ message: string }> {
    await this.dataSourceService.toggleActive(id, isActive);
    return { message: 'Data source updated successfully' };
  }
}
