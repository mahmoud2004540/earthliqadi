import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorCode } from '@platform/shared';

export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: { path: string; message: string }[],
  ) {
    super({ code, message, details }, status);
  }

  static unauthenticated(message = 'Authentication required'): AppError {
    return new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', message);
  }

  static forbidden(message = 'You do not have permission to perform this action'): AppError {
    return new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', message);
  }
}
