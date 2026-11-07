import { csvField, periodBounds, signed } from './statement';

describe('statement helpers', () => {
  it('computes UTC month and year bounds', () => {
    expect(periodBounds('2026-10')).toEqual({
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-11-01T00:00:00Z'),
    });
    expect(periodBounds('2026-12').to).toEqual(new Date('2027-01-01T00:00:00Z'));
    expect(periodBounds('2026')).toEqual({
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2027-01-01T00:00:00Z'),
    });
  });
  it('formats signed amounts', () => {
    expect(signed(-2_500_000n, 6)).toBe('-2.5');
    expect(signed(1_500_000n, 6, true)).toBe('+1.5');
    expect(signed(0n, 6, true)).toBe('0');
  });
  it('quotes CSV fields and neutralises formulas in text', () => {
    expect(csvField('a"b')).toBe('"a""b"');
    expect(csvField('=HYPERLINK("x")', true)).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvField('-1.5')).toBe('"-1.5"'); // numbers keep their sign
  });
});
