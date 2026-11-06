import { oracleToQuote } from './perp-risk.service';

describe('oracleToQuote', () => {
  it('converts feed decimals to quote minor units, rounding down', () => {
    expect(oracleToQuote(6_543_210_000_000n, 8, 6)).toBe(65_432_100_000n); // 65 432.1
    expect(oracleToQuote(123_456_789n, 8, 6)).toBe(1_234_567n); // 1.23456789 → 1.234567
    expect(oracleToQuote(5n, 2, 6)).toBe(50_000n); // 0.05
    expect(oracleToQuote(7n, 6, 6)).toBe(7n);
  });
});
