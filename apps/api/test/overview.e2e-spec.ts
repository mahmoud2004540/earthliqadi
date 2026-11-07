import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { LedgerService } from '../src/ledger/ledger.service';
import { MarketsService } from '../src/trading/markets.service';
import { EngineProcess } from './engine';
import { bootApp } from './helpers';
import { SYSTEM, TradingFixture } from './trading-helpers';

/** Account overview (ADR-0028): balances, custody and an indicative total. */
const VAL = `V${randomBytes(3).toString('hex').toUpperCase()}`;
let app: INestApplication;
let fx: TradingFixture;
const engine = new EngineProcess();
let saved: string | undefined;

beforeAll(async () => {
  saved = process.env.VALUATION_ASSET;
  process.env.VALUATION_ASSET = VAL;
  app = await bootApp();
  fx = new TradingFixture(app, engine);
  await engine.start();
}, 60_000);

afterAll(async () => {
  await engine.stop();
  await app.close();
  if (saved === undefined) delete process.env.VALUATION_ASSET;
  else process.env.VALUATION_ASSET = saved;
});

describe('account overview', () => {
  it('values balances at the last trade, lists unpriced assets and never estimates', async () => {
    const ledger = app.get(LedgerService);
    const base = `B${randomBytes(3).toString('hex').toUpperCase()}`;
    const loose = `L${randomBytes(3).toString('hex').toUpperCase()}`;
    await ledger.createAsset({ code: VAL, name: 'Valuation USD', scale: 6 }, SYSTEM);
    await ledger.createAsset({ code: base, name: 'Base', scale: 8 }, SYSTEM);
    await ledger.createAsset({ code: loose, name: 'No market', scale: 8 }, SYSTEM);
    const m = await app
      .get(MarketsService)
      .create(
        { base, quote: VAL, tickSize: '0.01', lotSize: '0.0001', makerFeeBps: 0, takerFeeBps: 0 },
        SYSTEM,
      );

    const t = await fx.trader([
      { asset: base, amount: '3', scale: 8 },
      { asset: VAL, amount: '500', scale: 6 },
      { asset: loose, amount: '7', scale: 8 },
    ]);
    // Before any trade the base asset has no price: unvalued, not guessed.
    let o = (await t.client.get('/v1/me/overview')).body;
    expect(o).toMatchObject({
      valuationAsset: VAL,
      totalValue: '500',
      unvalued: [base, loose].sort(),
    });

    // A trade at 120 sets the last price (another pair of traders).
    const s = await fx.trader([{ asset: base, amount: '1', scale: 8 }]);
    const b = await fx.trader([{ asset: VAL, amount: '1000', scale: 6 }]);
    await fx.place(s, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '120',
      quantity: '0.5',
    });
    const buy = await fx.place(b, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '120',
      quantity: '0.5',
    });
    await fx.until(async () => (await fx.status(buy.body.id)) === 'FILLED');

    // An open order moves funds to "locked" but keeps them in the total.
    const rest = await fx.place(t, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '200',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(rest.body.id)) === 'OPEN');

    o = (await t.client.get('/v1/me/overview')).body;
    const byCode = Object.fromEntries(o.assets.map((a: { asset: string }) => [a.asset, a]));
    expect(byCode[base]).toMatchObject({
      total: '3.00000000',
      locked: '1.00000000',
      price: '120',
      priceSource: 'last_trade',
      priceMarket: m.symbol,
      value: '360',
      custody: 'ledger',
    });
    expect(byCode[VAL]).toMatchObject({ priceSource: 'reference', value: '500.000000' });
    expect(byCode[loose].value).toBeNull();
    expect(o.unvalued).toEqual([loose]);
    expect(o.totalValue).toBe('860'); // 360 + 500; the unpriced asset is left out
  });
});
