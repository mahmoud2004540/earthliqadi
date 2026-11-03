import fc from 'fast-check';
import { AppError } from '../common/app-error';
import {
  baseAmount,
  feeFor,
  holdAmount,
  lotsToQuantity,
  priceToTicks,
  quantityToLots,
  quoteAmount,
  quotePerTickLot,
  ticksToPrice,
  type MarketUnits,
} from './order-math';

// BTC (8) / USDT (6): tick 0.01 USDT, lot 0.0001 BTC → 1 micro-USDT per tick·lot.
const BTC_USDT: MarketUnits = { baseScale: 8, quoteScale: 6, tickSize: 10_000n, lotSize: 10_000n };

describe('market units', () => {
  it('computes quote per tick·lot exactly', () => {
    expect(quotePerTickLot(BTC_USDT)).toBe(1n);
  });

  it('rejects unit combinations that would need fractional quote minor units', () => {
    expect(() => quotePerTickLot({ ...BTC_USDT, lotSize: 1_000n })).toThrow(AppError);
  });

  it('converts prices and quantities both ways', () => {
    expect(priceToTicks('65000.01', BTC_USDT)).toBe(6_500_001n);
    expect(quantityToLots('0.5', BTC_USDT)).toBe(5_000n);
    expect(ticksToPrice(6_500_001n, BTC_USDT)).toBe('65000.01');
    expect(lotsToQuantity(5_000n, BTC_USDT)).toBe('0.5');
  });

  it.each([
    ['65000.001', 'multiple'],
    ['65000.0000001', 'more than 6 decimal places'],
    ['0', 'positive'],
    ['-1', 'plain'],
  ])('rejects price %s', (price, message) => {
    expect(() => priceToTicks(price, BTC_USDT)).toThrow(new RegExp(message));
  });

  it('rejects quantities off the lot grid', () => {
    expect(() => quantityToLots('0.00015', BTC_USDT)).toThrow(/multiple/);
  });

  it('computes trade amounts: 0.5 BTC at 65000.01 = 32500.005 USDT', () => {
    const ticks = priceToTicks('65000.01', BTC_USDT);
    const lots = quantityToLots('0.5', BTC_USDT);
    expect(quoteAmount(ticks, lots, BTC_USDT)).toBe(32_500_005_000n); // 32500.005000 USDT
    expect(baseAmount(lots, BTC_USDT)).toBe(50_000_000n); // 0.5 BTC in satoshi
  });

  it('round-trips random grid values exactly', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (t, l) => {
          return (
            priceToTicks(ticksToPrice(t, BTC_USDT), BTC_USDT) === t &&
            quantityToLots(lotsToQuantity(l, BTC_USDT), BTC_USDT) === l
          );
        },
      ),
    );
  });
});

describe('holds and fees', () => {
  it('holds quote at the limit price for buys and base for sells', () => {
    expect(holdAmount('BUY', 100n, 3n, BTC_USDT)).toBe(300n);
    expect(holdAmount('SELL', null, 3n, BTC_USDT)).toBe(30_000n);
    expect(() => holdAmount('BUY', null, 3n, BTC_USDT)).toThrow(/protection price/);
  });

  it('rounds fees down and never exceeds 10%', () => {
    expect(feeFor(10_000n, 10)).toBe(10n); // 0.10%
    expect(feeFor(999n, 10)).toBe(0n); // tiny fill: no fee (customer-favourable)
    expect(() => feeFor(1n, 1001)).toThrow();
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.integer({ min: 0, max: 1000 }),
        (amount, bps) => {
          const fee = feeFor(amount, bps);
          return fee >= 0n && fee * 10n <= amount && fee * 10_000n <= amount * BigInt(bps);
        },
      ),
    );
  });
});
