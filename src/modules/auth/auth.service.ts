import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

import { UserService } from '../user/user.service';
import { User } from '../user/user.entity';
import { SignInDto } from './auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
  ) {}

  async signIn(dto: SignInDto) {
    const user = await this.userService.findByUsername(dto.username);
    if (!user) {
      throw new UnauthorizedException('نام کاربری یا رمز عبور اشتباه است');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('حساب کاربری غیرفعال است');
    }

    const isMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('نام کاربری یا رمز عبور اشتباه است');
    }

    return { accessToken: this.generateToken(user) };
  }

  /**
   * Change the password of the currently authenticated user.
   * Requires the current password to match.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 6) {
      throw new UnauthorizedException('رمز عبور جدید باید حداقل ۶ کاراکتر باشد');
    }

    const user = await this.userService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('کاربر یافت نشد');
    }

    const isMatch = await bcrypt.compare(currentPassword || '', user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('رمز عبور فعلی صحیح نیست');
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await this.userService.update(user.id, { passwordHash: newHash });

    return { success: true };
  }

  async getMe(userId: string) {
    const user = await this.userService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('کاربر یافت نشد');
    }

    return {
      user: {
        id: user.id,
        displayName: user.name,
        username: user.username,
        email: user.email,
        role: user.role,
        organization: user.organization,
        avatar: user.avatar,
      },
    };
  }

  private generateToken(user: User): string {
    return this.jwtService.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
    });
  }
}
