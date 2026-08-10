import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Pulls the currently-scoped profile id from the request.
 * Populated by ProfileScopeMiddleware from either:
 *   - X-Profile-Id header (super_admin's view-as selection)
 *   - the authenticated user's only accessible profile
 *   - query param ?profileId=... (fallback for public/pre-auth routes)
 */
export const CurrentProfile = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const req = ctx.switchToHttp().getRequest();
    return req.profileId ?? null;
  },
);
