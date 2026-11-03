import { HttpStatus } from '@nestjs/common';
import type { OrderSide, Position, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError } from '../common/app-error';
import { toMinorUnits } from '../ledger/ledger-domain';
import { feeFor, quoteAmount, type MarketUnits } from '../trading/order-math';
import type { MarketWithAssets } from '../trading/markets.service';
import { unitsOf } from '../trading/markets.service';
import type { PerpConfig } from './perp-config';
import {
  absBig,
  initialMargin,
  notionalAt,
  tierFor,
  withinBankruptcy,
  type PositionState,
} from './perp-math';

export const OPEN_ORDER_STATUSES = [
  'PENDING_NEW',
  'PENDING_TRIGGER',
  'OPEN',
  'PARTIALLY_FILLED',
] as const;

function conflict(message: string): AppError {
  return new AppError(HttpStatus.CONFLICT, 'CONFLICT', message);
}

function invalid(path: string, message: string): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', message, [{ path, message }]);
}

export function positionState(
  p: Pick<Position, 'sizeLots' | 'entryNotional' | 'margin'>,
): PositionState {
  return { size: p.sizeLots, entry: toMinorUnits(p.entryNotional), margin: toMinorUnits(p.margin) };
}

/** Highest fee rate of the market (the hold must cover a taker fill). */
export function maxFeeBps(market: MarketWithAssets): number {
  return Math.max(market.makerFeeBps, market.takerFeeBps);
}

/**
 * Funds held for `lots` of a perpetual order at its limit/protection price:
 * initial margin at the order's leverage plus the maximum fee. Reduce-only
 * orders hold the fee only (closing needs no new margin).
 */
export function perpHold(
  market: MarketWithAssets,
  priceTicks: bigint,
  lots: bigint,
  leverage: number,
  reduceOnly: boolean,
): bigint {
  const u = unitsOf(market);
  const notional = quoteAmount(priceTicks, lots, u);
  const fee = feeFor(notional, maxFeeBps(market));
  return reduceOnly ? fee : initialMargin(notional, leverage) + fee;
}

/** Locks (creating if needed) the user's position row. Lock order: positions → ledger → market sequence. */
export async function lockPosition(
  tx: Prisma.TransactionClient,
  userId: string,
  marketId: string,
  defaultLeverage: number,
): Promise<Position> {
  await tx.$executeRaw`
    INSERT INTO "positions" ("id", "user_id", "market_id", "leverage", "updated_at")
    VALUES (${randomUUID()}::uuid, ${userId}::uuid, ${marketId}::uuid, ${defaultLeverage}, now())
    ON CONFLICT ("user_id", "market_id") DO NOTHING`;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "positions" WHERE "user_id" = ${userId}::uuid AND "market_id" = ${marketId}::uuid FOR UPDATE`;
  return tx.position.findUniqueOrThrow({ where: { id: rows[0]!.id } });
}

export interface PerpOrderCheck {
  market: MarketWithAssets;
  config: PerpConfig;
  position: Position;
  side: OrderSide;
  priceTicks: bigint;
  quantityLots: bigint;
  reduceOnly: boolean;
  /** Current mark price (quote minor units per whole base unit), or null when unavailable. */
  mark: bigint | null;
}

/**
 * Risk checks for a new perpetual order, run inside the order transaction with
 * the position row locked. Returns the leverage the margin is held at.
 */
export async function checkPerpOrder(
  tx: Prisma.TransactionClient,
  c: PerpOrderCheck,
): Promise<number> {
  const u: MarketUnits = unitsOf(c.market);
  const pos = positionState(c.position);
  if (c.position.status === 'LIQUIDATING')
    throw conflict('This position is being liquidated; new orders are blocked until it closes');

  const dir = c.side === 'BUY' ? 1n : -1n;
  const reduces = pos.size !== 0n && (pos.size > 0n ? dir < 0n : dir > 0n);

  // Price band around the mark. Without a reliable mark only reducing orders are accepted.
  if (c.mark === null) {
    if (!c.reduceOnly)
      throw conflict(
        'No reliable index/mark price right now; only reduce-only orders are accepted',
      );
  } else {
    const priceMinor = c.priceTicks * u.tickSize;
    const band = (c.mark * BigInt(c.config.priceBandBps)) / 10_000n;
    if (priceMinor > c.mark + band || priceMinor < c.mark - band) {
      throw invalid(
        'price',
        `Price must be within ${c.config.priceBandBps / 100}% of the mark price`,
      );
    }
  }

  if (c.reduceOnly) {
    if (!reduces)
      throw invalid('reduceOnly', 'Reduce-only orders must be opposite to an open position');
    const pending = await tx.order.aggregate({
      where: {
        userId: c.position.userId,
        marketId: c.market.id,
        side: c.side,
        reduceOnly: true,
        status: { in: [...OPEN_ORDER_STATUSES] },
      },
      _sum: { quantityLots: true, filledLots: true },
    });
    const open = (pending._sum.quantityLots ?? 0n) - (pending._sum.filledLots ?? 0n);
    if (open + c.quantityLots > absBig(pos.size))
      throw invalid('quantity', 'Reduce-only quantity exceeds the open position');
  }

  // A closing order may not be priced beyond the bankruptcy price: it would
  // realise a loss larger than the position's margin.
  if (reduces && !withinBankruptcy(pos, c.priceTicks, u)) {
    throw invalid(
      'price',
      'Price is beyond the position bankruptcy price; add margin or let the liquidation engine close it',
    );
  }

  const leverage = c.position.leverage;
  if (!c.reduceOnly) {
    // Projected position size if this order fills completely in its direction.
    const projected = absBig(pos.size + dir * c.quantityLots);
    const tier = tierFor(c.config.tiers, notionalAt(c.priceTicks * u.tickSize, projected, u, 'up'));
    if (!tier || tier.maxLeverage < leverage) {
      throw invalid(
        'quantity',
        'Position would exceed the maximum size for the current leverage (lower the leverage or the size)',
      );
    }
  }
  return leverage;
}
