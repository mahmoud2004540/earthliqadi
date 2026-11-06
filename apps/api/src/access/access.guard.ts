import { SetMetadata, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '../common/app-error';
import { requestContextFrom } from '../common/request-context';
import { isReduceOnlyBody, type AccessKind, type ReduceOnlyShape } from './access-policy';
import { AccessService } from './access.service';

export const ACCESS_POLICY_KEY = 'access:policy';
export interface AccessPolicyMeta {
  kind: AccessKind;
  /** Body shape whose reduce-only orders stay allowed from restricted regions. */
  reduceOnly?: ReduceOnlyShape;
}

/**
 * Gates a route by the access policy (ADR-0022): sanctions, restricted
 * regions and terms acceptance. Routes without it (reads, cancels) are not gated.
 */
export const AccessPolicy = (kind: AccessKind, reduceOnly?: ReduceOnlyShape): MethodDecorator =>
  SetMetadata(ACCESS_POLICY_KEY, { kind, reduceOnly } satisfies AccessPolicyMeta);

/** Runs after authentication and permissions. */
@Injectable()
export class AccessPolicyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.get<AccessPolicyMeta | undefined>(
      ACCESS_POLICY_KEY,
      context.getHandler(),
    );
    if (!meta) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.auth) throw AppError.unauthenticated();
    await this.access.enforce(
      req.auth.user.id,
      meta.kind,
      this.access.locationOf(req),
      isReduceOnlyBody(meta.reduceOnly, req.body),
      requestContextFrom(req),
      `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`,
    );
    return true;
  }
}
