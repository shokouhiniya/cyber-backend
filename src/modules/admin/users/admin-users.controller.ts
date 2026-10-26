import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { AdminUsersService } from './admin-users.service';
import { CreateUserDto, UpdateUserDto, ResetPasswordDto } from '../admin.dto';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';

@Controller('admin/users')
@UseGuards(AuthGuard('jwt'), RolesGuard)
// client_admin is scoped to their own organisation/profiles inside the service.
@Roles('super_admin', 'client_admin')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Get()
  list(@Req() req: any) {
    return this.service.list(req.user);
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
}
