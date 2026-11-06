/**
 * Pure perpetual-futures arithmetic (ADR-0011). No I/O, no floating point:
 * every amount is a bigint of quote minor units, sizes are signed lots
 * (positive = long), prices are quote minor units per ONE whole base unit.
 *
 * Accounting identity (proved in the ADR and property-tested):
 * for every fill, Δentry − realizedPnl = sign(Δsize) × notional. A buyer and a
 * seller of the same fill have opposite signs, so per market
 *     Σ entryNotional (open positions) = Σ realizedPnl (all time)
 * and the clearing account, which pays out realised PnL, always equals the sum
 * of open entry notionals. Reconciliation checks this exactly.
 */
import type { MarketUnits } from '../trading/order-math';

export interface PositionState {
  /** Signed lots. */
  size: bigint;
  /** Signed entry notional (positive for longs), quote minor units. */
  entry: bigint;
  /** Isolated margin, quote minor units, ≥ 0. */
  margin: bigint;
}

export interface FillResult {
  closedLots: bigint;
  openedLots: bigint;
  /** Fill notional attributed to the closing part. */
  closeNotional: bigint;
  /** Fill notional attributed to the opening part. */
  openNotional: bigint;
  /** Realised PnL of the closing part (signed). */
  realizedPnl: bigint;
  /** Margin released by the closing part (proportional), ≥ 0. */
  releasedMargin: bigint;
  /** Position after the fill, before any margin is added for the opening part. */
  next: PositionState;
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);
const sign = (v: bigint): bigint => (v > 0n ? 1n : v < 0n ? -1n : 0n);

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('ceilDiv: divisor must be positive');
  return a >= 0n ? (a + b - 1n) / b : -(-a / b);
}

function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('floorDiv: divisor must be positive');
  return a >= 0n ? a / b : -ceilDiv(-a, b);
}

export { abs as absBig, ceilDiv, floorDiv };

/** Base units per lot denominator: notional = price × lots × lotSize / 10^baseScale. */
function baseDivisor(u: MarketUnits): bigint {
  return 10n ** BigInt(u.baseScale);
}

/** |notional| at a price (quote minor units per whole base unit), rounded down or up. */
export function notionalAt(
  priceMinor: bigint,
  lots: bigint,
  u: MarketUnits,
  round: 'down' | 'up' = 'down',
): bigint {
  const raw = priceMinor * abs(lots) * u.lotSize;
  return round === 'down' ? raw / baseDivisor(u) : ceilDiv(raw, baseDivisor(u));
}

/**
 * Applies a fill of `dq` signed lots with total notional `notional` (> 0) to a
 * position. Splits the fill into a closing part (opposite to the current
 * position) and an opening part. The caller adds margin for the opening part.
 */
