import type { INestApplication } from '@nestjs/common';
import { parseAmount, type PerpConfigInput } from '@platform/shared';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { toMinorUnits } from '../src/ledger/ledger-domain';
import { LedgerService } from '../src/ledger/ledger.service';
import { ReconciliationService } from '../src/ledger/reconciliation.service';
import { parsePerpConfig, sourceLabel } from '../src/perps/perp-config';
import { CollateralService } from '../src/perps/collateral.service';
import { PerpRiskService } from '../src/perps/perp-risk.service';
import { PerpsService } from '../src/perps/perps.service';
import { MarketsService, type MarketWithAssets } from '../src/trading/markets.service';
import { EngineProcess } from './engine';
import { bootApp } from './helpers';
import { SYSTEM, TradingFixture, type Trader } from './trading-helpers';

let app: INestApplication;
let prisma: PrismaService;
let ledger: LedgerService;
let risk: PerpRiskService;
let perps: PerpsService;
let fx: TradingFixture;
const engine = new EngineProcess();
const code = (p: string) => `${p}${randomBytes(4).toString('hex').toUpperCase()}`;
const USD = 1_000_000n; // quote scale 6

function perpConfig(overrides: Partial<PerpConfigInput> = {}, spot?: string): PerpConfigInput {
  return {
    defaultLeverage: 10,
    tiers: [
      { maxNotional: '100000', maxLeverage: 10, mmrBps: 500 },
      { maxNotional: '1000000', maxLeverage: 5, mmrBps: 1000 },
    ],
    fundingIntervalSeconds: 60,
    fundingClampBps: 75,
    maxBasisBps: 50,
    liquidationFeeBps: 50,
    priceBandBps: 1000,
    index: {
      sources: spot
        ? [{ type: 'spot', market: spot }]
        : [{ type: 'simulated', start: '100', volatilityBps: 1, seed: 'test' }],
      staleSeconds: 30,
      outlierBps: 500,
      minSources: 1,
    },
    ...overrides,
  };
}

interface Perp {
  symbol: string;
  market: MarketWithAssets;
  base: string;
  quote: string;
  spot: string;
}

async function perpMarket(
  overrides: Partial<PerpConfigInput> = {},
  fees = { makerFeeBps: 0, takerFeeBps: 0 },
): Promise<Perp> {
  const base = code('PB');
  const quote = code('PQ');
  await ledger.createAsset({ code: base, name: `Base ${base}`, scale: 8 }, SYSTEM);
  await ledger.createAsset({ code: quote, name: `Quote ${quote}`, scale: 6 }, SYSTEM);
  const markets = app.get(MarketsService);
  const spot = await markets.create(
    { base, quote, tickSize: '0.01', lotSize: '0.0001', makerFeeBps: 0, takerFeeBps: 0 },
    SYSTEM,
  );
  const perp = await markets.create(
    {
      base,
      quote,
      tickSize: '0.01',
      lotSize: '0.0001',
      ...fees,
      kind: 'perpetual',
      perp: perpConfig(overrides, spot.symbol),
    },
    SYSTEM,
  );
  return { symbol: perp.symbol, market: perp, base, quote, spot: spot.symbol };
}

/** Writes a mark/index sample directly (the risk engine's own table) to control prices. */
async function setMark(p: Perp, price: bigint, at = new Date(), premiumRate: bigint | null = null) {
  await prisma.perpPriceSample.create({
    data: {
      marketId: p.market.id,
      sampledAt: at,
      indexPrice: price.toString(),
      markPrice: price.toString(),
      premiumRate,
      sourcesUsed: 1,
    },
  });
}

/** A trader with 100 000 quote (simulated custody: local/ci test fixture only). */
async function funded(p: Perp, base = false): Promise<Trader> {
  return fx.trader([
    { asset: p.quote, amount: '100000', scale: 6 },
    ...(base ? [{ asset: p.base, amount: '10', scale: 8 }] : []),
  ]);
}

