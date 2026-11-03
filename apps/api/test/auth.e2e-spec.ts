import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { base32Decode, hotp, timeStep } from '../src/security/totp';
import {
  PASSWORD,
  TestClient,
  bootApp,
  createVerifiedUser,
  lastMailTo,
  mails,
  tokenFromMail,
  uniqueEmail,
} from './helpers';

let app: INestApplication;
let prisma: PrismaService;

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

describe('health', () => {
  it('reports liveness without dependency checks', async () => {
    const res = await new TestClient(app).get('/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reports readiness of database and redis', async () => {
    const res = await new TestClient(app).get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });
});

describe('HTTP hardening', () => {
  it('sets security headers and hides the framework', async () => {
    const res = await new TestClient(app).get('/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await new TestClient(app).get('/v1/does-not-exist').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('rejects malformed JSON without leaking a stack trace', async () => {
    const client = new TestClient(app);
    const token = await client.csrf();
    const res = await client.agent
      .post('/v1/auth/login')
      .set('X-Forwarded-For', client.ip)
      .set('X-CSRF-Token', token)
      .set('Content-Type', 'application/json')
      .send('{"email": broken');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|node_modules/);
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without a CSRF token', async () => {
    const client = new TestClient(app);
    const res = await client.agent
      .post('/v1/auth/login')
      .set('X-Forwarded-For', client.ip)
      .send({ email: 'a@b.co', password: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('issues the CSRF cookie as httpOnly + SameSite=Strict', async () => {
    const res = await new TestClient(app).get('/v1/auth/csrf').expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('csrf='),
    );
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });
});

describe('registration and email verification', () => {
  it('validates input with field-level details', async () => {
    const res = await new TestClient(app).post('/v1/auth/register', {
      email: 'nope',
      password: 'short',
      acceptTerms: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['email', 'password']),
    );
  });

  it('responds identically for new and existing emails (no enumeration)', async () => {
    const email = uniqueEmail();
    const client = new TestClient(app);
    const first = await client.post('/v1/auth/register', {
      email,
      password: PASSWORD,
      acceptTerms: true,
    });
    const second = await client.post('/v1/auth/register', {
      email,
      password: PASSWORD,
      acceptTerms: true,
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    // The real owner is notified instead of a duplicate account being created.
    expect(lastMailTo(app, email, 'security_notice').subject).toMatch(/Registration attempt/);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('stores an argon2id hash, never the password, and assigns the customer role', async () => {
    const email = uniqueEmail();
    await new TestClient(app).post('/v1/auth/register', {
      email,
      password: PASSWORD,
      acceptTerms: true,
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { roles: { include: { role: true } } },
    });
    expect(user.passwordHash!.startsWith('$argon2id$')).toBe(true);
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(user.status).toBe('PENDING_VERIFICATION');
    expect(user.roles.map((r) => r.role.key)).toEqual(['user']);
  });

  it('blocks login until the email is verified, and verification tokens are single-use', async () => {
    const email = uniqueEmail();
    const client = new TestClient(app);
    await client.post('/v1/auth/register', { email, password: PASSWORD, acceptTerms: true });

    const early = await client.post('/v1/auth/login', { email, password: PASSWORD });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const token = tokenFromMail(lastMailTo(app, email, 'email_verification'));
    const stored = await prisma.verificationToken.findFirstOrThrow({ where: { user: { email } } });
    expect(stored.tokenHash).not.toBe(token); // only the hash is stored

    expect((await client.post('/v1/auth/verify-email', { token })).status).toBe(200);
    const reuse = await client.post('/v1/auth/verify-email', { token });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_TOKEN');

    expect((await client.post('/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
  });
});

describe('login and sessions', () => {
  it('returns the same error for unknown email and wrong password', async () => {
    const email = uniqueEmail();
    await createVerifiedUser(app, email);
    const client = new TestClient(app);
    const wrongPw = await client.post('/v1/auth/login', {
      email,
      password: 'wrong password entirely',
    });
    const unknown = await client.post('/v1/auth/login', {
      email: uniqueEmail(),
      password: PASSWORD,
    });
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPw.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(wrongPw.body.error.message);
  });

  it('sets an httpOnly SameSite=Lax session cookie and stores only its hash', async () => {
    const email = uniqueEmail();
    const client = new TestClient(app);
    await client.post('/v1/auth/register', { email, password: PASSWORD, acceptTerms: true });
    await client.post('/v1/auth/verify-email', {
      token: tokenFromMail(lastMailTo(app, email, 'email_verification')),
    });
    const res = await client.post('/v1/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('authenticated');
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('session='),
    );
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const raw = /^session=([^;]+)/.exec(cookie ?? '')?.[1];
    expect(await prisma.session.count({ where: { tokenHash: raw } })).toBe(0);
  });

  it('returns the current user with roles and permissions', async () => {
    const email = uniqueEmail();
    const client = await createVerifiedUser(app, email);
    const res = await client.get('/v1/me').expect(200);
    expect(res.body).toMatchObject({
      email,
      emailVerified: true,
      status: 'ACTIVE',
      mfaEnabled: false,
      roles: ['user'],
      permissions: ['account:self:manage', 'account:self:read', 'trading:trade'],
    });
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it('rejects unauthenticated access to protected routes', async () => {
    const res = await new TestClient(app).get('/v1/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('lists sessions and lets the user revoke another device', async () => {
    const email = uniqueEmail();
    const laptop = await createVerifiedUser(app, email);
    const phone = new TestClient(app);
    await phone.post('/v1/auth/login', { email, password: PASSWORD });

    const list = await laptop.get('/v1/me/sessions').expect(200);
    expect(list.body.sessions).toHaveLength(2);
    const other = list.body.sessions.find((s: { current: boolean }) => !s.current);

    expect((await laptop.delete(`/v1/me/sessions/${other.id}`)).status).toBe(204);
    expect((await phone.get('/v1/me')).status).toBe(401);
    expect((await laptop.get('/v1/me')).status).toBe(200);
  });

  it("cannot revoke another user's session (IDOR)", async () => {
    const alice = await createVerifiedUser(app);
    const bob = await createVerifiedUser(app);
    const bobSession = (await bob.get('/v1/me/sessions')).body.sessions[0].id;
    expect((await alice.delete(`/v1/me/sessions/${bobSession}`)).status).toBe(404);
    expect((await bob.get('/v1/me')).status).toBe(200);
  });

  it('logs out and invalidates the session server-side', async () => {
    const client = await createVerifiedUser(app);
    expect((await client.post('/v1/auth/logout')).status).toBe(204);
    expect((await client.get('/v1/me')).status).toBe(401);
  });

  it('locks the account after repeated failures', async () => {
    const email = uniqueEmail();
    await createVerifiedUser(app, email);
    const attacker = new TestClient(app);
    for (let i = 0; i < 3; i++) {
      expect(
        (await attacker.post('/v1/auth/login', { email, password: 'wrong guess number x' })).status,
      ).toBe(401);
    }
    const locked = await attacker.post('/v1/auth/login', { email, password: PASSWORD });
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('rate-limits authentication endpoints per client IP', async () => {
    const client = new TestClient(app);
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      statuses.push(
        (await client.post('/v1/auth/login', { email: uniqueEmail(), password: 'x' })).status,
      );
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[21]).toBe(429);
    // Another client IP is unaffected.
    expect(
      (await new TestClient(app).post('/v1/auth/login', { email: uniqueEmail(), password: 'x' }))
        .status,
    ).toBe(401);
  });
});

describe('password reset and change', () => {
  it('resets the password via emailed single-use token and revokes all sessions', async () => {
    const email = uniqueEmail();
    const session = await createVerifiedUser(app, email);
    const anon = new TestClient(app);

    const forgot = await anon.post('/v1/auth/password/forgot', { email });
    expect(forgot.status).toBe(202);
    const unknown = await anon.post('/v1/auth/password/forgot', { email: uniqueEmail() });
    expect(unknown.body).toEqual(forgot.body);

    const token = tokenFromMail(lastMailTo(app, email, 'password_reset'));
    const newPassword = 'an entirely different passphrase 7';
    expect((await anon.post('/v1/auth/password/reset', { token, newPassword })).status).toBe(200);
    expect((await anon.post('/v1/auth/password/reset', { token, newPassword })).status).toBe(400);

    expect((await session.get('/v1/me')).status).toBe(401);
    expect((await anon.post('/v1/auth/login', { email, password: PASSWORD })).status).toBe(401);
    expect((await anon.post('/v1/auth/login', { email, password: newPassword })).status).toBe(200);
    expect(lastMailTo(app, email, 'security_notice').subject).toMatch(/password was changed/);
  });

  it('changes the password, keeping the current session and revoking others', async () => {
    const email = uniqueEmail();
    const current = await createVerifiedUser(app, email);
    const other = new TestClient(app);
    await other.post('/v1/auth/login', { email, password: PASSWORD });

    const wrong = await current.post('/v1/me/password', {
      currentPassword: 'not it at all',
      newPassword: 'brand new passphrase 99',
    });
    expect(wrong.status).toBe(401);

    const ok = await current.post('/v1/me/password', {
      currentPassword: PASSWORD,
      newPassword: 'brand new passphrase 99',
    });
    expect(ok.status).toBe(204);
    expect((await current.get('/v1/me')).status).toBe(200);
    expect((await other.get('/v1/me')).status).toBe(401);
  });
});

describe('TOTP multi-factor authentication', () => {
  const codeAt = (secret: Buffer, offsetSteps: number) => hotp(secret, timeStep() + offsetSteps);

  it('enrols, requires a code at login, rejects replay, and disables with password + code', async () => {
    const email = uniqueEmail();
    const client = await createVerifiedUser(app, email);

    expect(
      (await client.post('/v1/me/mfa/totp/setup', { password: 'wrong password!' })).status,
    ).toBe(401);
    const setup = await client.post('/v1/me/mfa/totp/setup', { password: PASSWORD });
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const secret = base32Decode(setup.body.secret as string);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(Buffer.from(stored.mfaTotpPendingEnc!).includes(secret)).toBe(false); // encrypted at rest

    expect((await client.post('/v1/me/mfa/totp/enable', { code: '000000' })).status).toBe(400);
    expect((await client.post('/v1/me/mfa/totp/enable', { code: codeAt(secret, 0) })).status).toBe(
      204,
    );
    expect((await client.get('/v1/me')).body.mfaEnabled).toBe(true);

    // Login now needs a second factor.
    const fresh = new TestClient(app);
    const step1 = await fresh.post('/v1/auth/login', { email, password: PASSWORD });
    expect(step1.body.status).toBe('mfa_required');
    expect(step1.headers['set-cookie']?.toString() ?? '').not.toMatch(/session=/);

    // Replaying the code used for enrolment is refused.
    const replay = await fresh.post('/v1/auth/login/mfa', {
      challengeId: step1.body.challengeId,
      code: codeAt(secret, 0),
    });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('MFA_INVALID');

    const nextCode = codeAt(secret, 1);
    const step2 = await fresh.post('/v1/auth/login/mfa', {
      challengeId: step1.body.challengeId,
      code: nextCode,
    });
    expect(step2.status).toBe(200);
    expect(step2.body.status).toBe('authenticated');
    expect((await fresh.get('/v1/me')).status).toBe(200);

    // The challenge is single-use.
    const again = await fresh.post('/v1/auth/login/mfa', {
      challengeId: step1.body.challengeId,
      code: nextCode,
    });
    expect(again.status).toBe(401);

    // Disabling requires password and a fresh (later) code: simulate 60s passing.
    const realNow = Date.now;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000);
    try {
      const disable = await client.post('/v1/me/mfa/totp/disable', {
        password: PASSWORD,
        code: codeAt(secret, 0),
      });
      expect(disable.status).toBe(204);
    } finally {
      spy.mockRestore();
    }
    expect((await client.get('/v1/me')).body.mfaEnabled).toBe(false);
    expect((await fresh.get('/v1/me')).status).toBe(401); // other sessions revoked
  });
});

describe('RBAC', () => {
  it('denies staff endpoints to customers and audits the denial', async () => {
    const email = uniqueEmail();
    const client = await createVerifiedUser(app, email);
    const res = await client.get('/v1/admin/users');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const denial = await prisma.auditLog.findFirst({
      where: { actorUserId: user.id, action: 'rbac.access.denied' },
    });
    expect(denial?.outcome).toBe('DENIED');
  });

  it('grants access according to role permissions only', async () => {
    const { RbacService } = await import('../src/rbac/rbac.service');
    const rbac = app.get(RbacService);

    const auditorEmail = uniqueEmail('auditor');
    const auditor = await createVerifiedUser(app, auditorEmail);
    const auditorUser = await prisma.user.findUniqueOrThrow({ where: { email: auditorEmail } });
    await rbac.grantRole({
      userId: auditorUser.id,
      roleKey: 'auditor',
      grantedById: null,
      actorType: 'SYSTEM',
      reason: 'test',
    });

    const logs = await auditor.get('/v1/admin/audit-logs?limit=5').expect(200);
    expect(logs.body.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs.body)).not.toMatch(/passwordHash|tokenHash/);
    expect((await auditor.get('/v1/admin/users')).status).toBe(403); // auditor lacks users:read

    const adminEmail = uniqueEmail('admin');
    const admin = await createVerifiedUser(app, adminEmail);
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });
    await rbac.grantRole({
      userId: adminUser.id,
      roleKey: 'administrator',
      grantedById: null,
      actorType: 'SYSTEM',
      reason: 'test',
    });
    const users = await admin.get('/v1/admin/users?limit=3').expect(200);
    expect(users.body.users).toHaveLength(3);
    expect(JSON.stringify(users.body)).not.toMatch(/passwordHash|mfaTotp/);

    await expect(
      rbac.grantRole({
        userId: adminUser.id,
        roleKey: 'compliance_officer',
        grantedById: adminUser.id,
        actorType: 'STAFF',
        reason: 'self',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('audit log', () => {
  it('records security events without secrets', async () => {
    const email = uniqueEmail();
    await createVerifiedUser(app, email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const actions = (await prisma.auditLog.findMany({ where: { actorUserId: user.id } })).map(
      (e) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['auth.register', 'auth.email.verified', 'auth.login']),
    );
    const all = JSON.stringify(
      await prisma.auditLog.findMany({ where: { actorUserId: user.id } }),
      (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
    expect(all).not.toContain(PASSWORD);
  });

  it('is append-only at the database level', async () => {
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.updateMany({ data: { action: 'tampered' } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('only sends mail through the in-memory test transport', () => {
    expect(mails(app).length).toBeGreaterThan(0);
  });
});