export function applyFill(pos: PositionState, dq: bigint, notional: bigint): FillResult {
  if (dq === 0n) throw new Error('applyFill: zero quantity');
  if (notional <= 0n) throw new Error('applyFill: notional must be positive');
  const q = abs(dq);
  const closing = pos.size !== 0n && sign(dq) !== sign(pos.size) ? minBig(q, abs(pos.size)) : 0n;
  const opening = q - closing;
  const closeNotional = (notional * closing) / q;
  const openNotional = notional - closeNotional;

  let entry = pos.entry;
  let margin = pos.margin;
  let realizedPnl = 0n;
  let releasedMargin = 0n;
  if (closing > 0n) {
    const full = closing === abs(pos.size);
    // Truncation toward zero keeps the removed share on the position's side.
    const removed = full ? pos.entry : (pos.entry * closing) / abs(pos.size);
    realizedPnl = -sign(dq) * closeNotional - removed;
    entry -= removed;
    releasedMargin = full ? pos.margin : (pos.margin * closing) / abs(pos.size);
    margin -= releasedMargin;
  }
  entry += sign(dq) * openNotional;
  return {
    closedLots: closing,
    openedLots: opening,
    closeNotional,
    openNotional,
    realizedPnl,
    releasedMargin,
    next: { size: pos.size + dq, entry, margin },
  };
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Signed position value at a price, rounded against the position holder. */
export function positionValue(size: bigint, priceMinor: bigint, u: MarketUnits): bigint {
  if (size >= 0n) return notionalAt(priceMinor, size, u, 'down');
  return -notionalAt(priceMinor, size, u, 'up');
}

export function unrealizedPnl(pos: PositionState, markMinor: bigint, u: MarketUnits): bigint {
  return positionValue(pos.size, markMinor, u) - pos.entry;
}

export function equity(pos: PositionState, markMinor: bigint, u: MarketUnits): bigint {
  return pos.margin + unrealizedPnl(pos, markMinor, u);
}

/** Basis points of an amount, rounded up (risk-conservative). */
export function bpsUp(amount: bigint, bps: number): bigint {
  return ceilDiv(abs(amount) * BigInt(bps), 10_000n);
}

export function maintenanceMargin(
  pos: PositionState,
  markMinor: bigint,
  u: MarketUnits,
  mmrBps: number,
): bigint {
  return bpsUp(notionalAt(markMinor, pos.size, u, 'up'), mmrBps);
}

export function isLiquidatable(
  pos: PositionState,
  markMinor: bigint,
  u: MarketUnits,
  mmrBps: number,
): boolean {
  if (pos.size === 0n) return false;
  return equity(pos, markMinor, u) < maintenanceMargin(pos, markMinor, u, mmrBps);
}

/** Initial margin for a notional at a leverage, rounded up. */
export function initialMargin(notional: bigint, leverage: number): bigint {
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error('Invalid leverage');
  return ceilDiv(notional, BigInt(leverage));
}

/**
 * Bankruptcy price in TICKS: the price at which equity reaches zero, rounded
 * so that a closing order at this price never realises more than the margin
 * (longs: up, shorts: down). Returns at least 1 tick.
 */
export function bankruptcyTicks(pos: PositionState, u: MarketUnits): bigint {
  if (pos.size === 0n) throw new Error('bankruptcyTicks: flat position');
  const denom = abs(pos.size) * u.lotSize * u.tickSize;
  const scaled = baseDivisor(u);
  if (pos.size > 0n) {
    const numerator = (pos.entry - pos.margin) * scaled;
    const ticks = numerator <= 0n ? 1n : ceilDiv(numerator, denom);
    return ticks < 1n ? 1n : ticks;
  }
  const numerator = (pos.margin - pos.entry) * scaled; // entry < 0 for shorts
  const ticks = floorDiv(numerator, denom);
  return ticks < 1n ? 1n : ticks;
}

/**
 * Whether a closing order priced at `limitTicks` stays within the bankruptcy
 * price (a worse price would realise a loss larger than the position margin).
 */
export function withinBankruptcy(pos: PositionState, limitTicks: bigint, u: MarketUnits): boolean {
  if (pos.size === 0n) return true;
  const b = bankruptcyTicks(pos, u);
  return pos.size > 0n ? limitTicks >= b : limitTicks <= b;
}

// ------------------------------------------------------------------ risk tiers

export interface RiskTier {
  /** Upper bound of position notional for this tier (quote minor units). */
  maxNotional: bigint;
  maxLeverage: number;
  mmrBps: number;
}

export function tierFor(tiers: RiskTier[], notional: bigint): RiskTier | null {
  for (const t of tiers) if (notional <= t.maxNotional) return t;
  return null;
}

export function validateTiers(tiers: RiskTier[]): string | null {
  if (tiers.length === 0) return 'At least one risk tier is required';
  let prev: RiskTier | null = null;
  for (const t of tiers) {
    if (t.maxNotional <= 0n) return 'Tier maxNotional must be positive';
    if (!Number.isInteger(t.maxLeverage) || t.maxLeverage < 1 || t.maxLeverage > 125)
      return 'Tier maxLeverage must be 1-125';
    if (!Number.isInteger(t.mmrBps) || t.mmrBps < 1 || t.mmrBps > 5000)
      return 'Tier mmrBps must be 1-5000';
    // Maintenance margin must stay strictly below initial margin, or new positions
    // would be liquidatable on entry.
    if (t.mmrBps * t.maxLeverage >= 10_000)
      return 'Tier mmrBps × maxLeverage must be below 10000 (maintenance < initial margin)';
    if (prev) {
      if (t.maxNotional <= prev.maxNotional) return 'Tiers must have increasing maxNotional';
      if (t.maxLeverage > prev.maxLeverage) return 'Larger tiers cannot allow more leverage';
      if (t.mmrBps < prev.mmrBps) return 'Larger tiers cannot have a lower maintenance rate';
    }
    prev = t;
  }
  return null;
}

// ------------------------------------------------------------- index and mark

export interface SourceSample {
  /** Price in quote minor units per whole base unit, or null if unavailable. */
  price: bigint | null;
  observedAt: Date;
}

export function medianBig(values: bigint[]): bigint {
  if (values.length === 0) throw new Error('median of empty list');
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

export interface IndexResult {
  price: bigint | null;
  used: number;
  rejectedStale: number;
  rejectedOutliers: number;
}

/**
 * Index = median of fresh sources after rejecting outliers (more than
 * `outlierBps` from the median of all fresh sources). Null when fewer than
 * `minSources` remain: the market then has no reliable index, and funding
 * and liquidations pause (ADR-0011).
 */
export function computeIndex(
  samples: SourceSample[],
  now: Date,
  opts: { staleMs: number; outlierBps: number; minSources: number },
): IndexResult {
  const fresh = samples.filter(
    (s): s is { price: bigint; observedAt: Date } =>
      s.price !== null && s.price > 0n && now.getTime() - s.observedAt.getTime() <= opts.staleMs,
  );
  const rejectedStale = samples.length - fresh.length;
  if (fresh.length === 0) return { price: null, used: 0, rejectedStale, rejectedOutliers: 0 };
  const m = medianBig(fresh.map((s) => s.price));
  const kept = fresh.filter((s) => abs(s.price - m) * 10_000n <= m * BigInt(opts.outlierBps));
  const rejectedOutliers = fresh.length - kept.length;
  if (kept.length < opts.minSources)
    return { price: null, used: kept.length, rejectedStale, rejectedOutliers };
  return {
    price: medianBig(kept.map((s) => s.price)),
    used: kept.length,
    rejectedStale,
    rejectedOutliers,
  };
}

/** Exponential moving average step with period n (integer arithmetic). */
export function emaStep(previous: bigint, sample: bigint, period: number): bigint {
  const n = BigInt(period);
  return (previous * (n - 1n) + 2n * sample) / (n + 1n);
}

/**
 * Mark = index + clamped basis EMA. The mark never strays more than
 * `maxBasisBps` from the index, so a thin or manipulated perp book cannot drive
 * liquidations on its own; the last trade price is never used directly.
 */
export function markPrice(index: bigint, basisEma: bigint, maxBasisBps: number): bigint {
  const cap = (index * BigInt(maxBasisBps)) / 10_000n;
  const basis = basisEma > cap ? cap : basisEma < -cap ? -cap : basisEma;
  const mark = index + basis;
  return mark < 1n ? 1n : mark;
}

// -------------------------------------------------------------------- funding

/** Funding rates are expressed in 1e-8 units (1_000_000 = 1%). */
export const RATE_SCALE = 100_000_000n;

/** Premium of the perp book mid over the index, in rate units. */
export function premiumRate(mid: bigint, index: bigint): bigint {
  if (index <= 0n) throw new Error('premiumRate: index must be positive');
  return ((mid - index) * RATE_SCALE) / index;
}

/** Funding rate for one interval: mean premium clamped to ±clampBps. */
export function fundingRate(premiums: bigint[], clampBps: number): bigint {
  if (premiums.length === 0) return 0n;
  const mean = premiums.reduce((a, b) => a + b, 0n) / BigInt(premiums.length);
  const cap = BigInt(clampBps) * 10_000n; // 1 bp = 10_000 rate units
  return mean > cap ? cap : mean < -cap ? -cap : mean;
}

export interface FundingPosition {
  id: string;
  size: bigint;
  margin: bigint;
}

export interface FundingTransfer {
  id: string;
  /** Positive: position receives; negative: position pays. */
  amount: bigint;
}

/**
 * Zero-sum funding allocation. Positive rate: longs pay shorts. Payers pay
 * their amount rounded UP but never more than their margin; receivers share
 * what was actually collected, rounded DOWN. Σ received ≤ Σ paid; the
 * difference (rounding dust) stays in the funding pool and is reconciled.
 */
export function allocateFunding(
  positions: FundingPosition[],
  markMinor: bigint,
  rate: bigint,
  u: MarketUnits,
): { transfers: FundingTransfer[]; collected: bigint; distributed: bigint } {
  if (rate === 0n) return { transfers: [], collected: 0n, distributed: 0n };
  const r = abs(rate);
  const payersAreLongs = rate > 0n;
  const transfers: FundingTransfer[] = [];
  let collected = 0n;
  const receivers: { id: string; due: bigint }[] = [];
  for (const p of positions) {
    if (p.size === 0n) continue;
    const notional = notionalAt(markMinor, p.size, u);
    const pays = p.size > 0n === payersAreLongs;
    if (pays) {
      const owed = ceilDiv(notional * r, RATE_SCALE);
      const paid = owed > p.margin ? p.margin : owed;
      if (paid > 0n) {
        transfers.push({ id: p.id, amount: -paid });
        collected += paid;
      }
    } else {
      receivers.push({ id: p.id, due: (notional * r) / RATE_SCALE });
    }
  }
  const totalDue = receivers.reduce((a, b) => a + b.due, 0n);
  let distributed = 0n;
  for (const rc of receivers) {
    const amount = totalDue <= collected ? rc.due : (rc.due * collected) / totalDue;
    if (amount > 0n) {
      transfers.push({ id: rc.id, amount });
      distributed += amount;
    }
  }
  return { transfers, collected, distributed };
}

// ------------------------------------------------------------ ADL (simulation)

export interface AdlCandidate {
  id: string;
  pos: PositionState;
}

/**
 * Auto-deleveraging priority (simulation only, not live; ADR-0011): profitable
 * positions ranked by unrealised-PnL ratio × effective leverage, highest first.
 */
export function adlRanking(
  candidates: AdlCandidate[],
  markMinor: bigint,
  u: MarketUnits,
): { id: string; score: bigint }[] {
  const scored: { id: string; score: bigint }[] = [];
  for (const c of candidates) {
    if (c.pos.size === 0n || c.pos.margin <= 0n) continue;
    const upnl = unrealizedPnl(c.pos, markMinor, u);
    if (upnl <= 0n) continue;
    const notional = notionalAt(markMinor, c.pos.size, u);
    const eq = c.pos.margin + upnl;
    if (eq <= 0n) continue;
    scored.push({ id: c.id, score: (upnl * notional * RATE_SCALE) / (c.pos.margin * eq) });
  }
  return scored.sort((a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : 0));
}

/**
 * Cross-margin top-up (ADR-0021): when a cross-mode position's equity falls
 * below 125% of its maintenance margin, free balance is moved into it until
 * equity is back at the initial margin for its current notional (capped by
 * what is free). Returns the amount to move, or 0.
 */
export function crossTopUp(
  pos: PositionState,
  markMinor: bigint,
  u: MarketUnits,
  mmrBps: number,
  leverage: number,
  available: bigint,
): bigint {
  if (pos.size === 0n || available <= 0n) return 0n;
  const eq = equity(pos, markMinor, u);
  const mm = maintenanceMargin(pos, markMinor, u, mmrBps);
  if (eq * 4n >= mm * 5n) return 0n; // equity ≥ 1.25 × maintenance: nothing to do
  const target = initialMargin(notionalAt(markMinor, pos.size, u, 'up'), leverage);
  const needed = target - eq;
  if (needed <= 0n) return 0n;
  return needed < available ? needed : available;
}
