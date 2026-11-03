import type { INestApplication } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { ReconciliationService } from '../src/ledger/reconciliation.service';
import { MarketsService } from '../src/trading/markets.service';
import { EngineProcess } from './engine';
import { bootApp, createVerifiedUser, uniqueEmail } from './helpers';
import { SYSTEM, TradingFixture } from './trading-helpers';

let app: INestApplication;
let prisma: PrismaService;
let ledger: LedgerService;
let fx: TradingFixture;
const engine = new EngineProcess();
const code = (p: string) => `${p}${randomBytes(4).toString('hex').toUpperCase()}`;

async function paperAsset(scale: number, faucet: string): Promise<string> {
  const c = code('P');
  await ledger.createAsset(
    { code: c, name: `Paper ${c}`, scale, paper: true, faucetAmount: faucet },
    SYSTEM,
  );
  return c;
}

async function paperMarket() {
  const base = await paperAsset(8, '1');
  const quote = await paperAsset(6, '10000');
  const m = await app
    .get(MarketsService)
    .create(
      { base, quote, tickSize: '0.01', lotSize: '0.0001', makerFeeBps: 10, takerFeeBps: 20 },
      SYSTEM,
    );
  return { symbol: m.symbol, id: m.id, base, quote };
}

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
  ledger = app.get(LedgerService);
  fx = new TradingFixture(app, engine);
  await engine.start();
}, 60_000);

afterAll(async () => {
  await engine.stop();
  await app.close();
});

