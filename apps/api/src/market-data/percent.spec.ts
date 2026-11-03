import { percentChange } from './market-data.service';

describe('percentChange', () => {
  it.each([
    [100n, 101n, '1.00'],
    [100n, 99n, '-1.00'],
    [300n, 301n, '0.33'],
    [300n, 299n, '-0.33'],
    [7n, 7n, '0.00'],
    [1n, 1000n, '99900.00'],
    [10_000n, 10_001n, '0.01'],
    [10_000n, 9_999n, '-0.01'],
    [100_000n, 100_001n, '0.00'],
  ])('%s → %s = %s%%', (from, to, expected) => {
    expect(percentChange(from, to)).toBe(expected);
  });
});
