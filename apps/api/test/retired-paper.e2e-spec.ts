import type { INestApplication } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { EngineProcess } from './engine';
import { bootApp } from './helpers';
import { TradingFixture } from './trading-helpers';

/**
 * Real markets only (ADR-0016): paper trading is retired. The database refuses
 * new paper rows and faucet grants; the faucet endpoint is gone. Also covers
 * order abuse controls and engine replay on real markets.
 */
let app: INestApplication;
let prisma: PrismaService;
let fx: TradingFixture;
const engine = new EngineProcess();
const code = (p: string) => `${p}${randomBytes(4).toString('hex').toUpperCase()}`;

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
  fx = new TradingFixture(app, engine);
  await engine.start();
}, 60_000);

afterAll(async () => {
  await engine.stop();
  await app.close();
});

describe('paper trading is retired', () => {
  it('the database refuses new paper assets and markets', async () => {
    await expect(
      prisma.asset.create({ data: { code: code('P'), name: 'Paper', scale: 2, isPaper: true } }),
    ).rejects.toThrow(/Paper trading is retired/);
    const m = await fx.market();
    const market = await prisma.market.findUniqueOrThrow({ where: { symbol: m.symbol } });
    await expect(
      prisma.market.create({
        data: {
          symbol: `${code('A')}-${code('B')}`,
          baseAssetId: market.baseAssetId,
          quoteAssetId: market.quoteAssetId,
          tickSize: '1',
          lotSize: '1',
          makerFeeBps: 0,
          takerFeeBps: 0,
          isPaper: true,
        },
      }),
    ).rejects.toThrow(/Paper trading is retired|all be paper or all be real/);
  });

  it('the database refuses faucet grants', async () => {
    await expect(
      prisma.journalEntry.create({
        data: {
          type: 'PAPER_FAUCET_GRANT',
          idempotencyKey: `retired:${code('K')}`,
          fingerprint: '0'.repeat(64),
          description: 'must fail',
          actorType: 'SYSTEM',
        },
      }),
    ).rejects.toThrow(/no faucet grants/);
  });

  it('has no faucet endpoint and lists only real markets', async () => {
    const t = await fx.trader();
    expect((await t.client.post('/v1/paper/faucet', { asset: 'X' })).status).toBe(404);
    const markets = (await t.client.get('/v1/markets')).body.markets as { symbol: string }[];
    const paper = await prisma.market.findMany({ where: { isPaper: true } });
    for (const p of paper) expect(markets.map((x) => x.symbol)).not.toContain(p.symbol);
  });
});

describe('order abuse controls', () => {
  it('rate-limits order commands per user', async () => {
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.quote, amount: '10000', scale: 6 }]);
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
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.quote, amount: '10000', scale: 6 }]);
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
