import type { INestApplication } from '@nestjs/common';
import type { AlgoOrderDto } from '@platform/shared';
import { AlgoOrdersService } from '../src/algo/algo-orders.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { MarketDataService } from '../src/market-data/market-data.service';
import { EngineProcess } from './engine';
import { bootApp } from './helpers';
import { TradingFixture, type Trader } from './trading-helpers';

/** Pro order tools (ADR-0025): hidden, scaled, trailing stop, chase, grid and its marketplace. */
let app: INestApplication;
let prisma: PrismaService;
let fx: TradingFixture;
let algos: AlgoOrdersService;
const engine = new EngineProcess();

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
  algos = app.get(AlgoOrdersService);
  fx = new TradingFixture(app, engine);
  await engine.start();
}, 60_000);

afterAll(async () => {
  await engine.stop();
  await app.close();
});

type Market = Awaited<ReturnType<TradingFixture['market']>>;

async function children(id: string) {
  return prisma.order.findMany({ where: { algoOrderId: id }, orderBy: { createdAt: 'asc' } });
}
async function settled(id: string) {
  await fx.until(async () => (await children(id)).every((c) => c.status !== 'PENDING_NEW'));
}
async function rest(t: Trader, m: Market, side: 'buy' | 'sell', price: string, quantity: string) {
  const o = await fx.place(t, { market: m.symbol, side, type: 'limit', price, quantity });
  expect(o.status).toBe(202);
  await fx.until(async () => ['OPEN', 'FILLED'].includes(await fx.status(o.body.id)));
  return o.body.id as string;
}
/** Prints a trade at `price` between two fresh traders (sets the last price). */
async function printTrade(m: Market, price: string) {
  const s = await fx.trader([{ asset: m.base, amount: '1', scale: 8 }]);
  const b = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
  await rest(s, m, 'sell', price, '0.01');
  const id = await rest(b, m, 'buy', price, '0.01');
  await fx.until(async () => (await fx.status(id)) === 'FILLED');
}
async function algo(id: string, t: Trader): Promise<AlgoOrderDto> {
  const list = (await t.client.get('/v1/algo-orders')).body.algoOrders as AlgoOrderDto[];
  return list.find((a) => a.id === id)!;
}

describe('hidden orders', () => {
  it('rest and match but stay out of the public book', async () => {
    const m = await fx.market();
    const maker = await fx.trader([{ asset: m.base, amount: '5', scale: 8 }]);
    const taker = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const res = await fx.place(maker, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '1',
      hidden: true,
    });
    expect(res.status).toBe(202);
    expect(res.body.hidden).toBe(true);
    await fx.until(async () => (await fx.status(res.body.id)) === 'OPEN');
    await rest(maker, m, 'sell', '101', '1');
    const book = await app.get(MarketDataService).book(m.symbol);
    expect(book.asks).toEqual([['101', '1']]);

    const buy = await fx.place(taker, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(buy.body.id)) === 'FILLED');
    expect(await fx.status(res.body.id)).toBe('FILLED');

    const bad = await fx.place(maker, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      timeInForce: 'ioc',
      price: '100',
      quantity: '1',
      hidden: true,
    });
    expect(bad.status).toBe(400);
  });
});

describe('scaled orders', () => {
  it('places evenly spaced limit orders that sum to the total', async () => {
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const res = await t.client.post('/v1/orders/scale', {
      market: m.symbol,
      clientOrderIdPrefix: 'ladder1',
      side: 'buy',
      quantity: '1.5',
      startPrice: '90',
      endPrice: '94',
      count: 5,
      distribution: 'increasing',
    });
    expect(res.status).toBe(200);
    const r = res.body.results as { status: number; order: { price: string; quantity: string } }[];
    expect(r.map((x) => x.status)).toEqual([202, 202, 202, 202, 202]);
    expect(r.map((x) => [x.order.price, x.order.quantity])).toEqual([
      ['90', '0.1'],
      ['91', '0.2'],
      ['92', '0.3'],
      ['93', '0.4'],
      ['94', '0.5'],
    ]);
    const narrow = await t.client.post('/v1/orders/scale', {
      market: m.symbol,
      clientOrderIdPrefix: 'ladder2',
      side: 'buy',
      quantity: '1',
      startPrice: '90',
      endPrice: '90.02',
      count: 5,
    });
    expect(narrow.status).toBe(400);
  });
});

