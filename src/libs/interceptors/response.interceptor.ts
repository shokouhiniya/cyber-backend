import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler<any>,
  ): Observable<any> {
    // Errors are formatted by AllExceptionsFilter (src/libs/filters), which
    // also keeps query text / stack traces out of the response body.
    return next.handle().pipe(
      map((data) => {
        // Return the response in the desired format
        return {
          meta: {
            status: 'success',
            timestamp: this.formatDateTimeString(),
            // Add other meta fields if needed
          },
          data, // This will be the data returned from the controller
        };
      }),
    );
  }

  formatDateTimeString(date: Date | null = null): string {
    if (date === null) {
      date = new Date();
    }
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0'); // Month is zero-indexed
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }
}
