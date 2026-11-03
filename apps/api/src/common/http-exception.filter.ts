import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ApiErrorBody, ApiErrorCode } from '@platform/shared';
import type { Request, Response } from 'express';
import { AppError } from './app-error';

const STATUS_CODES: Partial<Record<number, ApiErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Uniform error envelope. Never exposes stack traces or internal error
 * messages to clients; unexpected errors are logged server-side with the
 * request id so support can correlate.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = typeof req.id === 'string' ? req.id : undefined;

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ApiErrorBody['error'] = {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId,
    };

    if (exception instanceof AppError) {
      status = exception.getStatus();
      body = {
        code: exception.code,
        message: exception.message,
        requestId,
        details: exception.details,
      };
    } else if (exception instanceof ThrottlerException) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      body = { code: 'RATE_LIMITED', message: 'Too many requests, please slow down', requestId };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const code = STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED');
      // Framework exceptions (e.g. 404 route not found, malformed JSON) carry safe messages.
      const message = status >= 500 ? 'An unexpected error occurred' : exception.message;
      body = { code, message, requestId };
    }

    if (status >= 500) {
      this.logger.error(
        { err: exception, requestId },
        exception instanceof Error ? exception.message : 'Non-error exception thrown',
      );
    }

    if (body.details === undefined) delete body.details;
    res.status(status).json({ error: body } satisfies ApiErrorBody);
  }
}
