import { z } from 'zod';

/**
 * Exact amount handling. Amounts are integers in an asset's minor units
 * (e.g. satoshi for BTC with scale 8) represented as `bigint`. Binary floating
 * point (`number`) must never be used for money.
 */
export const MAX_ASSET_SCALE = 18;
/** Matches the database column NUMERIC(38,0). */
export const MAX_AMOUNT_DIGITS = 38;
export const MAX_MINOR_UNITS = 10n ** BigInt(MAX_AMOUNT_DIGITS) - 1n;

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_ASSET_SCALE) {
    throw new AmountError(`Invalid asset scale: ${scale}`);
  }
}

/**
 * Parses a non-negative decimal string into minor units. Never rounds: input
 * with more fractional digits than `scale` is rejected.
 */
export function parseAmount(input: string, scale: number): bigint {
  assertScale(scale);
  const match = DECIMAL_PATTERN.exec(input);
  if (!match) throw new AmountError('Amount must be a plain non-negative decimal (e.g. "12.5")');
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > scale) {
    throw new AmountError(`Amount has more than ${scale} decimal places`);
  }
  const minor = BigInt(whole + fraction.padEnd(scale, '0'));
  if (minor > MAX_MINOR_UNITS) throw new AmountError('Amount is too large');
  return minor;
}

/** Formats minor units as a decimal string with exactly `scale` fractional digits. */
export function formatAmount(minor: bigint, scale: number): string {
  assertScale(scale);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale > 0 ? `.${fraction}` : ''}`;
}

/** Like `formatAmount` but drops trailing fractional zeros ("1.50000000" → "1.5"). */
export function formatAmountTrimmed(minor: bigint, scale: number): string {
  const full = formatAmount(minor, scale);
  return full.includes('.') ? full.replace(/\.?0+$/, '') : full;
}

/**
 * Exact notional (quote amount) of `quantity` base units at `price` quote per
 * base unit, as a decimal string at the quote scale. Returns null if either
 * input is not a valid decimal for its asset. Rounds down only below the quote
 * minor unit, which cannot happen for prices/quantities on a valid market grid.
 */
export function notional(
  price: string,
  quantity: string,
  baseScale: number,
  quoteScale: number,
): string | null {
  try {
    const p = parseAmount(price, quoteScale);
    const q = parseAmount(quantity, baseScale);
    return formatAmountTrimmed((p * q) / 10n ** BigInt(baseScale), quoteScale);
  } catch {
    return null;
  }
}

/** Compares two non-negative decimal strings exactly (-1, 0, 1). Invalid input throws AmountError. */
export function compareDecimal(a: string, b: string): number {
  const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0, 0);
  const x = parseAmount(a, Math.min(scale, MAX_ASSET_SCALE));
  const y = parseAmount(b, Math.min(scale, MAX_ASSET_SCALE));
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Syntactic validation for API inputs; scale-aware parsing happens server-side. */
export const amountStringSchema = z
  .string()
  .max(MAX_AMOUNT_DIGITS + 2)
  .regex(DECIMAL_PATTERN, 'Amount must be a plain non-negative decimal (e.g. "12.5")');

export const assetCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,16}$/, 'Asset code must be 2-16 letters or digits');