async function balance(userId: string, asset: string, type: 'USER_AVAILABLE' | 'USER_MARGIN') {
  const a = await ledger.requireAsset(asset);
  const acc = await prisma.ledgerAccount.findFirst({
    where: { assetId: a.id, type, ownerUserId: userId },
  });
  return acc ? toMinorUnits(acc.balance) : 0n;
}

async function position(p: Perp, userId: string) {
  return prisma.position.findUnique({
    where: { userId_marketId: { userId, marketId: p.market.id } },
  });
}

async function expectReconciled() {
  const run = await app.get(ReconciliationService).run('CLI');
  expect(run.findings).toEqual([]);
  expect(run.status).toBe('OK');
}

/** Places an order and waits until it rests or completes. */
async function placed(t: Trader, body: Record<string, unknown>) {
  const res = await fx.place(t, body);
  expect(res.status).toBe(202);
  await fx.until(async () => (await fx.status(res.body.id)) !== 'PENDING_NEW');
  return res.body.id as string;
}

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
  ledger = app.get(LedgerService);
  risk = app.get(PerpRiskService);
  perps = app.get(PerpsService);
  fx = new TradingFixture(app, engine);
  await engine.start();
}, 60_000);

afterAll(async () => {
  await engine.stop();
  await app.close();
});

