import { MarketDataService } from '../src/market-data/market-data.service';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { loadAppConfig } from '../src/config/app-config';
import { WS_LIMITS } from '../src/market-data/market-data.gateway';
import { EngineProcess, sleep } from './engine';
import { TradingFixture, WsClient, portOf, sessionCookie } from './trading-helpers';

let app: INestApplication;
let fx: TradingFixture;
let port: number;
const engine = new EngineProcess();

beforeAll(async () => {
  if (!process.env.TEST_LOGS) Logger.overrideLogger(false);
  app = await createApp(loadAppConfig());
  await app.listen(0, '127.0.0.1'); // WebSockets need a real listening server
  port = portOf(app);
  fx = new TradingFixture(app, engine);
  await engine.start();
}, 60_000);

afterAll(async () => {
  await engine.stop();
  await app.close();
});

const api = () => request(app.getHttpServer());

describe('REST market data (derived from settled state)', () => {
  it('aggregates the order book by price, best first, excluding non-resting orders', async () => {
    const m = await fx.market();
    const maker = await fx.trader([
      { asset: m.base, amount: '10', scale: 8 },
      { asset: m.quote, amount: '10000', scale: 6 },
    ]);
    const orders = [
      { side: 'buy', type: 'limit', price: '99', quantity: '1' },
      { side: 'buy', type: 'limit', price: '99', quantity: '0.5' },
      { side: 'buy', type: 'limit', price: '98.5', quantity: '2' },
      { side: 'sell', type: 'limit', price: '101', quantity: '1' },
      { side: 'sell', type: 'limit', price: '100.25', quantity: '0.3', timeInForce: 'post_only' },
    ];
    const ids: string[] = [];
    for (const o of orders) ids.push((await fx.place(maker, { market: m.symbol, ...o })).body.id);
    await fx.until(async () =>
      (await Promise.all(ids.map((id) => fx.status(id)))).every((s) => s === 'OPEN'),
    );

    const book = await api().get(`/v1/markets/${m.symbol}/book`).expect(200);
    expect(book.body).toMatchObject({
      market: m.symbol,
      bids: [
        ['99', '1.5'],
        ['98.5', '2'],
      ],
      asks: [
        ['100.25', '0.3'],
        ['101', '1'],
      ],
      status: { state: 'live', engineBacklog: 0, settlementLag: 0 },
    });
    const settled = await fx.prisma.settlementState.findUniqueOrThrow({
      where: { marketId: m.id },
    });
    expect(book.body.seq).toBe(settled.lastEventSeq.toString());
    expect((await api().get(`/v1/markets/${m.symbol}/book?depth=1`).expect(200)).body.bids).toEqual(
      [['99', '1.5']],
    );
  });

  it('builds trades, OHLCV candles and a 24h ticker from real fills only', async () => {
    const m = await fx.market();
    const empty = await api().get(`/v1/markets/${m.symbol}/ticker`).expect(200);
    expect(empty.body).toMatchObject({
      last: null,
      change24hPct: null,
      volume24h: '0',
      bestBid: null,
      bestAsk: null,
    });
    expect(
      (await api().get(`/v1/markets/${m.symbol}/candles?interval=1m`).expect(200)).body.data,
    ).toEqual([]);

    const seller = await fx.trader([{ asset: m.base, amount: '10', scale: 8 }]);
    const buyer = await fx.trader([{ asset: m.quote, amount: '10000', scale: 6 }]);
    // Three fills: 100 (0.1), 104 (0.2), 98 (0.3) - each a separate resting ask taken by a buy.
    for (const [price, qty] of [
      ['100', '0.1'],
      ['104', '0.2'],
      ['98', '0.3'],
    ] as const) {
      const ask = await fx.place(seller, {
        market: m.symbol,
        side: 'sell',
        type: 'limit',
        price,
        quantity: qty,
      });
      await fx.until(async () => (await fx.status(ask.body.id)) === 'OPEN');
      const bid = await fx.place(buyer, {
        market: m.symbol,
        side: 'buy',
        type: 'limit',
        price,
        quantity: qty,
      });
      await fx.until(async () => (await fx.status(bid.body.id)) === 'FILLED');
    }

    const trades = await api().get(`/v1/markets/${m.symbol}/trades`).expect(200);
    expect(
      trades.body.trades.map((t: { price: string; quantity: string; takerSide: string }) => [
        t.price,
        t.quantity,
        t.takerSide,
      ]),
    ).toEqual([
      ['98', '0.3', 'buy'],
      ['104', '0.2', 'buy'],
      ['100', '0.1', 'buy'],
    ]);

    const candles = await api().get(`/v1/markets/${m.symbol}/candles?interval=1d`).expect(200);
    expect(candles.body.data).toHaveLength(1);
    expect(candles.body.data[0]).toMatchObject({
      open: '100',
      high: '104',
      low: '98',
      close: '98',
      volume: '0.6',
      quoteVolume: '60.2', // 10 + 20.8 + 29.4
      trades: 3,
    });

    const ticker = await api().get(`/v1/markets/${m.symbol}/ticker`).expect(200);
    expect(ticker.body).toMatchObject({
      last: '98',
      open24h: '100',
      high24h: '104',
      low24h: '98',
      change24hPct: '-2.00',
      volume24h: '0.6',
      quoteVolume24h: '60.2',
    });
    const all = await api().get('/v1/markets/tickers').expect(200);
    expect(all.body.tickers.find((t: { market: string }) => t.market === m.symbol).last).toBe('98');
  });

  it('reports delayed data when the engine stops processing, and live again after recovery', async () => {
    const m = await fx.market();
    const t = await fx.trader([{ asset: m.quote, amount: '100', scale: 6 }]);
    const ws = await WsClient.connect(port);
    ws.send({ op: 'subscribe', channel: 'book', market: m.symbol });
    expect(
      ((await ws.next((x) => x.type === 'book')).data as { status: { state: string } }).status
        .state,
    ).toBe('live');

    await engine.stop();
    try {
      const o = await fx.place(t, {
        market: m.symbol,
        side: 'buy',
        type: 'limit',
        price: '1',
        quantity: '1',
      });
      expect(o.status).toBe(202);
      await sleep(2_300);
      const ticker = await api().get(`/v1/markets/${m.symbol}/ticker`).expect(200);
      expect(ticker.body.status).toEqual({ state: 'delayed', engineBacklog: 1, settlementLag: 0 });
      // Pushed over WebSocket even though the settlement sequence did not move.
      const pushed = await ws.next(
        (x) =>
          x.type === 'book' && (x.data as { status: { state: string } }).status.state === 'delayed',
      );
      expect((pushed.data as { status: { engineBacklog: number } }).status.engineBacklog).toBe(1);
    } finally {
      await engine.start();
    }
    await fx.until(
      async () => (await api().get(`/v1/markets/${m.symbol}/ticker`)).body.status.state === 'live',
    );
    await ws.next(
      (x) => x.type === 'book' && (x.data as { status: { state: string } }).status.state === 'live',
    );
    ws.close();
  });
});

