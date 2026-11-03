import type { CurrentUserDto } from '@platform/shared';
import type { AuthContext } from './auth-context';

export function toCurrentUserDto(
  user: AuthContext['user'],
  roles: string[],
  permissions: string[],
): CurrentUserDto {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    status: user.status,
    accountType: user.accountType,
    locale: user.locale,
    mfaEnabled: user.mfaEnabledAt !== null,
    roles,
    permissions,
    createdAt: user.createdAt.toISOString(),
  };
}
