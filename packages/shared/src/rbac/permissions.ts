/**
 * RBAC catalogue — the single source of truth for permissions and the system
 * roles that bundle them. The API synchronises this catalogue into the
 * database at boot; administrators may only assign roles, never invent
 * permissions at runtime.
 *
 * There is deliberately no wildcard / "superuser" permission. Every privileged
 * capability must be named and auditable.
 */
export const PERMISSIONS = {
  ACCOUNT_SELF_READ: 'account:self:read',
  ACCOUNT_SELF_MANAGE: 'account:self:manage',
  USERS_READ: 'users:read',
  USERS_MANAGE_STATUS: 'users:manage-status',
  ROLES_READ: 'roles:read',
  ROLES_ASSIGN: 'roles:assign',
  AUDIT_READ: 'audit:read',
  KYC_REVIEW: 'kyc:review',
  AML_CASES_MANAGE: 'aml:cases:manage',
  WITHDRAWALS_REVIEW: 'withdrawals:review',
  MARKETS_CONFIGURE: 'markets:configure',
  FEES_CONFIGURE: 'fees:configure',
  SUPPORT_TICKETS_MANAGE: 'support:tickets:manage',
  REPORTS_READ: 'reports:read',
  OPERATIONS_EMERGENCY: 'operations:emergency',
  LEDGER_READ: 'ledger:read',
  LEDGER_RECONCILE: 'ledger:reconcile',
  ASSETS_CONFIGURE: 'assets:configure',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'account:self:read': 'Read own account, sessions and security settings',
  'account:self:manage': 'Manage own security settings, sessions and MFA',
  'users:read': 'View user accounts (no credentials or secrets)',
  'users:manage-status': 'Suspend or reactivate user accounts',
  'roles:read': 'View roles and permission assignments',
  'roles:assign': 'Grant or revoke roles for users',
  'audit:read': 'Read the audit log',
  'kyc:review': 'Review identity verification submissions',
  'aml:cases:manage': 'Open and manage AML investigation cases',
  'withdrawals:review': 'Approve or reject withdrawals requiring review',
  'markets:configure': 'Configure markets and trading parameters',
  'fees:configure': 'Configure fee schedules',
  'support:tickets:manage': 'Respond to and manage support tickets',
  'reports:read': 'Access operational and regulatory reports',
  'operations:emergency': 'Trigger emergency operational controls (e.g. halt trading)',
  'ledger:read': 'Read ledger accounts, journal entries and reconciliation results',
  'ledger:reconcile': 'Run a ledger reconciliation',
  'assets:configure': 'Create and enable/disable assets (listing decisions)',
};

export const ROLES = {
  USER: 'user',
  SUPPORT_AGENT: 'support_agent',
  COMPLIANCE_OFFICER: 'compliance_officer',
  RISK_OFFICER: 'risk_officer',
  AUDITOR: 'auditor',
  ADMINISTRATOR: 'administrator',
} as const;

export type RoleKey = (typeof ROLES)[keyof typeof ROLES];

export interface RoleDefinition {
  key: RoleKey;
  name: string;
  description: string;
  permissions: readonly Permission[];
  /** Staff roles are back-office roles and require MFA (enforced from Phase 7). */
  staff: boolean;
}

const P = PERMISSIONS;

export const SYSTEM_ROLES: readonly RoleDefinition[] = [
  {
    key: 'user',
    name: 'Customer',
    description: 'Default role for every registered customer',
    permissions: [P.ACCOUNT_SELF_READ, P.ACCOUNT_SELF_MANAGE],
    staff: false,
  },
  {
    key: 'support_agent',
    name: 'Support agent',
    description: 'Handles support tickets; read-only access to user profiles',
    permissions: [P.USERS_READ, P.SUPPORT_TICKETS_MANAGE],
    staff: true,
  },
  {
    key: 'compliance_officer',
    name: 'Compliance officer',
    description: 'KYC review, AML case management and withdrawal review',
    permissions: [
      P.USERS_READ,
      P.KYC_REVIEW,
      P.AML_CASES_MANAGE,
      P.WITHDRAWALS_REVIEW,
      P.REPORTS_READ,
      P.AUDIT_READ,
      P.LEDGER_READ,
    ],
    staff: true,
  },
  {
    key: 'risk_officer',
    name: 'Risk officer',
    description: 'Market and asset configuration, ledger oversight and emergency controls',
    permissions: [
      P.MARKETS_CONFIGURE,
      P.ASSETS_CONFIGURE,
      P.REPORTS_READ,
      P.OPERATIONS_EMERGENCY,
      P.LEDGER_READ,
      P.LEDGER_RECONCILE,
    ],
    staff: true,
  },
  {
    key: 'auditor',
    name: 'Auditor',
    description: 'Read-only access to the audit log, ledger and reports; may run reconciliations',
    permissions: [P.AUDIT_READ, P.REPORTS_READ, P.ROLES_READ, P.LEDGER_READ, P.LEDGER_RECONCILE],
    staff: true,
  },
  {
    key: 'administrator',
    name: 'Administrator',
    description:
      'User and role administration. Does not include compliance decisions or market risk controls.',
    permissions: [
      P.USERS_READ,
      P.USERS_MANAGE_STATUS,
      P.ROLES_READ,
      P.ROLES_ASSIGN,
      P.AUDIT_READ,
      P.FEES_CONFIGURE,
    ],
    staff: true,
  },
] as const;

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

export function permissionsForRoles(roleKeys: readonly string[]): Permission[] {
  const set = new Set<Permission>();
  for (const role of SYSTEM_ROLES) {
    if (roleKeys.includes(role.key)) role.permissions.forEach((p) => set.add(p));
  }
  return [...set].sort();
}

export function isRoleKey(value: string): value is RoleKey {
  return SYSTEM_ROLES.some((role) => role.key === value);
}