describe('application context without HTTP (CLI tools)', () => {
  it('boots and shuts down cleanly', async () => {
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../src/app.module');
    const context = await NestFactory.createApplicationContext(
      AppModule.forRoot({ ...loadAppConfig(), LEDGER_RECONCILIATION_INTERVAL_SECONDS: 0 }),
      { logger: false },
    );
    await context.close();
  });
});

describe('WebSocket gateway', () => {
  it('rejects foreign origins at the handshake', async () => {
    await expect(WsClient.connect(port, { origin: 'https://evil.example' })).rejects.toThrow(/403/);
  });

  it('streams book snapshots and incremental trades as settlement advances', async () => {
    const m = await fx.market();
    const seller = await fx.trader([{ asset: m.base, amount: '5', scale: 8 }]);
    const buyer = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const ws = await WsClient.connect(port);
    ws.send({ op: 'subscribe', channel: 'book', market: m.symbol });
    ws.send({ op: 'subscribe', channel: 'trades', market: m.symbol });
    await ws.next((x) => x.type === 'subscribed' && x.channel === 'book');
    const first = await ws.next((x) => x.type === 'book');
    expect(first.data).toMatchObject({ bids: [], asks: [] });
    expect(await ws.next((x) => x.type === 'trades')).toMatchObject({ snapshot: true, data: [] });

    const ask = await fx.place(seller, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '10',
      quantity: '2',
    });
    await fx.until(async () => (await fx.status(ask.body.id)) === 'OPEN');
    const withAsk = await ws.next(
      (x) => x.type === 'book' && (x.data as { asks: unknown[] }).asks.length === 1,
    );
    expect((withAsk.data as { asks: unknown }).asks).toEqual([['10', '2']]);
    expect(BigInt((withAsk.data as { seq: string }).seq)).toBeGreaterThan(
      BigInt((first.data as { seq: string }).seq),
    );

    const bid = await fx.place(buyer, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '10',
      quantity: '0.5',
    });
    await fx.until(async () => (await fx.status(bid.body.id)) === 'FILLED');
    const trade = await ws.next((x) => x.type === 'trades' && x.snapshot === false);
    expect(trade.data).toEqual([
      expect.objectContaining({ price: '10', quantity: '0.5', takerSide: 'buy' }),
    ]);
    await ws.next(
      (x) =>
        x.type === 'book' &&
        JSON.stringify((x.data as { asks: unknown }).asks) === JSON.stringify([['10', '1.5']]),
    );

    ws.send({ op: 'unsubscribe', channel: 'book', market: m.symbol });
    expect(await ws.next((x) => x.type === 'unsubscribed')).toMatchObject({ channel: 'book' });
    ws.close();
  });

  it('streams sequenced book diffs that rebuild the book exactly (book_diff)', async () => {
    const { applyLevels } = await import('../src/market-data/book-diff');
    const m = await fx.market();
    const seller = await fx.trader([{ asset: m.base, amount: '5', scale: 8 }]);
    const buyer = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const ws = await WsClient.connect(port);
    ws.send({ op: 'subscribe', channel: 'book_diff', market: m.symbol });
    const snap = (await ws.next((x) => x.type === 'book')).data as {
      seq: string;
      bids: [string, string][];
      asks: [string, string][];
    };
    let view = { seq: snap.seq, bids: snap.bids, asks: snap.asks };
    const apply = (d: Record<string, unknown>) => {
      expect(d.prevSeq).toBe(view.seq); // chained: no gap
      view = {
        seq: d.seq as string,
        bids: applyLevels(view.bids, d.bids as [string, string][], 'bids'),
        asks: applyLevels(view.asks, d.asks as [string, string][], 'asks'),
      };
    };
    const ask = await fx.place(seller, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '10',
      quantity: '2',
    });
    await fx.until(async () => (await fx.status(ask.body.id)) === 'OPEN');
    // Diffs may be empty (seq advanced without a level change); keep applying.
    for (;;) {
      apply(await ws.next((x) => x.type === 'book_diff'));
      if (view.asks.length === 1) break;
    }
    expect(view.asks).toEqual([['10', '2']]);
    const bid = await fx.place(buyer, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '9',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(bid.body.id)) === 'OPEN');
    for (;;) {
      apply(await ws.next((x) => x.type === 'book_diff'));
      if (view.bids.length === 1) break;
    }
    expect(view.bids).toEqual([['9', '1']]);
    // The rebuilt view equals a fresh snapshot.
    const fresh = await app.get(MarketDataService).book(m.symbol, 50);
    expect({ bids: view.bids, asks: view.asks }).toEqual({ bids: fresh.bids, asks: fresh.asks });
    ws.close();
  });

  it('serves candles and tickers over WebSocket', async () => {
    const m = await fx.market();
    const ws = await WsClient.connect(port);
    ws.send({ op: 'subscribe', channel: 'candles', market: m.symbol });
    expect(await ws.next((x) => x.type === 'error')).toMatchObject({ code: 'VALIDATION_FAILED' });
    ws.send({ op: 'subscribe', channel: 'candles', market: m.symbol, interval: '5m' });
    expect(await ws.next((x) => x.type === 'candles')).toMatchObject({ interval: '5m', data: [] });
    ws.send({ op: 'subscribe', channel: 'ticker', market: m.symbol });
    expect(await ws.next((x) => x.type === 'ticker')).toMatchObject({
      data: { market: m.symbol, last: null },
    });
    ws.close();
  });

  it('requires a valid session for the private orders channel and streams only own orders', async () => {
    const m = await fx.market();
    const alice = await fx.trader([{ asset: m.quote, amount: '100', scale: 6 }]);
    const bob = await fx.trader([{ asset: m.quote, amount: '100', scale: 6 }]);

    const anon = await WsClient.connect(port);
    anon.send({ op: 'subscribe', channel: 'orders', market: m.symbol });
    expect(await anon.next((x) => x.type === 'error')).toMatchObject({ code: 'UNAUTHENTICATED' });
    anon.close();

    const ws = await WsClient.connect(port, { cookie: await sessionCookie(app, alice.email) });
    ws.send({ op: 'subscribe', channel: 'orders', market: m.symbol });
    expect(await ws.next((x) => x.type === 'orders')).toMatchObject({ data: [] });

    await fx.place(bob, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '1',
      quantity: '1',
    });
    const mine = await fx.place(alice, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '2',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(mine.body.id)) === 'OPEN');
    const update = await ws.next(
      (x) =>
        x.type === 'orders' && (x.data as { status: string }[]).some((o) => o.status === 'open'),
    );
    const ids = (update.data as { id: string }[]).map((o) => o.id);
    expect(ids).toContain(mine.body.id);
    expect(ids.every((id) => id === mine.body.id)).toBe(true); // never Bob's orders
    ws.close();
  });

  it('disconnects private subscribers whose session was revoked', async () => {
    const m = await fx.market();
    const t = await fx.trader();
    const cookie = await sessionCookie(app, t.email);
    const ws = await WsClient.connect(port, { cookie });
    ws.send({ op: 'subscribe', channel: 'orders', market: m.symbol });
    await ws.next((x) => x.type === 'orders');

    const original = WS_LIMITS.sessionRecheckMs;
    WS_LIMITS.sessionRecheckMs = 50;
    try {
      const token = cookie.split('=')[1]!;
      const { sha256Hex } = await import('../src/security/crypto');
      await fx.prisma.session.updateMany({
        where: { tokenHash: sha256Hex(token) },
        data: { revokedAt: new Date(), revokedReason: 'test' },
      });
      expect(await ws.next((x) => x.type === 'error' && x.code === 'UNAUTHENTICATED')).toBeTruthy();
      await expect(ws.next(() => false, 3_000)).rejects.toThrow(/socket closed \(4401/);
    } finally {
      WS_LIMITS.sessionRecheckMs = original;
    }
  });

  it('validates messages and enforces limits', async () => {
    const m = await fx.market();
    const ws = await WsClient.connect(port);
    ws.socket.send('not json');
    expect(await ws.next((x) => x.type === 'error')).toMatchObject({ code: 'VALIDATION_FAILED' });
    ws.send({ op: 'subscribe', channel: 'nope', market: m.symbol });
    expect(await ws.next((x) => x.type === 'error')).toMatchObject({ code: 'VALIDATION_FAILED' });
    ws.send({ op: 'subscribe', channel: 'book', market: 'NOPE-NOPE' });
    expect(await ws.next((x) => x.type === 'error')).toMatchObject({ code: 'NOT_FOUND' });
    ws.send({ op: 'ping' });
    expect(await ws.next((x) => x.type === 'pong')).toEqual({ type: 'pong' });

    for (let i = 0; i < 25; i++) ws.send({ op: 'ping' });
    await expect(ws.next(() => false, 3_000)).rejects.toThrow(/socket closed \(1008/);

    // Per-IP connection cap.
    const ip = '10.252.0.1';
    const sockets = await Promise.all(
      Array.from({ length: WS_LIMITS.maxConnectionsPerIp }, () => WsClient.connect(port, { ip })),
    );
    await expect(WsClient.connect(port, { ip })).rejects.toThrow(/429/);
    sockets.forEach((s) => s.close());
  });
});
