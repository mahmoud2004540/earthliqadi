import type { INestApplication } from '@nestjs/common';
import { AlgoOrdersService } from '../src/algo/algo-orders.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { MarketDataService } from '../src/market-data/market-data.service';
import { EngineProcess } from './engine';
import { bootApp } from './helpers';
import { TradingFixture } from './trading-helpers';

/** Large-trader tools (ADR-0020). */
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

async function children(id: string) {
  return prisma.order.findMany({ where: { algoOrderId: id }, orderBy: { createdAt: 'asc' } });
}
async function settled(id: string) {
  await fx.until(async () => (await children(id)).every((c) => c.status !== 'PENDING_NEW'));
}

describe('iceberg orders', () => {
  it('show one slice at a time and refill until the total is done', async () => {
    const m = await fx.market();
    const maker = await fx.trader([{ asset: m.base, amount: '10', scale: 8 }]);
    const taker = await fx.trader([{ asset: m.quote, amount: '10000', scale: 6 }]);
    const res = await maker.client.post('/v1/algo-orders', {
      market: m.symbol,
      kind: 'iceberg',
      side: 'sell',
      quantity: '3',
      sliceQuantity: '1',
      price: '100',
    });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    for (let i = 0; i < 3; i++) {
      await settled(id);
      const book = await app.get(MarketDataService).book(m.symbol, 10);
      expect(book.asks).toEqual([['100', '1']]); // only the visible slice
      const buy = await fx.place(taker, {
        market: m.symbol,
        side: 'buy',
        type: 'limit',
        price: '100',
        quantity: '1',
      });
      await fx.until(async () => (await fx.status(buy.body.id)) === 'FILLED');
      await algos.tick();
    }
    await algos.tick();
    const done = (await maker.client.get('/v1/algo-orders')).body.algoOrders[0];
    expect(done).toMatchObject({ id, status: 'done', filledQuantity: '3', slicesSent: 3 });
  });

  it('cancelling the parent cancels the visible child', async () => {
    const m = await fx.market();
    const maker = await fx.trader([{ asset: m.base, amount: '10', scale: 8 }]);
    const res = await maker.client.post('/v1/algo-orders', {
      market: m.symbol,
      kind: 'iceberg',
      side: 'sell',
      quantity: '5',
      sliceQuantity: '1',
      price: '100',
    });
    await settled(res.body.id);
    const cancelled = await maker.client.delete(`/v1/algo-orders/${res.body.id}`);
    expect(cancelled.body.status).toBe('cancelled');
    const [child] = await children(res.body.id);
    await fx.until(async () => (await fx.status(child!.id)) === 'CANCELLED');
    await algos.tick();
    expect(await children(res.body.id)).toHaveLength(1);
  });
});

describe('TWAP orders', () => {
  it('send one IOC slice per interval at the limit price, then finish', async () => {
    const m = await fx.market();
    const maker = await fx.trader([{ asset: m.base, amount: '10', scale: 8 }]);
    const taker = await fx.trader([{ asset: m.quote, amount: '10000', scale: 6 }]);
    const ask = await fx.place(maker, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '2',
    });
    await fx.until(async () => (await fx.status(ask.body.id)) === 'OPEN');
    const res = await taker.client.post('/v1/algo-orders', {
      market: m.symbol,
      kind: 'twap',
      side: 'buy',
      quantity: '2',
      sliceQuantity: '1',
      price: '101',
      intervalSeconds: 60,
    });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    await settled(id);
    expect((await children(id)).map((c) => c.timeInForce)).toEqual(['IOC']);
    await algos.tick(); // not due yet
    expect(await children(id)).toHaveLength(1);
    await algos.tick(new Date(Date.now() + 61_000));
    await settled(id);
    expect(await children(id)).toHaveLength(2);
    await algos.tick(new Date(Date.now() + 122_000));
    const dto = (await taker.client.get('/v1/algo-orders')).body.algoOrders[0];
    expect(dto).toMatchObject({ status: 'done', filledQuantity: '2' });
  });

  it('stops with the reason when a slice cannot be funded', async () => {
    const m = await fx.market();
    const poor = await fx.trader([{ asset: m.quote, amount: '50', scale: 6 }]);
    const res = await poor.client.post('/v1/algo-orders', {
      market: m.symbol,
      kind: 'twap',
      side: 'buy',
      quantity: '2',
      sliceQuantity: '1',
      price: '100',
      intervalSeconds: 5,
    });
    expect(res.body.status).toBe('failed');
    expect(res.body.lastError).toMatch(/insufficient|Insufficient/);
  });
});

