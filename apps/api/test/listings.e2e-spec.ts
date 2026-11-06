import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { ListingsService } from '../src/listings/listings.service';
import { MarketsService } from '../src/trading/markets.service';
import { EngineProcess } from './engine';
import { TestClient, bootApp } from './helpers';
import { SYSTEM, TradingFixture, type Trader } from './trading-helpers';

/** Listing request board (ADR-0026). */
let app: INestApplication;
let prisma: PrismaService;
let fx: TradingFixture;
let listings: ListingsService;
const engine = new EngineProcess();
let quote: string;

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
  listings = app.get(ListingsService);
  fx = new TradingFixture(app, engine);
  await engine.start();
  quote = `Q${randomBytes(3).toString('hex').toUpperCase()}`;
  await app.get(LedgerService).createAsset({ code: quote, name: 'Quote', scale: 6 }, SYSTEM);
}, 60_000);

afterAll(async () => {
  await engine.stop();
  await app.close();
});

const sym = () => `N${randomBytes(3).toString('hex').toUpperCase()}`;
const request = (baseSymbol: string, extra: Record<string, unknown> = {}) => ({
  baseSymbol,
  baseName: 'New Token',
  kind: 'spot',
  quoteAsset: quote,
  rationale: 'Deep liquidity on several venues and an active community.',
  ...extra,
});

/** A trader who has traded (their votes rank the board). */
async function activeTrader(): Promise<Trader> {
  const m = await fx.market();
  const a = await fx.trader([{ asset: m.base, amount: '1', scale: 8 }]);
  const b = await fx.trader([{ asset: m.quote, amount: '1000', scale: 6 }]);
  await fx.place(a, {
    market: m.symbol,
    side: 'sell',
    type: 'limit',
    price: '10',
    quantity: '0.1',
  });
  const buy = await fx.place(b, {
    market: m.symbol,
    side: 'buy',
    type: 'limit',
    price: '10',
    quantity: '0.1',
  });
  await fx.until(async () => (await fx.status(buy.body.id)) === 'FILLED');
  return b;
}

describe('listing requests', () => {
  it('ranks by votes from accounts that traded; duplicates and floods are refused', async () => {
    const author = await fx.trader();
    const first = await author.client.post(
      '/v1/listings',
      request(sym(), {
        chainId: 1,
        tokenAddress: `0x${'AB'.repeat(20)}`,
        link: 'https://example.org/token',
      }),
    );
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'open',
      totalVotes: 1,
      eligibleVotes: 0, // the author has not traded
      tokenAddress: `0x${'ab'.repeat(20)}`,
      mine: true,
      votedByMe: true,
    });
    const id = first.body.id as string;

    const other = await fx.trader();
    const dup = await other.client.post('/v1/listings', request(first.body.baseSymbol));
    expect(dup.status).toBe(409);

    const second = await author.client.post('/v1/listings', request(sym()));
    expect(second.status).toBe(201);

    // A trader's vote counts; a fresh account's vote is shown but does not rank.
    const trader = await activeTrader();
    const voted = await trader.client.post(`/v1/listings/${second.body.id}/vote`, {});
    expect(voted.body).toMatchObject({ eligibleVotes: 1, totalVotes: 2, votedByMe: true });
    expect(
      (await trader.client.post(`/v1/listings/${second.body.id}/vote`, {})).body.totalVotes,
    ).toBe(2);
    expect((await other.client.post(`/v1/listings/${id}/vote`, {})).body).toMatchObject({
      eligibleVotes: 0,
      totalVotes: 2,
    });

    const board = (await new TestClient(app).get('/v1/listings')).body.requests as {
      id: string;
    }[];
    const pos = (x: string) => board.findIndex((r) => r.id === x);
    expect(pos(second.body.id)).toBeLessThan(pos(id));
    expect(JSON.stringify(board)).not.toContain(author.userId); // authors stay anonymous

    const mine = (await trader.client.get('/v1/listings/mine')).body;
    expect(mine).toEqual({ authored: [], voted: [second.body.id] });
    expect(
      (await trader.client.delete(`/v1/listings/${second.body.id}/vote`)).body.totalVotes,
    ).toBe(1);

    await author.client.post('/v1/listings', request(sym()));
    const fourth = await author.client.post('/v1/listings', request(sym()));
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe('LIMIT_EXCEEDED');

    // Withdrawing frees a slot; only the author can withdraw.
    expect((await other.client.post(`/v1/listings/${id}/withdraw`, {})).status).toBe(409);
    expect((await author.client.post(`/v1/listings/${id}/withdraw`, {})).body.status).toBe(
      'withdrawn',
    );
    expect((await author.client.post('/v1/listings', request(sym()))).status).toBe(201);
    expect((await other.client.post(`/v1/listings/${id}/vote`, {})).status).toBe(409);
  });

  it('validates the request and refuses markets that already exist', async () => {
    const t = await fx.trader();
    expect(
      (await t.client.post('/v1/listings', request(sym(), { quoteAsset: 'NOPE' }))).status,
    ).toBe(400);
    expect((await t.client.post('/v1/listings', request(sym(), { chainId: 1 }))).status).toBe(400);
    expect(
      (await t.client.post('/v1/listings', request(sym(), { link: 'javascript:alert(1)' }))).status,
    ).toBe(400);
    const m = await fx.market();
    const existing = await t.client.post('/v1/listings', request(m.base, { quoteAsset: m.quote }));
    expect(existing.status).toBe(409);
    expect(existing.body.error.message).toMatch(/already listed/);
    expect((await new TestClient(app).post('/v1/listings', request(sym()))).status).toBe(401);
  });
});

describe('listing decisions', () => {
  it('are staff-only, explained, audited and name the listed market', async () => {
    const t = await fx.trader();
    const base = sym();
    const r = await t.client.post('/v1/listings', request(base));
    const id = r.body.id as string;
    expect(
      (await t.client.post(`/v1/admin/listings/${id}/decision`, { status: 'review' })).status,
    ).toBe(403);

    const staff = (await fx.trader()).userId;
    const ctx = { requestId: 'test', ipAddress: null, userAgent: null };
    expect((await listings.decide(staff, id, { status: 'review' }, ctx)).status).toBe('review');

    // A listing must name a matching market.
    await expect(
      listings.decide(
        staff,
        id,
        { status: 'listed', note: 'Meets the published liquidity criteria.', market: 'NOPE-USD' },
        ctx,
      ),
    ).rejects.toThrow(/No matching market|existing market/);
    await app.get(LedgerService).createAsset({ code: base, name: 'New', scale: 8 }, SYSTEM);
    const m = await app
      .get(MarketsService)
      .create(
        { base, quote, tickSize: '0.01', lotSize: '0.0001', makerFeeBps: 0, takerFeeBps: 0 },
        SYSTEM,
      );
    const listed = await listings.decide(
      staff,
      id,
      { status: 'listed', note: 'Meets the published liquidity criteria.', market: m.symbol },
      ctx,
    );
    expect(listed).toMatchObject({
      status: 'listed',
      market: m.symbol,
      decisionNote: 'Meets the published liquidity criteria.',
    });
    await expect(
      listings.decide(staff, id, { status: 'rejected', note: 'Too late to reject now.' }, ctx),
    ).rejects.toThrow(/cannot move/);
    expect(
      await prisma.auditLog.count({ where: { action: 'listing.decided', targetId: id } }),
    ).toBe(2);
    const pub = (await new TestClient(app).get(`/v1/listings/${id}`)).body;
    expect(pub).toMatchObject({ status: 'listed', market: m.symbol });
    expect(pub.mine).toBeUndefined();
  });
});
