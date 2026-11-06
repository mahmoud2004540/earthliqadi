/**
 * Pure rules for the pro order tools (ADR-0025). Prices are integer ticks,
 * quantities integer lots; nothing here does I/O.
 */

export type Side = 'BUY' | 'SELL';

// ------------------------------------------------------------ trailing stop

export interface TrailingState {
  activated: boolean;
  /** Peak (sell) or trough (buy) reference price since activation. */
  extreme: bigint | null;
}

export interface TrailingParams {
  side: Side;
  callbackBps: number;
  activation: bigint | null;
}

/**
 * Advances a trailing stop with a new reference price. A sell trailing stop
 * (protecting a long) triggers when the price falls `callbackBps` below its
 * peak; a buy trailing stop when it rises that much above its trough.
 * Tracking starts once the activation price is reached (sell: at or above,
 * buy: at or below), or immediately without one.
 */
export function trailingStep(
  state: TrailingState,
  p: TrailingParams,
  price: bigint,
): TrailingState & { triggered: boolean } {
  let { activated, extreme } = state;
  if (!activated) {
    const reached =
      p.activation === null || (p.side === 'SELL' ? price >= p.activation : price <= p.activation);
    if (!reached) return { activated, extreme, triggered: false };
    activated = true;
    extreme = price;
  }
  if (extreme === null) extreme = price;
  if (p.side === 'SELL' && price > extreme) extreme = price;
  if (p.side === 'BUY' && price < extreme) extreme = price;
  const cb = BigInt(p.callbackBps);
  const triggered =
    p.side === 'SELL'
      ? price * 10_000n <= extreme * (10_000n - cb)
      : price * 10_000n >= extreme * (10_000n + cb);
  return { activated, extreme, triggered };
}

/** Worst acceptable price of the order a triggered trailing stop sends. */
export function protectionPrice(side: Side, reference: bigint, slippageBps: number): bigint {
  const s = BigInt(slippageBps);
  if (side === 'SELL') {
    const p = (reference * (10_000n - s)) / 10_000n;
    return p < 1n ? 1n : p;
  }
  return (reference * (10_000n + s) + 9_999n) / 10_000n;
}

// ------------------------------------------------------------ chase

/**
 * Price a chase order should rest at: the best price on its own side of the
 * visible book (joining the queue as a maker), never beyond the cap. With an
 * empty own side it rests one tick inside the opposite best, or at the cap.
 */
export function chaseTarget(
  side: Side,
  best: { bid: bigint | null; ask: bigint | null },
  cap: bigint,
): bigint {
  let target: bigint;
  if (side === 'BUY') {
    target = best.bid ?? (best.ask !== null && best.ask > 1n ? best.ask - 1n : cap);
    return target > cap ? cap : target;
  }
  target = best.ask ?? (best.bid !== null ? best.bid + 1n : cap);
  return target < cap ? cap : target;
}

/** Whether a resting chase child must be replaced: the market moved past it. */
export function chaseNeedsReprice(side: Side, childPrice: bigint, target: bigint): boolean {
  return side === 'BUY' ? target > childPrice : target < childPrice;
}

// ------------------------------------------------------------ scaled orders

export type ScaleDistribution = 'flat' | 'increasing' | 'decreasing';

/**
 * Splits `totalLots` into `count` limit orders at evenly spaced prices from
 * `start` to `end` (inclusive). `increasing` puts more size towards `end`.
 * Rounding leftovers go to the largest order. Throws a message on bad input.
 */
export function scalePlan(p: {
  totalLots: bigint;
  start: bigint;
  end: bigint;
  count: number;
  distribution: ScaleDistribution;
  minLots: bigint;
}): { priceTicks: bigint; lots: bigint }[] {
  const { count } = p;
  if (!Number.isInteger(count) || count < 2 || count > 20) throw new Error('count must be 2-20');
  const span = p.end - p.start;
  const absSpan = span < 0n ? -span : span;
  if (absSpan < BigInt(count - 1))
    throw new Error('The price range is too narrow for that many orders');
  const weights = Array.from({ length: count }, (_, i) =>
    BigInt(p.distribution === 'flat' ? 1 : p.distribution === 'increasing' ? i + 1 : count - i),
  );
  const sumW = weights.reduce((a, b) => a + b, 0n);
  const lots = weights.map((w) => (p.totalLots * w) / sumW);
  const leftover = p.totalLots - lots.reduce((a, b) => a + b, 0n);
  let biggest = 0;
  for (let i = 1; i < count; i++) if (weights[i]! > weights[biggest]!) biggest = i;
  lots[biggest]! += leftover;
  if (lots.some((l) => l < p.minLots))
    throw new Error('Each order would be below the market minimum; use fewer orders');
  const den = BigInt(count - 1);
  return lots.map((l, i) => {
    // Round to the nearest tick.
    const num = span * BigInt(i);
    const offset = num >= 0n ? (num * 2n + den) / (den * 2n) : -((-num * 2n + den) / (den * 2n));
    return { priceTicks: p.start + offset, lots: l };
  });
}

// ------------------------------------------------------------ grid

export type GridDirection = 'LONG' | 'SHORT' | 'NEUTRAL';

/** Arithmetic grid: `count` intervals, so count + 1 levels from lower to upper. */
export function gridLevels(lower: bigint, upper: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 2 || count > 100)
    throw new Error('gridCount must be 2-100');
  if (upper <= lower) throw new Error('upperPrice must be above lowerPrice');
  if (upper - lower < BigInt(count))
    throw new Error('The price range is too narrow for that many grids');
  const c = BigInt(count);
  return Array.from({ length: count + 1 }, (_, i) => lower + ((upper - lower) * BigInt(i)) / c);
}

/**
 * Orders a grid places at start. Levels below the reference buy, levels
 * above sell; a level equal to the reference gets nothing. LONG grids only
 * buy at first (sells follow fills), SHORT grids only sell, NEUTRAL both.
 */
export function initialGridOrders(
  levels: bigint[],
  reference: bigint,
  direction: GridDirection,
): { level: number; side: Side }[] {
  const out: { level: number; side: Side }[] = [];
  levels.forEach((price, level) => {
    if (price < reference && direction !== 'SHORT') out.push({ level, side: 'BUY' });
    if (price > reference && direction !== 'LONG') out.push({ level, side: 'SELL' });
  });
  return out;
}

/**
 * The order that answers a filled grid order: a buy at level i is answered
 * by a sell one level up, a sell by a buy one level down. Null at the edges.
 */
export function gridCounter(
  side: Side,
  level: number,
  levelCount: number,
): { level: number; side: Side } | null {
  if (side === 'BUY') return level + 1 < levelCount ? { level: level + 1, side: 'SELL' } : null;
  return level - 1 >= 0 ? { level: level - 1, side: 'BUY' } : null;
}
