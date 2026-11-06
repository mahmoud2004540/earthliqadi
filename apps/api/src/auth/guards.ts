import {
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isStaffPermission, type Permission } from '@platform/shared';
import type { Request } from 'express';
import { BlockList, isIP } from 'node:net';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { ApiKeysService } from '../api-keys/api-keys.service';
import {
  API_KEY_SCOPE_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  STEP_UP_KEY,
} from '../common/decorators';
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
    // API-key requests carry no cookies and are signed per request; a browser
    // cannot attach these headers cross-site without a CORS preflight (none is allowed).
    if (req.headers['x-api-key'] !== undefined) return true;

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
    private readonly apiKeys: ApiKeysService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const keyId = req.headers['x-api-key'];
    if (keyId !== undefined) {
      const scope = this.reflector.get<'read' | 'trade' | undefined>(
        API_KEY_SCOPE_KEY,
        context.getHandler(),
      );
      if (!scope)
        throw new AppError(
          HttpStatus.FORBIDDEN,
          'API_KEY_NOT_ALLOWED',
          'This endpoint cannot be used with an API key',
        );
      const header = (name: string) => {
        const v = req.headers[name];
        return typeof v === 'string' ? v : '';
      };
      const raw = (req as Request & { rawBody?: Buffer }).rawBody;
      const { auth, scopes } = await this.apiKeys.authenticate({
        keyId: typeof keyId === 'string' ? keyId : '',
        timestamp: header('x-api-timestamp'),
        signature: header('x-api-signature'),
        method: req.method,
        pathWithQuery: req.originalUrl,
        body: raw ? raw.toString('utf8') : '',
        ip: req.ip,
      });
      if (!scopes.includes(scope))
        throw new AppError(
          HttpStatus.FORBIDDEN,
          'API_KEY_NOT_ALLOWED',
          `This endpoint needs an API key with the "${scope}" scope`,
        );
      req.auth = auth;
      return true;
    }
    const token = readCookie(req, cookieNames(this.config).session);
    const result = token ? await this.sessions.validate(token) : null;
    if (!result) throw AppError.unauthenticated();

    const { roles, permissions } = await this.rbac.rolesAndPermissionsFor(result.user.id);
    req.auth = {
      sessionId: result.session.id,
      stepUpAt: result.session.stepUpAt,
      user: result.user,
      roles,
      permissions,
    };
    return true;
  }
}

/**
 * Enforces @RequirePermissions(). Denials are audited. Staff permissions also
 * require MFA on the account (ADR-0012), so a stolen staff password alone is
 * not enough to use back-office capabilities.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    for (const cidr of config.ADMIN_IP_ALLOWLIST) {
      const [addr, bits] = cidr.split('/');
      const family = isIP(addr ?? '') === 6 ? 'ipv6' : 'ipv4';
      this.allowlist.addSubnet(addr!, Number(bits ?? (family === 'ipv6' ? 128 : 32)), family);
    }
  }

  private readonly allowlist = new BlockList();

  private ipAllowed(ip: string | undefined): boolean {
    if (this.config.ADMIN_IP_ALLOWLIST.length === 0) return true;
    if (!ip) return false;
    const plain = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    return this.allowlist.check(plain, isIP(plain) === 6 ? 'ipv6' : 'ipv4');
  }

  private async deny(
    req: Request,
    auth: NonNullable<Request['auth']>,
    code: 'MFA_REQUIRED' | 'STEP_UP_REQUIRED' | 'IP_NOT_ALLOWED',
    message: string,
  ): Promise<never> {
    await this.audit.recordSafe({
      action: 'rbac.access.denied',
      outcome: 'DENIED',
      actorType: 'USER',
      actorUserId: auth.user.id,
      targetType: 'route',
      targetId: `${req.method} ${req.path}`.slice(0, 128),
      context: requestContextFrom(req),
      metadata: { reason: code },
    });
    throw new AppError(HttpStatus.FORBIDDEN, code, message);
  }

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
    if (missing.length === 0) {
      const staff = required.some(isStaffPermission);
      if (staff && !this.ipAllowed(req.ip))
        await this.deny(
          req,
          auth,
          'IP_NOT_ALLOWED',
          'Staff access is not allowed from this network',
        );
      if (staff && this.config.STAFF_MFA_REQUIRED && auth.user.mfaEnabledAt === null)
        await this.deny(
          req,
          auth,
          'MFA_REQUIRED',
          'Staff access requires two-factor authentication on your account',
        );
      const stepUp =
        this.reflector.getAllAndOverride<unknown>(STEP_UP_KEY, [
          context.getHandler(),
          context.getClass(),
        ]) === true;
      // Accounts without MFA only reach here when STAFF_MFA_REQUIRED is off (local/ci).
      if (stepUp && auth.user.mfaEnabledAt !== null) {
        const fresh =
          auth.stepUpAt !== null &&
          Date.now() - auth.stepUpAt.getTime() <= this.config.STEP_UP_WINDOW_SECONDS * 1000;
        if (!fresh)
          await this.deny(
            req,
            auth,
            'STEP_UP_REQUIRED',
            'Confirm this action with a fresh authenticator code',
          );
      }
      return true;
    }

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
