import { Injectable, NestMiddleware, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { NextFunction, Request, Response } from 'express';

import { Profile } from '../profile/profile.entity';
import { UserProfile } from '../user/user-profile.entity';
import { User } from '../user/user.entity';

/**
 * Resolves the profile the current request should be scoped to and
 * attaches it as `req.profileId`. Also decorates `req.user` with
 * role + accessibleProfileIds when a valid JWT is present.
 *
 * Resolution order:
 *   1. X-Profile-Id header (super_admin's view-as selection, verified for non-super-admins)
 *   2. ?profileId query param
 *   3. Authenticated user's only linked profile (client_admin / client_viewer)
 *   4. The sole active profile in the DB (v1 fallback — a single tenant system)
 *   5. null (routes that don't need scoping will ignore)
 *
 * We swallow auth errors here; the actual auth guard on the route decides
 * whether to reject.
 */
@Injectable()
export class ProfileScopeMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(Profile) private readonly profileRepo: Repository<Profile>,
    @InjectRepository(UserProfile) private readonly userProfileRepo: Repository<UserProfile>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  async use(req: Request & { user?: any; profileId?: string }, _res: Response, next: NextFunction) {
    await this.hydrateUser(req);

    const headerProfile = (req.headers['x-profile-id'] as string) || null;
    const queryProfile = (req.query.profileId as string) || null;
    const user = req.user as any;

    if (headerProfile) {
      if (user?.role === 'super_admin' || user?.accessibleProfileIds?.includes(headerProfile)) {
        req.profileId = headerProfile;
      } else if (user) {
        throw new ForbiddenException('به این پروفایل دسترسی ندارید');
      } else {
        // unauthenticated route: honor header without access check
        req.profileId = headerProfile;
      }
    } else if (queryProfile) {
      req.profileId = queryProfile;
    } else if (user?.accessibleProfileIds?.length === 1) {
      req.profileId = user.accessibleProfileIds[0];
    } else {
      // Fallback: only auto-scope if there's exactly one active profile.
      // With multiple profiles, leave profileId unset so queries return all data.
      const activeCount = await this.profileRepo.count({ where: { isActive: true } });
      if (activeCount === 1) {
        const active = await this.profileRepo.findOne({ where: { isActive: true } });
        if (active) req.profileId = active.id;
      }
    }

    next();
  }

  private async hydrateUser(req: Request & { user?: any }) {
    if (req.user) return;

    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return;

    const token = auth.substring(7);
    try {
      const jwtConfig = this.config.get('jwt');
      const payload: any = this.jwt.verify(token, {
        secret: jwtConfig?.secret || 'default-secret',
      });

      const accessibleProfileIds = await this.resolveAccessibleProfiles(payload.sub, payload.role);
      req.user = {
        sub: payload.sub,
        email: payload.email,
        role: payload.role,
        accessibleProfileIds,
      };
    } catch {
      // invalid token — leave req.user undefined
    }
  }

  private async resolveAccessibleProfiles(userId: string, role: string): Promise<string[]> {
    if (role === 'super_admin') return ['*'];
    const rows = await this.userProfileRepo.find({ where: { userId } });
    return rows.map((r) => r.profileId);
  }
}
