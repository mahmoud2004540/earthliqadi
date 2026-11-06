/**
 * Multi-collateral conversion sizing (ADR-0027). Pure; prices in ticks,
 * sizes in lots, money in quote minor units.
 */

/** Worst price a conversion may sell at: the bid minus the haircut, at least one tick. */
export function conversionFloor(bidTicks: bigint, haircutBps: number): bigint {
  const p = (bidTicks * BigInt(10_000 - haircutBps)) / 10_000n;
  return p < 1n ? 1n : p;
}

/**
 * How many lots to sell so that, even at the worst accepted price, the
 * proceeds cover `shortfall`. Rounded up to whole lots, at least the market
 * minimum, at most what is free. Null when nothing useful can be sold.
 */
export function conversionLots(p: {
  shortfall: bigint;
  /** Quote minor units one lot fetches at the floor price. */
  quotePerLotAtFloor: bigint;
  availableLots: bigint;
  minLots: bigint;
}): bigint | null {
  if (p.shortfall <= 0n || p.quotePerLotAtFloor <= 0n || p.availableLots < p.minLots) return null;
  let lots = (p.shortfall + p.quotePerLotAtFloor - 1n) / p.quotePerLotAtFloor;
  if (lots < p.minLots) lots = p.minLots;
  return lots > p.availableLots ? p.availableLots : lots;
}

/** Value of a balance after the haircut, at the bid (quote minor units). */
export function haircutValue(quoteAtBid: bigint, haircutBps: number): bigint {
  return (quoteAtBid * BigInt(10_000 - haircutBps)) / 10_000n;
}
