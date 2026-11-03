import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../common/app-error';
import type { AuthContext } from './auth-context';

export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.auth) throw AppError.unauthenticated();
    return req.auth;
  },
);
