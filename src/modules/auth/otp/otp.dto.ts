import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class OtpRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone: string;

  @IsIn(['login', 'reset'])
  purpose: 'login' | 'reset';
}

export class OtpSignInDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  code: string;

  @IsOptional()
  @IsBoolean()
  remember?: boolean;
}

export class PasswordForgotVerifyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  code: string;
}

export class PasswordResetDto {
  @IsString()
  @IsNotEmpty()
  resetToken: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  newPassword: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
