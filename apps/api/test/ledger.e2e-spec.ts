import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { formatAmount, parseAmount } from '@platform/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { loadAppConfig } from '../src/config/app-config';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { LedgerService, type LedgerActor } from '../src/ledger/ledger.service';
import { ReconciliationService } from '../src/ledger/reconciliation.service';
import { RbacService } from '../src/rbac/rbac.service';
import { TestClient, bootApp, createVerifiedUser, uniqueEmail } from './helpers';

let app: INestApplication;
let prisma: PrismaService;
let ledger: LedgerService;
let reconciliation: ReconciliationService;

const SYSTEM: LedgerActor = { actorType: 'SYSTEM' };
const key = (label: string) => `test:${label}:${randomUUID()}`;
const assetCode = () => `T${randomBytes(5).toString('hex').toUpperCase()}`;

async function newUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: uniqueEmail('ledger'), passwordHash: 'not-a-real-hash', status: 'ACTIVE' },
  });
  return user.id;
}

async function newAsset(scale = 8): Promise<string> {
  const code = assetCode();
  await ledger.createAsset({ code, name: `Test asset ${code}`, scale }, SYSTEM);
  return code;
}

async function balances(
  userId: string,
  code: string,
): Promise<{ available: bigint; locked: bigint }> {
  const asset = await ledger.requireAsset(code, false);
  const rows = await prisma.ledgerAccount.findMany({
    where: { ownerUserId: userId, assetId: asset.id },
  });
  const get = (t: string) => BigInt(rows.find((r) => r.type === t)?.balance.toFixed(0) ?? '0');
  return { available: get('USER_AVAILABLE'), locked: get('USER_LOCKED') };
}

async function deposit(userId: string, code: string, amount: bigint) {
  return ledger.simulatedDeposit(
    { userId, assetCode: code, amount, idempotencyKey: key('deposit') },
    SYSTEM,
  );
}

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
  ledger = app.get(LedgerService);
  reconciliation = app.get(ReconciliationService);
});

afterAll(async () => {
  await app.close();
});

