import type { INestApplication } from '@nestjs/common';
import { parseAmount } from '@platform/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { ReconciliationService } from '../src/ledger/reconciliation.service';
import { RbacService } from '../src/rbac/rbac.service';
import { MarketsService } from '../src/trading/markets.service';
import { SettlementService } from '../src/trading/settlement.service';
import { EngineProcess, sleep } from './engine';
import { type TestClient, bootApp, createVerifiedUser, uniqueEmail } from './helpers';

let app: INestApplication;
let prisma: PrismaService;
let ledger: LedgerService;
let settlement: SettlementService;
const engine = new EngineProcess();
const SYSTEM = { actorType: 'SYSTEM' as const };

interface Trader {
  client: TestClient;
  userId: string;
}

const code = () => `T${randomBytes(4).toString('hex').toUpperCase()}`;

/** Creates BASE (scale 8) / QUOTE (scale 6), tick 0.01 QUOTE, lot 0.0001 BASE, fees maker 10 / taker 20 bps. */
async function newMarket(fees = { makerFeeBps: 10, takerFeeBps: 20 }) {
  const base = code();
  const quote = code();
  await ledger.createAsset({ code: base, name: `Base ${base}`, scale: 8 }, SYSTEM);
  await ledger.createAsset({ code: quote, name: `Quote ${quote}`, scale: 6 }, SYSTEM);
  const market = await app
    .get(MarketsService)
    .create({ base, quote, tickSize: '0.01', lotSize: '0.0001', ...fees }, SYSTEM);
  return { symbol: market.symbol, base, quote, id: market.id };
}

async function trader(
  funds: { asset: string; amount: string; scale: number }[] = [],
): Promise<Trader> {
  const email = uniqueEmail('trader');
  const client = await createVerifiedUser(app, email);
  const { id: userId } = await prisma.user.findUniqueOrThrow({ where: { email } });
  for (const f of funds) {
    await ledger.simulatedDeposit(
      {
        userId,
        assetCode: f.asset,
        amount: parseAmount(f.amount, f.scale),
        idempotencyKey: `dep:${randomUUID()}`,
      },
      SYSTEM,
    );
  }
  return { client, userId };
}

async function balance(
  userId: string,
  asset: string,
): Promise<{ available: string; locked: string }> {
  const res = await prisma.ledgerAccount.findMany({
    where: { ownerUserId: userId, asset: { code: asset } },
  });
  const get = (t: string) => res.find((a) => a.type === t)?.balance.toFixed(0) ?? '0';
  return { available: get('USER_AVAILABLE'), locked: get('USER_LOCKED') };
}

async function place(t: Trader, body: Record<string, unknown>) {
  return t.client.post('/v1/orders', { clientOrderId: randomUUID(), ...body });
}

/** Drives settlement until the predicate holds (engine runs asynchronously). */
async function until(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await settlement.processPending();
    if (await predicate()) return;
    if (Date.now() > deadline)
      throw new Error(
        `condition not met in time. Engine logs:\n${engine.logs.slice(-20).join('\n')}`,
      );
    await sleep(25);
  }
}

async function orderStatus(id: string): Promise<string> {
  return (await prisma.order.findUniqueOrThrow({ where: { id } })).status;
}

async function settledUpTo(marketId: string): Promise<boolean> {
  const [m, e, s] = await Promise.all([
    prisma.market.findUniqueOrThrow({ where: { id: marketId } }),
    prisma.engineMarketState.findUnique({ where: { marketId } }),
    prisma.settlementState.findUnique({ where: { marketId } }),
  ]);
  return !!e && e.lastCommandSeq === m.nextCommandSeq && !!s && s.lastEventSeq === e.lastEventSeq;
}

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
  ledger = app.get(LedgerService);
  settlement = app.get(SettlementService);
  await engine.start();
}, 60_000);

afterAll(async () => {
  await engine.stop();
  await app.close();
});