describe('paper assets and markets', () => {
  it('validates paper asset configuration', async () => {
    await expect(
      ledger.createAsset({ code: code('X'), name: 'x', scale: 2, paper: true }, SYSTEM),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      ledger.createAsset({ code: code('X'), name: 'x', scale: 2, faucetAmount: '1' }, SYSTEM),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const c = await paperAsset(2, '100.5');
    const dto = ledger.toAssetDto(await ledger.requireAsset(c));
    expect(dto).toMatchObject({ paper: true, faucetAmount: '100.5' });
  });

  it('refuses markets that mix paper and real assets (service and database)', async () => {
    const paper = await paperAsset(8, '1');
    const real = code('R');
    await ledger.createAsset({ code: real, name: 'Real', scale: 6 }, SYSTEM);
    await expect(
      app.get(MarketsService).create(
        {
          base: paper,
          quote: real,
          tickSize: '0.01',
          lotSize: '0.0001',
          makerFeeBps: 0,
          takerFeeBps: 0,
        },
        SYSTEM,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const [p, r] = await Promise.all([ledger.requireAsset(paper), ledger.requireAsset(real)]);
    await expect(
      prisma.market.create({
        data: {
          symbol: `${paper}-${real}`,
          baseAssetId: p.id,
          quoteAssetId: r.id,
          tickSize: '1',
          lotSize: '1',
          makerFeeBps: 0,
          takerFeeBps: 0,
          isPaper: true,
        },
      }),
    ).rejects.toThrow(/all be paper or all be real/);
  });

  it('keeps the paper flag immutable', async () => {
    const c = await paperAsset(2, '1');
    await expect(
      prisma.$executeRaw`UPDATE "assets" SET "is_paper" = false WHERE "code" = ${c}`,
    ).rejects.toThrow(/immutable/);
  });
});

describe('namespace isolation in the ledger (database-enforced)', () => {
  it('rejects any journal entry that mixes paper and real assets', async () => {
    const paper = await ledger.requireAsset(await paperAsset(6, '1'));
    const realCode = code('R');
    await ledger.createAsset({ code: realCode, name: 'Real', scale: 6 }, SYSTEM);
    const real = await ledger.requireAsset(realCode);
    const userId = (
      await prisma.user.create({
        data: { email: uniqueEmail('iso'), passwordHash: 'x', status: 'ACTIVE' },
      })
    ).id;
    // SUSPENSE accounts may go negative, so only the namespace rule can stop this entry.
    const paperSuspense = await ledger.ensureAccount(paper.id, 'SUSPENSE', null);
    const realSuspense = await ledger.ensureAccount(real.id, 'SUSPENSE', null);
    const paperUser = await ledger.ensureAccount(paper.id, 'USER_AVAILABLE', userId);
    const realUser = await ledger.ensureAccount(real.id, 'USER_AVAILABLE', userId);
    await expect(
      prisma.$transaction(async (tx) => {
        const e = await tx.journalEntry.create({
          data: {
            type: 'TRADE',
            idempotencyKey: `iso:${randomUUID()}`,
            fingerprint: 'f'.repeat(64),
            description: 'mixed',
            actorType: 'SYSTEM',
          },
        });
        await tx.posting.createMany({
          data: [
            {
              entryId: e.id,
              accountId: paperSuspense.id,
              assetId: paper.id,
              direction: 'DEBIT',
              amount: '5',
            },
            {
              entryId: e.id,
              accountId: paperUser.id,
              assetId: paper.id,
              direction: 'CREDIT',
              amount: '5',
            },
            {
              entryId: e.id,
              accountId: realSuspense.id,
              assetId: real.id,
              direction: 'DEBIT',
              amount: '5',
            },
            {
              entryId: e.id,
              accountId: realUser.id,
              assetId: real.id,
              direction: 'CREDIT',
              amount: '5',
            },
          ],
        });
      }),
    ).rejects.toThrow(/mixes paper and real assets/);
  });

  it('reconciliation flags a mixed-namespace entry if the triggers were ever bypassed', async () => {
    const paper = await ledger.requireAsset(await paperAsset(6, '1'));
    const realCode = code('R');
    await ledger.createAsset({ code: realCode, name: 'Real', scale: 6 }, SYSTEM);
    const real = await ledger.requireAsset(realCode);
    const ps = await ledger.ensureAccount(paper.id, 'SUSPENSE', null);
    const rs = await ledger.ensureAccount(real.id, 'SUSPENSE', null);
    const key = `bypass:${randomUUID()}`;
    // Simulate a privileged actor disabling triggers (superuser-only), then clean up the same way.
    const bypass = (
      sql: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>,
    ) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await sql(tx);
      });
    await bypass(async (tx) => {
      const e = await tx.journalEntry.create({
        data: {
          type: 'TRADE',
          idempotencyKey: key,
          fingerprint: 'f'.repeat(64),
          description: 'bypass',
          actorType: 'SYSTEM',
        },
      });
      await tx.posting.createMany({
        data: [
          { entryId: e.id, accountId: ps.id, assetId: paper.id, direction: 'DEBIT', amount: '1' },
          { entryId: e.id, accountId: ps.id, assetId: paper.id, direction: 'CREDIT', amount: '1' },
          { entryId: e.id, accountId: rs.id, assetId: real.id, direction: 'DEBIT', amount: '1' },
          { entryId: e.id, accountId: rs.id, assetId: real.id, direction: 'CREDIT', amount: '1' },
        ],
      });
    });
    try {
      const run = await app.get(ReconciliationService).run('MANUAL');
      expect(run.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'MIXED_NAMESPACE_ENTRY' })]),
      );
    } finally {
      await bypass(async (tx) => {
        const e = await tx.journalEntry.findUniqueOrThrow({ where: { idempotencyKey: key } });
        await tx.posting.deleteMany({ where: { entryId: e.id } });
        await tx.journalEntry.delete({ where: { id: e.id } });
      });
    }
    expect((await app.get(ReconciliationService).run('MANUAL')).status).toBe('OK');
  });

  it('restricts faucet accounts to paper assets and simulated custody to real assets', async () => {
    const realCode = code('R');
    await ledger.createAsset({ code: realCode, name: 'Real', scale: 6 }, SYSTEM);
    const real = await ledger.requireAsset(realCode);
    const paper = await ledger.requireAsset(await paperAsset(6, '1'));
    await expect(ledger.ensureAccount(real.id, 'PAPER_FAUCET', null)).rejects.toThrow(
      /only allowed for paper assets/,
    );
    await expect(ledger.ensureAccount(paper.id, 'SIMULATED_CUSTODY', null)).rejects.toThrow(
      /only allowed for real assets/,
    );
    const userId = (
      await prisma.user.create({
        data: { email: uniqueEmail('iso'), passwordHash: 'x', status: 'ACTIVE' },
      })
    ).id;
    await expect(
      ledger.simulatedDeposit(
        { userId, assetCode: paper.code, amount: 1n, idempotencyKey: `x:${randomUUID()}` },
        SYSTEM,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('paper faucet', () => {
  it('grants paper funds once per asset per UTC day, only for paper assets', async () => {
    const m = await paperMarket();
    const email = uniqueEmail('paper');
    const client = await createVerifiedUser(app, email);
    const { id: userId } = await prisma.user.findUniqueOrThrow({ where: { email } });

    const first = await client.post('/v1/paper/faucet', { asset: m.quote });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ asset: m.quote, amount: '10000' });
    const again = await client.post('/v1/paper/faucet', { asset: m.quote });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('RATE_LIMITED');
    // A new UTC day allows another grant (service-level, deterministic date).
    await ledger.paperFaucet(userId, m.quote, SYSTEM, new Date(Date.now() + 86_400_000));

    const balances = (await client.get('/v1/me/balances').expect(200)).body.balances as {
      asset: string;
      available: string;
    }[];
    expect(balances.find((b) => b.asset === m.quote)?.available).toBe('20000.000000');

    const realCode = code('R');
    await ledger.createAsset({ code: realCode, name: 'Real', scale: 2 }, SYSTEM);
    const real = await client.post('/v1/paper/faucet', { asset: realCode });
    expect(real.status).toBe(400);
    expect(
      (await client.get('/v1/assets').expect(200)).body.assets.find(
        (a: { code: string }) => a.code === m.base,
      ),
    ).toMatchObject({
      paper: true,
      faucetAmount: '1',
    });
  });

  it('trades paper funds end to end through the real engine and settlement', async () => {
    const m = await paperMarket();
    const seller = await fx.trader();
    const buyer = await fx.trader();
    expect((await seller.client.post('/v1/paper/faucet', { asset: m.base })).status).toBe(201);
    expect((await buyer.client.post('/v1/paper/faucet', { asset: m.quote })).status).toBe(201);

    const ask = await fx.place(seller, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '50',
      quantity: '0.5',
    });
    await fx.until(async () => (await fx.status(ask.body.id)) === 'OPEN');
    const bid = await fx.place(buyer, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '50',
      quantity: '0.5',
    });
    await fx.until(async () => (await fx.status(bid.body.id)) === 'FILLED');

    const markets = (await buyer.client.get('/v1/markets').expect(200)).body.markets as {
      symbol: string;
      paper: boolean;
    }[];
    expect(markets.find((x) => x.symbol === m.symbol)?.paper).toBe(true);
    // Paper fees accrue to a separate paper fee account; the trade entry stays single-namespace.
    const trade = await prisma.trade.findFirstOrThrow({ where: { marketId: m.id } });
    const assets = await prisma.posting.findMany({
      where: { entryId: trade.journalEntryId },
      include: { asset: true },
    });
    expect(new Set(assets.map((p) => p.asset.isPaper))).toEqual(new Set([true]));
    expect((await app.get(ReconciliationService).run('MANUAL')).status).toBe('OK');
  });
});

