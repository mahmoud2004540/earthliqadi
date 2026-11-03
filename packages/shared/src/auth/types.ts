export const USER_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ACCOUNT_TYPES = ['INDIVIDUAL', 'INSTITUTIONAL'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export interface CurrentUserDto {
  id: string;
  email: string;
  emailVerified: boolean;
  status: UserStatus;
  accountType: AccountType;
  locale: string;
  mfaEnabled: boolean;
  roles: string[];
  permissions: string[];
  createdAt: string;
}

export interface SessionDto {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export type LoginResultDto =
  | { status: 'authenticated'; user: CurrentUserDto }
  | { status: 'mfa_required'; challengeId: string; expiresInSeconds: number };
