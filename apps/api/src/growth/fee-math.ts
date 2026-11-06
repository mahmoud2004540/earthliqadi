import { feeFor } from '../trading/order-math';

/** A user's fee discounts and referrer, as settlement needs them (ADR-0018). */
export interface FeeProfile {
  takerDiscountBps: number;
  makerDiscountBps: number;
  /** Referrer that receives a share of this user's taker fees, if eligible now. */
  referrerId: string | null;
}

export const NO_DISCOUNT: FeeProfile = {
  takerDiscountBps: 0,
  makerDiscountBps: 0,
  referrerId: null,
};

/** Effective taker fee: never below zero. */
export function takerBps(marketTakerBps: number, p: FeeProfile): number {
  return Math.max(0, marketTakerBps - p.takerDiscountBps);
}

/** Effective maker fee; negative means a rebate (capped later by the taker fee). */
export function makerBps(marketMakerBps: number, p: FeeProfile): number {
  return marketMakerBps - p.makerDiscountBps;
}

export interface TakerFeeSplit {
  /** Paid to the maker (rebate). */
  rebate: bigint;
  /** Paid to the taker's referrer. */
  referral: bigint;
  /** Kept as fee revenue. */
  revenue: bigint;
}

/**
 * Splits one trade's taker fee: the maker rebate first (never more than the
 * fee), then the referral share of what is left, the rest is revenue. The
 * three parts always add up to the fee, so payouts can never exceed income.
 */
export function splitTakerFee(
  takerFee: bigint,
  rebateBasis: bigint,
  effectiveMakerBps: number,
  referralShareBps: number,
  hasReferrer: boolean,
): TakerFeeSplit {
  const wanted = effectiveMakerBps < 0 ? feeFor(rebateBasis, -effectiveMakerBps) : 0n;
  const rebate = wanted < takerFee ? wanted : takerFee;
  const rest = takerFee - rebate;
  const referral = hasReferrer ? (rest * BigInt(referralShareBps)) / 10_000n : 0n;
  return { rebate, referral, revenue: rest - referral };
}

/** Highest tier whose minimum 30-day volume is reached. */
export function tierForVolume<T extends { tier: number; minVolume: bigint }>(
  tiers: readonly T[],
  volume: bigint,
): T | undefined {
  return [...tiers].sort((a, b) => b.tier - a.tier).find((t) => volume >= t.minVolume);
}
