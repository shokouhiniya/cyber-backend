import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Observable, tap } from 'rxjs';

import { UserSessionsService } from './user-sessions.service';

/** Sign-out endpoint; must not re-open the session it just closed. */
const END_PATH = /\/usage\/sessions\/end(?:$|\?)/;
/** Any successful POST under /auth/ that returns an access token is a sign-in (password or OTP)… */
const AUTH_PATH = /\/auth\//;
/** …except a token refresh (remember-me / auto-refresh), which is activity in the same session. */
const REFRESH_PATH = /\/auth\/refresh(?:$|\?)/;

/**
 * Global interceptor feeding user_sessions without touching the auth code:
 *   - a successful sign-in response (accessToken in the body) opens a session;
 *   - a token refresh, and every other authenticated request, counts as
 *     activity (throttled to about once a minute in the service).
 */
@Injectable()
export class SessionTrackingInterceptor implements NestInterceptor {
  constructor(
    private readonly sessions: UserSessionsService,
    private readonly jwt: JwtService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest();
    const url: string = req.originalUrl || req.url || '';
    const method = (req.method || '').toUpperCase();

    if (method === 'POST' && AUTH_PATH.test(url)) {
      const isRefresh = REFRESH_PATH.test(url);
      return next.handle().pipe(
        tap((body) => {
          const sub = this.subjectOf(body);
          if (!sub) return;
          if (isRefresh) void this.sessions.touch(sub, this.client(req));
          else this.sessions.start(sub, this.client(req)).catch(() => undefined);
        }),
      );
    }

    const userId = req.user?.sub;
    if (userId && !END_PATH.test(url)) {
      void this.sessions.touch(userId, this.client(req));
    }
    return next.handle();
  }

  /** User id from an auth response: the raw result, or one wrapped as { meta, data }. */
  private subjectOf(body: any): string | null {
    const token = body?.accessToken ?? body?.data?.accessToken;
    if (typeof token !== 'string') return null;
    return (this.jwt.decode(token) as any)?.sub ?? null;
  }

  private client(req: any) {
    const fwd = req.headers?.['x-forwarded-for'];
    const ip = typeof fwd === 'string' && fwd ? fwd.split(',')[0].trim() : req.ip;
    return { ip: ip ?? null, userAgent: req.headers?.['user-agent'] ?? null };
  }
}
