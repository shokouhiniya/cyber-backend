import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { DataSourceService } from '../../data-source/data-source.service';
import { CreateDataSourceDto, UpdateDataSourceDto } from '../admin.dto';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';

/**
 * Admin-scoped data-source management. Every source is attached to a profile;
 * super_admin can manage any source.
 */
@Controller('admin/data-sources')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin')
export class AdminDataSourcesController {
  constructor(private readonly service: DataSourceService) {}

  @Get()
  list(@Query('profileId') profileId?: string) {
    return profileId ? this.service.findByProfile(profileId) : this.service.findAll();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.getOrThrow(id);
  }

  @Post()
  create(@Body() dto: CreateDataSourceDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDataSourceDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post(':id/test')
  test(@Param('id') id: string, @Body() params: any) {
    // Dry-run: do not stamp last_fetch_at
    return this.service.testConnection(id, params);
  }

  @Post(':id/run-now')
  runNow(@Param('id') id: string, @Body() params: any) {
    return this.service.runNow(id, params);
  }

  @Post(':id/search')
  search(@Param('id') id: string, @Body() params: any) {
    return this.service.search(id, params);
  }

  @Post(':id/pages')
  listPages(@Param('id') id: string) {
    return this.service.listPages(id);
  }

  @Patch(':id/toggle')
  async toggle(@Param('id') id: string, @Body('isActive') isActive: boolean) {
    await this.service.toggleActive(id, isActive);
    return { id, isActive };
  }
}
