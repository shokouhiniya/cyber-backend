import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { UserService } from '../../user/user.service';
import { AuthSessionService } from '../auth-session.service';
import { OtpService, OTP_TTL_MS } from './otp.service';
import { OTP_LIMITS } from './otp-throttle';
import {
  OtpRequestDto,
  OtpSignInDto,
  PasswordForgotVerifyDto,
  PasswordResetDto,
  RefreshDto,
} from './otp.dto';

/**
 * Public endpoints for phone sign-in (SMS one-time code), password reset by
 * SMS and remember-me refresh. All under /api/auth.
 */
@Controller('auth')
export class OtpController {
  constructor(
    private readonly otp: OtpService,
    private readonly sessions: AuthSessionService,
    private readonly users: UserService,
  ) {}

  /** What the sign-in page may offer. SMS features are hidden when SMS is off. */
  @Get('capabilities')
  capabilities() {
    const sms = this.otp.enabled;
    return {
      otpLogin: sms,
      passwordReset: sms,
      rememberMe: true,
      rememberDays: this.sessions.rememberDays,
      otp: sms
        ? {
            codeLength: this.otp.codeLength,
            expiresInSeconds: OTP_TTL_MS / 1000,
            resendInSeconds: OTP_LIMITS.RESEND_COOLDOWN_MS / 1000,
          }
        : null,
    };
  }

  @Post('otp/request')
  @HttpCode(200)
  request(@Body() dto: OtpRequestDto, @Req() req: any) {
    return this.otp.request(dto.phone, dto.purpose, req.ip, ua(req));
  }

  @Post('otp/sign-in')
  @HttpCode(200)
  async signIn(@Body() dto: OtpSignInDto, @Req() req: any) {
    const user = await this.otp.verify(dto.phone, dto.code, 'login', req.ip, ua(req));
    return this.sessions.issue(user, !!dto.remember);
  }

  /** Step 2 of «فراموشی رمز»: exchanges a valid code for a 10-minute reset token. */
  @Post('password/forgot/verify')
  @HttpCode(200)
  async forgotVerify(@Body() dto: PasswordForgotVerifyDto, @Req() req: any) {
    const user = await this.otp.verify(dto.phone, dto.code, 'reset', req.ip, ua(req));
    return { resetToken: this.sessions.resetToken(user), expiresInSeconds: 600 };
  }

  /** Step 3: sets the new password. Revokes remembered sessions (password_changed_at trigger). */
  @Post('password/reset')
  @HttpCode(200)
  async reset(@Body() dto: PasswordResetDto, @Req() req: any) {
    const user = await this.sessions.userForResetToken(dto.resetToken);
    await this.users.update(user.id, { passwordHash: await bcrypt.hash(dto.newPassword, 10) });
    await this.otp.log('auth.password.reset', { userId: user.id, phone: user.phone ?? undefined, ip: req.ip, userAgent: ua(req) });
    return { success: true };
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.sessions.refresh(dto.refreshToken);
  }
}

const ua = (req: any): string | undefined => req.headers?.['user-agent'];
