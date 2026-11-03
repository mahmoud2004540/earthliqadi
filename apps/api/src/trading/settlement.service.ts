import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { EngineEvent, Order, OrderStatus, Prisma } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { toMinorUnits, type EntryRequest } from '../ledger/ledger-domain';
import {
  LedgerService,
  type LedgerActor,
  type TransactionalAccounts,
} from '../ledger/ledger.service';
import { unitsOf, type MarketWithAssets } from './markets.service';
import { baseAmount, feeFor, quoteAmount } from './order-math';
import { isTerminal, nextStatus } from './order-state';

const SETTLEMENT_ACTOR: LedgerActor = { actorType: 'SYSTEM', requestId: 'settlement' };

/** Engine event payloads (snake_case, as written by the Rust engine). */
type EnginePayload =
  | {
      type: 'accepted';
      order_id: string;
      kind: string;
      price: number | null;
      stop_price: number | null;
      quantity: number;
    }
  | { type: 'rejected'; order_id: string; reason: string }
  | { type: 'stop_triggered'; order_id: string; trigger_price: number }
  | {
      type: 'trade';
      maker_order_id: string;
      taker_order_id: string;
      taker_side: 'buy' | 'sell';
      price: number;
      quantity: number;
      maker_remaining: number;
      taker_remaining: number;
    }
  | { type: 'filled'; order_id: string }
  | { type: 'cancelled'; order_id: string; remaining: number; reason: string }
  | { type: 'reduced'; order_id: string; remaining: number }
  | { type: 'command_rejected'; order_id: string; reason: string };

export class SettlementInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementInvariantError';
  }
}

/** In-memory working copy of an order during one settlement batch. */
interface WorkingOrder {
  row: Order;
  status: OrderStatus;
  filledLots: bigint;
  quantityLots: bigint;
  locked: bigint;
  rejectReason: string | null;
  cancelReason: string | null;
  dirty: boolean;
}

interface TradeDraft {
  key: string;
  data: Omit<Prisma.TradeCreateManyInput, 'journalEntryId'>;
}

interface BatchContext {
  acc: TransactionalAccounts;
  market: MarketWithAssets;
  orders: Map<string, WorkingOrder>;
  entries: EntryRequest[];
  trades: TradeDraft[];
}

function referencedOrderIds(e: EnginePayload): string[] {
  if (e.type === 'trade') return [e.maker_order_id, e.taker_order_id];
  if (e.type === 'command_rejected') return [];
  return [e.order_id];
}

