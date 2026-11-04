import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { roleSatisfies } from './roles';

/**
 * Checks that req.user.role is in the list declared via @Roles(...), directly
 * or through ROLE_INHERITS (client_expert passes wherever client_viewer does).
 * Use together with AuthGuard('jwt'): @UseGuards(AuthGuard('jwt'), RolesGuard).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest();
    const role = req.user?.role;

    if (!roleSatisfies(role, required)) {
      throw new ForbiddenException('دسترسی کافی ندارید');
    }
    return true;
  }
}
