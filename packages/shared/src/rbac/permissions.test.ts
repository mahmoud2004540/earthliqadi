import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  PERMISSIONS,
  SYSTEM_ROLES,
  permissionsForRoles,
} from './permissions';

describe('RBAC catalogue', () => {
  it('describes every permission', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(PERMISSION_DESCRIPTIONS[permission]).toBeTruthy();
    }
  });

  it('only references known permissions in roles', () => {
    for (const role of SYSTEM_ROLES) {
      for (const permission of role.permissions) {
        expect(ALL_PERMISSIONS).toContain(permission);
      }
    }
  });

  it('has unique role keys', () => {
    const keys = SYSTEM_ROLES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has no role holding every permission (no superuser)', () => {
    for (const role of SYSTEM_ROLES) {
      expect(role.permissions.length).toBeLessThan(ALL_PERMISSIONS.length);
    }
  });

  it('separates role assignment from compliance decisions', () => {
    for (const role of SYSTEM_ROLES) {
      const p = role.permissions as readonly string[];
      const assignsRoles = p.includes(PERMISSIONS.ROLES_ASSIGN);
      const reviewsWithdrawals = p.includes(PERMISSIONS.WITHDRAWALS_REVIEW);
      expect(assignsRoles && reviewsWithdrawals).toBe(false);
    }
  });

  it('gives customers only self-service permissions', () => {
    expect(permissionsForRoles(['user'])).toEqual(['account:self:manage', 'account:self:read']);
  });

  it('ignores unknown role keys', () => {
    expect(permissionsForRoles(['nonexistent'])).toEqual([]);
  });
});
