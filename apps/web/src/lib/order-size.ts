import { formatAmountTrimmed, parseAmount } from '@platform/shared';

export interface SizeInput {
  side: 'buy' | 'sell';
  perp: boolean;
  /** Free balance of the asset the order holds (quote for buys and perpetuals, base for spot sells). */
  available: string;
  /** Limit or protection price; needed except for spot sells. */
  price: string;
  leverage: number;
  takerFeeBps: number;
  lotSize: string;
  scales: { base: number; quote: number };
}

/**
 * Quantity for `percent` of what the free balance can open, rounded down to
 * the lot size (exact integer arithmetic). The fee is reserved so a 100%
 * order still fits. Null when it cannot be computed (no price, no balance).
 * A UI convenience only: the server checks every order.
 */
export function sizeForPercent(p: SizeInput, percent: number): string | null {
  if (!Number.isFinite(percent) || percent <= 0) return null;
  const pct = BigInt(Math.min(100, Math.round(percent)));
  try {
    const lot = parseAmount(p.lotSize, p.scales.base);
    if (lot <= 0n) return null;
    let baseMinor: bigint;
    if (!p.perp && p.side === 'sell') {
      baseMinor = parseAmount(p.available, p.scales.base);
    } else {
      const quote = parseAmount(p.available, p.scales.quote);
      const price = parseAmount(p.price, p.scales.quote);
      if (price <= 0n) return null;
      const lev = BigInt(p.perp ? Math.max(1, Math.floor(p.leverage)) : 1);
      const fee = BigInt(Math.max(0, p.takerFeeBps));
      // base = quote × leverage / price, less the fee, in base minor units.
      baseMinor =
        (quote * lev * 10n ** BigInt(p.scales.base) * (10_000n - fee)) / (price * 10_000n);
    }
    const lots = (baseMinor * pct) / 100n / lot;
    if (lots <= 0n) return null;
    return formatAmountTrimmed(lots * lot, p.scales.base);
  } catch {
    return null;
  }
}
