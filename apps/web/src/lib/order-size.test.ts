import { describe, expect, it } from 'vitest';
import { sizeForPercent, type SizeInput } from './order-size';

const base: SizeInput = {
  side: 'buy',
  perp: false,
  available: '1000',
  price: '100',
  leverage: 1,
  takerFeeBps: 0,
  lotSize: '0.001',
  scales: { base: 8, quote: 6 },
};

describe('sizeForPercent', () => {
  it('spends the free quote balance at the price, rounded down to lots', () => {
    expect(sizeForPercent(base, 100)).toBe('10');
    expect(sizeForPercent(base, 25)).toBe('2.5');
    expect(sizeForPercent({ ...base, price: '300' }, 100)).toBe('3.333');
  });
  it('reserves the taker fee and applies perpetual leverage', () => {
    expect(sizeForPercent({ ...base, takerFeeBps: 10 }, 100)).toBe('9.99');
    expect(sizeForPercent({ ...base, perp: true, leverage: 10 }, 50)).toBe('50');
    expect(sizeForPercent({ ...base, perp: false, leverage: 10 }, 100)).toBe('10'); // spot ignores it
  });
  it('sells the free base balance on spot without needing a price', () => {
    expect(sizeForPercent({ ...base, side: 'sell', available: '2.34567', price: '' }, 50)).toBe(
      '1.172',
    );
  });
  it('returns null when it cannot compute a size', () => {
    expect(sizeForPercent({ ...base, price: '' }, 50)).toBeNull();
    expect(sizeForPercent({ ...base, available: '0' }, 50)).toBeNull();
    expect(sizeForPercent(base, 0)).toBeNull();
    expect(sizeForPercent({ ...base, available: 'abc' }, 50)).toBeNull();
  });
});