describe('posting', () => {
  it('credits a simulated deposit to the user and debits simulated custody', async () => {
    const userId = await newUser();
    const code = await newAsset(8);
    const { entry, replayed } = await deposit(userId, code, parseAmount('1.5', 8));
    expect(replayed).toBe(false);
    expect(entry.type).toBe('SIMULATED_DEPOSIT');
    expect(await balances(userId, code)).toEqual({ available: 150_000_000n, locked: 0n });

    const postings = await prisma.posting.findMany({
      where: { entryId: entry.id },
      include: { account: true },
    });
    expect(postings.map((p) => [p.account.type, p.direction, p.amount.toFixed(0)]).sort()).toEqual([
      ['SIMULATED_CUSTODY', 'DEBIT', '150000000'],
      ['USER_AVAILABLE', 'CREDIT', '150000000'],
    ]);
  });

  it('handles 18-decimal amounts beyond 2^64 exactly', async () => {
    const userId = await newUser();
    const code = await newAsset(18);
    const amount = parseAmount('123456789012.123456789012345678', 18);
    expect(amount > 2n ** 64n).toBe(true);
    await deposit(userId, code, amount);
    expect((await balances(userId, code)).available).toBe(amount);
  });

  it('moves funds between available and locked with hold/release', async () => {
    const userId = await newUser();
    const code = await newAsset();
    await deposit(userId, code, 1000n);
    await ledger.hold(
      { userId, assetCode: code, amount: 400n, idempotencyKey: key('hold'), description: 'order' },
      SYSTEM,
    );
    expect(await balances(userId, code)).toEqual({ available: 600n, locked: 400n });
    await ledger.release(
      { userId, assetCode: code, amount: 150n, idempotencyKey: key('rel'), description: 'cancel' },
      SYSTEM,
    );
    expect(await balances(userId, code)).toEqual({ available: 750n, locked: 250n });
  });

  it('rejects an overdraft atomically: no entry, no balance change', async () => {
    const userId = await newUser();
    const code = await newAsset();
    await deposit(userId, code, 100n);
    const before = await prisma.journalEntry.count();
    await expect(
      ledger.hold(
        {
          userId,
          assetCode: code,
          amount: 101n,
          idempotencyKey: key('hold'),
          description: 'too much',
        },
        SYSTEM,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await prisma.journalEntry.count()).toBe(before);
    expect(await balances(userId, code)).toEqual({ available: 100n, locked: 0n });
  });

  it('rejects postings to a disabled asset', async () => {
    const userId = await newUser();
    const code = await newAsset();
    await ledger.setAssetStatus(code, 'DISABLED', SYSTEM);
    await expect(deposit(userId, code, 1n)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses simulated deposits outside local/ci', async () => {
    const config = { ...loadAppConfig(), DEPLOY_ENV: 'staging' as const };
    const strict = new LedgerService(prisma, app.get(AuditService), config);
    await expect(
      strict.simulatedDeposit(
        { userId: await newUser(), assetCode: 'ANY', amount: 1n, idempotencyKey: key('x') },
        SYSTEM,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('idempotency', () => {
  it('replays an identical request without posting twice', async () => {
    const userId = await newUser();
    const code = await newAsset();
    const k = key('dep');
    const first = await ledger.simulatedDeposit(
      { userId, assetCode: code, amount: 10n, idempotencyKey: k },
      SYSTEM,
    );
    const second = await ledger.simulatedDeposit(
      { userId, assetCode: code, amount: 10n, idempotencyKey: k },
      SYSTEM,
    );
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect((await balances(userId, code)).available).toBe(10n);
  });

  it('rejects reuse of a key with a different payload', async () => {
    const userId = await newUser();
    const code = await newAsset();
    const k = key('dep');
    await ledger.simulatedDeposit(
      { userId, assetCode: code, amount: 10n, idempotencyKey: k },
      SYSTEM,
    );
    await expect(
      ledger.simulatedDeposit({ userId, assetCode: code, amount: 11n, idempotencyKey: k }, SYSTEM),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await balances(userId, code)).available).toBe(10n);
  });

  it('posts exactly once under 25 concurrent identical requests', async () => {
    const userId = await newUser();
    const code = await newAsset();
    const k = key('race');
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        ledger.simulatedDeposit({ userId, assetCode: code, amount: 7n, idempotencyKey: k }, SYSTEM),
      ),
    );
    expect(new Set(results.map((r) => r.entry.id.toString())).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await balances(userId, code)).available).toBe(7n);
    expect(await prisma.journalEntry.count({ where: { idempotencyKey: k } })).toBe(1);
  });
});

describe('concurrency', () => {
  it('never overdraws under 30 concurrent holds (exactly 10 of 10 units fit in 100)', async () => {
    const userId = await newUser();
    const code = await newAsset();
    await deposit(userId, code, 100n);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        ledger.hold(
          {
            userId,
            assetCode: code,
            amount: 10n,
            idempotencyKey: key(`h${i}`),
            description: 'race',
          },
          SYSTEM,
        ),
      ),
    );
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(ok).toHaveLength(10);
    expect(
      rejected.every((r) => (r.reason as { code?: string }).code === 'INSUFFICIENT_FUNDS'),
    ).toBe(true);
    expect(await balances(userId, code)).toEqual({ available: 0n, locked: 100n });
  });

  it('does not deadlock with concurrent opposite-direction movements', async () => {
    const userId = await newUser();
    const code = await newAsset();
    await deposit(userId, code, 1000n);
    await ledger.hold(
      { userId, assetCode: code, amount: 500n, idempotencyKey: key('seed'), description: 'seed' },
      SYSTEM,
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0
          ? ledger.hold(
              {
                userId,
                assetCode: code,
                amount: 3n,
                idempotencyKey: key(`h${i}`),
                description: 'h',
              },
              SYSTEM,
            )
          : ledger.release(
              {
                userId,
                assetCode: code,
                amount: 5n,
                idempotencyKey: key(`r${i}`),
                description: 'r',
              },
              SYSTEM,
            ),
      ),
    );
    const failures = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(failures.map((f) => String(f.reason))).toEqual([]);
    // 20 holds of 3, 20 releases of 5 → available 500 - 60 + 100 = 540, locked 500 + 60 - 100 = 460
    expect(await balances(userId, code)).toEqual({ available: 540n, locked: 460n });
  });
});

describe('reversals', () => {
  it('restores balances and links the reversal; each entry can be reversed once', async () => {
    const userId = await newUser();
    const code = await newAsset();
    const { entry } = await deposit(userId, code, 50n);
    const rev = await ledger.reverse(
      { entryId: entry.id, reason: 'test correction', idempotencyKey: key('rev') },
      SYSTEM,
    );
    expect(rev.entry.reversesEntryId).toBe(entry.id);
    expect(await balances(userId, code)).toEqual({ available: 0n, locked: 0n });

    await expect(
      ledger.reverse({ entryId: entry.id, reason: 'again', idempotencyKey: key('rev2') }, SYSTEM),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      ledger.reverse(
        { entryId: rev.entry.id, reason: 'undo', idempotencyKey: key('rev3') },
        SYSTEM,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a reversal that would overdraw (funds already moved)', async () => {
    const userId = await newUser();
    const code = await newAsset();
    const { entry } = await deposit(userId, code, 50n);
    await ledger.hold(
      { userId, assetCode: code, amount: 50n, idempotencyKey: key('hold'), description: 'order' },
      SYSTEM,
    );
    await expect(
      ledger.reverse(
        { entryId: entry.id, reason: 'late correction', idempotencyKey: key('rev') },
        SYSTEM,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });
});

describe('database invariants (backstop for application bugs)', () => {
  it('rejects direct balance edits, posting/entry mutation and account deletion', async () => {
    const userId = await newUser();
    const code = await newAsset();
    const { entry } = await deposit(userId, code, 5n);
    await expect(
      prisma.$executeRaw`UPDATE "ledger_accounts" SET "balance" = 999999 WHERE "owner_user_id" = ${userId}::uuid`,
    ).rejects.toThrow(/only change through postings/);
    await expect(
      prisma.$executeRaw`UPDATE "postings" SET "amount" = 1 WHERE "entry_id" = ${entry.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRaw`DELETE FROM "journal_entries" WHERE "id" = ${entry.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRaw`DELETE FROM "ledger_accounts" WHERE "owner_user_id" = ${userId}::uuid`,
    ).rejects.toThrow(/cannot be deleted/);
    await expect(prisma.$executeRaw`TRUNCATE "postings" CASCADE`).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRaw`UPDATE "assets" SET "scale" = 2 WHERE "code" = ${code}`,
    ).rejects.toThrow(/immutable/);
  });

  it('rejects an unbalanced entry written directly to the database (checked at commit)', async () => {
    const userId = await newUser();
    const code = await newAsset();
    await deposit(userId, code, 5n);
    const accounts = await prisma.ledgerAccount.findMany({
      where: { asset: { code } },
      orderBy: { type: 'asc' },
    });
    const [custody, available] = [
      accounts.find((a) => a.type === 'SIMULATED_CUSTODY')!,
      accounts.find((a) => a.type === 'USER_AVAILABLE')!,
    ];
    const before = await prisma.journalEntry.count();
    await expect(
      prisma.$transaction(async (tx) => {
        const e = await tx.journalEntry.create({
          data: {
            type: 'SIMULATED_DEPOSIT',
            idempotencyKey: key('raw'),
            fingerprint: 'f'.repeat(64),
            description: 'raw',
            actorType: 'SYSTEM',
          },
        });
        await tx.posting.createMany({
          data: [
            {
              entryId: e.id,
              accountId: custody.id,
              assetId: custody.assetId,
              direction: 'DEBIT',
              amount: '10',
            },
            {
              entryId: e.id,
              accountId: available.id,
              assetId: available.assetId,
              direction: 'CREDIT',
              amount: '9',
            },
          ],
        });
      }),
    ).rejects.toThrow(/not balanced/);
    expect(await prisma.journalEntry.count()).toBe(before);
  });

  it('rejects an overdraft written directly to the database', async () => {
    const userId = await newUser();
    const code = await newAsset();
    await deposit(userId, code, 5n);
    const accounts = await prisma.ledgerAccount.findMany({ where: { asset: { code } } });
    const [custody, available] = [
      accounts.find((a) => a.type === 'SIMULATED_CUSTODY')!,
      accounts.find((a) => a.type === 'USER_AVAILABLE')!,
    ];
    await expect(
      prisma.$transaction(async (tx) => {
        const e = await tx.journalEntry.create({
          data: {
            type: 'SIMULATED_DEPOSIT',
            idempotencyKey: key('raw'),
            fingerprint: 'f'.repeat(64),
            description: 'raw',
            actorType: 'SYSTEM',
          },
        });
        await tx.posting.createMany({
          data: [
            {
              entryId: e.id,
              accountId: available.id,
              assetId: available.assetId,
              direction: 'DEBIT',
              amount: '6',
            },
            {
              entryId: e.id,
              accountId: custody.id,
              assetId: custody.assetId,
              direction: 'CREDIT',
              amount: '6',
            },
          ],
        });
      }),
    ).rejects.toThrow(/ledger_accounts_non_negative_chk/);
    expect((await balances(userId, code)).available).toBe(5n);
  });
});

describe('transaction-scoped account resolution', () => {
  it('never needs a second pool connection while inside a transaction', async () => {
    // Deterministic regression test for the Sprint 4 pool-starvation deadlock:
    // with a pool of ONE connection, resolving a new account inside a transaction
    // must use that transaction's connection (a second checkout would time out).
    const { PrismaClient } = await import('@prisma/client');
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('pool_timeout', '2');
    const single = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      const scoped = new LedgerService(
        single as unknown as PrismaService,
        app.get(AuditService),
        loadAppConfig(),
      );
      const userId = await newUser();
      const code = await newAsset();
      const asset = await scoped.requireAsset(code);
      let resolved = '';
      await single.$transaction(async (tx) => {
        const accounts = scoped.transactionalAccounts(tx);
        resolved = await accounts.id(asset.id, 'USER_AVAILABLE', userId);
        expect(await accounts.id(asset.id, 'USER_AVAILABLE', userId)).toBe(resolved); // pending hit
        accounts.commit();
      });
      expect(await prisma.ledgerAccount.findUnique({ where: { id: resolved } })).not.toBeNull();
    } finally {
      await single.$disconnect();
    }
  });

  it('does not cache accounts created in a rolled-back transaction', async () => {
    const userId = await newUser();
    const code = await newAsset();
    const asset = await ledger.requireAsset(code);
    let createdId = '';
    await expect(
      prisma.$transaction(async (tx) => {
        const accounts = ledger.transactionalAccounts(tx);
        createdId = await accounts.id(asset.id, 'USER_LOCKED', userId);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await prisma.ledgerAccount.findUnique({ where: { id: createdId } })).toBeNull();
    // A later lookup creates a real account instead of returning the rolled-back id.
    const real = await ledger.accountId(asset.id, 'USER_LOCKED', userId);
    expect(real).not.toBe(createdId);
    expect(await prisma.ledgerAccount.findUnique({ where: { id: real } })).not.toBeNull();
  });
});

describe('reconciliation', () => {
  it('is OK after a random sequence of operations, and user funds equal simulated custody', async () => {
    const code = await newAsset(6);
    const users = await Promise.all(Array.from({ length: 5 }, () => newUser()));
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 150; i++) {
      const userId = users[rand(users.length)]!;
      const amount = BigInt(1 + rand(1_000_000));
      const op = rand(3);
      const call =
        op === 0
          ? deposit(userId, code, amount)
          : op === 1
            ? ledger.hold(
                { userId, assetCode: code, amount, idempotencyKey: key('h'), description: 'h' },
                SYSTEM,
              )
            : ledger.release(
                { userId, assetCode: code, amount, idempotencyKey: key('r'), description: 'r' },
                SYSTEM,
              );
      await call.catch((err: { code?: string }) => {
        if (err.code !== 'INSUFFICIENT_FUNDS') throw err;
      });
    }
    let userTotal = 0n;
    for (const u of users) {
      const b = await balances(u, code);
      expect(b.available >= 0n && b.locked >= 0n).toBe(true);
      userTotal += b.available + b.locked;
    }
    const asset = await ledger.requireAsset(code);
    const custody = await prisma.ledgerAccount.findFirstOrThrow({
      where: { assetId: asset.id, type: 'SIMULATED_CUSTODY' },
    });
    expect(BigInt(custody.balance.toFixed(0))).toBe(userTotal);

    const run = await reconciliation.run('MANUAL');
    expect(run.findings).toEqual([]);
    expect(run.status).toBe('OK');
  });

  it('detects tampering that bypasses the posting path, then passes once corrected', async () => {
    const userId = await newUser();
    const code = await newAsset();
    await deposit(userId, code, 100n);
    const account = await prisma.ledgerAccount.findFirstOrThrow({
      where: { ownerUserId: userId, type: 'USER_AVAILABLE' },
    });

    // Simulate a privileged actor deliberately bypassing the guard trigger.
    const tamper = (delta: number) =>
      prisma.$transaction([
        prisma.$executeRaw`SELECT set_config('ledger.applying_posting', 'on', true)`,
        prisma.$executeRaw`UPDATE "ledger_accounts" SET "balance" = "balance" + ${delta} WHERE "id" = ${account.id}::uuid`,
      ]);
    await tamper(1);
    try {
      const run = await reconciliation.run('MANUAL');
      expect(run.status).toBe('MISMATCH');
      expect(run.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'BALANCE_MISMATCH',
            accountId: account.id,
            projected: '101',
            computed: '100',
          }),
        ]),
      );
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'ledger.reconciliation.run', targetId: run.id },
      });
      expect(audit?.outcome).toBe('FAILURE');
    } finally {
      await tamper(-1);
    }
    expect((await reconciliation.run('MANUAL')).status).toBe('OK');
  });

  it('stores runs append-only', async () => {
    const [run] = await reconciliation.latest(1);
    await expect(
      prisma.ledgerReconciliationRun.update({ where: { id: run!.id }, data: { status: 'OK' } }),
    ).rejects.toThrow(/immutable/);
  });
});

