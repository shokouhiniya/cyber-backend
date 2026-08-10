import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { UserProfile } from '../user/user-profile.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectRepository(UserProfile)
    private readonly userProfileRepo: Repository<UserProfile>,
  ) {
    const jwtConfig = configService.get('jwt');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConfig?.secret || 'default-secret',
    });
  }

  async validate(payload: { sub: string; username: string; role: string }) {
    const accessibleProfileIds =
      payload.role === 'super_admin'
        ? ['*']
        : (await this.userProfileRepo.find({ where: { userId: payload.sub } })).map(
            (r) => r.profileId,
          );

    return {
      sub: payload.sub,
      username: payload.username,
      role: payload.role,
      accessibleProfileIds,
    };
  }
}
