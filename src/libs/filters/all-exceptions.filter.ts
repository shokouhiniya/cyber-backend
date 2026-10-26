import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

export const INTERNAL_ERROR_MESSAGE = 'خطای داخلی سرور رخ داد. لطفاً دوباره تلاش کنید.';

/**
 * Global exception filter — the single place errors are turned into HTTP
 * responses. Clients always get `{ meta, error: { message, statusCode } }`;
 * query text, bound parameters and stack traces only go to the server log.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[];
    if (status >= 500 && (status === HttpStatus.INTERNAL_SERVER_ERROR || !(exception instanceof HttpException))) {
      // Unexpected failure: log everything, tell the client nothing specific
      const err = exception as any;
      const detail = [
        err?.message,
        err?.query ? `query=${err.query}` : null,
        err?.parameters ? `params=${JSON.stringify(err.parameters)}` : null,
      ].filter(Boolean).join(' | ');
      this.logger.error(`${req?.method} ${req?.originalUrl ?? req?.url} → ${status}: ${detail}`, err?.stack);
      message = INTERNAL_ERROR_MESSAGE;
    } else {
      // Intentional HttpException (4xx, or a deliberate 502/503 with our own message)
      const response = (exception as HttpException).getResponse();
      message = typeof response === 'string'
        ? response
        : (response as any)?.error?.message ?? (response as any)?.message ?? (exception as HttpException).message;
      if (status >= 500) {
        this.logger.warn(`${req?.method} ${req?.originalUrl ?? req?.url} → ${status}: ${message}`);
      }
    }

    if (res.headersSent) return;

    res.status(status).json({
      meta: { status, timestamp: new Date().toISOString() },
      error: { message, statusCode: status },
    });
  }
}
