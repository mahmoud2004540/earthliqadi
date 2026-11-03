import { HttpStatus } from '@nestjs/common';
import { AmountError, formatAmountTrimmed, parseAmount } from '@platform/shared';
import { AppError } from '../common/app-error';

/**
 * Unit conversions between user-facing decimals and engine integers (ADR-0007).
 * price ticks  × tickSize = quote minor units per one whole base unit
 * quantity lots × lotSize = base minor units
 * quote amount = ticks × lots × quotePerTickLot, where
 * quotePerTickLot = tickSize × lotSize / 10^baseScale (must be an integer ≥ 1).
 */
export const MAX_ENGINE_UNITS = 1_000_000_000_000n;

export interface MarketUnits {
  baseScale: number;
  quoteScale: number;
  tickSize: bigint;
  lotSize: bigint;
}

function invalid(path: string, message: string): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', message, [{ path, message }]);
}

export function quotePerTickLot(u: MarketUnits): bigint {
  const product = u.tickSize * u.lotSize;
  const divisor = 10n ** BigInt(u.baseScale);
  if (u.tickSize <= 0n || u.lotSize <= 0n || product % divisor !== 0n || product / divisor < 1n) {
    throw invalid(
      'tickSize',
      'tickSize × lotSize must be a whole number of quote minor units (increase the lot or tick size)',
    );
  }
  return product / divisor;
}

function toUnits(value: string, scale: number, step: bigint, path: string, label: string): bigint {
  let minor: bigint;
  try {
    minor = parseAmount(value, scale);
  } catch (err) {
    throw invalid(path, err instanceof AmountError ? err.message : `Invalid ${label}`);
  }
  if (minor <= 0n) throw invalid(path, `${label} must be positive`);
  if (minor % step !== 0n)
    throw invalid(path, `${label} must be a multiple of the market increment`);
  const units = minor / step;
  if (units > MAX_ENGINE_UNITS) throw invalid(path, `${label} is too large`);
  return units;
}

export function priceToTicks(price: string, u: MarketUnits, path = 'price'): bigint {
  return toUnits(price, u.quoteScale, u.tickSize, path, 'Price');
}

export function quantityToLots(quantity: string, u: MarketUnits, path = 'quantity'): bigint {
  return toUnits(quantity, u.baseScale, u.lotSize, path, 'Quantity');
}

export function ticksToPrice(ticks: bigint, u: MarketUnits): string {
  return formatAmountTrimmed(ticks * u.tickSize, u.quoteScale);
}

export function lotsToQuantity(lots: bigint, u: MarketUnits): string {
  return formatAmountTrimmed(lots * u.lotSize, u.baseScale);
}

export function quoteAmount(ticks: bigint, lots: bigint, u: MarketUnits): bigint {
  return ticks * lots * quotePerTickLot(u);
}

export function baseAmount(lots: bigint, u: MarketUnits): bigint {
  return lots * u.lotSize;
}

/** Fee in basis points, rounded down (customer-favourable). */
export function feeFor(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 1000) throw new Error(`Invalid fee bps ${bps}`);
  return (amount * BigInt(bps)) / 10_000n;
}

/** Funds to hold at order entry: buys hold quote at the limit/protection price, sells hold base. */
export function holdAmount(
  side: 'BUY' | 'SELL',
  priceTicks: bigint | null,
  lots: bigint,
  u: MarketUnits,
): bigint {
  if (side === 'SELL') return baseAmount(lots, u);
  if (priceTicks === null) throw invalid('price', 'Buy orders need a limit or protection price');
  return quoteAmount(priceTicks, lots, u);
}