describe('HTTP API', () => {
  it('lists active assets publicly (no prices)', async () => {
    const code = await newAsset(2);
    const res = await new TestClient(app).get('/v1/assets').expect(200);
    expect(res.body.assets).toEqual(
      expect.arrayContaining([
        {
          code,
          name: `Test asset ${code}`,
          scale: 2,
          status: 'ACTIVE',
          paper: false,
          faucetAmount: null,
        },
      ]),
    );
  });

  it('shows a user only their own balances and history, as exact decimal strings', async () => {
    const email = uniqueEmail();
    const client = await createVerifiedUser(app, email);
    const other = await createVerifiedUser(app);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const code = await newAsset(8);

    const empty = await client.get('/v1/me/balances').expect(200);
    expect(empty.body.balances).toEqual(
      expect.arrayContaining([
        {
          asset: code,
          name: `Test asset ${code}`,
          scale: 8,
          paper: false,
          available: '0.00000000',
          locked: '0.00000000',
          total: '0.00000000',
        },
      ]),
    );

    await deposit(user.id, code, parseAmount('2.5', 8));
    await ledger.hold(
      {
        userId: user.id,
        assetCode: code,
        amount: parseAmount('0.1', 8),
        idempotencyKey: key('h'),
        description: 'h',
      },
      SYSTEM,
    );

    const res = await client.get('/v1/me/balances').expect(200);
    expect(res.body.balances.find((b: { asset: string }) => b.asset === code)).toMatchObject({
      available: '2.40000000',
      locked: '0.10000000',
      total: '2.50000000',
    });

    const history = await client.get('/v1/me/ledger-entries?limit=10').expect(200);
    const mine = history.body.items.filter((i: { asset: string }) => i.asset === code);
    // Newest entry first; postings within one entry have no meaningful order.
    const rows = mine.map((i: { entryType: string; bucket: string; change: string }) => [
      i.entryType,
      i.bucket,
      i.change,
    ]);
    expect(rows[2]).toEqual(['SIMULATED_DEPOSIT', 'available', '+2.50000000']);
    expect(rows.slice(0, 2).sort()).toEqual([
      ['BALANCE_HOLD', 'available', '-0.10000000'],
      ['BALANCE_HOLD', 'locked', '+0.10000000'],
    ]);

    const otherHistory = await other.get('/v1/me/ledger-entries').expect(200);
    expect(otherHistory.body.items.some((i: { asset: string }) => i.asset === code)).toBe(false);
    const otherBalances = await other.get('/v1/me/balances').expect(200);
    expect(otherBalances.body.balances.find((b: { asset: string }) => b.asset === code).total).toBe(
      formatAmount(0n, 8),
    );
  });

  it('protects staff ledger endpoints by permission and audits reads', async () => {
    const rbac = app.get(RbacService);
    const customer = await createVerifiedUser(app);
    expect((await customer.get('/v1/admin/ledger/reconciliations')).status).toBe(403);
    expect(
      (await customer.post('/v1/admin/assets', { code: 'NOPE', name: 'Nope', scale: 2 })).status,
    ).toBe(403);

    const riskEmail = uniqueEmail('risk');
    const risk = await createVerifiedUser(app, riskEmail);
    const riskUser = await prisma.user.findUniqueOrThrow({ where: { email: riskEmail } });
    await rbac.grantRole({
      userId: riskUser.id,
      roleKey: 'risk_officer',
      grantedById: null,
      actorType: 'SYSTEM',
      reason: 'test',
    });

    const code = assetCode();
    const created = await risk.post('/v1/admin/assets', {
      code: code.toLowerCase(),
      name: 'API asset',
      scale: 6,
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      code,
      name: 'API asset',
      scale: 6,
      status: 'ACTIVE',
      paper: false,
      faucetAmount: null,
    });
    expect((await risk.post('/v1/admin/assets', { code, name: 'Dup', scale: 6 })).status).toBe(409);
    expect(
      (await risk.post('/v1/admin/assets', { code: 'BAD CODE', name: 'x', scale: 99 })).status,
    ).toBe(400);

    const run = await risk.post('/v1/admin/ledger/reconciliations');
    expect(run.status).toBe(201);
    expect(run.body.status).toBe('OK');

    const { entry } = await deposit(riskUser.id, code, 1n);
    const detail = await risk.get(`/v1/admin/ledger/entries/${entry.id}`).expect(200);
    expect(detail.body.postings).toHaveLength(2);
    expect(detail.body.postings.map((p: { amount: string }) => p.amount)).toEqual([
      '0.000001',
      '0.000001',
    ]);

    const accounts = await risk
      .get(`/v1/admin/ledger/accounts?ownerUserId=${riskUser.id}`)
      .expect(200);
    expect(accounts.body.accounts.length).toBeGreaterThan(0);
    const reads = await prisma.auditLog.count({
      where: { actorUserId: riskUser.id, action: { startsWith: 'admin.ledger.' } },
    });
    expect(reads).toBe(2);
  });

  it('never exposes a way to post arbitrary entries over HTTP', async () => {
    const client = await createVerifiedUser(app);
    for (const path of [
      '/v1/admin/ledger/entries',
      '/v1/me/deposits',
      '/v1/admin/ledger/adjustments',
    ]) {
      expect((await client.post(path, {})).status).toBe(404);
    }
  });
});

describe('types', () => {
  it('uses NUMERIC(38,0) for amounts', async () => {
    const cols = await prisma.$queryRaw<
      {
        table_name: string;
        column_name: string;
        numeric_precision: number;
        numeric_scale: number;
      }[]
    >(
      Prisma.sql`SELECT table_name, column_name, numeric_precision, numeric_scale FROM information_schema.columns
                 WHERE table_name IN ('postings','ledger_accounts') AND column_name IN ('amount','balance') ORDER BY table_name`,
    );
    expect(
      cols.map((c) => [c.table_name, c.column_name, c.numeric_precision, c.numeric_scale]),
    ).toEqual([
      ['ledger_accounts', 'balance', 38, 0],
      ['postings', 'amount', 38, 0],
    ]);
  });
});
