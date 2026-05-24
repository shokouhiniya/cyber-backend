import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { AdminProfilesService } from './admin-profiles.service';
import { CreateProfileDto, UpdateProfileDto } from '../admin.dto';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';

@Controller('admin/profiles')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin')
export class AdminProfilesController {
  constructor(private readonly service: AdminProfilesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  create(@Body() dto: CreateProfileDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProfileDto) {
    return this.service.update(id, dto);
  }

  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return this.service.archive(id);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}

/** Unscoped helper endpoint — available to every authenticated user. */
@Controller('admin/accessible-profiles')
@UseGuards(AuthGuard('jwt'))
export class AccessibleProfilesController {
  constructor(private readonly service: AdminProfilesService) {}

  @Get()
  list(@Req() req: any) {
    return this.service.listAccessibleFor(req.user.sub, req.user.role);
  }
}