describe('trailing stop', () => {
  it('follows the peak and sells after the callback, bounded by the protection price', async () => {
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.base, amount: '1', scale: 8 }]);
    await printTrade(m, '100');
    const res = await t.client.post('/v1/algo-orders', {
      market: m.symbol,
      kind: 'trailing',
      side: 'sell',
      quantity: '0.5',
      callbackBps: 100,
      slippageBps: 100,
    });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    expect(res.body.trailing).toMatchObject({ activated: true, extremePrice: '100' });

    await printTrade(m, '110');
    await algos.tick();
    expect((await algo(id, t)).trailing).toMatchObject({
      extremePrice: '110',
      triggerPrice: '108.9',
    });
    await printTrade(m, '109');
    await algos.tick();
    expect(await children(id)).toHaveLength(0);

    const bidder = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    await rest(bidder, m, 'buy', '107', '0.5');
    await printTrade(m, '108');
    await algos.tick();
    await settled(id);
    const [child] = await children(id);
    expect(child).toMatchObject({ side: 'SELL', timeInForce: 'IOC' });
    expect(child!.priceTicks).toBe(10692n); // 108 × 0.99
    await fx.until(async () => (await fx.status(child!.id)) === 'FILLED');
    await algos.tick();
    expect(await algo(id, t)).toMatchObject({ status: 'done', filledQuantity: '0.5' });
  });

  it('waits for the activation price', async () => {
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    await printTrade(m, '100');
    const res = await t.client.post('/v1/algo-orders', {
      market: m.symbol,
      kind: 'trailing',
      side: 'buy',
      quantity: '0.1',
      callbackBps: 200,
      activationPrice: '95',
    });
    expect(res.body.trailing).toMatchObject({ activated: false, extremePrice: null });
    await printTrade(m, '96');
    await algos.tick();
    expect((await algo(res.body.id, t)).trailing).toMatchObject({ activated: false });
    await printTrade(m, '94');
    await algos.tick();
    expect((await algo(res.body.id, t)).trailing).toMatchObject({
      activated: true,
      extremePrice: '94',
      triggerPrice: '95.88',
    });
  });
});

describe('chase orders', () => {
  it('rest at the best bid, follow it up within the cap, and finish when filled', async () => {
    const m = await fx.market();
    const others = await fx.trader([
      { asset: m.quote, amount: '1000', scale: 6 },
      { asset: m.base, amount: '5', scale: 8 },
    ]);
    const t = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    await rest(others, m, 'buy', '99', '0.1');
    await rest(others, m, 'sell', '103', '0.1');
    const res = await t.client.post('/v1/algo-orders', {
      market: m.symbol,
      kind: 'chase',
      side: 'buy',
      quantity: '0.2',
      price: '101',
    });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    await settled(id);
    let kids = await children(id);
    expect(kids.map((c) => [c.priceTicks, c.timeInForce])).toEqual([[9900n, 'POST_ONLY']]);

    // A better bid appears: the chase re-prices to it.
    await rest(others, m, 'buy', '100', '0.1');
    await algos.tick();
    await fx.until(async () => (await fx.status(kids[0]!.id)) === 'CANCELLED');
    await algos.tick();
    await settled(id);
    kids = await children(id);
    expect(kids.map((c) => c.priceTicks)).toEqual([9900n, 10000n]);

    // Beyond the cap it stays at the cap.
    await rest(others, m, 'buy', '102', '0.1');
    await algos.tick();
    await fx.until(async () => (await fx.status(kids[1]!.id)) === 'CANCELLED');
    await algos.tick();
    await settled(id);
    kids = await children(id);
    expect(kids[2]!.priceTicks).toBe(10100n);

    // Fill it: the 102 bid takes the seller's first 0.1, the chase the next 0.2.
    const seller = await fx.trader([{ asset: m.base, amount: '1', scale: 8 }]);
    const sell = await fx.place(seller, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '101',
      quantity: '0.3',
    });
    await fx.until(async () => (await fx.status(sell.body.id)) === 'FILLED');
    await algos.tick();
    expect(await algo(id, t)).toMatchObject({ status: 'done', filledQuantity: '0.2' });
  });
});

