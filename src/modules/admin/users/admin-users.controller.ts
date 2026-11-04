import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { AdminUsersService } from './admin-users.service';
import { ApplyAccessDto, CreateUserDto, UpdateUserDto, ResetPasswordDto } from '../admin.dto';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { PERMISSIONS } from '../../auth/roles';

@Controller('admin/users')
@UseGuards(AuthGuard('jwt'), RolesGuard)
// client_admin is scoped to their own organisation/profiles inside the service.
@Roles(...PERMISSIONS['users.manage'])
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  /**
   * Optional filters: `q` (name / username / email, case-insensitive),
   * `role` (one role or a comma-separated list), `active` ('true' | 'false').
   */
  @Get()
  list(
    @Req() req: any,
    @Query('q') q?: string,
    @Query('role') role?: string,
    @Query('active') active?: string,
  ) {
    return this.service.list(req.user, { q, role, active });
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.service.get(id, req.user);
  }

  @Post()
  create(@Body() dto: CreateUserDto, @Req() req: any) {
    return this.service.create(dto, req.user);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @Req() req: any) {
    return this.service.update(id, dto, req.user);
  }

  @Post(':id/reset-password')
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
    @Req() req: any,
  ) {
    return this.service.resetPassword(id, dto.password, req.user);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.service.deactivate(id, req.user);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.service.remove(id, req.user);
  }
}

/** Permission matrix: which users (experts / viewers / client admins) can open which profiles. */
@Controller('admin/access')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(...PERMISSIONS['users.manage'])
export class AdminAccessController {
  constructor(private readonly service: AdminUsersService) {}

  @Get('matrix')
  matrix(@Req() req: any) {
    return this.service.accessMatrix(req.user);
  }

  @Put('matrix')
  apply(@Body() dto: ApplyAccessDto, @Req() req: any) {
    return this.service.applyAccess(dto, req.user);
  }
}
