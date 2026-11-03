import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS } from '@platform/shared';
import type { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { testConfig } from '../test-utils';
import { CsrfService } from './csrf.service';
import { CsrfGuard, PermissionsGuard } from './guards';

function httpContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  const audit = { recordSafe: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;

  function guardRequiring(perms: string[] | undefined, staffMfa = true): PermissionsGuard {
    const reflector = { getAllAndOverride: () => perms } as unknown as Reflector;
    return new PermissionsGuard(reflector, audit, {
      ...testConfig(),
      STAFF_MFA_REQUIRED: staffMfa,
    });
  }

  const auth = (permissions: string[], mfa = true) => ({
    auth: {
      user: { id: 'u1', mfaEnabledAt: mfa ? new Date() : null },
      permissions,
      roles: [],
      sessionId: 's1',
    },
    method: 'GET',
    path: '/v1/admin/users',
    headers: {},
  });

  it('allows routes without permission metadata', async () => {
    await expect(guardRequiring(undefined).canActivate(httpContext(auth([])))).resolves.toBe(true);
  });

  it('allows when all required permissions are held', async () => {
    const guard = guardRequiring([PERMISSIONS.USERS_READ]);
    await expect(guard.canActivate(httpContext(auth([PERMISSIONS.USERS_READ])))).resolves.toBe(
      true,
    );
  });

  it('denies and audits when a permission is missing', async () => {
    const guard = guardRequiring([PERMISSIONS.USERS_READ, PERMISSIONS.AUDIT_READ]);
    await expect(
      guard.canActivate(httpContext(auth([PERMISSIONS.USERS_READ]))),
    ).rejects.toBeInstanceOf(AppError);
    expect(audit.recordSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rbac.access.denied',
        outcome: 'DENIED',
        metadata: { missing: ['audit:read'] },
      }),
    );
  });

  it('requires MFA on the account for staff permissions (not for customer permissions)', async () => {
    const staff = guardRequiring([PERMISSIONS.USERS_READ]);
    await expect(
      staff.canActivate(httpContext(auth([PERMISSIONS.USERS_READ], false))),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    const customer = guardRequiring([PERMISSIONS.TRADING_TRADE]);
    await expect(
      customer.canActivate(httpContext(auth([PERMISSIONS.TRADING_TRADE], false))),
    ).resolves.toBe(true);
    const relaxed = guardRequiring([PERMISSIONS.USERS_READ], false);
    await expect(
      relaxed.canActivate(httpContext(auth([PERMISSIONS.USERS_READ], false))),
    ).resolves.toBe(true);
  });

  it('rejects unauthenticated requests on protected routes', async () => {
    const guard = guardRequiring([PERMISSIONS.USERS_READ]);
    await expect(guard.canActivate(httpContext({ headers: {} }))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});

describe('CsrfGuard', () => {
  const config = testConfig();
  const csrf = new CsrfService(config);
  const guard = new CsrfGuard(csrf, config);
  const token = csrf.issue();

  it('lets safe methods through without a token', () => {
    expect(guard.canActivate(httpContext({ method: 'GET', headers: {}, cookies: {} }))).toBe(true);
  });

  it('accepts a valid double-submitted token', () => {
    const req = { method: 'POST', headers: { 'x-csrf-token': token }, cookies: { csrf: token } };
    expect(guard.canActivate(httpContext(req))).toBe(true);
  });

  it('rejects POST without a token', () => {
    expect(() =>
      guard.canActivate(httpContext({ method: 'POST', headers: {}, cookies: {} })),
    ).toThrow(AppError);
  });

  it('rejects a foreign Origin even with a valid token', () => {
    const req = {
      method: 'POST',
      headers: { 'x-csrf-token': token, origin: 'https://evil.invalid' },
      cookies: { csrf: token },
    };
    expect(() => guard.canActivate(httpContext(req))).toThrow(/Cross-origin/);
  });

  it('accepts the configured web origin', () => {
    const req = {
      method: 'DELETE',
      headers: { 'x-csrf-token': token, origin: 'http://localhost:3000' },
      cookies: { csrf: token },
    };
    expect(guard.canActivate(httpContext(req))).toBe(true);
  });
});
