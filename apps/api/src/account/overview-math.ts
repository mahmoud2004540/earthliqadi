import { formatAmountTrimmed, notional, parseAmount } from '@platform/shared';

/**
 * Exact sum of decimal strings at `scale` (signed values allowed with a
 * leading "-"). Pure; used for overview totals (ADR-0028).
 */
export function sumDecimals(values: string[], scale: number): string {
  let total = 0n;
  for (const v of values) {
    const neg = v.startsWith('-');
    const minor = parseAmount(neg ? v.slice(1) : v, scale);
    total += neg ? -minor : minor;
  }
  const neg = total < 0n;
  const s = formatAmountTrimmed(neg ? -total : total, scale);
  return neg ? `-${s}` : s;
}

/** Value of `quantity` base units at `price`, in the valuation asset (exact, rounded down). */
export function valueAt(
  price: string,
  quantity: string,
  baseScale: number,
  quoteScale: number,
): string | null {
  return notional(price, quantity, baseScale, quoteScale);
}
