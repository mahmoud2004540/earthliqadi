/**
 * Leader-vault share accounting (ADR-0019). Pure, integer-only.
 * Price per share is kept as an 18-decimal fixed-point number (pps_e18).
 */
export const E18 = 10n ** 18n;

/** Shares minted for a deposit at the current equity (first deposit: 1 share per minor unit). */
export function sharesForDeposit(amount: bigint, equity: bigint, totalShares: bigint): bigint {
  if (amount <= 0n) throw new Error('deposit must be positive');
  if (totalShares === 0n) return amount;
  if (equity <= 0n) throw new Error('vault has no equity; deposits are closed');
  return (amount * totalShares) / equity; // rounds down: never dilutes existing holders
}

export function ppsE18(equity: bigint, totalShares: bigint): bigint {
  return totalShares === 0n ? E18 : (equity * E18) / totalShares;
}

export interface Redemption {
  /** Gross value of the shares at the current equity (rounded down). */
  gross: bigint;
  /** Profit share paid to the leader, only on gains above the holder's high-water mark. */
  profitShare: bigint;
  /** Paid to the holder. */
  net: bigint;
  /** New high-water mark for the holder's remaining shares. */
  hwmE18: bigint;
}

/**
 * Redeeming `shares` at the current equity. Profit share applies only to the
 * part of the price per share above the holder's high-water mark, and never
 * to the leader's own shares.
 */
export function redeem(
  shares: bigint,
  equity: bigint,
  totalShares: bigint,
  hwmE18: bigint,
  profitShareBps: number,
  isLeader: boolean,
): Redemption {
  if (shares <= 0n || shares > totalShares) throw new Error('invalid share amount');
  const gross = (shares * (equity > 0n ? equity : 0n)) / totalShares;
  const pps = ppsE18(equity > 0n ? equity : 0n, totalShares);
  let profitShare = 0n;
  if (!isLeader && pps > hwmE18 && profitShareBps > 0) {
    const gain = ((pps - hwmE18) * shares) / E18;
    profitShare = (gain * BigInt(profitShareBps)) / 10_000n;
  }
  return { gross, profitShare, net: gross - profitShare, hwmE18: pps > hwmE18 ? pps : hwmE18 };
}

/** High-water mark after adding shares bought at `ppsNow` to an existing holding. */
export function blendedHwm(
  oldShares: bigint,
  oldHwm: bigint,
  newShares: bigint,
  ppsNow: bigint,
): bigint {
  const total = oldShares + newShares;
  if (total === 0n) return ppsNow;
  // Share-weighted; rounds up so the holder is never charged twice on the same gain.
  return (oldShares * oldHwm + newShares * ppsNow + total - 1n) / total;
}

/** The leader's share of the vault after a change, in basis points. */
export function leaderShareBps(leaderShares: bigint, totalShares: bigint): bigint {
  return totalShares === 0n ? 10_000n : (leaderShares * 10_000n) / totalShares;
}

/** Drawdown from the peak in basis points (0 when at or above the peak). */
export function drawdownBps(peakE18: bigint, nowE18: bigint): bigint {
  return nowE18 >= peakE18 ? 0n : ((peakE18 - nowE18) * 10_000n) / peakE18;
}