describe('grid bots and the marketplace', () => {
  it('buys below, answers each fill one level away, reports rounds and can be copied', async () => {
    const m = await fx.market();
    await printTrade(m, '100');
    const t = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const res = await t.client.post('/v1/algo-orders', {
      market: m.symbol,
      kind: 'grid',
      lowerPrice: '90',
      upperPrice: '110',
      gridCount: 4,
      quantityPerGrid: '0.1',
      direction: 'long',
      isPublic: true,
    });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    expect(res.body).toMatchObject({ kind: 'grid', side: 'both' });
    await settled(id);
    let kids = await children(id);
    expect(kids.map((c) => [c.side, c.priceTicks, c.gridLevel])).toEqual([
      ['BUY', 9000n, 0],
      ['BUY', 9500n, 1],
    ]);

    // The market drops to 95: the grid buys and answers with a sell at 100.
    const mm = await fx.trader([
      { asset: m.base, amount: '5', scale: 8 },
      { asset: m.quote, amount: '1000', scale: 6 },
    ]);
    const hit = await fx.place(mm, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '95',
      quantity: '0.1',
    });
    await fx.until(async () => (await fx.status(hit.body.id)) === 'FILLED');
    await algos.tick();
    await settled(id);
    kids = await children(id);
    const sell = kids.find((c) => c.clientOrderId.startsWith('gx-'))!;
    expect(sell).toMatchObject({ side: 'SELL', priceTicks: 10000n, gridLevel: 2 });

    // Back up to 100: the sell completes a round and a buy at 95 re-opens it.
    const lift = await fx.place(mm, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '0.1',
    });
    await fx.until(async () => (await fx.status(lift.body.id)) === 'FILLED');
    await algos.tick();
    await settled(id);
    kids = await children(id);
    expect(kids.find((c) => c.clientOrderId.startsWith('go-'))).toMatchObject({
      side: 'BUY',
      priceTicks: 9500n,
      gridLevel: 1,
    });
    await algos.tick(); // nothing new to answer
    expect(await children(id)).toHaveLength(kids.length);
    expect((await algo(id, t)).grid).toMatchObject({ completedRounds: 1, gridProfit: '0.5' });

    // Marketplace: listed without the owner; another trader copies it at their own size.
    const anon = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const listed = (await anon.client.get(`/v1/grids/public?market=${m.symbol}`)).body.grids;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, completedRounds: 1, copies: 0, lowerPrice: '90' });
    expect(listed[0].userId).toBeUndefined();
    const copy = await anon.client.post(`/v1/grids/${id}/copy`, { quantityPerGrid: '0.2' });
    expect(copy.status).toBe(201);
    expect(copy.body.grid).toMatchObject({
      upperPrice: '110',
      gridCount: 4,
      quantityPerGrid: '0.2',
      copiedFromId: id,
      isPublic: false,
    });
    expect(
      (await anon.client.get(`/v1/grids/public?market=${m.symbol}`)).body.grids[0].copies,
    ).toBe(1);
    // Private grids cannot be copied.
    expect(
      (await t.client.post(`/v1/grids/${copy.body.id}/copy`, { quantityPerGrid: '0.1' })).status,
    ).toBe(404);
    await t.client.post(`/v1/algo-orders/${id}/visibility`, { isPublic: false });
    expect((await anon.client.get(`/v1/grids/public?market=${m.symbol}`)).body.grids).toEqual([]);

    // A grid order cancelled outside the grid stops it and cancels the rest.
    const own = (await children(id)).find((c) => c.status === 'OPEN')!;
    await t.client.delete(`/v1/orders/${own.id}`);
    await fx.until(async () => (await fx.status(own.id)) === 'CANCELLED');
    await algos.tick();
    const stopped = await algo(id, t);
    expect(stopped).toMatchObject({ status: 'failed' });
    expect(stopped.lastError).toMatch(/cancelled outside the grid/);
    await fx.until(async () =>
      (await children(id)).every((c) => ['FILLED', 'CANCELLED'].includes(c.status)),
    );
  });

  it('refuses spot grids that would sell first', async () => {
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.quote, amount: '100', scale: 6 }]);
    const res = await t.client.post('/v1/algo-orders', {
      market: m.symbol,
      kind: 'grid',
      lowerPrice: '90',
      upperPrice: '110',
      gridCount: 4,
      quantityPerGrid: '0.1',
      direction: 'neutral',
    });
    expect(res.status).toBe(400);
  });
});

