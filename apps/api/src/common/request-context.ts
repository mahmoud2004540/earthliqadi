import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export function requestContextFrom(req: Request): RequestContext {
  const ua = req.headers['user-agent'];
  return {
    // req.ip honours the configured trust-proxy hop count.
    ipAddress: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
    requestId: typeof req.id === 'string' ? req.id : null,
  };
}

export const ReqContext = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  requestContextFrom(ctx.switchToHttp().getRequest<Request>()),
);
