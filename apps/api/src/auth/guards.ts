import {
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@platform/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from '../common/decorators';
import { requestContextFrom } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { RbacService } from '../rbac/rbac.service';
import { cookieNames } from './cookies';
import { CsrfService } from './csrf.service';
import { SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readCookie(req: Request, name: string): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[name];
  return typeof value === 'string' ? value : undefined;
}

/** Rejects cross-site state-changing requests (CSRF). Runs before authentication. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly csrf: CsrfService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    const origin = req.headers.origin;
    if (origin !== undefined && origin !== new URL(this.config.WEB_ORIGIN).origin) {
      throw new AppError(HttpStatus.FORBIDDEN, 'CSRF_INVALID', 'Cross-origin request rejected');
    }
    const header = req.headers['x-csrf-token'];
    const headerToken = typeof header === 'string' ? header : undefined;
    if (!this.csrf.isValid(headerToken, readCookie(req, cookieNames(this.config).csrf))) {
      throw new AppError(HttpStatus.FORBIDDEN, 'CSRF_INVALID', 'Missing or invalid CSRF token');
    }
    return true;
  }
}

/** Authenticates every route by session cookie unless marked @Public(). */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly rbac: RbacService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = readCookie(req, cookieNames(this.config).session);
    const result = token ? await this.sessions.validate(token) : null;
    if (!result) throw AppError.unauthenticated();

    const { roles, permissions } = await this.rbac.rolesAndPermissionsFor(result.user.id);
    req.auth = { sessionId: result.session.id, user: result.user, roles, permissions };
    return true;
  }
}

/** Enforces @RequirePermissions(). Denials are audited. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.auth;
    if (!auth) throw AppError.unauthenticated();

    const missing = required.filter((p) => !auth.permissions.includes(p));
    if (missing.length === 0) return true;

    await this.audit.recordSafe({
      action: 'rbac.access.denied',
      outcome: 'DENIED',
      actorType: 'USER',
      actorUserId: auth.user.id,
      targetType: 'route',
      targetId:
        `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`.slice(
          0,
          128,
        ),
      context: requestContextFrom(req),
      metadata: { missing },
    });
    throw AppError.forbidden();
  }
}
