import type { AccountType, UserStatus } from '@prisma/client';
import type { Permission } from '@platform/shared';

/** Attached to `req.auth` by the session guard for authenticated requests. */
export interface AuthContext {
  sessionId: string;
  user: {
    id: string;
    email: string;
    status: UserStatus;
    accountType: AccountType;
    emailVerifiedAt: Date | null;
    mfaEnabledAt: Date | null;
    createdAt: Date;
  };
  roles: string[];
  permissions: Permission[];
}
