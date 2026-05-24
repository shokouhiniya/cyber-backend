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

@Controller('admin/global-context')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin')
export class GlobalContextController {
  constructor(private readonly service: GlobalContextService) {}

  @Get()
  list() {
    return this.service.list();
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