/**
 * Consumes engine events and settles them in the ledger (ADR-0007). One
 * transaction per batch: ledger entries, order projections, trades and the
 * offset commit together. Any failure rolls back and halts that market's
 * settlement until fixed - money movements are never skipped.
 *
 * Batches are applied IN MEMORY and written with a constant number of round
 * trips (one order load, one ledger batch, one trade insert, one bulk order
 * update). Profiling showed ~2.4 ms per round trip and ~10 per fill when
 * events were written one by one (docs/operations/performance.md).
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /** Settles all pending events for all markets. Returns the number of events processed. */
  async processPending(batchSize = 500): Promise<number> {
    const markets = await this.prisma.market.findMany({
      include: { baseAsset: true, quoteAsset: true },
    });
    let total = 0;
    for (const market of markets) {
      let processed: number;
      do {
        processed = await this.processMarket(market, batchSize);
        total += processed;
      } while (processed === batchSize);
    }
    return total;
  }

  async processMarket(market: MarketWithAssets, batchSize: number): Promise<number> {
    let accounts: TransactionalAccounts | null = null;
    const processed = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "settlement_state" ("market_id", "last_event_seq", "updated_at")
          VALUES (${market.id}::uuid, 0, now()) ON CONFLICT ("market_id") DO NOTHING`;
        const state = await tx.$queryRaw<{ last_event_seq: bigint }[]>`
          SELECT "last_event_seq" FROM "settlement_state" WHERE "market_id" = ${market.id}::uuid FOR UPDATE SKIP LOCKED`;
        if (state.length === 0) return 0; // another instance is settling this market
        let last = state[0]!.last_event_seq;

        const events = await tx.engineEvent.findMany({
          where: { marketId: market.id, seq: { gt: last } },
          orderBy: { seq: 'asc' },
          take: batchSize,
        });
        if (events.length === 0) return 0;

        const ids = [
          ...new Set(
            events.flatMap((ev) => referencedOrderIds(ev.payload as unknown as EnginePayload)),
          ),
        ];
        const rows = await tx.order.findMany({ where: { id: { in: ids } } });
        accounts = this.ledger.transactionalAccounts(tx);
        const ctx: BatchContext = {
          acc: accounts,
          market,
          orders: new Map(
            rows.map((o) => [
              o.id,
              {
                row: o,
                status: o.status,
                filledLots: o.filledLots,
                quantityLots: o.quantityLots,
                locked: toMinorUnits(o.lockedRemaining),
                rejectReason: o.rejectReason,
                cancelReason: o.cancelReason,
                dirty: false,
              },
            ]),
          ),
          entries: [],
          trades: [],
        };

        for (const event of events) {
          if (event.seq !== last + 1n) {
            throw new SettlementInvariantError(
              `Event gap in ${market.symbol}: expected ${last + 1n}, got ${event.seq}`,
            );
          }
          await this.apply(ctx, event);
          last = event.seq;
        }

        const posted = await this.ledger.postBatchWithin(tx, ctx.entries, SETTLEMENT_ACTOR);
        if (ctx.trades.length > 0) {
          await tx.trade.createMany({
            data: ctx.trades.map((t) => ({ ...t.data, journalEntryId: posted.get(t.key)!.id })),
          });
        }
        await this.writeOrders(tx, ctx);
        await tx.settlementState.update({
          where: { marketId: market.id },
          data: { lastEventSeq: last },
        });
        return events.length;
      },
      { timeout: 120_000 },
    );
    (accounts as TransactionalAccounts | null)?.commit(); // only after a successful commit
    return processed;
  }

  /** One bulk UPDATE for every order changed in the batch. */
  private async writeOrders(tx: Prisma.TransactionClient, ctx: BatchContext): Promise<void> {
    const dirty = [...ctx.orders.values()].filter((o) => o.dirty);
    if (dirty.length === 0) return;
    await tx.$executeRaw`
      UPDATE "orders" AS o
         SET "status" = v."status"::"OrderStatus",
             "filled_lots" = v."filled",
             "quantity_lots" = v."quantity",
             "locked_remaining" = v."locked",
             "reject_reason" = v."reject",
             "cancel_reason" = v."cancel",
             "updated_at" = now()
        FROM (SELECT unnest(${dirty.map((o) => o.row.id)}::uuid[]) AS "id",
                     unnest(${dirty.map((o) => o.status)}::text[]) AS "status",
                     unnest(${dirty.map((o) => o.filledLots.toString())}::bigint[]) AS "filled",
                     unnest(${dirty.map((o) => o.quantityLots.toString())}::bigint[]) AS "quantity",
                     unnest(${dirty.map((o) => o.locked.toString())}::numeric[]) AS "locked",
                     unnest(${dirty.map((o) => o.rejectReason)}::text[]) AS "reject",
                     unnest(${dirty.map((o) => o.cancelReason)}::text[]) AS "cancel") AS v
       WHERE o."id" = v."id"`;
  }

  private order(ctx: BatchContext, id: string): WorkingOrder {
    const order = ctx.orders.get(id);
    if (!order) throw new SettlementInvariantError(`Engine referenced unknown order ${id}`);
    return order;
  }

  private async apply(ctx: BatchContext, event: EngineEvent): Promise<void> {
    const e = event.payload as unknown as EnginePayload;
    switch (e.type) {
      case 'accepted': {
        const order = this.order(ctx, e.order_id);
        // Defence in depth: the engine must have accepted exactly what we enqueued.
        if (
          BigInt(e.quantity) !== order.quantityLots ||
          (e.price === null ? null : BigInt(e.price)) !== order.row.priceTicks ||
          (e.stop_price === null ? null : BigInt(e.stop_price)) !== order.row.stopPriceTicks
        ) {
          throw new SettlementInvariantError(
            `Engine accepted order ${order.row.id} with different parameters`,
          );
        }
        const isStop = order.row.type === 'STOP_LIMIT' || order.row.type === 'STOP_MARKET';
        this.transition(order, nextStatus(order.status, 'accepted', { isStop }));
        return;
      }
      case 'rejected': {
        const order = this.order(ctx, e.order_id);
        order.rejectReason = e.reason;
        await this.close(ctx, order, nextStatus(order.status, 'rejected'), event);
        return;
      }
      case 'stop_triggered': {
        const order = this.order(ctx, e.order_id);
        this.transition(order, nextStatus(order.status, 'stop_triggered'));
        return;
      }
      case 'trade':
        await this.settleTrade(ctx, event, e);
        return;
      case 'filled': {
        const order = this.order(ctx, e.order_id);
        if (order.filledLots !== order.quantityLots) {
          throw new SettlementInvariantError(
            `Order ${order.row.id} reported filled with ${order.filledLots}/${order.quantityLots}`,
          );
        }
        await this.close(ctx, order, nextStatus(order.status, 'filled'), event);
        return;
      }
      case 'cancelled': {
        const order = this.order(ctx, e.order_id);
        if (BigInt(e.remaining) !== order.quantityLots - order.filledLots) {
          throw new SettlementInvariantError(
            `Cancelled quantity mismatch for order ${order.row.id}`,
          );
        }
        order.cancelReason = e.reason;
        await this.close(ctx, order, nextStatus(order.status, 'cancelled'), event);
        return;
      }
      case 'reduced':
        await this.settleReduce(ctx, event, e);
        return;
      case 'command_rejected':
        this.logger.debug({ orderId: e.order_id, reason: e.reason }, 'Engine rejected a command');
        return;
      default:
        throw new SettlementInvariantError(
          `Unknown engine event type ${(e as { type: string }).type}`,
        );
    }
  }

  private transition(order: WorkingOrder, status: OrderStatus): void {
    order.status = status;
    order.dirty = true;
  }

  private async settleTrade(
    ctx: BatchContext,
    event: EngineEvent,
    e: Extract<EnginePayload, { type: 'trade' }>,
  ): Promise<void> {
    const { market, acc } = ctx;
    const u = unitsOf(market);
    const maker = this.order(ctx, e.maker_order_id);
    const taker = this.order(ctx, e.taker_order_id);
    const [buyer, seller] = e.taker_side === 'buy' ? [taker, maker] : [maker, taker];
    if (buyer.row.side !== 'BUY' || seller.row.side !== 'SELL') {
      throw new SettlementInvariantError('Trade sides do not match orders');
    }
    if (buyer.row.userId === seller.row.userId)
      throw new SettlementInvariantError('Self-trade reached settlement');

    const priceTicks = BigInt(e.price);
    const lots = BigInt(e.quantity);
    // Maker price must be within the buyer's limit (it is the buyer's hold basis).
    if (buyer.row.priceTicks !== null && priceTicks > buyer.row.priceTicks) {
      throw new SettlementInvariantError(`Trade price above buyer limit for order ${buyer.row.id}`);
    }
    const quote = quoteAmount(priceTicks, lots, u);
    const base = baseAmount(lots, u);
    const buyerBps = buyer === maker ? market.makerFeeBps : market.takerFeeBps;
    const sellerBps = seller === maker ? market.makerFeeBps : market.takerFeeBps;
    const buyerFee = feeFor(base, buyerBps); // buyer receives base
    const sellerFee = feeFor(quote, sellerBps); // seller receives quote
    if (buyer.locked < quote || seller.locked < base) {
      throw new SettlementInvariantError(
        `Insufficient held funds for trade ${market.symbol}#${event.seq}`,
      );
    }

    const postings = [
      {
        accountId: await acc.id(market.quoteAssetId, 'USER_LOCKED', buyer.row.userId),
        direction: 'DEBIT' as const,
        amount: quote,
      },
      {
        accountId: await acc.id(market.quoteAssetId, 'USER_AVAILABLE', seller.row.userId),
        direction: 'CREDIT' as const,
        amount: quote - sellerFee,
      },
      {
        accountId: await acc.id(market.baseAssetId, 'USER_LOCKED', seller.row.userId),
        direction: 'DEBIT' as const,
        amount: base,
      },
      {
        accountId: await acc.id(market.baseAssetId, 'USER_AVAILABLE', buyer.row.userId),
        direction: 'CREDIT' as const,
        amount: base - buyerFee,
      },
    ];
    if (sellerFee > 0n) {
      postings.push({
        accountId: await acc.id(market.quoteAssetId, 'FEE_REVENUE', null),
        direction: 'CREDIT',
        amount: sellerFee,
      });
    }
    if (buyerFee > 0n) {
      postings.push({
        accountId: await acc.id(market.baseAssetId, 'FEE_REVENUE', null),
        direction: 'CREDIT',
        amount: buyerFee,
      });
    }
    const key = `trade:${market.id}:${event.seq}`;
    ctx.entries.push({
      type: 'TRADE',
      idempotencyKey: key,
      description: `Trade ${market.symbol} #${event.seq}`,
      postings,
    });
    ctx.trades.push({
      key,
      data: {
        marketId: market.id,
        eventSeq: event.seq,
        makerOrderId: maker.row.id,
        takerOrderId: taker.row.id,
        buyerUserId: buyer.row.userId,
        sellerUserId: seller.row.userId,
        takerSide: taker.row.side,
        priceTicks,
        quantityLots: lots,
        baseAmount: base.toString(),
        quoteAmount: quote.toString(),
        buyerFee: buyerFee.toString(),
        sellerFee: sellerFee.toString(),
        executedAt: event.createdAt,
      },
    });

    for (const [order, consumed] of [
      [buyer, quote],
      [seller, base],
    ] as const) {
      const filled = order.filledLots + lots;
      if (filled > order.quantityLots)
        throw new SettlementInvariantError(`Overfill on order ${order.row.id}`);
      const remainingInEvent = BigInt(order === maker ? e.maker_remaining : e.taker_remaining);
      if (order.quantityLots - filled !== remainingInEvent) {
        throw new SettlementInvariantError(`Remaining quantity mismatch on order ${order.row.id}`);
      }
      order.filledLots = filled;
      order.locked -= consumed;
      this.transition(order, nextStatus(order.status, 'trade'));
    }
  }

  private async settleReduce(
    ctx: BatchContext,
    event: EngineEvent,
    e: Extract<EnginePayload, { type: 'reduced' }>,
  ): Promise<void> {
    const order = this.order(ctx, e.order_id);
    const u = unitsOf(ctx.market);
    const reducedBy = order.quantityLots - order.filledLots - BigInt(e.remaining);
    if (reducedBy <= 0n)
      throw new SettlementInvariantError(`Invalid reduction for order ${order.row.id}`);
    let release: bigint;
    if (order.row.side === 'SELL') {
      release = baseAmount(reducedBy, u);
    } else {
      if (order.row.priceTicks === null)
        throw new SettlementInvariantError('Buy order without price cannot rest');
      release = quoteAmount(order.row.priceTicks, reducedBy, u);
    }
    if (release > order.locked) {
      throw new SettlementInvariantError(`Reduction releases more than held for ${order.row.id}`);
    }
    if (release > 0n)
      await this.releaseFunds(ctx, order, release, `order-reduce:${order.row.id}:${event.seq}`);
    order.quantityLots -= reducedBy;
    order.locked -= release;
    this.transition(order, nextStatus(order.status, 'reduced'));
  }

  /** Terminal transition: releases whatever is still held for the order. */
  private async close(
    ctx: BatchContext,
    order: WorkingOrder,
    status: OrderStatus,
    event: EngineEvent,
  ): Promise<void> {
    if (!isTerminal(status))
      throw new SettlementInvariantError(`close() called with non-terminal ${status}`);
    if (order.locked > 0n) {
      await this.releaseFunds(
        ctx,
        order,
        order.locked,
        `order-release:${order.row.id}:${event.seq}`,
      );
    }
    order.locked = 0n;
    this.transition(order, status);
  }

  private async releaseFunds(
    ctx: BatchContext,
    order: WorkingOrder,
    amount: bigint,
    key: string,
  ): Promise<void> {
    const { holdAssetId, userId, id } = order.row;
    ctx.entries.push({
      type: 'BALANCE_RELEASE',
      idempotencyKey: key,
      description: `Release for order ${id}`,
      postings: [
        {
          accountId: await ctx.acc.id(holdAssetId, 'USER_LOCKED', userId),
          direction: 'DEBIT',
          amount,
        },
        {
          accountId: await ctx.acc.id(holdAssetId, 'USER_AVAILABLE', userId),
          direction: 'CREDIT',
          amount,
        },
      ],
    });
  }
}

/** Polls for new engine events; settlement errors are logged loudly and retried. */
@Injectable()
export class SettlementScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SettlementScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly settlement: SettlementService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const ms = this.config.SETTLEMENT_POLL_MS;
    if (ms <= 0) return;
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.settlement.processPending();
    } catch (err) {
      this.logger.error(
        { err },
        'SETTLEMENT_HALTED: an engine event could not be settled; retrying',
      );
    } finally {
      this.running = false;
    }
  }
}
