import { conversionFloor, conversionLots, haircutValue } from './collateral-math';

describe('collateral conversion', () => {
  it('never sells below the bid minus the haircut', () => {
    expect(conversionFloor(10_000n, 1000)).toBe(9_000n);
    expect(conversionFloor(1n, 5000)).toBe(1n);
  });
  it('sells just enough to cover the shortfall at the floor price', () => {
    const base = { quotePerLotAtFloor: 90n, availableLots: 1_000n, minLots: 1n };
    expect(conversionLots({ ...base, shortfall: 900n })).toBe(10n);
    expect(conversionLots({ ...base, shortfall: 901n })).toBe(11n); // rounded up
    expect(conversionLots({ ...base, shortfall: 10n, minLots: 5n })).toBe(5n);
  });
  it('sells at most what is free, and nothing below the market minimum', () => {
    const base = { quotePerLotAtFloor: 90n, minLots: 2n };
    expect(conversionLots({ ...base, shortfall: 1_000_000n, availableLots: 50n })).toBe(50n);
    expect(conversionLots({ ...base, shortfall: 1_000n, availableLots: 1n })).toBeNull();
    expect(conversionLots({ ...base, shortfall: 0n, availableLots: 50n })).toBeNull();
  });
  it('values collateral after the haircut', () => {
    expect(haircutValue(1_000n, 1500)).toBe(850n);
  });
});
