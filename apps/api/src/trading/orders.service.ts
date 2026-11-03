import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  type Order,
  type OrderSide,
  type OrderType,
  type TimeInForce,
} from '@prisma/client';
import { formatAmountTrimmed, type OrderDto, type TradeDto } from '@platform/shared';
import { randomUUID } from 'node:crypto';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { toMinorUnits } from '../ledger/ledger-domain';
import { LedgerService } from '../ledger/ledger.service';
import { MarketsService, unitsOf, type MarketWithAssets } from './markets.service';
import {
  holdAmount,
  lotsToQuantity,
  priceToTicks,
  quantityToLots,
  ticksToPrice,
} from './order-math';
import { isTerminal } from './order-state';

export interface PlaceOrderRequest {
  market: string;
  clientOrderId: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market' | 'stop_limit' | 'stop_market';
  timeInForce?: 'gtc' | 'ioc' | 'fok' | 'post_only';
  price?: string;
  stopPrice?: string;
  quantity: string;
}

type OrderWithMarket = Order & { market: MarketWithAssets };

function invalid(path: string, message: string): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', message, [{ path, message }]);
}

/**
 * Order entry. Funds are held and the engine command is enqueued in ONE
 * transaction, so the engine only ever sees fully funded orders (ADR-0007).
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly markets: MarketsService,
    private readonly ledger: LedgerService,
  ) {}

  async place(
    userId: string,
    req: PlaceOrderRequest,
    ctx: RequestContext,
  ): Promise<{ order: OrderDto; replayed: boolean }> {
    const market = await this.markets.require(req.market);
    const u = unitsOf(market);
    const side: OrderSide = req.side === 'buy' ? 'BUY' : 'SELL';
    const type = req.type.toUpperCase() as OrderType;
    const isMarketLike = type === 'MARKET' || type === 'STOP_MARKET';
    const tif = (req.timeInForce ?? (isMarketLike ? 'ioc' : 'gtc')).toUpperCase() as TimeInForce;

    // Mirror the engine's validation so users get precise errors synchronously.
    if (isMarketLike && tif !== 'IOC' && tif !== 'FOK') {
      throw invalid('timeInForce', 'Market and stop-market orders must be IOC or FOK');
    }
    if (tif === 'POST_ONLY' && type !== 'LIMIT')
      throw invalid('timeInForce', 'post_only is only valid for limit orders');
    if ((type === 'LIMIT' || type === 'STOP_LIMIT') && !req.price)
      throw invalid('price', 'A limit price is required');
    if (type === 'MARKET' && side === 'BUY' && !req.price) {
      throw invalid('price', 'Market buy orders need a protection price (the maximum you accept)');
    }
    if (type === 'STOP_MARKET' && side === 'BUY' && !req.price) {
      throw invalid('price', 'Stop-market buy orders need a protection price');
    }
    const isStop = type === 'STOP_LIMIT' || type === 'STOP_MARKET';
    if (isStop && !req.stopPrice) throw invalid('stopPrice', 'A stop price is required');
    if (!isStop && req.stopPrice)
      throw invalid('stopPrice', 'stopPrice is only valid for stop orders');

    const priceTicks = req.price ? priceToTicks(req.price, u) : null;
    const stopPriceTicks = req.stopPrice ? priceToTicks(req.stopPrice, u, 'stopPrice') : null;
    const quantityLots = quantityToLots(req.quantity, u);
    if (quantityLots < market.minQuantityLots) {
      throw invalid('quantity', `Minimum quantity is ${lotsToQuantity(market.minQuantityLots, u)}`);
    }
    const hold = holdAmount(side, priceTicks, quantityLots, u);
    const holdAsset = side === 'BUY' ? market.quoteAsset : market.baseAsset;

    const fingerprint = {
      marketId: market.id,
      side,
      type,
      timeInForce: tif,
      priceTicks,
      stopPriceTicks,
      quantityLots,
    };
    const existing = await this.prisma.order.findUnique({
      where: { userId_clientOrderId: { userId, clientOrderId: req.clientOrderId } },
      include: { market: { include: { baseAsset: true, quoteAsset: true } } },
    });
    if (existing) return { order: this.replayOrConflict(existing, fingerprint), replayed: true };

    if (market.status !== 'ACTIVE')
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', `Market ${market.symbol} is halted`);
    const available = await this.ledger.ensureAccount(holdAsset.id, 'USER_AVAILABLE', userId);
    const locked = await this.ledger.ensureAccount(holdAsset.id, 'USER_LOCKED', userId);
    const orderId = randomUUID();

    try {
      const order = await this.prisma.$transaction(
        async (tx) => {
          const seq = await this.nextCommandSeq(tx, market.id, true);
          const created = await tx.order.create({
            data: {
              id: orderId,
              userId,
              marketId: market.id,
              clientOrderId: req.clientOrderId,
              side,
              type,
              timeInForce: tif,
              priceTicks,
              stopPriceTicks,
              quantityLots,
              holdAssetId: holdAsset.id,
              holdAmount: hold.toString(),
              lockedRemaining: hold.toString(),
            },
            include: { market: { include: { baseAsset: true, quoteAsset: true } } },
          });
          await this.ledger.postWithin(
            tx,
            {
              type: 'BALANCE_HOLD',
              idempotencyKey: `order-hold:${orderId}`,
              description: `Hold for order ${orderId} on ${market.symbol}`,
              postings: [
                { accountId: available.id, direction: 'DEBIT', amount: hold },
                { accountId: locked.id, direction: 'CREDIT', amount: hold },
              ],
            },
            { actorType: 'USER', actorUserId: userId, requestId: ctx.requestId },
          );
          await this.enqueue(tx, market.id, seq, 'place', {
            type: 'place',
            order_id: orderId,
            account: userId,
            side: req.side,
            kind: req.type,
            tif: tif.toLowerCase(),
            price: priceTicks === null ? null : Number(priceTicks),
            stop_price: stopPriceTicks === null ? null : Number(stopPriceTicks),
            quantity: Number(quantityLots),
          });
          return created;
        },
        { timeout: 15_000 },
      );
      return { order: this.toDto(order), replayed: false };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.order.findUnique({
          where: { userId_clientOrderId: { userId, clientOrderId: req.clientOrderId } },
          include: { market: { include: { baseAsset: true, quoteAsset: true } } },
        });
        if (winner) return { order: this.replayOrConflict(winner, fingerprint), replayed: true };
      }
      throw err;
    }
  }

  async cancel(userId: string, orderId: string): Promise<OrderDto> {
    const order = await this.ownOrder(userId, orderId);
    if (isTerminal(order.status))
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'Order is already closed');
    const updated = await this.prisma.$transaction(async (tx) => {
      // Cancels are accepted even while a market is halted.
      const seq = await this.nextCommandSeq(tx, order.marketId, false);
      await this.enqueue(tx, order.marketId, seq, 'cancel', {
        type: 'cancel',
        order_id: order.id,
        account: userId,
      });
      return tx.order.update({
        where: { id: order.id },
        data: { cancelRequestedAt: new Date() },
        include: { market: { include: { baseAsset: true, quoteAsset: true } } },
      });
    });
    return this.toDto(updated);
  }

  async reduce(userId: string, orderId: string, remainingQuantity: string): Promise<OrderDto> {
    const order = await this.ownOrder(userId, orderId);
    if (isTerminal(order.status))
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'Order is already closed');
    const u = unitsOf(order.market);
    const remaining = quantityToLots(remainingQuantity, u, 'remainingQuantity');
    if (remaining >= order.quantityLots - order.filledLots) {
      throw invalid(
        'remainingQuantity',
        'New remaining quantity must be lower than the current remaining quantity',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const seq = await this.nextCommandSeq(tx, order.marketId, false);
      await this.enqueue(tx, order.marketId, seq, 'reduce', {
        type: 'reduce',
        order_id: order.id,
        account: userId,
        remaining: Number(remaining),
      });
    });
    return this.toDto(order);
  }

  async get(userId: string, orderId: string): Promise<OrderDto> {
    return this.toDto(await this.ownOrder(userId, orderId));
  }

  async list(
    userId: string,
    q: { status: 'open' | 'closed' | 'all'; market?: string; limit: number },
  ): Promise<OrderDto[]> {
    const open = ['PENDING_NEW', 'PENDING_TRIGGER', 'OPEN', 'PARTIALLY_FILLED'] as const;
    const closed = ['FILLED', 'CANCELLED', 'REJECTED'] as const;
    const orders = await this.prisma.order.findMany({
      where: {
        userId,
        ...(q.status === 'open'
          ? { status: { in: [...open] } }
          : q.status === 'closed'
            ? { status: { in: [...closed] } }
            : {}),
        ...(q.market ? { market: { symbol: q.market } } : {}),
      },
      include: { market: { include: { baseAsset: true, quoteAsset: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    return orders.map((o) => this.toDto(o));
  }

  async trades(userId: string, limit: number): Promise<TradeDto[]> {
    const trades = await this.prisma.trade.findMany({
      where: { OR: [{ buyerUserId: userId }, { sellerUserId: userId }] },
      include: { market: { include: { baseAsset: true, quoteAsset: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const makerOrders = await this.prisma.order.findMany({
      where: { id: { in: trades.map((t) => t.makerOrderId) }, userId },
      select: { id: true },
    });
    const mine = new Set(makerOrders.map((o) => o.id));
    return trades.map((t) => {
      const u = unitsOf(t.market);
      const isBuyer = t.buyerUserId === userId;
      const isMaker = mine.has(t.makerOrderId);
      return {
        id: t.id,
        market: t.market.symbol,
        orderId: isMaker ? t.makerOrderId : t.takerOrderId,
        side: isBuyer ? 'buy' : 'sell',
        liquidity: isMaker ? 'maker' : 'taker',
        price: ticksToPrice(t.priceTicks, u),
        quantity: lotsToQuantity(t.quantityLots, u),
        quoteAmount: formatAmountTrimmed(toMinorUnits(t.quoteAmount), u.quoteScale),
        fee: isBuyer
          ? formatAmountTrimmed(toMinorUnits(t.buyerFee), u.baseScale)
          : formatAmountTrimmed(toMinorUnits(t.sellerFee), u.quoteScale),
        feeAsset: isBuyer ? t.market.baseAsset.code : t.market.quoteAsset.code,
        createdAt: t.createdAt.toISOString(),
      };
    });
  }

  // ---------------------------------------------------------------- helpers

  /** Increments the per-market counter; the row lock orders command commits (ADR-0007). */
  private async nextCommandSeq(
    tx: Prisma.TransactionClient,
    marketId: string,
    requireActive: boolean,
  ): Promise<bigint> {
    const rows = requireActive
      ? await tx.$queryRaw<{ seq: bigint }[]>`
          UPDATE "markets" SET "next_command_seq" = "next_command_seq" + 1, "updated_at" = now()
           WHERE "id" = ${marketId}::uuid AND "status" = 'ACTIVE' RETURNING "next_command_seq" AS "seq"`
      : await tx.$queryRaw<{ seq: bigint }[]>`
          UPDATE "markets" SET "next_command_seq" = "next_command_seq" + 1, "updated_at" = now()
           WHERE "id" = ${marketId}::uuid RETURNING "next_command_seq" AS "seq"`;
    if (rows.length === 0) throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'Market is halted');
    return rows[0]!.seq;
  }

  private async enqueue(
    tx: Prisma.TransactionClient,
    marketId: string,
    seq: bigint,
    kind: 'place' | 'cancel' | 'reduce',
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.engineCommand.create({
      data: { marketId, seq, kind, payload: payload as Prisma.InputJsonValue },
    });
    await tx.$executeRaw`SELECT pg_notify('engine_commands', ${marketId})`;
  }

  private async ownOrder(userId: string, orderId: string): Promise<OrderWithMarket> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { market: { include: { baseAsset: true, quoteAsset: true } } },
    });
    if (!order) throw AppError.notFound('Order not found');
    return order;
  }

  private replayOrConflict(existing: OrderWithMarket, f: Record<string, unknown>): OrderDto {
    const same =
      existing.marketId === f.marketId &&
      existing.side === f.side &&
      existing.type === f.type &&
      existing.timeInForce === f.timeInForce &&
      existing.priceTicks === f.priceTicks &&
      existing.stopPriceTicks === f.stopPriceTicks &&
      existing.quantityLots === f.quantityLots;
    if (!same) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'IDEMPOTENCY_CONFLICT',
        'clientOrderId was already used for a different order',
      );
    }
    return this.toDto(existing);
  }

  toDto(o: OrderWithMarket): OrderDto {
    const u = unitsOf(o.market);
    return {
      id: o.id,
      clientOrderId: o.clientOrderId,
      market: o.market.symbol,
      side: o.side === 'BUY' ? 'buy' : 'sell',
      type: o.type.toLowerCase() as OrderDto['type'],
      timeInForce: o.timeInForce.toLowerCase() as OrderDto['timeInForce'],
      price: o.priceTicks === null ? null : ticksToPrice(o.priceTicks, u),
      stopPrice: o.stopPriceTicks === null ? null : ticksToPrice(o.stopPriceTicks, u),
      quantity: lotsToQuantity(o.quantityLots, u),
      filledQuantity: o.filledLots === 0n ? '0' : lotsToQuantity(o.filledLots, u),
      remainingQuantity:
        isTerminal(o.status) || o.quantityLots === o.filledLots
          ? '0'
          : lotsToQuantity(o.quantityLots - o.filledLots, u),
      status: o.status.toLowerCase() as OrderDto['status'],
      rejectReason: o.rejectReason,
      cancelReason: o.cancelReason,
      cancelRequested: o.cancelRequestedAt !== null,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    };
  }
}
