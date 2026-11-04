import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { hasProfileAccess } from './roles';

export const PROFILE_PARAM_KEY = 'profileParam';

/**
 * Names the route param holding the profile id that ProfileAccessGuard checks,
 * e.g. `@ProfileParam('id')` on `PATCH /admin/profiles/:id`.
 */
export const ProfileParam = (param: string) => SetMetadata(PROFILE_PARAM_KEY, param);

/**
 * Rejects the request unless the profile named by @ProfileParam is in
 * req.user.accessibleProfileIds (super_admin passes for every profile).
 * Runs after AuthGuard('jwt') and RolesGuard.
 */
@Injectable()
export class ProfileAccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const param = this.reflector.getAllAndOverride<string>(PROFILE_PARAM_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!param) return true;

    const req = ctx.switchToHttp().getRequest();
    const profileId = req.params?.[param];
    if (!profileId) return true;

    if (!hasProfileAccess(req.user, profileId)) {
      throw new ForbiddenException('به این شخصیت دسترسی ندارید');
    }
    return true;
  }
}