describe('recurring purchases (ADR-0029)', () => {
  it('spend a fixed amount every interval at a bounded price, then finish', async () => {
    const m = await fx.market();
    const maker = await fx.trader([{ asset: m.base, amount: '10', scale: 8 }]);
    await rest(maker, m, 'sell', '100', '5');
    const t = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const res = await t.client.post('/v1/algo-orders', {
      market: m.symbol,
      kind: 'recurring',
      side: 'buy',
      amount: '250',
      intervalSeconds: 3600,
      runs: 2,
      slippageBps: 100,
    });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    await settled(id);
    // Run 1: IOC at 101 (ask + 1%), 250 / 101 → 2.4752 rounded down to lots.
    let kids = await children(id);
    expect(kids.map((c) => [c.timeInForce, c.priceTicks, c.quantityLots])).toEqual([
      ['IOC', 10100n, 24752n],
    ]);
    await fx.until(async () => (await fx.status(kids[0]!.id)) === 'FILLED');
    expect((await algo(id, t)).recurring).toMatchObject({ amount: '250', runs: 2, runsDone: 1 });

    await algos.tick(); // not due yet
    expect(await children(id)).toHaveLength(1);
    await algos.tick(new Date(Date.now() + 3_601_000));
    await settled(id);
    kids = await children(id);
    expect(kids).toHaveLength(2);
    await fx.until(async () => (await fx.status(kids[1]!.id)) === 'FILLED');
    await algos.tick(new Date(Date.now() + 7_202_000));
    expect(await algo(id, t)).toMatchObject({ status: 'done', filledQuantity: '4.9504' });
  });

  it('skip a run with the reason when there is no price, and keep running', async () => {
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.base, amount: '1', scale: 8 }]);
    const res = await t.client.post('/v1/algo-orders', {
      market: m.symbol,
      kind: 'recurring',
      side: 'sell',
      amount: '0.1',
      intervalSeconds: 86400,
      runs: 3,
    });
    expect(res.body).toMatchObject({
      status: 'running',
      lastError: 'Run 1 skipped: No buy orders on the book',
    });
    expect(await children(res.body.id)).toHaveLength(0);
    expect(res.body.recurring).toMatchObject({ runsDone: 1, amountAsset: m.base });
    // Too short an interval is refused.
    const bad = await t.client.post('/v1/algo-orders', {
      market: m.symbol,
      kind: 'recurring',
      side: 'sell',
      amount: '0.1',
      intervalSeconds: 60,
      runs: 3,
    });
    expect(bad.status).toBe(400);
  });
});
