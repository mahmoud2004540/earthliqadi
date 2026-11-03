import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@platform/shared';

export const IS_PUBLIC_KEY = 'auth:isPublic';
/** Route does not require an authenticated session. Everything else does by default. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'auth:permissions';
/** Route requires ALL listed permissions. */
export const RequirePermissions = (
  ...permissions: Permission[]
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSIONS_KEY, permissions);

export const AUTH_RATE_LIMIT_KEY = 'ratelimit:auth';
/** Applies the stricter authentication rate limit (credential stuffing / enumeration defence). */
export const AuthRateLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTH_RATE_LIMIT_KEY, true);
