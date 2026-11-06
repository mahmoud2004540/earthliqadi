import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  type Order,
  type OrderSide,
  type OrderType,
  type TimeInForce,
} from '@prisma/client';
import { formatAmountTrimmed, type OrderDto, type TradeDto } from '@platform/shared';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { REDIS } from '../infrastructure/redis/redis.module';
import type Redis from 'ioredis';
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
import { parsePerpConfig } from '../perps/perp-config';
import { checkPerpOrder, lockPosition, perpHold } from '../perps/perp-orders';
import { currentMark } from '../perps/perp-prices';

export interface PlaceOrderRequest {
  market: string;
  clientOrderId: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market' | 'stop_limit' | 'stop_market';
  timeInForce?: 'gtc' | 'ioc' | 'fok' | 'post_only';
  price?: string;
  stopPrice?: string;
  quantity: string;
  reduceOnly?: boolean;
  trigger?: 'above' | 'below';
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
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Per-user fixed one-second window across place/cancel/reduce (shared via Redis). */
  private async checkRate(userId: string): Promise<void> {
    const key = `orders:rate:${userId}:${Math.floor(Date.now() / 1000)}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 2);
    if (count > this.config.ORDER_RATE_LIMIT_PER_SECOND) {
      throw new AppError(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        'Too many order requests; slow down',
      );
    }
  }

  async place(
    userId: string,
    req: PlaceOrderRequest,
    ctx: RequestContext,
    opts: { rateChecked?: boolean; ocoGroupId?: string } = {},
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
    const perp = market.kind === 'PERPETUAL';
    const reduceOnly = req.reduceOnly ?? false;
    if (!perp && reduceOnly)
      throw invalid('reduceOnly', 'reduceOnly is only valid on perpetual markets');
    if (perp && !req.price) {
      throw invalid(
        'price',
        'Perpetual orders need a limit price or, for market orders, a protection price',
      );
    }
    const isStop = type === 'STOP_LIMIT' || type === 'STOP_MARKET';
    if (isStop && !req.stopPrice) throw invalid('stopPrice', 'A stop price is required');
    if (!isStop && req.stopPrice)
      throw invalid('stopPrice', 'stopPrice is only valid for stop orders');
    if (!isStop && req.trigger) throw invalid('trigger', 'trigger is only valid for stop orders');
    const trigger = isStop ? (req.trigger ?? null) : null;

    const priceTicks = req.price ? priceToTicks(req.price, u) : null;
    const stopPriceTicks = req.stopPrice ? priceToTicks(req.stopPrice, u, 'stopPrice') : null;
    const quantityLots = quantityToLots(req.quantity, u);
    if (quantityLots < market.minQuantityLots) {
      throw invalid('quantity', `Minimum quantity is ${lotsToQuantity(market.minQuantityLots, u)}`);
    }
    const perpConfig = perp ? parsePerpConfig(market.perpConfig) : null;
    const spotHold = perp ? 0n : holdAmount(side, priceTicks, quantityLots, u);
    const holdAsset = perp || side === 'BUY' ? market.quoteAsset : market.baseAsset;

    const fingerprint = {
      marketId: market.id,
      side,
      type,
      timeInForce: tif,
      priceTicks,
      stopPriceTicks,
      quantityLots,
      reduceOnly,
      trigger,
    };
    const existing = await this.prisma.order.findUnique({
      where: { userId_clientOrderId: { userId, clientOrderId: req.clientOrderId } },
      include: { market: { include: { baseAsset: true, quoteAsset: true } } },
    });
    if (existing) return { order: this.replayOrConflict(existing, fingerprint), replayed: true };

    if (!opts.rateChecked) await this.checkRate(userId);
    const open = await this.prisma.order.count({
      where: {
        userId,
        marketId: market.id,
        status: { in: ['PENDING_NEW', 'PENDING_TRIGGER', 'OPEN', 'PARTIALLY_FILLED'] },
      },
    });
    if (open >= this.config.MAX_OPEN_ORDERS_PER_MARKET) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'LIMIT_EXCEEDED',
        `At most ${this.config.MAX_OPEN_ORDERS_PER_MARKET} open orders per market; cancel some first`,
      );
    }
    if (market.status !== 'ACTIVE')
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', `Market ${market.symbol} is halted`);
    if (market.baseAsset.chainTokenAddress || market.quoteAsset.chainTokenAddress) {
      const u = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { walletAddress: true, parent: { select: { walletAddress: true } } },
      });
      // Sub-accounts settle under their parent's wallet (ADR-0017).
      const walletAddress = u.walletAddress ?? u.parent?.walletAddress ?? null;
      if (!walletAddress) {
        throw new AppError(
          HttpStatus.FORBIDDEN,
          'FORBIDDEN',
          'Vault-backed markets are for wallet accounts (balances must be claimable on-chain)',
        );
      }
    }
    if (this.config.KYC_REQUIRED_FOR_REAL_TRADING && !market.isPaper) {
      const { kycLevel } = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { kycLevel: true },
      });
      if (kycLevel < 1) {
        throw new AppError(
          HttpStatus.FORBIDDEN,
          'KYC_REQUIRED',
          'Verify your identity before trading on this market',
        );
      }
    }
    const available = await this.ledger.accountId(holdAsset.id, 'USER_AVAILABLE', userId);
    const locked = await this.ledger.accountId(holdAsset.id, 'USER_LOCKED', userId);
    const orderId = randomUUID();
    const mark = perpConfig ? await currentMark(this.prisma, market.id, perpConfig) : null;

    try {
      const order = await this.prisma.$transaction(
        async (tx) => {
          let hold = spotHold;
          let leverage: number | null = null;
          if (perpConfig) {
            const position = await lockPosition(tx, userId, market.id, perpConfig.defaultLeverage);
            leverage = await checkPerpOrder(tx, {
              market,
              config: perpConfig,
              position,
              side,
              priceTicks: priceTicks!,
              quantityLots,
              reduceOnly,
              mark,
              isStop,
              oco: opts.ocoGroupId !== undefined,
            });
            hold = perpHold(market, priceTicks!, quantityLots, leverage, reduceOnly);
          }
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
              reduceOnly,
              leverage,
              triggerDirection: trigger,
              ocoGroupId: opts.ocoGroupId ?? null,
            },
            include: { market: { include: { baseAsset: true, quoteAsset: true } } },
          });
          if (hold > 0n)
            await this.ledger.postWithin(
              tx,
              {
                type: 'BALANCE_HOLD',
                idempotencyKey: `order-hold:${orderId}`,
                description: `Hold for order ${orderId} on ${market.symbol}`,
                postings: [
                  { accountId: available, direction: 'DEBIT', amount: hold },
                  { accountId: locked, direction: 'CREDIT', amount: hold },
                ],
              },
              { actorType: 'USER', actorUserId: userId, requestId: ctx.requestId },
            );
          // Take the per-market sequence lock LAST: it is held until commit (keeping
          // sequences gap-free and commit-ordered) but no longer serialises the
          // order insert and fund hold of concurrent orders (measured: ADR-0007 notes).
          const seq = await this.nextCommandSeq(tx, market.id, true);
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
            ...(trigger ? { trigger } : {}),
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

  /**
   * Places up to 20 orders; each succeeds or fails on its own (no partial
   * hold is ever left behind: every order is its own transaction). The batch
   * counts as one request for the per-user rate limit.
   */
  async placeBatch(
    userId: string,
    reqs: PlaceOrderRequest[],
    ctx: RequestContext,
  ): Promise<
    {
      clientOrderId: string;
      status: number;
      order?: OrderDto;
      error?: { code: string; message: string };
    }[]
  > {
    await this.checkRate(userId);
    const out = [];
    for (const req of reqs) {
      try {
        const { order, replayed } = await this.place(userId, req, ctx, { rateChecked: true });
        out.push({ clientOrderId: req.clientOrderId, status: replayed ? 200 : 202, order });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        out.push({
          clientOrderId: req.clientOrderId,
          status: err.getStatus(),
          error: { code: err.code, message: err.message },
        });
      }
    }
    return out;
  }

  /** Requests cancellation of every open order (optionally one market). Counts as one request. */
  async cancelAll(userId: string, market?: string, opts: { rateChecked?: boolean } = {}) {
    if (!opts.rateChecked) await this.checkRate(userId);
    const marketId = market ? (await this.markets.require(market)).id : undefined;
    const open = await this.prisma.order.findMany({
      where: {
        userId,
        ...(marketId ? { marketId } : {}),
        status: { in: ['PENDING_NEW', 'PENDING_TRIGGER', 'OPEN', 'PARTIALLY_FILLED'] },
        cancelRequestedAt: null,
      },
      select: { id: true, marketId: true },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    });
    for (const o of open) {
      await this.prisma.$transaction(async (tx) => {
        const seq = await this.nextCommandSeq(tx, o.marketId, false);
        await this.enqueue(tx, o.marketId, seq, 'cancel', {
          type: 'cancel',
          order_id: o.id,
          account: userId,
        });
        await tx.order.update({ where: { id: o.id }, data: { cancelRequestedAt: new Date() } });
      });
    }
    return { cancelRequested: open.length };
  }

  /** Requests cancellation of specific own orders without counting against the rate limit. */
  async cancelOwned(userId: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      const order = await this.ownOrder(userId, id);
      if (isTerminal(order.status) || order.cancelRequestedAt) continue;
      await this.prisma.$transaction(async (tx) => {
        const seq = await this.nextCommandSeq(tx, order.marketId, false);
        await this.enqueue(tx, order.marketId, seq, 'cancel', {
          type: 'cancel',
          order_id: order.id,
          account: userId,
        });
        await tx.order.update({ where: { id: order.id }, data: { cancelRequestedAt: new Date() } });
      });
    }
  }

  /**
   * Dead-man switch: cancel everything if not refreshed within `timeoutSeconds`.
   * 0 disables it. Clients refresh it periodically while they are healthy.
   */
  async setCancelAfter(userId: string, timeoutSeconds: number, now = new Date()) {
    if (timeoutSeconds === 0) {
      await this.prisma.cancelAllTimer.deleteMany({ where: { userId } });
      return { deadline: null };
    }
    const deadline = new Date(now.getTime() + timeoutSeconds * 1000);
    await this.prisma.cancelAllTimer.upsert({
      where: { userId },
      create: { userId, deadline },
      update: { deadline, updatedAt: now },
    });
    return { deadline: deadline.toISOString() };
  }

  /** Fires expired dead-man switches (any API instance; rows are claimed with SKIP LOCKED). */
  async fireCancelTimers(now = new Date()): Promise<number> {
    const due = await this.prisma.$queryRaw<{ user_id: string }[]>`
      DELETE FROM "cancel_all_timers"
       WHERE "user_id" IN (SELECT "user_id" FROM "cancel_all_timers" WHERE "deadline" <= ${now}
                            ORDER BY "deadline" LIMIT 100 FOR UPDATE SKIP LOCKED)
      RETURNING "user_id"`;
    for (const { user_id } of due) {
      const { cancelRequested } = await this.cancelAll(user_id, undefined, { rateChecked: true });
      await this.audit.recordSafe({
        action: 'trading.cancel_after.fired',
        outcome: 'SUCCESS',
        actorType: 'SYSTEM',
        targetType: 'user',
        targetId: user_id,
        context: { requestId: 'dead-man-switch' },
        metadata: { cancelRequested },
      });
    }
    return due.length;
  }

  async cancel(userId: string, orderId: string): Promise<OrderDto> {
    await this.checkRate(userId);
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
    await this.checkRate(userId);
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
        // Spot buyers pay fees in base; perpetual fees are always in the quote (margin) asset.
        fee:
          isBuyer && t.market.kind === 'SPOT'
            ? formatAmountTrimmed(toMinorUnits(t.buyerFee), u.baseScale)
            : formatAmountTrimmed(toMinorUnits(isBuyer ? t.buyerFee : t.sellerFee), u.quoteScale),
        feeAsset:
          isBuyer && t.market.kind === 'SPOT' ? t.market.baseAsset.code : t.market.quoteAsset.code,
        createdAt: t.createdAt.toISOString(),
      };
    });
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Enqueues an engine command on behalf of the system (liquidation engine).
   * Must run inside the caller's transaction, after its position/ledger locks.
   */
  async enqueueSystemCommand(
    tx: Prisma.TransactionClient,
    marketId: string,
    kind: 'place' | 'cancel',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const seq = await this.nextCommandSeq(tx, marketId, kind === 'place');
    await this.enqueue(tx, marketId, seq, kind, payload);
  }

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
      existing.quantityLots === f.quantityLots &&
      existing.reduceOnly === f.reduceOnly &&
      existing.triggerDirection === f.trigger;
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
      trigger:
        o.stopPriceTicks === null
          ? null
          : ((o.triggerDirection as 'above' | 'below' | null) ??
            (o.side === 'BUY' ? 'above' : 'below')),
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
      reduceOnly: o.reduceOnly,
      liquidation: o.isLiquidation,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    };
  }
}
