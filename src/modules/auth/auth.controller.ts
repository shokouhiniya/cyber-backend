import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { SignInDto, ChangePasswordDto } from './auth.dto';

/**
 * Public sign-up is disabled — accounts are provisioned by a super_admin
 * through the admin panel (POST /api/admin/users).
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('sign-in')
  signIn(@Body() dto: SignInDto) {
    return this.authService.signIn(dto);
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  getMe(@Req() req: any) {
    return this.authService.getMe(req.user.sub);
  }

  @Post('change-password')
  @UseGuards(AuthGuard('jwt'))
  changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(req.user.sub, dto.currentPassword, dto.newPassword);
  }
}
