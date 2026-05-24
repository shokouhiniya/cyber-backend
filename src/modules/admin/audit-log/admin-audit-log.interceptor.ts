import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

import { AdminAuditLogService } from './admin-audit-log.service';

/**
 * Writes an admin_audit_log row after any successful mutating request
 * under /admin/*. Read requests are skipped.
 *
 * The entry captures:
 *   - the acting user (req.user.sub)
 *   - the effective profile (req.profileId, if any)
 *   - action derived from METHOD + route path
 *   - entity id from the route param :id or :key
 *   - diff from the request body (credentials are redacted)
 *
 * Applied by attaching `@UseInterceptors(AdminAuditLogInterceptor)` on
 * admin controllers, or once in AdminModule via APP_INTERCEPTOR if we
 * want it everywhere. We do it at the module level — see admin.module.ts.
 */
@Injectable()
export class AdminAuditLogInterceptor implements NestInterceptor {
  constructor(private readonly audit: AdminAuditLogService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    const method = (req.method || '').toUpperCase();

    const url: string = req.originalUrl || req.url || '';
    const isAdminRoute = url.includes('/admin/');
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

    if (!isAdminRoute || !isMutation) {
      return next.handle();
    }

    return next.handle().pipe(
      tap(() => {
        const params = req.params || {};
        const body = req.body || {};
        const entityId = params.id || params.key || undefined;

        // Derive entity_type from the first path segment after /admin/
        const match = url.match(/\/admin\/([^/?]+)/);
        const entityType = match ? match[1] : undefined;

        const action = `${entityType ?? 'admin'}.${method.toLowerCase()}`;

        const safeBody = this.redact(body);

        this.audit.write({
          userId: req.user?.sub ?? undefined,
          profileId: req.profileId ?? body.profileId ?? undefined,
          action,
          entityType,
          entityId,
          diff: { body: safeBody, params },
          ip: this.clientIp(req),
          userAgent: req.headers?.['user-agent'],
        });
      }),
    );
  }

  private redact(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj;
    const out: any = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
      const lower = k.toLowerCase();
      if (['password', 'credentials', 'token', 'apikey', 'api_key', 'secret'].some((s) => lower.includes(s))) {
        out[k] = '[REDACTED]';
      } else if (v && typeof v === 'object') {
        out[k] = this.redact(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private clientIp(req: any): string | undefined {
    const fwd = req.headers?.['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress;
  }
}