describe('order entry', () => {
  it('holds funds and enqueues a gap-free command atomically', async () => {
    const m = await newMarket();
    const alice = await trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const res = await place(alice, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '100.5',
      quantity: '2',
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'pending_new',
      price: '100.5',
      quantity: '2',
      filledQuantity: '0',
    });
    // 2 × 100.50 = 201 QUOTE held.
    expect(await balance(alice.userId, m.quote)).toEqual({
      available: '799000000',
      locked: '201000000',
    });
    const commands = await prisma.engineCommand.findMany({
      where: { marketId: m.id },
      orderBy: { seq: 'asc' },
    });
    expect(commands.map((c) => c.seq)).toEqual([1n]);
    await until(async () => (await orderStatus(res.body.id)) === 'OPEN');
  });

  it('rejects unfunded orders without enqueuing anything', async () => {
    const m = await newMarket();
    const poor = await trader([{ asset: m.quote, amount: '10', scale: 6 }]);
    const res = await place(poor, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await prisma.engineCommand.count({ where: { marketId: m.id } })).toBe(0);
    expect((await prisma.market.findUniqueOrThrow({ where: { id: m.id } })).nextCommandSeq).toBe(
      0n,
    );
    expect(await prisma.order.count({ where: { marketId: m.id } })).toBe(0);
  });

  it('validates prices/quantities against the market grid and order-type rules', async () => {
    const m = await newMarket();
    const t = await trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const cases: [Record<string, unknown>, string][] = [
      [{ side: 'buy', type: 'limit', price: '100.001', quantity: '1' }, 'price'],
      [{ side: 'buy', type: 'limit', price: '100', quantity: '0.00001' }, 'quantity'],
      [{ side: 'buy', type: 'limit', quantity: '1' }, 'price'],
      [{ side: 'buy', type: 'market', quantity: '1' }, 'price'],
      [
        { side: 'buy', type: 'market', price: '100', quantity: '1', timeInForce: 'gtc' },
        'timeInForce',
      ],
      [{ side: 'buy', type: 'stop_limit', price: '100', quantity: '1' }, 'stopPrice'],
      [{ side: 'buy', type: 'limit', price: '100', stopPrice: '99', quantity: '1' }, 'stopPrice'],
    ];
    for (const [body, path] of cases) {
      const res = await place(t, { market: m.symbol, ...body });
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(res.body.error.details[0].path).toBe(path);
    }
  });

  it('is idempotent per clientOrderId', async () => {
    const m = await newMarket();
    const t = await trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const body = {
      market: m.symbol,
      clientOrderId: 'my-order-1',
      side: 'buy',
      type: 'limit',
      price: '10',
      quantity: '1',
    };
    const first = await t.client.post('/v1/orders', body);
    const second = await t.client.post('/v1/orders', body);
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect((await balance(t.userId, m.quote)).locked).toBe('10000000'); // held once
    const conflict = await t.client.post('/v1/orders', { ...body, quantity: '2' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('matching and settlement through the real engine', () => {
  it('settles a trade exactly: maker price, fees in the received asset, price-improvement refund', async () => {
    const m = await newMarket({ makerFeeBps: 10, takerFeeBps: 20 });
    const seller = await trader([{ asset: m.base, amount: '1', scale: 8 }]);
    const buyer = await trader([{ asset: m.quote, amount: '100000', scale: 6 }]);

    const ask = await place(seller, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '65000',
      quantity: '0.5',
    });
    await until(async () => (await orderStatus(ask.body.id)) === 'OPEN');
    // Buyer bids higher than the ask: trades at the maker's 65000, excess hold is released.
    const bid = await place(buyer, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '65100',
      quantity: '0.5',
    });
    await until(
      async () =>
        (await orderStatus(bid.body.id)) === 'FILLED' &&
        (await orderStatus(ask.body.id)) === 'FILLED',
    );

    // Quote: 0.5 × 65000 = 32500. Seller is maker (10 bps on quote received) → fee 32.5.
    // Base: buyer is taker (20 bps on base received) → 0.5 × 0.002 = 0.001 fee.
    expect(await balance(seller.userId, m.quote)).toEqual({
      available: '32467500000',
      locked: '0',
    });
    expect(await balance(seller.userId, m.base)).toEqual({ available: '50000000', locked: '0' });
    expect(await balance(buyer.userId, m.base)).toEqual({ available: '49900000', locked: '0' });
    expect(await balance(buyer.userId, m.quote)).toEqual({ available: '67500000000', locked: '0' });

    const fees = await prisma.ledgerAccount.findMany({
      where: { type: 'FEE_REVENUE', asset: { code: { in: [m.base, m.quote] } } },
      include: { asset: true },
    });
    expect(Object.fromEntries(fees.map((f) => [f.asset.code, f.balance.toFixed(0)]))).toEqual({
      [m.quote]: '32500000',
      [m.base]: '100000',
    });

    const trade = await prisma.trade.findFirstOrThrow({ where: { marketId: m.id } });
    expect(trade).toMatchObject({ priceTicks: 6_500_000n, quantityLots: 5_000n, takerSide: 'BUY' });
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: trade.journalEntryId },
    });
    expect(entry.type).toBe('TRADE');

    const buyerTrades = await buyer.client.get('/v1/me/trades').expect(200);
    expect(buyerTrades.body.trades[0]).toMatchObject({
      market: m.symbol,
      side: 'buy',
      liquidity: 'taker',
      price: '65000',
      quantity: '0.5',
      quoteAmount: '32500',
      fee: '0.001',
      feeAsset: m.base,
    });
    const sellerTrades = await seller.client.get('/v1/me/trades').expect(200);
    expect(sellerTrades.body.trades[0]).toMatchObject({
      side: 'sell',
      liquidity: 'maker',
      fee: '32.5',
      feeAsset: m.quote,
    });

    const order = await buyer.client.get(`/v1/orders/${bid.body.id}`).expect(200);
    expect(order.body).toMatchObject({
      status: 'filled',
      filledQuantity: '0.5',
      remainingQuantity: '0',
    });
    expect((await app.get(ReconciliationService).run('MANUAL')).status).toBe('OK');
  });

  it('partially fills, rests the remainder, and releases funds on cancel', async () => {
    const m = await newMarket({ makerFeeBps: 0, takerFeeBps: 0 });
    const seller = await trader([{ asset: m.base, amount: '1', scale: 8 }]);
    const buyer = await trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const ask = await place(seller, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '0.3',
    });
    await until(async () => (await orderStatus(ask.body.id)) === 'OPEN');
    const bid = await place(buyer, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await until(async () => (await orderStatus(bid.body.id)) === 'PARTIALLY_FILLED');
    expect(await balance(buyer.userId, m.quote)).toEqual({
      available: '900000000',
      locked: '70000000',
    });

    const cancel = await buyer.client.delete(`/v1/orders/${bid.body.id}`);
    expect(cancel.status).toBe(202);
    expect(cancel.body.cancelRequested).toBe(true);
    await until(async () => (await orderStatus(bid.body.id)) === 'CANCELLED');
    expect(await balance(buyer.userId, m.quote)).toEqual({ available: '970000000', locked: '0' });
    const closed = await prisma.order.findUniqueOrThrow({ where: { id: bid.body.id } });
    expect(closed).toMatchObject({ cancelReason: 'user', filledLots: 3_000n });
    expect((await buyer.client.delete(`/v1/orders/${bid.body.id}`)).status).toBe(409);
  });

  it('reduces a resting order in place and releases the reduced hold', async () => {
    const m = await newMarket();
    const t = await trader([{ asset: m.base, amount: '2', scale: 8 }]);
    const ask = await place(t, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '50',
      quantity: '2',
    });
    await until(async () => (await orderStatus(ask.body.id)) === 'OPEN');
    const res = await t.client.agent
      .patch(`/v1/orders/${ask.body.id}`)
      .set('X-Forwarded-For', t.client.ip)
      .set('X-CSRF-Token', await t.client.csrf())
      .send({ remainingQuantity: '0.5' });
    expect(res.status).toBe(202);
    await until(async () => (await balance(t.userId, m.base)).locked === '50000000');
    expect(await balance(t.userId, m.base)).toEqual({ available: '150000000', locked: '50000000' });
    expect((await t.client.get(`/v1/orders/${ask.body.id}`)).body).toMatchObject({
      quantity: '0.5',
      status: 'open',
    });
  });

  it('IOC and market orders never rest; unfilled remainder is released', async () => {
    const m = await newMarket({ makerFeeBps: 0, takerFeeBps: 0 });
    const maker = await trader([{ asset: m.base, amount: '1', scale: 8 }]);
    const taker = await trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const ask = await place(maker, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '10',
      quantity: '0.4',
    });
    await until(async () => (await orderStatus(ask.body.id)) === 'OPEN');
    // Market buy with protection 12: fills 0.4 @ 10, remaining 0.6 cancelled.
    const mkt = await place(taker, {
      market: m.symbol,
      side: 'buy',
      type: 'market',
      price: '12',
      quantity: '1',
    });
    await until(async () => (await orderStatus(mkt.body.id)) === 'CANCELLED');
    const o = await prisma.order.findUniqueOrThrow({ where: { id: mkt.body.id } });
    expect(o).toMatchObject({ filledLots: 4_000n, cancelReason: 'unfilled' });
    expect(await balance(taker.userId, m.quote)).toEqual({ available: '996000000', locked: '0' });
    expect(await balance(taker.userId, m.base)).toEqual({ available: '40000000', locked: '0' });
  });

  it('prevents self-trades and handles stop orders end to end', async () => {
    const m = await newMarket({ makerFeeBps: 0, takerFeeBps: 0 });
    const a = await trader([
      { asset: m.base, amount: '5', scale: 8 },
      { asset: m.quote, amount: '1000', scale: 6 },
    ]);
    const b = await trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const ask = await place(a, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '10',
      quantity: '1',
    });
    await until(async () => (await orderStatus(ask.body.id)) === 'OPEN');
    const self = await place(a, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '10',
      quantity: '1',
    });
    await until(async () => (await orderStatus(self.body.id)) === 'CANCELLED');
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: self.body.id } })).cancelReason,
    ).toBe('self_trade_prevention');
    expect(await prisma.trade.count({ where: { marketId: m.id } })).toBe(0);

    // A sells more above; B places a buy stop at 11 that triggers when a trade prints at 11.
    const ask2 = await place(a, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '11',
      quantity: '1',
    });
    const stop = await place(b, {
      market: m.symbol,
      side: 'buy',
      type: 'stop_limit',
      stopPrice: '11',
      price: '11',
      quantity: '0.5',
    });
    await until(
      async () =>
        (await orderStatus(stop.body.id)) === 'PENDING_TRIGGER' &&
        (await orderStatus(ask2.body.id)) === 'OPEN',
    );
    // Takes 1 @ 10 and 0.5 @ 11 → last trade 11 → the stop triggers and buys the remaining 0.5 @ 11.
    const lift = await place(b, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '11',
      quantity: '1.5',
    });
    await until(async () => (await orderStatus(lift.body.id)) === 'FILLED');
    await until(async () => (await orderStatus(stop.body.id)) === 'FILLED');
    expect(await prisma.trade.count({ where: { marketId: m.id } })).toBe(3);
  });

  it('halting a market blocks new orders but still allows cancels', async () => {
    const m = await newMarket();
    const t = await trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
    const open = await place(t, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '1',
      quantity: '1',
    });
    await until(async () => (await orderStatus(open.body.id)) === 'OPEN');
    await app.get(MarketsService).setStatus(m.symbol, 'HALTED', SYSTEM);
    const blocked = await place(t, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '1',
      quantity: '1',
    });
    expect(blocked.status).toBe(409);
    expect((await t.client.delete(`/v1/orders/${open.body.id}`)).status).toBe(202);
    await until(async () => (await orderStatus(open.body.id)) === 'CANCELLED');
    expect(await balance(t.userId, m.quote)).toEqual({ available: '1000000000', locked: '0' });
  });

  it('conserves funds under 40 concurrent orders from 8 traders', async () => {
    const m = await newMarket({ makerFeeBps: 5, takerFeeBps: 7 });
    const traders = await Promise.all(
      Array.from({ length: 8 }, () =>
        trader([
          { asset: m.base, amount: '10', scale: 8 },
          { asset: m.quote, amount: '10000', scale: 6 },
        ]),
      ),
    );
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const t = traders[i % traders.length]!;
        const side = i % 2 === 0 ? 'buy' : 'sell';
        const price = (100 + ((i * 7) % 11) - 5).toString();
        return place(t, {
          market: m.symbol,
          side,
          type: 'limit',
          price,
          quantity: `0.${(i % 9) + 1}`,
        });
      }),
    );
    expect(results.every((r) => r.status === 202)).toBe(true);
    const commands = await prisma.engineCommand.findMany({
      where: { marketId: m.id },
      orderBy: { seq: 'asc' },
    });
    expect(commands.map((c) => Number(c.seq))).toEqual(Array.from({ length: 40 }, (_, i) => i + 1)); // gap-free

    await until(() => settledUpTo(m.id));
    expect(await prisma.trade.count({ where: { marketId: m.id } })).toBeGreaterThan(0);

    // Conservation: users + fee accounts hold exactly what was deposited.
    for (const [asset, deposited] of [
      [m.base, 8n * 10n * 10n ** 8n],
      [m.quote, 8n * 10_000n * 10n ** 6n],
    ] as const) {
      const accounts = await prisma.ledgerAccount.findMany({
        where: {
          asset: { code: asset },
          type: { in: ['USER_AVAILABLE', 'USER_LOCKED', 'FEE_REVENUE'] },
        },
      });
      const total = accounts.reduce((sum, a) => sum + BigInt(a.balance.toFixed(0)), 0n);
      expect({ asset, total }).toEqual({ asset, total: deposited });
    }
    // Locked balances equal the sum of open orders' remaining holds.
    const openOrders = await prisma.order.findMany({
      where: { marketId: m.id, status: { in: ['OPEN', 'PARTIALLY_FILLED'] } },
    });
    const lockedByOrders = openOrders.reduce(
      (s, o) => s + BigInt(o.lockedRemaining.toFixed(0)),
      0n,
    );
    const lockedAccounts = await prisma.ledgerAccount.findMany({
      where: { asset: { code: { in: [m.base, m.quote] } }, type: 'USER_LOCKED' },
    });
    expect(lockedAccounts.reduce((s, a) => s + BigInt(a.balance.toFixed(0)), 0n)).toBe(
      lockedByOrders,
    );
    expect((await app.get(ReconciliationService).run('MANUAL')).status).toBe('OK');
  });
});