describe('RFQ block trades', () => {
  it('execute a negotiated size off the book at a banded price', async () => {
    const { RfqService } = await import('../src/algo/rfq.service');
    const { ReconciliationService } = await import('../src/ledger/reconciliation.service');
    const { MarketDataService: MD } = await import('../src/market-data/market-data.service');
    const m = await fx.market({ makerFeeBps: 0, takerFeeBps: 0 });
    // A reference book: bid 99 / ask 101.
    const lp = await fx.trader([
      { asset: m.base, amount: '10', scale: 8 },
      { asset: m.quote, amount: '10000', scale: 6 },
    ]);
    for (const [side, price] of [
      ['buy', '99'],
      ['sell', '101'],
    ] as const) {
      const o = await fx.place(lp, { market: m.symbol, side, type: 'limit', price, quantity: '1' });
      await fx.until(async () => (await fx.status(o.body.id)) === 'OPEN');
    }
    const whale = await fx.trader([{ asset: m.quote, amount: '100000', scale: 6 }]);
    const maker = await fx.trader([{ asset: m.base, amount: '50', scale: 8 }]);
    const stranger = await fx.trader();

    const req = await whale.client.post('/v1/rfq', {
      market: m.symbol,
      side: 'buy',
      quantity: '20',
    });
    expect(req.status).toBe(201);
    const id = req.body.id as string;
    // Only registered makers quote; never on their own request; inside the band.
    expect((await stranger.client.post(`/v1/rfq/${id}/quotes`, { price: '100' })).status).toBe(403);
    await app.get(RfqService).registerMaker(lp.userId, maker.userId, {
      requestId: 'test',
      ipAddress: null,
      userAgent: null,
    });
    expect(
      (await maker.client.get('/v1/rfq/open')).body.requests.map((r: { id: string }) => r.id),
    ).toContain(id);
    expect((await maker.client.post(`/v1/rfq/${id}/quotes`, { price: '120' })).status).toBe(400);
    const quote = await maker.client.post(`/v1/rfq/${id}/quotes`, { price: '100.5' });
    expect(quote.status).toBe(201);
    const seen = (await whale.client.get(`/v1/rfq/${id}`)).body;
    expect(seen.quotes).toEqual([expect.objectContaining({ id: quote.body.id, price: '100.5' })]);

    const accepted = await whale.client.post(`/v1/rfq/${id}/accept`, { quoteId: quote.body.id });
    expect(accepted.status).toBe(202);
    await fx.until(async () => (await fx.status(accepted.body.buyOrderId)) === 'FILLED');
    expect(await fx.status(accepted.body.sellOrderId)).toBe('FILLED');
    const trade = await prisma.trade.findFirstOrThrow({
      where: { takerOrderId: accepted.body.buyOrderId },
    });
    expect(trade.makerOrderId).toBe(accepted.body.sellOrderId);
    expect(trade.quantityLots).toBe(200_000n); // 20 at lot 0.0001
    // The book was not touched.
    const book = await app.get(MD).book(m.symbol, 10);
    expect(book).toMatchObject({ bids: [['99', '1']], asks: [['101', '1']] });
    // A filled request cannot be accepted twice.
    expect(
      (await whale.client.post(`/v1/rfq/${id}/accept`, { quoteId: quote.body.id })).status,
    ).toBe(409);
    const run = await app.get(ReconciliationService).run('CLI');
    expect(run.findings).toEqual([]);
  });
});
