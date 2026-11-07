import { sumDecimals, valueAt } from './overview-math';

describe('overview math', () => {
  it('sums exactly, including negatives', () => {
    expect(sumDecimals(['0.1', '0.2'], 6)).toBe('0.3');
    expect(sumDecimals(['10', '-12.5'], 6)).toBe('-2.5');
    expect(sumDecimals([], 6)).toBe('0');
  });
  it('values a balance at a price exactly', () => {
    expect(valueAt('100.5', '2.00000001', 8, 6)).toBe('201.000001');
    expect(valueAt('abc', '1', 8, 6)).toBeNull();
  });
});
