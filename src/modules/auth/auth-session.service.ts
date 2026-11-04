import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { User } from '../user/user.entity';
import { UserService } from '../user/user.service';

export interface SessionTokens {
  accessToken: string;
  /** Only with «مرا به خاطر بسپار». Exchanged at POST /auth/refresh. */
  refreshToken?: string;
  refreshExpiresAt?: string;
}

export const DEFAULT_REMEMBER_DAYS = 30;
const RESET_TOKEN_TTL = '10m';

/**
 * Issues the access token (default JWT_EXPIRES_IN, e.g. 60m) and, for
 * remember-me, a long-lived refresh token.
 *
 * The refresh and password-reset tokens are signed with secrets derived from
 * JWT_SECRET, so the API's JWT guard (which uses JWT_SECRET itself) never
 * accepts them as access tokens. A refresh only succeeds while the account
 * is active and its password has not changed since the token was issued —
 * so a password change or reset (including an admin reset) revokes every
 * remembered session.
 */
@Injectable()
export class AuthSessionService {
  private readonly secret: string;
  readonly rememberDays: number;

  constructor(
    private readonly jwt: JwtService,
    private readonly users: UserService,
    config: ConfigService,
  ) {
    this.secret = config.get('jwt')?.secret || 'default-secret';
    const days = Number(config.get('AUTH_REMEMBER_DAYS'));
    this.rememberDays = days > 0 && days <= 90 ? Math.floor(days) : DEFAULT_REMEMBER_DAYS;
  }

  accessToken(user: User): string {
    return this.jwt.sign({ sub: user.id, username: user.username, role: user.role });
  }

  issue(user: User, remember = false): SessionTokens {
    const out: SessionTokens = { accessToken: this.accessToken(user) };
    if (remember) {
      out.refreshToken = this.jwt.sign(
        { sub: user.id, typ: 'refresh' },
        { secret: `${this.secret}::refresh`, expiresIn: `${this.rememberDays}d` },
      );
      out.refreshExpiresAt = new Date(Date.now() + this.rememberDays * 86_400_000).toISOString();
    }
    return out;
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string }> {
    const payload = this.verify(refreshToken, 'refresh');
    const user = await this.activeUserIssuedAfterPasswordChange(payload);
    return { accessToken: this.accessToken(user) };
  }

  resetToken(user: User): string {
    return this.jwt.sign(
      { sub: user.id, typ: 'pwreset' },
      { secret: `${this.secret}::pwreset`, expiresIn: RESET_TOKEN_TTL },
    );
  }

  /** Returns the user a reset token belongs to; single use (see class doc). */
  async userForResetToken(token: string): Promise<User> {
    const payload = this.verify(token, 'pwreset');
    return this.activeUserIssuedAfterPasswordChange(payload);
  }

  private verify(token: string, typ: 'refresh' | 'pwreset'): { sub: string; iat: number } {
    try {
      const payload = this.jwt.verify(String(token || ''), { secret: `${this.secret}::${typ}` });
      if (payload?.typ !== typ || !payload.sub) throw new Error('wrong type');
      return payload;
    } catch {
      throw new UnauthorizedException(
        typ === 'refresh' ? 'نشست منقضی شده است؛ دوباره وارد شوید' : 'مهلت تغییر رمز تمام شده است؛ دوباره کد بگیرید',
      );
    }
  }

  private async activeUserIssuedAfterPasswordChange(payload: { sub: string; iat: number }): Promise<User> {
    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive) throw new UnauthorizedException('حساب کاربری فعال نیست');
    // iat has second precision: reject tokens from before the change's second
    if (user.passwordChangedAt && new Date(user.passwordChangedAt).getTime() >= (payload.iat + 1) * 1000) {
      throw new UnauthorizedException('رمز عبور تغییر کرده است؛ دوباره وارد شوید');
    }
    return user;
  }
}
