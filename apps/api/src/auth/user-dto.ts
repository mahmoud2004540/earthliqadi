import type { CurrentUserDto } from '@platform/shared';
import type { AuthContext } from './auth-context';
import { toChecksumAddress } from './siwe';

export function toCurrentUserDto(
  user: AuthContext['user'],
  roles: string[],
  permissions: string[],
): CurrentUserDto {
  return {
    id: user.id,
    email: user.email,
    walletAddress: user.walletAddress ? toChecksumAddress(user.walletAddress) : null,
    emailVerified: user.emailVerifiedAt !== null,
    status: user.status,
    accountType: user.accountType,
    mfaEnabled: user.mfaEnabledAt !== null,
    roles,
    permissions,
    createdAt: user.createdAt.toISOString(),
  };
}