describe('order abuse controls', () => {
  it('rate-limits order commands per user', async () => {
    const m = await paperMarket();
    const t = await fx.trader();
    await t.client.post('/v1/paper/faucet', { asset: m.quote });
    // Fixed one-second windows (server clock). A fast sequential stream (> 10/s)
    // must be refused within at most two windows, so at most 2 × 10 get through.
    // (Client-side timestamps cannot attribute requests to server windows exactly.)
    let accepted = 0;
    let refused = false;
    for (let i = 0; i < 60 && !refused; i++) {
      const res = await fx.place(t, {
        market: m.symbol,
        side: 'buy',
        type: 'limit',
        price: '1',
        quantity: '0.0001',
      });
      if (res.status === 202) accepted++;
      else if (res.status === 429) refused = true;
      else throw new Error(`unexpected status ${res.status}`);
    }
    expect(refused).toBe(true);
    expect(accepted).toBeGreaterThanOrEqual(1);
    expect(accepted).toBeLessThanOrEqual(20);
  });

  it('caps open orders per user per market', async () => {
    const m = await paperMarket();
    const t = await fx.trader();
    await t.client.post('/v1/paper/faucet', { asset: m.quote });
    const { OrdersService } = await import('../src/trading/orders.service');
    // Test-only: swap the service's (frozen) config for one with a tiny cap.
    const orders = app.get<unknown, { config: Record<string, number> }>(OrdersService);
    const originalConfig = orders.config;
    orders.config = { ...originalConfig, MAX_OPEN_ORDERS_PER_MARKET: 2 };
    try {
      for (let i = 0; i < 2; i++) {
        expect(
          (
            await fx.place(t, {
              market: m.symbol,
              side: 'buy',
              type: 'limit',
              price: '1',
              quantity: '0.0001',
            })
          ).status,
        ).toBe(202);
      }
      const third = await fx.place(t, {
        market: m.symbol,
        side: 'buy',
        type: 'limit',
        price: '1',
        quantity: '0.0001',
      });
      expect(third.status).toBe(409);
      expect(third.body.error.code).toBe('LIMIT_EXCEEDED');
    } finally {
      orders.config = originalConfig;
    }
  });
});

describe('engine-replay', () => {
  it('reproduces the recorded event history of every market exactly', () => {
    const binary = resolve(
      __dirname,
      '../../../services/matching-engine/target/debug/engine-replay',
    );
    const out = execFileSync(binary, [], {
      env: { ...process.env },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const reports = out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { market: string; ok: boolean; report: { events: number } });
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.filter((r) => !r.ok)).toEqual([]);
    expect(reports.reduce((s, r) => s + r.report.events, 0)).toBeGreaterThan(0);
  });
});
