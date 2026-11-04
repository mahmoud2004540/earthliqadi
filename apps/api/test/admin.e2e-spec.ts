import type { INestApplication } from '@nestjs/common';
import type { RoleKey } from '@platform/shared';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { toMinorUnits } from '../src/ledger/ledger-domain';
import { LedgerService } from '../src/ledger/ledger.service';
import { RbacService } from '../src/rbac/rbac.service';
import { base32Decode, hotp, timeStep } from '../src/security/totp';
import { MarketsService } from '../src/trading/markets.service';
import { PASSWORD, TestClient, bootApp, createVerifiedUser, uniqueEmail } from './helpers';
import { SYSTEM } from './trading-helpers';

let app: INestApplication;
let prisma: PrismaService;
let ledger: LedgerService;
const code = (p: string) => `${p}${randomBytes(4).toString('hex').toUpperCase()}`;

interface Person {
  client: TestClient;
  id: string;
  email: string;
}

/** Boots a second app with extra environment (the app config object is frozen by design). */
async function withEnv<T>(
  env: Record<string, string>,
  fn: (other: INestApplication) => Promise<T>,
) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const other = await bootApp();
  try {
    return await fn(other);
  } finally {
    await other.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function person(...roles: RoleKey[]): Promise<Person> {
  return personOn(app, ...roles);
}

async function personOn(target: INestApplication, ...roles: RoleKey[]): Promise<Person> {
  const email = uniqueEmail('p7');
  const client = await createVerifiedUser(target, email);
  const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });
  for (const role of roles) {
    await app.get(RbacService).grantRole({
      userId: id,
      roleKey: role,
      grantedById: null,
      actorType: 'SYSTEM',
      reason: 'test',
    });
  }
  return { client, id, email };
}

/** Enrols TOTP through the real API (the code is computed like an authenticator app). */
async function enableMfa(p: Person): Promise<Buffer> {
  const setup = await p.client.post('/v1/me/mfa/totp/setup', { password: PASSWORD });
  expect(setup.status).toBe(200);
  const secret = base32Decode(setup.body.secret as string);
  const res = await p.client.post('/v1/me/mfa/totp/enable', { code: hotp(secret, timeStep()) });
  expect(res.status).toBe(204);
  return secret;
}

const KYC = {
  legalName: 'Test Person',
  dateOfBirth: '1990-04-12',
  countryCode: 'de',
  addressLine: '1 Example Street',
  city: 'Berlin',
  postalCode: '10115',
};

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
  ledger = app.get(LedgerService);
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('staff MFA enforcement', () => {
  it('blocks staff permissions until the account has MFA; customers are unaffected', async () => {
    await withEnv({ STAFF_MFA_REQUIRED: 'true' }, async (strict) => {
      const staff = await personOn(strict, 'support_agent');
      const denied = await staff.client.get('/v1/admin/tickets');
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('MFA_REQUIRED');
      expect((await staff.client.get('/v1/me/tickets')).status).toBe(200);
      await enableMfa(staff);
      expect((await staff.client.get('/v1/admin/tickets')).status).toBe(200);
    });
  });
});

describe('step-up re-authentication (ADR-0015)', () => {
  it('requires a fresh authenticator code for sensitive staff actions', async () => {
    await withEnv({ STAFF_MFA_REQUIRED: 'true' }, async (strict) => {
      const admin = await personOn(strict, 'administrator');
      const secret = await enableMfa(admin);
      const target = await personOn(strict);
      const suspend = () =>
        admin.client.post(`/v1/admin/users/${target.id}/suspend`, { reason: 'step-up test' });
      // Reading is fine without step-up; the sensitive action is not.
      expect((await admin.client.get('/v1/admin/users')).status).toBe(200);
      const denied = await suspend();
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('STEP_UP_REQUIRED');
      expect((await admin.client.post('/v1/auth/step-up', { code: '000000' })).status).toBe(401);
      // The enrolment used the current time-step; replay protection needs the next one.
      const ok = await admin.client.post('/v1/auth/step-up', {
        code: hotp(secret, timeStep() + 1),
      });
      expect(ok.status).toBe(204);
      expect((await suspend()).status).toBe(200);
    });
  });

  it('restricts staff permissions to the admin IP allow-list when configured', async () => {
    await withEnv({ ADMIN_IP_ALLOWLIST: '192.0.2.0/24' }, async (restricted) => {
      const staff = await personOn(restricted, 'support_agent');
      const res = await staff.client.get('/v1/admin/tickets');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('IP_NOT_ALLOWED');
      expect((await staff.client.get('/v1/me/tickets')).status).toBe(200);
    });
  });
});