describe('perpetual markets', () => {
  it('settle on real assets, are validated, and are described in the market DTO', async () => {
    const markets = app.get(MarketsService);
    // The market kind is immutable once created (database trigger).
    const spot = await fx.market();
    await expect(
      prisma.$executeRaw`UPDATE "markets" SET "kind" = 'PERPETUAL', "perp_config" = '{}' WHERE "id" = ${spot.id}::uuid`,
    ).rejects.toThrow(/immutable/);

    const p = await perpMarket();
    expect(p.symbol).toBe(`${p.base}-${p.quote}-PERP`);
    expect(p.market.isPaper).toBe(false);
    const dto = markets.toDto(p.market);
    expect(dto).toMatchObject({ kind: 'perpetual', vaultBacked: false });
    expect(dto.perp).toMatchObject({ defaultLeverage: 10, maxLeverage: 10, liquidationFeeBps: 50 });

    await expect(
      perpMarket({
        tiers: [{ maxNotional: '1000', maxLeverage: 50, mmrBps: 500 }], // mmr × leverage ≥ 100%
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('allows derivative ledger accounts for real assets', async () => {
    const real = code('R');
    await ledger.createAsset({ code: real, name: 'Real', scale: 6 }, SYSTEM);
    const asset = await ledger.requireAsset(real);
    await expect(ledger.ensureAccount(asset.id, 'INSURANCE_FUND', null)).resolves.toBeTruthy();
  });

  it('derives index and mark from the spot book and labels simulated feeds', async () => {
    const p = await perpMarket();
    const mm = await funded(p, true);
    await placed(mm, { market: p.spot, side: 'buy', type: 'limit', price: '99', quantity: '0.1' });
    await placed(mm, {
      market: p.spot,
      side: 'sell',
      type: 'limit',
      price: '101',
      quantity: '0.1',
    });
    const config = parsePerpConfig(p.market.perpConfig);
    await risk.sample(p.market, config);
    const stats = await perps.stats(p.symbol);
    expect(stats).toMatchObject({ indexPrice: '100', markPrice: '100', indexStale: false });
    expect(stats.sourcesUsed).toBe(1);

    const dto = app.get(MarketsService).toDto(await app.get(MarketsService).require(p.symbol));
    expect(dto.perp!.indexSources[0]).toMatch(/mid price/);
    const label = sourceLabel(
      { type: 'simulated', start: 100n * USD, volatilityBps: 1, seed: 's' },
      6,
    );
    expect(label).toMatch(/^TEST-ONLY SIMULATED feed .*not a real price/);
    expect(
      sourceLabel({ type: 'oracle', address: '0x' + 'ab'.repeat(20), label: 'BTC / USD' }, 6),
    ).toMatch(/^Oracle feed BTC \/ USD/);
  });
});

describe('perpetual trading', () => {
  it('rejects risk-increasing orders without a mark, and prices outside the band', async () => {
    const p = await perpMarket();
    const a = await funded(p);
    const order = { market: p.symbol, side: 'buy', type: 'limit', price: '100', quantity: '1' };
    expect((await fx.place(a, order)).status).toBe(409);
    await setMark(p, 100n * USD);
    expect((await fx.place(a, { ...order, price: '111' })).status).toBe(400);
    expect((await fx.place(a, { ...order, reduceOnly: true })).status).toBe(400); // no position
    // Spot markets do not accept reduceOnly.
    expect((await fx.place(a, { ...order, market: p.spot, reduceOnly: true })).status).toBe(400);
  });

  it('opens and closes positions with exact margin, PnL and clearing', async () => {
    const p = await perpMarket();
    await setMark(p, 100n * USD);
    const a = await funded(p);
    const b = await funded(p);
    const start = 100_000n * USD;

    await placed(a, { market: p.symbol, side: 'buy', type: 'limit', price: '100', quantity: '1' });
    const sell = await placed(b, {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(sell)) === 'FILLED');

    const pa = (await position(p, a.userId))!;
    const pb = (await position(p, b.userId))!;
    expect(pa).toMatchObject({ sizeLots: 10_000n, status: 'NORMAL', leverage: 10 });
    expect(toMinorUnits(pa.entryNotional)).toBe(100n * USD);
    expect(toMinorUnits(pa.margin)).toBe(10n * USD); // 10x
    expect(pb.sizeLots).toBe(-10_000n);
    expect(toMinorUnits(pb.entryNotional)).toBe(-100n * USD);
    expect(await balance(a.userId, p.quote, 'USER_AVAILABLE')).toBe(start - 10n * USD);
    expect(await balance(a.userId, p.quote, 'USER_MARGIN')).toBe(10n * USD);
    await expectReconciled();

    const dto = (await perps.positions(a.userId)).find((x) => x.market === p.symbol)!;
    expect(dto).toMatchObject({
      side: 'long',
      size: '1',
      entryPrice: '100',
      margin: '10',
      bankruptcyPrice: '90',
      unrealizedPnl: '0',
    });

    // Close at 110: A gains 10, B loses 10. Both flat; all margin released.
    await setMark(p, 110n * USD);
    await placed(a, {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      price: '110',
      quantity: '1',
      reduceOnly: true,
    });
    const close = await placed(b, {
      market: p.symbol,
      side: 'buy',
      type: 'limit',
      price: '110',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(close)) === 'FILLED');
    expect(await position(p, a.userId)).toMatchObject({ sizeLots: 0n });
    expect(toMinorUnits((await position(p, a.userId))!.realizedPnl)).toBe(10n * USD);
    expect(await balance(a.userId, p.quote, 'USER_AVAILABLE')).toBe(start + 10n * USD);
    expect(await balance(b.userId, p.quote, 'USER_AVAILABLE')).toBe(start - 10n * USD);
    expect(await balance(a.userId, p.quote, 'USER_MARGIN')).toBe(0n);
    await expectReconciled();
  });

  it('take-profit / stop-loss: one-cancels-the-other pair sized to the position', async () => {
    const p = await perpMarket();
    await setMark(p, 100n * USD);
    const a = await funded(p);
    const b = await funded(p);
    await placed(a, { market: p.symbol, side: 'buy', type: 'limit', price: '100', quantity: '1' });
    const s = await placed(b, {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(s)) === 'FILLED');

    // Wrong side of the mark is refused; a flat account cannot set TP/SL.
    const wrong = await a.client.post('/v1/perp/tpsl', { market: p.symbol, stopLoss: '101' });
    expect(wrong.status).toBe(400);
    const flat = await funded(p);
    expect(
      (await flat.client.post('/v1/perp/tpsl', { market: p.symbol, stopLoss: '95' })).status,
    ).toBe(409);

    // A first stop-loss, then replaced by a full pair (the first one is cancelled).
    const first = await a.client.post('/v1/perp/tpsl', { market: p.symbol, stopLoss: '96' });
    expect(first.status).toBe(201);
    const firstId = first.body.orders[0].id as string;
    const pair = await a.client.post('/v1/perp/tpsl', {
      market: p.symbol,
      takeProfit: '105',
      stopLoss: '95',
    });
    expect(pair.status).toBe(201);
    const [tp, sl] = pair.body.orders as { id: string; trigger: string; reduceOnly: boolean }[];
    expect(tp).toMatchObject({ trigger: 'above', reduceOnly: true, type: 'stop_market' });
    expect(sl).toMatchObject({ trigger: 'below', reduceOnly: true });
    await fx.until(async () => (await fx.status(firstId)) === 'CANCELLED');
    await fx.until(async () => (await fx.status(sl!.id)) === 'PENDING_TRIGGER');

    // The price trades up to 105: the take-profit fires and closes the long.
    const c = await funded(p);
    const d = await funded(p);
    await placed(c, { market: p.symbol, side: 'buy', type: 'limit', price: '104', quantity: '1' });
    await placed(c, { market: p.symbol, side: 'buy', type: 'limit', price: '105', quantity: '1' });
    await placed(d, { market: p.symbol, side: 'sell', type: 'limit', price: '105', quantity: '1' });
    await fx.until(async () => (await fx.status(tp!.id)) === 'FILLED');
    const pa = (await position(p, a.userId))!;
    expect(pa.sizeLots).toBe(0n);
    expect(toMinorUnits(pa.realizedPnl)).toBe(4n * USD); // filled at the 104 bid
    // The stop-loss is cancelled by the one-cancels-the-other rule.
    expect(await risk.cancelOcoSiblings(p.market)).toBe(1);
    await fx.until(async () => (await fx.status(sl!.id)) === 'CANCELLED');
    await expectReconciled();
  });

  it('pays a tier maker rebate out of the taker fee (ADR-0018)', async () => {
    const p = await perpMarket({}, { makerFeeBps: 0, takerFeeBps: 10 });
    await setMark(p, 100n * USD);
    const maker = await funded(p);
    const taker = await funded(p);
    await prisma.userFeeTier.create({
      data: { userId: maker.userId, tier: 4, volume30d: '0', computedAt: new Date() },
    });
    await placed(maker, {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    const take = await placed(taker, {
      market: p.symbol,
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(take)) === 'FILLED');
    // Taker fee 10 bps of 100 = 0.1; maker rebate 4 bps of 100 = 0.04.
    const start = 100_000n * USD;
    expect(await balance(maker.userId, p.quote, 'USER_AVAILABLE')).toBe(
      start - 10n * USD + 40_000n,
    );
    expect(await balance(taker.userId, p.quote, 'USER_AVAILABLE')).toBe(
      start - 10n * USD - 100_000n,
    );
    const rebate = await prisma.feePayout.findFirstOrThrow({
      where: { userId: maker.userId, kind: 'maker_rebate' },
    });
    expect(toMinorUnits(rebate.amount)).toBe(40_000n);
    await expectReconciled();
  });

  it('cross margin: free balance tops up a weakening position instead of liquidating it (ADR-0021)', async () => {
    const p = await perpMarket();
    await setMark(p, 100n * USD);
    const cross = await funded(p);
    const iso = await funded(p);
    const short = await funded(p);
    expect((await cross.client.post('/v1/perp/margin-mode', { mode: 'cross' })).body).toEqual({
      mode: 'cross',
    });
    for (const t of [cross, iso]) {
      await placed(t, {
        market: p.symbol,
        side: 'buy',
        type: 'limit',
        price: '100',
        quantity: '1',
      });
    }
    const s = await placed(short, {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '2',
    });
    await fx.until(async () => (await fx.status(s)) === 'FILLED');

    // Mark 92: both longs have equity 2 < maintenance 4.6.
    await setMark(p, 92n * USD);
    await risk.liquidate(p.market, parsePerpConfig(p.market.perpConfig));
    const c = (await position(p, cross.userId))!;
    expect(c.status).toBe('NORMAL');
    expect(toMinorUnits(c.margin)).toBe(10n * USD + 7_200_000n); // back to initial margin at 92
    expect(await balance(cross.userId, p.quote, 'USER_AVAILABLE')).toBe(
      100_000n * USD - 10n * USD - 7_200_000n,
    );
    expect((await position(p, iso.userId))!.status).toBe('LIQUIDATING');
    await expectReconciled();
  });

  it('caps market open interest; reducing is always allowed (ADR-0032)', async () => {
    const markets = app.get(MarketsService);
    // Cap 250 quote at mark: two 1-unit positions at 100 fit, a third does not.
    const p = await perpMarket({ maxOpenInterest: '250' });
    expect(markets.toDto(p.market).perp!.maxOpenInterest).toBe('250');
    await setMark(p, 100n * USD);
    const a = await funded(p);
    const b = await funded(p);
    const open = { market: p.symbol, type: 'limit', price: '100', quantity: '1' };
    for (let i = 0; i < 2; i++) {
      await placed(a, { ...open, side: 'buy' });
      const s = await placed(b, { ...open, side: 'sell' });
      await fx.until(async () => (await fx.status(s)) === 'FILLED');
    }
    expect((await perps.stats(p.symbol)).openInterest).toBe('2');
    expect((await perps.stats(p.symbol)).openInterestNotional).toBe('200');

    // Either side growing open interest is refused; nothing is held for it.
    const before = await balance(a.userId, p.quote, 'USER_AVAILABLE');
    const refused = await fx.place(a, { ...open, side: 'buy' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('LIMIT_EXCEEDED');
    expect((await fx.place(b, { ...open, side: 'sell' })).status).toBe(409);
    expect(await balance(a.userId, p.quote, 'USER_AVAILABLE')).toBe(before);
    // A smaller order that still fits is accepted (it rests below the market).
    await placed(a, { ...open, side: 'buy', price: '99', quantity: '0.5' });

    // Closing is never blocked by the cap.
    await placed(b, { ...open, side: 'buy', reduceOnly: true });
    const close = await placed(a, { ...open, side: 'sell', reduceOnly: true });
    await fx.until(async () => (await fx.status(close)) === 'FILLED');
    expect((await perps.stats(p.symbol)).openInterest).toBe('1');

    // Staff can raise or remove the cap; the change is audited.
    const uncapped = await markets.setOpenInterestCap(p.symbol, null, SYSTEM);
    expect(markets.toDto(uncapped).perp!.maxOpenInterest).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'trading.market.open_interest_cap_changed', targetId: p.symbol },
    });
    expect(audit?.metadata).toMatchObject({ from: '250000000', to: null });
    expect(parsePerpConfig(uncapped.perpConfig).tiers).toHaveLength(2); // other parameters kept
    await expect(markets.setOpenInterestCap(p.spot, '10', SYSTEM)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expectReconciled();
  });

  it('enforces reduce-only size, the bankruptcy price and leverage rules', async () => {
    const p = await perpMarket();
    await setMark(p, 100n * USD);
    const a = await funded(p);
    const b = await funded(p);
    await placed(a, { market: p.symbol, side: 'buy', type: 'limit', price: '100', quantity: '1' });
    const s = await placed(b, {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(s)) === 'FILLED');

    const close = {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      quantity: '1',
      reduceOnly: true,
    };
    expect((await fx.place(a, { ...close, quantity: '2', price: '100' })).status).toBe(400);
    // 10x long from 100: bankruptcy at 90; a close at 91 is fine, 90 is the limit, below is refused.
    await setMark(p, 92n * USD);
    expect((await fx.place(a, { ...close, price: '89.99' })).status).toBe(400);
    // Leverage cannot change with an open position; margin can be added.
    expect(
      (await a.client.post('/v1/perp/leverage', { market: p.symbol, leverage: 5 })).status,
    ).toBe(409);
    const added = await a.client.post('/v1/perp/margin', { market: p.symbol, amount: '5' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ margin: '15', bankruptcyPrice: '85' });
    expect((await fx.place(a, { ...close, price: '89.99' })).status).toBe(202);
    await expectReconciled();

    const c = await funded(p);
    expect(
      (await c.client.post('/v1/perp/leverage', { market: p.symbol, leverage: 50 })).status,
    ).toBe(400);
    const lev = await c.client.post('/v1/perp/leverage', { market: p.symbol, leverage: 2 });
    expect(lev.status).toBe(201);
    expect(lev.body.leverage).toBe(2);
  });
});

describe('funding', () => {
  it('moves funding from longs to shorts once per interval, zero-sum and reconciled', async () => {
    const p = await perpMarket();
    const config = parsePerpConfig(p.market.perpConfig);
    await setMark(p, 100n * USD);
    const a = await funded(p);
    const b = await funded(p);
    await placed(a, { market: p.symbol, side: 'buy', type: 'limit', price: '100', quantity: '1' });
    const s = await placed(b, {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(s)) === 'FILLED');

    const t0 = new Date();
    await risk.sample(p.market, config, t0); // creates the risk state row
    expect(await risk.settleFunding(p.market, config, t0)).toBe(false); // first interval starts
    const state = await prisma.perpMarketState.findUniqueOrThrow({
      where: { marketId: p.market.id },
    });
    const boundary = new Date(state.lastFundingAt!.getTime() + 60_000);
    // A 0.01% premium during the interval, and a fresh mark at the boundary.
    await setMark(p, 100n * USD, new Date(boundary.getTime() - 1000), 10_000n);
    const marginA = await balance(a.userId, p.quote, 'USER_MARGIN');
    expect(await risk.settleFunding(p.market, config, new Date(boundary.getTime() + 10))).toBe(
      true,
    );
    expect(await risk.settleFunding(p.market, config, new Date(boundary.getTime() + 20))).toBe(
      false,
    ); // idempotent

    // 0.01% of 100 = 0.01 paid by the long to the short.
    expect(await balance(a.userId, p.quote, 'USER_MARGIN')).toBe(marginA - 10_000n);
    const pa = (await position(p, a.userId))!;
    expect(toMinorUnits(pa.fundingPnl)).toBe(-10_000n);
    expect(toMinorUnits((await position(p, b.userId))!.fundingPnl)).toBe(10_000n);
    const [round] = await perps.fundingHistory(p.symbol, 1);
    expect(round).toMatchObject({ rate: '0.0100', collected: '0.01', distributed: '0.01' });
    await expectReconciled();
  });
});

describe('liquidation', () => {
  it('liquidates a position below maintenance margin at no worse than the bankruptcy price', async () => {
    const p = await perpMarket();
    await setMark(p, 100n * USD);
    const a = await funded(p);
    const b = await funded(p);
    const mm = await funded(p);
    await placed(a, { market: p.symbol, side: 'buy', type: 'limit', price: '100', quantity: '1' });
    const s = await placed(b, {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(s)) === 'FILLED');
    // A also has a resting order that the liquidation must cancel first.
    const resting = await placed(a, {
      market: p.symbol,
      side: 'buy',
      type: 'limit',
      price: '91',
      quantity: '0.5',
    });
    // Liquidity for the liquidation order.
    await placed(mm, { market: p.symbol, side: 'buy', type: 'limit', price: '95', quantity: '1' });

    const config = parsePerpConfig(p.market.perpConfig);
    await setMark(p, 94n * USD); // equity 4 < maintenance 4.70 (5% of 94)
    expect(await risk.liquidate(p.market, config)).toBe(1);
    expect((await position(p, a.userId))!.status).toBe('LIQUIDATING');
    expect(
      (
        await fx.place(a, {
          market: p.symbol,
          side: 'buy',
          type: 'limit',
          price: '94',
          quantity: '0.1',
        })
      ).status,
    ).toBe(409);
    await fx.until(async () => (await fx.status(resting)) === 'CANCELLED');

    expect(await risk.liquidate(p.market, config)).toBe(1); // places the liquidation order
    const liq = await prisma.order.findFirstOrThrow({
      where: { userId: a.userId, marketId: p.market.id, isLiquidation: true },
    });
    expect(liq).toMatchObject({
      side: 'SELL',
      type: 'MARKET',
      timeInForce: 'IOC',
      reduceOnly: true,
    });
    expect(liq.priceTicks).toBe(9_000n); // bankruptcy price 90.00
    await fx.until(async () => (await fx.status(liq.id)) === 'FILLED');

    const pa = (await position(p, a.userId))!;
    expect(pa).toMatchObject({ sizeLots: 0n, status: 'NORMAL' });
    expect(toMinorUnits(pa.realizedPnl)).toBe(-5n * USD); // filled at 95
    // Payout = margin 10 − loss 5 − liquidation fee 0.5% × 95 (0.475) to the insurance fund.
    expect(await balance(a.userId, p.quote, 'USER_AVAILABLE')).toBe(
      100_000n * USD - 10n * USD + 5n * USD - 475_000n,
    );
    const funds = await perps.insuranceFunds();
    expect(funds.find((f) => f.asset === p.quote)?.balance).toBe('0.475');
    expect((await position(p, mm.userId))!.sizeLots).toBe(10_000n);
    await expectReconciled();
  });

  it('tops up the insurance fund from collected fees only (nothing is minted)', async () => {
    const m = await fx.market({ makerFeeBps: 0, takerFeeBps: 100 });
    const seller = await fx.trader([{ asset: m.base, amount: '1', scale: 8 }]);
    const buyer = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const ask = await placed(buyer, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    const taker = await fx.place(seller, {
      market: m.symbol,
      side: 'sell',
      type: 'market',
      quantity: '1',
    });
    expect(taker.status).toBe(202);
    await fx.until(async () => (await fx.status(ask)) === 'FILLED');
    // The taker (seller) paid 1% of 100 in the quote asset.
    await expect(perps.seedInsuranceFund(m.quote, '1000', SYSTEM)).rejects.toThrow();
    expect(await perps.seedInsuranceFund(m.quote, '0.6', SYSTEM)).toBe('0.6');
    const funds = await perps.insuranceFunds();
    expect(funds.find((f) => f.asset === m.quote)?.balance).toBe('0.6');
    expect(parseAmount('0.6', 6)).toBe(600_000n);
    await expectReconciled();
  });
});

describe('multi-collateral (ADR-0027)', () => {
  it('sells pledged collateral at no worse than bid minus haircut, then the proceeds back the position', async () => {
    const p = await perpMarket();
    await setMark(p, 100n * USD);
    // Collateral asset C with its own spot market C / quote.
    const c = code('CB');
    await ledger.createAsset({ code: c, name: `Collateral ${c}`, scale: 8 }, SYSTEM);
    const cSpot = await app.get(MarketsService).create(
      {
        base: c,
        quote: p.quote,
        tickSize: '0.01',
        lotSize: '0.0001',
        makerFeeBps: 0,
        takerFeeBps: 0,
      },
      SYSTEM,
    );
    const staff = await fx.trader();
    const collateral = app.get(CollateralService);
    const ctx = { requestId: 't', ipAddress: null, userAgent: null };
    await expect(
      collateral.configure(
        staff.userId,
        { asset: c, market: p.symbol, haircutBps: 1000, enabled: true },
        ctx,
      ),
    ).rejects.toThrow(/spot market/);
    await collateral.configure(
      staff.userId,
      { asset: c, market: cSpot.symbol, haircutBps: 1000, enabled: true },
      ctx,
    );

    // Only 10 quote free: all of it becomes margin. 1 C is pledged.
    const t = await fx.trader([
      { asset: p.quote, amount: '10', scale: 6 },
      { asset: c, amount: '1', scale: 8 },
    ]);
    await t.client.post('/v1/perp/margin-mode', { mode: 'cross' });
    expect((await t.client.post('/v1/perp/collateral', { enabled: true })).body).toMatchObject({
      enabled: true,
      crossMode: true,
    });
    const bidder = await fx.trader([{ asset: p.quote, amount: '1000', scale: 6 }]);
    await placed(bidder, {
      market: cSpot.symbol,
      side: 'buy',
      type: 'limit',
      price: '50',
      quantity: '1',
    });
    const mine = (await t.client.get('/v1/perp/collateral')).body;
    expect(mine.assets.find((a: { asset: string }) => a.asset === c)).toMatchObject({
      balance: '1',
      bid: '50',
      value: '45', // 1 × 50 × 0.9
      haircutBps: 1000,
    });

    const short = await funded(p);
    await placed(t, { market: p.symbol, side: 'buy', type: 'limit', price: '100', quantity: '1' });
    const s = await placed(short, {
      market: p.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(s)) === 'FILLED');
    expect(await balance(t.userId, p.quote, 'USER_AVAILABLE')).toBe(0n);

    // Mark 95.5: equity 5.5 < 1.25 × maintenance 4.775, nothing free → convert collateral.
    // Shortfall to initial margin at 95.5 is 4.05; at the floor 45 that is 0.09 C.
    await setMark(p, 95_500_000n);
    const cfg = parsePerpConfig(p.market.perpConfig);
    await risk.liquidate(p.market, cfg);
    await risk.liquidate(p.market, cfg); // one conversion in flight at a time
    const conv = await prisma.order.findMany({
      where: { userId: t.userId, clientOrderId: { startsWith: 'collat-' } },
    });
    expect(conv).toHaveLength(1);
    expect(conv[0]).toMatchObject({
      side: 'SELL',
      timeInForce: 'IOC',
      priceTicks: 4500n,
      quantityLots: 900n,
    });
    await fx.until(async () => (await fx.status(conv[0]!.id)) === 'FILLED');
    expect(await balance(t.userId, p.quote, 'USER_AVAILABLE')).toBe(4_500_000n); // sold at the bid, 50

    // Next tick: the proceeds back the position.
    await risk.liquidate(p.market, cfg);
    const pos = (await position(p, t.userId))!;
    expect(pos.status).toBe('NORMAL');
    expect(toMinorUnits(pos.margin)).toBe(10n * USD + 4_050_000n);
    expect(await balance(t.userId, p.quote, 'USER_AVAILABLE')).toBe(450_000n);
    expect(
      await prisma.auditLog.count({
        where: { action: 'perp.collateral.conversion', targetId: conv[0]!.id },
      }),
    ).toBe(1);

    // Opted out: nothing is sold.
    await t.client.post('/v1/perp/collateral', { enabled: false });
    await setMark(p, 95_000_000n);
    await risk.liquidate(p.market, cfg);
    expect(
      await prisma.order.count({
        where: { userId: t.userId, clientOrderId: { startsWith: 'collat-' } },
      }),
    ).toBe(1);
    await expectReconciled();
  });
});
