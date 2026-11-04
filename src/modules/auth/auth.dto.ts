import { IsBoolean, IsNotEmpty, IsOptional, MinLength } from 'class-validator';

export class SignInDto {
  @IsNotEmpty()
  username: string;

  @IsNotEmpty()
  @MinLength(6)
  password: string;

  /** «مرا به خاطر بسپار»: also return a long-lived refresh token. */
  @IsOptional()
  @IsBoolean()
  remember?: boolean;
}

export class ChangePasswordDto {
  @IsNotEmpty()
  currentPassword: string;

  @IsNotEmpty()
  @MinLength(6)
  newPassword: string;
}