describe('engine recovery', () => {
  it('replays and verifies state on restart, then continues processing', async () => {
    const m = await newMarket({ makerFeeBps: 0, takerFeeBps: 0 });
    const t = await trader([{ asset: m.quote, amount: '100', scale: 6 }]);
    const first = await place(t, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '1',
      quantity: '1',
    });
    await until(async () => (await orderStatus(first.body.id)) === 'OPEN');

    await engine.stop();
    const queued = await place(t, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '2',
      quantity: '1',
    }); // engine down: queued durably
    expect(queued.status).toBe(202);
    await engine.start();
    expect(
      engine.logs.some((l) => l.includes('market recovered and verified') && l.includes(m.id)),
    ).toBe(true);
    await until(async () => (await orderStatus(queued.body.id)) === 'OPEN');
  });

  it('refuses to start when stored state does not match a deterministic replay', async () => {
    const m = await newMarket();
    const t = await trader([{ asset: m.quote, amount: '100', scale: 6 }]);
    const o = await place(t, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '1',
      quantity: '1',
    });
    await until(async () => (await orderStatus(o.body.id)) === 'OPEN');
    await engine.stop();
    const state = await prisma.engineMarketState.findUniqueOrThrow({ where: { marketId: m.id } });
    await prisma.engineMarketState.update({
      where: { marketId: m.id },
      data: { stateHash: 'f'.repeat(64) },
    });
    try {
      await expect(engine.start()).rejects.toThrow(/does not reproduce stored state/);
    } finally {
      await prisma.engineMarketState.update({
        where: { marketId: m.id },
        data: { stateHash: state.stateHash },
      });
      await engine.start();
    }
  });
});

