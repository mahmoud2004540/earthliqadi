import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AmountError,
  MAX_MINOR_UNITS,
  formatAmount,
  formatAmountTrimmed,
  parseAmount,
} from './amount';

describe('parseAmount', () => {
  it.each([
    ['1', 8, 100000000n],
    ['0.00000001', 8, 1n],
    ['12.5', 2, 1250n],
    ['0', 6, 0n],
    ['42', 0, 42n],
    ['1.000000000000000001', 18, 1000000000000000001n],
  ])('%s with scale %i → %s', (input, scale, expected) => {
    expect(parseAmount(input, scale)).toBe(expected);
  });

  it.each(['', '-1', '1e5', '01', '1.', '.5', ' 1', '1,5', 'NaN', 'Infinity', '0x10', '+1'])(
    'rejects %j',
    (input) => {
      expect(() => parseAmount(input, 8)).toThrow(AmountError);
    },
  );

  it('never rounds: rejects more decimals than the scale', () => {
    expect(() => parseAmount('0.000000001', 8)).toThrow(/more than 8 decimal places/);
    expect(() => parseAmount('1.5', 0)).toThrow(AmountError);
  });

  it('rejects amounts beyond NUMERIC(38,0)', () => {
    expect(() => parseAmount('1' + '0'.repeat(38), 0)).toThrow(/too large/);
    expect(parseAmount('9'.repeat(38), 0)).toBe(MAX_MINOR_UNITS);
  });

  it('rejects invalid scales', () => {
    expect(() => parseAmount('1', 19)).toThrow(AmountError);
    expect(() => parseAmount('1', -1)).toThrow(AmountError);
    expect(() => parseAmount('1', 1.5)).toThrow(AmountError);
  });
});

describe('formatAmount', () => {
  it('pads to the asset scale', () => {
    expect(formatAmount(1n, 8)).toBe('0.00000001');
    expect(formatAmount(150000000n, 8)).toBe('1.50000000');
    expect(formatAmount(42n, 0)).toBe('42');
    expect(formatAmount(-5n, 2)).toBe('-0.05');
  });

  it('trims trailing zeros on request', () => {
    expect(formatAmountTrimmed(150000000n, 8)).toBe('1.5');
    expect(formatAmountTrimmed(100000000n, 8)).toBe('1');
    expect(formatAmountTrimmed(0n, 8)).toBe('0');
    expect(formatAmountTrimmed(100n, 0)).toBe('100');
  });
});

describe('amount properties', () => {
  const scale = fc.integer({ min: 0, max: 18 });
  const minor = fc.bigInt({ min: 0n, max: MAX_MINOR_UNITS });

  it('parse(format(x)) === x for every amount and scale', () => {
    fc.assert(fc.property(minor, scale, (x, s) => parseAmount(formatAmount(x, s), s) === x));
  });

  it('trimmed formatting also round-trips', () => {
    fc.assert(fc.property(minor, scale, (x, s) => parseAmount(formatAmountTrimmed(x, s), s) === x));
  });

  it('formatting preserves order (no precision loss)', () => {
    fc.assert(
      fc.property(minor, minor, scale, (a, b, s) => {
        const fa = parseAmount(formatAmount(a, s), s);
        const fb = parseAmount(formatAmount(b, s), s);
        return a < b === fa < fb;
      }),
    );
  });
});
