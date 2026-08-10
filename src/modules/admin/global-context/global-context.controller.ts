import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { GlobalContextService } from './global-context.service';
import { UpsertContextDto } from '../admin.dto';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { DEFAULT_INGEST_SETTINGS } from '../../ingest/ingest-settings';

@Controller('admin/global-context')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin')
export class GlobalContextController {
  constructor(private readonly service: GlobalContextService) {}

  @Get()
  list() {
    return this.service.list();
  }

  /** Returns current ingest settings merged with defaults */
  @Get('ingest-settings')
  async getIngestSettings() {
    const row = await this.service.get('ingest_settings');
    const stored = row?.value ? JSON.parse(row.value) : {};
    return { ...DEFAULT_INGEST_SETTINGS, ...stored };
  }

  /** Save ingest settings */
  @Put('ingest-settings')
  async saveIngestSettings(@Body() body: Record<string, any>, @Req() req: any) {
    await this.service.upsert('ingest_settings', JSON.stringify(body), req.user.sub);
    return body;
  }

  @Get(':key')
  get(@Param('key') key: string) {
    return this.service.get(key);
  }

  @Put(':key')
  upsert(@Param('key') key: string, @Body() dto: UpsertContextDto, @Req() req: any) {
    return this.service.upsert(key, dto.value, req.user.sub);
  }

  @Delete(':key')
  remove(@Param('key') key: string) {
    return this.service.remove(key);
  }
}
