import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserModule } from '../user/user.module';
import { UserProfile } from '../user/user-profile.entity';
import { Profile } from '../profile/profile.entity';
import { User } from '../user/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { ProfileScopeMiddleware } from './profile-scope.middleware';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [
    UserModule,
    PassportModule,
    TypeOrmModule.forFeature([UserProfile, Profile, User]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const jwtConfig = config.get('jwt');
        return {
          secret: jwtConfig?.secret || 'default-secret',
          signOptions: { expiresIn: jwtConfig?.expiresIn || '3d' },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, ProfileScopeMiddleware, RolesGuard],
  exports: [AuthService, ProfileScopeMiddleware, RolesGuard, JwtModule, TypeOrmModule],
})
export class AuthModule {}