describe('logs and admin', () => {
  it('keeps the command and event logs immutable', async () => {
    const m = await newMarket();
    const t = await trader([{ asset: m.quote, amount: '10', scale: 6 }]);
    const o = await place(t, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '1',
      quantity: '1',
    });
    await until(async () => (await orderStatus(o.body.id)) === 'OPEN');
    await expect(
      prisma.$executeRaw`UPDATE "engine_events" SET "type" = 'x' WHERE "market_id" = ${m.id}::uuid`,
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRaw`DELETE FROM "engine_commands" WHERE "market_id" = ${m.id}::uuid`,
    ).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRaw`TRUNCATE "trades"`).rejects.toThrow(/immutable/);
  });

  it('rejects out-of-sequence commands at the database', async () => {
    const m = await newMarket();
    await expect(
      prisma.engineCommand.create({
        data: { marketId: m.id, seq: 5n, kind: 'cancel', payload: {} },
      }),
    ).rejects.toThrow(/does not match market counter/);
  });

  it('lets risk officers create and halt markets, and reports engine status', async () => {
    const email = uniqueEmail('risk');
    const risk = await createVerifiedUser(app, email);
    const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });
    await app.get(RbacService).grantRole({
      userId: id,
      roleKey: 'risk_officer',
      grantedById: null,
      actorType: 'SYSTEM',
      reason: 'test',
    });
    const customer = await createVerifiedUser(app);

    const base = code();
    const quote = code();
    await ledger.createAsset({ code: base, name: 'b', scale: 8 }, SYSTEM);
    await ledger.createAsset({ code: quote, name: 'q', scale: 2 }, SYSTEM);
    const body = {
      base,
      quote,
      tickSize: '0.01',
      lotSize: '0.000001',
      makerFeeBps: 0,
      takerFeeBps: 0,
    };
    expect((await customer.post('/v1/admin/markets', body)).status).toBe(403);
    // 0.01 × 0.000001 would need fractional cents → rejected.
    expect((await risk.post('/v1/admin/markets', body)).status).toBe(400);
    const created = await risk.post('/v1/admin/markets', { ...body, lotSize: '1' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      symbol: `${base}-${quote}`,
      tickSize: '0.01',
      lotSize: '1',
      status: 'ACTIVE',
    });

    const halted = await risk.agent
      .patch(`/v1/admin/markets/${base}-${quote}/status`)
      .set('X-Forwarded-For', risk.ip)
      .set('X-CSRF-Token', await risk.csrf())
      .send({ status: 'HALTED' });
    expect(halted.body.status).toBe('HALTED');
    const markets = await customer.get('/v1/markets').expect(200);
    expect(
      markets.body.markets.find((x: { symbol: string }) => x.symbol === `${base}-${quote}`).status,
    ).toBe('HALTED');

    expect((await customer.get('/v1/admin/engine/status')).status).toBe(403);
    const status = await risk.get('/v1/admin/engine/status').expect(200);
    expect(status.body.markets.length).toBeGreaterThan(0);
  });
});