describe('maker-checker approvals', () => {
  it('requires a different staff member, executes once, and is immutable afterwards', async () => {
    const asset = code('PI');
    await ledger.createAsset(
      { code: asset, name: 'Paper', scale: 6, paper: true, faucetAmount: '1' },
      SYSTEM,
    );
    const a = await person('risk_officer');
    const b = await person('risk_officer');
    const outsider = await person('support_agent');

    const req = await a.client.post('/v1/admin/approvals', {
      action: 'insurance_fund.seed',
      payload: { asset, amount: '500' },
      reason: 'Seed the paper insurance fund',
    });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('pending');
    const id = req.body.id as string;

    expect((await a.client.post(`/v1/admin/approvals/${id}/approve`, {})).status).toBe(403);
    expect((await outsider.client.post(`/v1/admin/approvals/${id}/approve`, {})).status).toBe(403);
    const ok = await b.client.post(`/v1/admin/approvals/${id}/approve`, { note: 'checked' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', result: { asset, amount: '500' } });
    expect((await b.client.post(`/v1/admin/approvals/${id}/approve`, {})).status).toBe(409);

    const fund = await prisma.ledgerAccount.findFirstOrThrow({
      where: { type: 'INSURANCE_FUND', asset: { code: asset } },
    });
    expect(toMinorUnits(fund.balance)).toBe(500_000_000n);
    // The requester is notified of the decision.
    const notes = await a.client.get('/v1/me/notifications');
    expect(notes.body.items[0]).toMatchObject({ kind: 'approval.decided', read: false });

    // Database backstops: decided requests are immutable; requester ≠ approver.
    await expect(
      prisma.approvalRequest.update({ where: { id }, data: { reason: 'changed later' } }),
    ).rejects.toThrow(/already decided/);
    const pending = await a.client.post('/v1/admin/approvals', {
      action: 'insurance_fund.seed',
      payload: { asset, amount: '1' },
      reason: 'Second seed for testing',
    });
    await expect(
      prisma.approvalRequest.update({
        where: { id: pending.body.id as string },
        data: { status: 'APPROVED', decidedById: a.id, decidedAt: new Date() },
      }),
    ).rejects.toThrow(/four_eyes/);
    // The requester can withdraw it.
    const cancelled = await a.client.post(`/v1/admin/approvals/${pending.body.id}/cancel`, {});
    expect(cancelled.body.status).toBe('cancelled');
  });

  it('resumes a halted market only with approval; rejection leaves it halted', async () => {
    const base = code('MB');
    const quote = code('MQ');
    await ledger.createAsset({ code: base, name: 'B', scale: 8 }, SYSTEM);
    await ledger.createAsset({ code: quote, name: 'Q', scale: 6 }, SYSTEM);
    const markets = app.get(MarketsService);
    const m = await markets.create(
      { base, quote, tickSize: '0.01', lotSize: '0.0001', makerFeeBps: 0, takerFeeBps: 0 },
      SYSTEM,
    );
    const a = await person('risk_officer');
    const b = await person('risk_officer');
    // Halting is a single-person emergency control.
    expect(
      (await a.client.patch(`/v1/admin/markets/${m.symbol}/status`, { status: 'HALTED' })).status,
    ).toBe(200);
    const body = {
      action: 'market.resume',
      payload: { symbol: m.symbol },
      reason: 'Incident resolved',
    };
    const first = await a.client.post('/v1/admin/approvals', body);
    const rejected = await b.client.post(`/v1/admin/approvals/${first.body.id}/reject`, {
      note: 'not yet',
    });
    expect(rejected.body.status).toBe('rejected');
    expect((await markets.require(m.symbol)).status).toBe('HALTED');
    const second = await a.client.post('/v1/admin/approvals', body);
    await b.client.post(`/v1/admin/approvals/${second.body.id}/approve`, {});
    expect((await markets.require(m.symbol)).status).toBe('ACTIVE');
  });

  it('suspends immediately, reactivates only with approval, refuses self-service', async () => {
    const admin1 = await person('administrator');
    const admin2 = await person('administrator');
    const target = await person();
    expect(
      (await admin1.client.post(`/v1/admin/users/${admin1.id}/suspend`, { reason: 'self test' }))
        .status,
    ).toBe(403);
    const s = await admin1.client.post(`/v1/admin/users/${target.id}/suspend`, {
      reason: 'Suspicious activity',
    });
    expect(s.status).toBe(200);
    expect(s.body.sessionsRevoked).toBeGreaterThan(0);
    expect((await target.client.get('/v1/me')).status).toBe(401);

    const self = await admin1.client.post('/v1/admin/approvals', {
      action: 'role.grant',
      payload: { userId: admin1.id, role: 'auditor' },
      reason: 'I want more access',
    });
    expect(self.status).toBe(403);

    const r = await admin1.client.post('/v1/admin/approvals', {
      action: 'user.reactivate',
      payload: { userId: target.id },
      reason: 'Investigation closed',
    });
    await admin2.client.post(`/v1/admin/approvals/${r.body.id}/approve`, {});
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(
      'ACTIVE',
    );

    const detail = await admin2.client.get(`/v1/admin/users/${target.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: target.id, status: 'ACTIVE', kycLevel: 0 });
  });

  it('reverses a ledger entry through maker-checker', async () => {
    const asset = code('PR');
    await ledger.createAsset(
      { code: asset, name: 'Paper', scale: 2, paper: true, faucetAmount: '10' },
      SYSTEM,
    );
    const user = await person();
    const grant = await ledger.paperFaucet(user.id, asset, SYSTEM);
    const a = await person('risk_officer');
    const b = await person('risk_officer');
    const r = await a.client.post('/v1/admin/approvals', {
      action: 'ledger.reversal',
      payload: { entryId: grant.entry.id.toString() },
      reason: 'Granted in error',
    });
    const ok = await b.client.post(`/v1/admin/approvals/${r.body.id}/approve`, {});
    expect(ok.status).toBe(200);
    const balances = await ledger.balancesForUser(user.id);
    expect(balances.find((x) => x.asset === asset)?.available).toBe('0.00');
  });

  it('expires stale requests', async () => {
    const a = await person('risk_officer');
    const row = await prisma.approvalRequest.create({
      data: {
        id: crypto.randomUUID(),
        action: 'market.resume',
        payload: { symbol: 'AA-BB' },
        reason: 'old request',
        requestedById: a.id,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const list = await a.client.get('/v1/admin/approvals?status=all&limit=200');
    expect(list.body.requests.find((x: { id: string }) => x.id === row.id)?.status).toBe('expired');
  });
});

describe('identity verification (KYC)', () => {
  it('is switched off by default (ADR-0013): every KYC endpoint answers 404', async () => {
    await withEnv({ KYC_ENABLED: 'false' }, async (off) => {
      const user = await personOn(off);
      const officer = await personOn(off, 'compliance_officer');
      expect((await user.client.get('/v1/me/verification')).status).toBe(404);
      expect((await user.client.post('/v1/me/verification', KYC)).status).toBe(404);
      expect((await officer.client.get('/v1/admin/kyc')).status).toBe(404);
    });
  });

  it('encrypts the profile, screens it, and lets a different officer decide', async () => {
    const user = await person();
    const officer = await person('compliance_officer');
    const sub = await user.client.post('/v1/me/verification', KYC);
    expect(sub.status).toBe(201);
    expect(sub.body).toMatchObject({ level: 0, case: { status: 'pending' } });
    expect((await user.client.post('/v1/me/verification', KYC)).status).toBe(409);
    expect(
      (await user.client.post('/v1/me/verification', { ...KYC, dateOfBirth: '2020-01-01' })).status,
    ).toBe(400);

    const row = await prisma.kycCase.findFirstOrThrow({ where: { userId: user.id } });
    expect(Buffer.from(row.profileEnc).toString('utf8')).not.toContain('Test Person');
    expect(row.countryCode).toBe('DE');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'kyc.submitted', targetId: row.id },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain('Test Person');

    const queue = await officer.client.get('/v1/admin/kyc');
    const listed = queue.body.cases.find((c: { id: string }) => c.id === row.id);
    expect(listed.profile).toBeUndefined();
    expect(listed.screening).toMatchObject({ restrictedCountry: false, sanctions: 'not_screened' });
    const view = await officer.client.get(`/v1/admin/kyc/${row.id}`);
    expect(view.body.profile).toMatchObject({ legalName: 'Test Person', countryCode: 'DE' });

    const approve = await officer.client.post(`/v1/admin/kyc/${row.id}/decision`, {
      decision: 'approve',
      note: 'Documents consistent',
    });
    expect(approve.status).toBe(200);
    expect((await user.client.get('/v1/me/verification')).body.level).toBe(1);
    const notes = await user.client.get('/v1/me/notifications');
    expect(notes.body.items[0]).toMatchObject({ kind: 'kyc.decided', title: 'Identity verified' });
    expect((await user.client.post('/v1/me/notifications/read', {})).body.updated).toBeGreaterThan(
      0,
    );
    expect((await user.client.get('/v1/me/notifications')).body.unread).toBe(0);
  });

  it('refuses approval for restricted countries and self-review', async () => {
    await withEnv({ RESTRICTED_COUNTRIES: 'XX' }, async (strict) => {
      const user = await personOn(strict, 'compliance_officer');
      await user.client.post('/v1/me/verification', { ...KYC, countryCode: 'XX' });
      const c = await prisma.kycCase.findFirstOrThrow({ where: { userId: user.id } });
      expect((c.screening as { restrictedCountry: boolean }).restrictedCountry).toBe(true);
      expect(
        (
          await user.client.post(`/v1/admin/kyc/${c.id}/decision`, {
            decision: 'approve',
            note: 'mine',
          })
        ).status,
      ).toBe(403);
      const other = await personOn(strict, 'compliance_officer');
      const res = await other.client.post(`/v1/admin/kyc/${c.id}/decision`, {
        decision: 'approve',
        note: 'try',
      });
      expect(res.status).toBe(409);
      const needs = await other.client.post(`/v1/admin/kyc/${c.id}/decision`, {
        decision: 'needs_info',
        note: 'Please provide a residence outside restricted jurisdictions',
      });
      expect(needs.body.status).toBe('needs_info');
    });
  });

  it('gates real-asset trading behind KYC when configured (paper stays open)', async () => {
    const base = code('KB');
    const quote = code('KQ');
    await ledger.createAsset({ code: base, name: 'B', scale: 8 }, SYSTEM);
    await ledger.createAsset({ code: quote, name: 'Q', scale: 6 }, SYSTEM);
    const m = await app
      .get(MarketsService)
      .create(
        { base, quote, tickSize: '0.01', lotSize: '0.0001', makerFeeBps: 0, takerFeeBps: 0 },
        SYSTEM,
      );
    await withEnv({ KYC_REQUIRED_FOR_REAL_TRADING: 'true' }, async (strict) => {
      const user = await personOn(strict);
      const res = await user.client.post('/v1/orders', {
        market: m.symbol,
        clientOrderId: 'kyc-gate-1',
        side: 'buy',
        type: 'limit',
        price: '1',
        quantity: '1',
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('KYC_REQUIRED');
    });
  });
});

describe('support and announcements', () => {
  it('runs a ticket conversation with notifications and append-only messages', async () => {
    const user = await person();
    const other = await person();
    const agent = await person('support_agent');
    const t = await user.client.post('/v1/me/tickets', {
      subject: 'Cannot see my order',
      body: 'Order abc is missing',
    });
    expect(t.status).toBe(201);
    const id = t.body.id as string;
    expect((await other.client.get(`/v1/me/tickets/${id}`)).status).toBe(404);
    const reply = await agent.client.post(`/v1/admin/tickets/${id}/messages`, {
      body: 'Looking into it',
    });
    expect(reply.body).toMatchObject({ status: 'waiting_on_user' });
    expect(reply.body.messages).toHaveLength(2);
    const notes = await user.client.get('/v1/me/notifications');
    expect(notes.body.items[0]).toMatchObject({ kind: 'support.reply' });
    await user.client.post(`/v1/me/tickets/${id}/messages`, { body: 'Thanks' });
    const closed = await agent.client.post(`/v1/admin/tickets/${id}/close`, {});
    expect(closed.body.status).toBe('closed');
    expect((await user.client.post(`/v1/me/tickets/${id}/messages`, { body: 'more' })).status).toBe(
      409,
    );
    const msg = await prisma.supportMessage.findFirstOrThrow({ where: { ticketId: id } });
    await expect(
      prisma.supportMessage.update({ where: { id: msg.id }, data: { body: 'edited' } }),
    ).rejects.toThrow(/append-only/);
  });

  it('publishes announcements (staff) and lists them publicly', async () => {
    const agent = await person('support_agent');
    const user = await person();
    expect((await user.client.post('/v1/announcements', { title: 'Nope', body: 'x' })).status).toBe(
      403,
    );
    const a = await agent.client.post('/v1/announcements', {
      title: `Maintenance ${code('W')}`,
      body: 'Planned maintenance window (paper environment).',
    });
    expect(a.status).toBe(201);
    const list = await new TestClient(app).get('/v1/announcements');
    expect(list.body.announcements[0].id).toBe(a.body.id);
  });
});

describe('monitoring', () => {
  it('exposes Prometheus metrics only with the bearer token, plus an admin health view', async () => {
    const anon = new TestClient(app);
    expect((await anon.get('/metrics')).status).toBe(404); // disabled without a token
    const token = 'm'.repeat(40);
    await withEnv({ METRICS_TOKEN: token }, async (withMetrics) => {
      const client = new TestClient(withMetrics);
      expect((await client.get('/metrics')).status).toBe(401);
      await client.get('/v1/markets'); // at least one recorded request
      const res = await client.get('/metrics').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toContain('# TYPE exchange_engine_backlog_commands gauge');
      expect(res.text).toContain('exchange_http_requests_total{');
      expect(res.text).toContain('exchange_approvals_pending');
    });
    const auditor = await person('auditor');
    const health = await auditor.client.get('/v1/admin/health');
    expect(health.status).toBe(200);
    expect(health.body.queues).toEqual(
      expect.objectContaining({ approvalsPending: expect.any(Number) }),
    );
  });
});

describe('personal data export', () => {
  it('returns everything about the account, without secrets, and audits the export', async () => {
    const user = await person();
    await user.client.post('/v1/me/verification', { ...KYC, legalName: 'Export Person' });
    await user.client.post('/v1/me/tickets', { subject: 'Export test', body: 'Hello' });
    const res = await user.client.get('/v1/me/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body).toMatchObject({
      format: 'exchange-platform/personal-data-export@1',
      account: { id: user.id, email: user.email },
    });
    expect(res.body.identityVerification[0].profile.legalName).toBe('Export Person');
    expect(res.body.supportTickets[0].messages[0].body).toBe('Hello');
    expect(res.body.sessions.length).toBeGreaterThan(0);
    const text = JSON.stringify(res.body);
    for (const secret of [
      'passwordHash',
      'password_hash',
      'mfaTotpSecretEnc',
      'tokenHash',
      'profileEnc',
    ])
      expect(text).not.toContain(secret);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(text).not.toContain(row.passwordHash!);
    expect(
      await prisma.auditLog.count({
        where: { action: 'account.data_exported', actorUserId: user.id },
      }),
    ).toBe(1);
  });
});
