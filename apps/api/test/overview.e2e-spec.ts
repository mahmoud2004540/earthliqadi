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

  it('statements: opening, credits, debits, closing per asset; internal holds left out; CSV', async () => {
    const ledger = app.get(LedgerService);
    const base = `S${randomBytes(3).toString('hex').toUpperCase()}`;
    await ledger
      .createAsset({ code: base, name: 'Statement base', scale: 8 }, SYSTEM)
      .catch(() => undefined);
    const m = await app
      .get(MarketsService)
      .create(
        { base, quote: VAL, tickSize: '0.01', lotSize: '0.0001', makerFeeBps: 0, takerFeeBps: 0 },
        SYSTEM,
      );
    const t = await fx.trader([{ asset: VAL, amount: '1000', scale: 6 }]);
    const s = await fx.trader([{ asset: base, amount: '2', scale: 8 }]);
    await fx.place(s, {
      market: m.symbol,
      side: 'sell',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    const buy = await fx.place(t, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '100',
      quantity: '1',
    });
    await fx.until(async () => (await fx.status(buy.body.id)) === 'FILLED');
    // An open order only moves funds inside the account: not a statement line.
    const rest = await fx.place(t, {
      market: m.symbol,
      side: 'buy',
      type: 'limit',
      price: '50',
      quantity: '2',
    });
    await fx.until(async () => (await fx.status(rest.body.id)) === 'OPEN');

    const period = new Date().toISOString().slice(0, 7);
    const st = (await t.client.get(`/v1/me/statements?period=${period}`)).body;
    expect(st.assets).toEqual(
      [
        { asset: base, opening: '0', credits: '1', debits: '0', closing: '1' },
        { asset: VAL, opening: '0', credits: '1000', debits: '-100', closing: '900' },
      ].sort((a, b) => a.asset.localeCompare(b.asset)),
    );
    expect(st.lines.map((l: { type: string }) => l.type)).not.toContain('BALANCE_HOLD');
    expect(
      st.lines
        .filter((l: { asset: string }) => l.asset === VAL)
        .map((l: { change: string }) => l.change),
    ).toEqual(['+1000', '-100']);
    expect(st.truncated).toBe(false);

    // The closing balance equals the account's actual total.
    const bal = (await t.client.get('/v1/me/balances')).body.balances.find(
      (b: { asset: string }) => b.asset === VAL,
    );
    expect(bal.total).toBe('900.000000');

    const [y, mo] = period.split('-').map(Number) as [number, number];
    const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
    expect((await t.client.get(`/v1/me/statements?period=${prev}`)).body.assets).toEqual([]);
    expect((await t.client.get('/v1/me/statements?period=2026-13')).status).toBe(400);

    const csv = await t.client.get(`/v1/me/statements.csv?period=${period}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toBe(
      `attachment; filename="statement-${period}.csv"`,
    );
    expect(csv.text).toContain(`"${VAL}","0","1000","-100","900"`);
    expect(csv.text).toContain('Not a bank statement');
  });
});
