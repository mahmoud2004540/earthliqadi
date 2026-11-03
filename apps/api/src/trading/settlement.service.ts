import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type {
  EngineEvent,
  LedgerAccountType,
  Order,
  OrderStatus,
  Position,
  PositionStatus,
  Prisma,
} from '@prisma/client';
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
import { parsePerpConfig, type PerpConfig } from '../perps/perp-config';
import { applyFill, initialMargin, type PositionState } from '../perps/perp-math';
import { perpHold, positionState } from '../perps/perp-orders';

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

/** In-memory working copy of a perpetual position during one batch. */
interface WorkingPosition {
  row: Position;
  state: PositionState;
  realizedPnl: bigint;
  status: PositionStatus;
  dirty: boolean;
}

interface PerpBatch {
  config: PerpConfig;
  /** By user id (one position per user and market). */
  positions: Map<string, WorkingPosition>;
}

interface BatchContext {
  acc: TransactionalAccounts;
  market: MarketWithAssets;
  orders: Map<string, WorkingOrder>;
  entries: EntryRequest[];
  trades: TradeDraft[];
  perp: PerpBatch | null;
}

/** Accumulates transfers and nets them per account (an entry lists each account once). */
class NetTransfers {
  private readonly net = new Map<string, bigint>();
  /** Moves value out of `from` into `to` (debit source, credit destination). */
  move(from: string, to: string, amount: bigint): void {
    if (amount < 0n) throw new SettlementInvariantError('Negative transfer');
    if (amount === 0n || from === to) return;
    this.net.set(from, (this.net.get(from) ?? 0n) + amount);
    this.net.set(to, (this.net.get(to) ?? 0n) - amount);
  }
  postings(): EntryRequest['postings'] {
    const out: EntryRequest['postings'] = [];
    for (const [accountId, v] of this.net) {
      if (v > 0n) out.push({ accountId, direction: 'DEBIT', amount: v });
      else if (v < 0n) out.push({ accountId, direction: 'CREDIT', amount: -v });
    }
    return out;
  }
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
          perp: null,
        };
        if (market.kind === 'PERPETUAL') {
          ctx.perp = await this.loadPositions(tx, market, rows);
        }

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
        if (ctx.perp) await this.writePositions(tx, ctx.perp);
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

  /**
   * Locks the positions of every user in the batch, in id order, BEFORE any
   * ledger account (global lock order: positions → ledger → market sequence).
   */
  private async loadPositions(
    tx: Prisma.TransactionClient,
    market: MarketWithAssets,
    orders: Order[],
  ): Promise<PerpBatch> {
    const userIds = [...new Set(orders.map((o) => o.userId))];
    const positions = new Map<string, WorkingPosition>();
    if (userIds.length > 0) {
      await tx.$queryRaw`
        SELECT "id" FROM "positions"
         WHERE "market_id" = ${market.id}::uuid AND "user_id" = ANY(${userIds}::uuid[])
         ORDER BY "id" FOR UPDATE`;
      const rows = await tx.position.findMany({
        where: { marketId: market.id, userId: { in: userIds } },
      });
      for (const row of rows) {
        positions.set(row.userId, {
          row,
          state: positionState(row),
          realizedPnl: toMinorUnits(row.realizedPnl),
          status: row.status,
          dirty: false,
        });
      }
    }
    return { config: parsePerpConfig(market.perpConfig), positions };
  }

  private async writePositions(tx: Prisma.TransactionClient, perp: PerpBatch): Promise<void> {
    const dirty = [...perp.positions.values()].filter((p) => p.dirty);
    if (dirty.length === 0) return;
    await tx.$executeRaw`
      UPDATE "positions" AS p
         SET "size_lots" = v."size",
             "entry_notional" = v."entry",
             "margin" = v."margin",
             "realized_pnl" = v."pnl",
             "status" = v."status"::"PositionStatus",
             "updated_at" = now()
        FROM (SELECT unnest(${dirty.map((p) => p.row.id)}::uuid[]) AS "id",
                     unnest(${dirty.map((p) => p.state.size.toString())}::bigint[]) AS "size",
                     unnest(${dirty.map((p) => p.state.entry.toString())}::numeric[]) AS "entry",
                     unnest(${dirty.map((p) => p.state.margin.toString())}::numeric[]) AS "margin",
                     unnest(${dirty.map((p) => p.realizedPnl.toString())}::numeric[]) AS "pnl",
                     unnest(${dirty.map((p) => p.status)}::text[]) AS "status") AS v
       WHERE p."id" = v."id"`;
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
        if (ctx.perp) await this.settlePerpTrade(ctx, ctx.perp, event, e);
        else await this.settleTrade(ctx, event, e);
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
    if (ctx.perp) {
      const r = order.row;
      release =
        r.isLiquidation || r.priceTicks === null
          ? 0n
          : perpHold(ctx.market, r.priceTicks, reducedBy, r.leverage ?? 1, r.reduceOnly);
      if (release > order.locked) release = order.locked; // per-part rounding
    } else if (order.row.side === 'SELL') {
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

  /**
   * Settles a perpetual fill (ADR-0011): no base asset moves. Each side's fill
   * is split into closing and opening parts; realised PnL is paid by (or to)
   * PERP_CLEARING, opening margin moves from the order hold to USER_MARGIN, and
   * fees go to FEE_REVENUE (liquidations: INSURANCE_FUND). One balanced entry.
   */
  private async settlePerpTrade(
    ctx: BatchContext,
    perp: PerpBatch,
    event: EngineEvent,
    e: Extract<EnginePayload, { type: 'trade' }>,
  ): Promise<void> {
    const { market, acc } = ctx;
    const u = unitsOf(market);
    const quoteId = market.quoteAssetId;
    const maker = this.order(ctx, e.maker_order_id);
    const taker = this.order(ctx, e.taker_order_id);
    const [buyer, seller] = e.taker_side === 'buy' ? [taker, maker] : [maker, taker];
    if (buyer.row.side !== 'BUY' || seller.row.side !== 'SELL')
      throw new SettlementInvariantError('Trade sides do not match orders');
    if (buyer.row.userId === seller.row.userId)
      throw new SettlementInvariantError('Self-trade reached settlement');
    const priceTicks = BigInt(e.price);
    const lots = BigInt(e.quantity);
    if (buyer.row.priceTicks !== null && priceTicks > buyer.row.priceTicks)
      throw new SettlementInvariantError(`Trade price above buyer limit for order ${buyer.row.id}`);
    if (seller.row.priceTicks !== null && priceTicks < seller.row.priceTicks)
      throw new SettlementInvariantError(
        `Trade price below seller limit for order ${seller.row.id}`,
      );
    const notional = quoteAmount(priceTicks, lots, u);

    const t = new NetTransfers();
    const id = (type: LedgerAccountType, owner: string | null): Promise<string> =>
      acc.id(quoteId, type, owner);
    const clearing = await id('PERP_CLEARING', null);
    const fees: bigint[] = [];

    for (const [order, dq] of [
      [buyer, lots],
      [seller, -lots],
    ] as const) {
      const userId = order.row.userId;
      const wp = perp.positions.get(userId);
      if (!wp)
        throw new SettlementInvariantError(`No position row for ${userId} on ${market.symbol}`);
      const filled = order.filledLots + lots;
      if (filled > order.quantityLots)
        throw new SettlementInvariantError(`Overfill on order ${order.row.id}`);
      const remainingInEvent = BigInt(order === maker ? e.maker_remaining : e.taker_remaining);
      if (order.quantityLots - filled !== remainingInEvent)
        throw new SettlementInvariantError(`Remaining quantity mismatch on order ${order.row.id}`);

      const available = await id('USER_AVAILABLE', userId);
      const locked = await id('USER_LOCKED', userId);
      const margin = await id('USER_MARGIN', userId);
      const isLiq = order.row.isLiquidation;
      const feeAccount = await id(isLiq ? 'INSURANCE_FUND' : 'FEE_REVENUE', null);
      const leverage = order.row.leverage ?? wp.row.leverage;

      const r = applyFill(wp.state, dq, notional);

      // 1. Spend this fill's share of the order hold: fee, then opening margin, rest back.
      let budget = 0n;
      if (!isLiq && order.row.priceTicks !== null) {
        const share = perpHold(market, order.row.priceTicks, lots, leverage, order.row.reduceOnly);
        budget = share < order.locked ? share : order.locked;
      }
      order.locked -= budget;
      const feeBps = isLiq
        ? perp.config.liquidationFeeBps
        : order === maker
          ? market.makerFeeBps
          : market.takerFeeBps;
      const feeDue = feeFor(notional, feeBps);
      const feeFromHold = feeDue < budget ? feeDue : budget;
      t.move(locked, feeAccount, feeFromHold);
      budget -= feeFromHold;
      const marginWanted = r.openedLots > 0n ? initialMargin(r.openNotional, leverage) : 0n;
      const openMargin = marginWanted < budget ? marginWanted : budget;
      t.move(locked, margin, openMargin);
      budget -= openMargin;
      t.move(locked, available, budget);
      let toAvailable = budget;

      // 2. Closing part: released margin plus realised PnL.
      let positionMargin = r.next.margin;
      if (r.realizedPnl >= 0n) {
        t.move(clearing, available, r.realizedPnl);
        t.move(margin, available, r.releasedMargin);
        toAvailable += r.realizedPnl + r.releasedMargin;
      } else {
        const loss = -r.realizedPnl;
        const fromReleased = loss < r.releasedMargin ? loss : r.releasedMargin;
        t.move(margin, clearing, fromReleased);
        t.move(margin, available, r.releasedMargin - fromReleased);
        toAvailable += r.releasedMargin - fromReleased;
        let rest = loss - fromReleased;
        // Possible only through rounding or a reduce-only race (ADR-0011):
        // the remaining position margin, then the insurance fund, absorb it.
        const fromPosition = rest < positionMargin ? rest : positionMargin;
        t.move(margin, clearing, fromPosition);
        positionMargin -= fromPosition;
        rest -= fromPosition;
        if (rest > 0n) {
          this.logger.warn(
            { market: market.symbol, userId, shortfall: rest.toString() },
            'Bankrupt fill: insurance fund covers the shortfall',
          );
          t.move(await id('INSURANCE_FUND', null), clearing, rest);
        }
      }

      // 3. Any fee the hold could not cover comes out of what the fill paid out.
      const feeLeft = feeDue - feeFromHold;
      const feeFromPayout = feeLeft < toAvailable ? feeLeft : toAvailable;
      t.move(available, feeAccount, feeFromPayout);
      fees.push(feeFromHold + feeFromPayout);

      wp.state = { ...r.next, margin: positionMargin + openMargin };
      wp.realizedPnl += r.realizedPnl;
      if (wp.state.size === 0n) wp.status = 'NORMAL';
      wp.dirty = true;

      order.filledLots = filled;
      this.transition(order, nextStatus(order.status, 'trade'));
    }

    const postings = t.postings();
    if (postings.length < 2)
      throw new SettlementInvariantError(
        `Perpetual fill ${market.symbol}#${event.seq} moved nothing`,
      );
    const key = `trade:${market.id}:${event.seq}`;
    ctx.entries.push({
      type: 'TRADE',
      idempotencyKey: key,
      description: `Perpetual trade ${market.symbol} #${event.seq}`,
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
        baseAmount: baseAmount(lots, u).toString(),
        quoteAmount: notional.toString(),
        buyerFee: fees[0]!.toString(),
        sellerFee: fees[1]!.toString(),
        executedAt: event.createdAt,
      },
    });
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
