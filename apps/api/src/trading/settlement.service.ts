import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { EngineEvent, Order, Prisma } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { toMinorUnits } from '../ledger/ledger-domain';
import { LedgerService, type LedgerActor } from '../ledger/ledger.service';
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

/**
 * Consumes engine events and settles them in the ledger (ADR-0007). One
 * transaction per batch: ledger entries, order projections, trades and the
 * offset commit together. Any failure rolls back and halts that market's
 * settlement until fixed - money movements are never skipped.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /** Settles all pending events for all markets. Returns the number of events processed. */
  async processPending(batchSize = 200): Promise<number> {
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
    return this.prisma.$transaction(
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
        for (const event of events) {
          if (event.seq !== last + 1n) {
            throw new SettlementInvariantError(
              `Event gap in ${market.symbol}: expected ${last + 1n}, got ${event.seq}`,
            );
          }
          await this.apply(tx, market, event);
          last = event.seq;
        }
        if (events.length > 0) {
          await tx.settlementState.update({
            where: { marketId: market.id },
            data: { lastEventSeq: last },
          });
        }
        return events.length;
      },
      { timeout: 60_000 },
    );
  }

  private async apply(
    tx: Prisma.TransactionClient,
    market: MarketWithAssets,
    event: EngineEvent,
  ): Promise<void> {
    const e = event.payload as unknown as EnginePayload;
    switch (e.type) {
      case 'accepted': {
        const order = await this.order(tx, e.order_id);
        // Defence in depth: the engine must have accepted exactly what we enqueued.
        if (
          BigInt(e.quantity) !== order.quantityLots ||
          (e.price === null ? null : BigInt(e.price)) !== order.priceTicks ||
          (e.stop_price === null ? null : BigInt(e.stop_price)) !== order.stopPriceTicks
        ) {
          throw new SettlementInvariantError(
            `Engine accepted order ${order.id} with different parameters`,
          );
        }
        const isStop = order.type === 'STOP_LIMIT' || order.type === 'STOP_MARKET';
        await this.setStatus(tx, order, nextStatus(order.status, 'accepted', { isStop }));
        return;
      }
      case 'rejected': {
        const order = await this.order(tx, e.order_id);
        await this.close(
          tx,
          order,
          nextStatus(order.status, 'rejected'),
          { rejectReason: e.reason },
          event,
        );
        return;
      }
      case 'stop_triggered': {
        const order = await this.order(tx, e.order_id);
        await this.setStatus(tx, order, nextStatus(order.status, 'stop_triggered'));
        return;
      }
      case 'trade':
        await this.settleTrade(tx, market, event, e);
        return;
      case 'filled': {
        const order = await this.order(tx, e.order_id);
        if (order.filledLots !== order.quantityLots) {
          throw new SettlementInvariantError(
            `Order ${order.id} reported filled with ${order.filledLots}/${order.quantityLots}`,
          );
        }
        await this.close(tx, order, nextStatus(order.status, 'filled'), {}, event);
        return;
      }
      case 'cancelled': {
        const order = await this.order(tx, e.order_id);
        if (BigInt(e.remaining) !== order.quantityLots - order.filledLots) {
          throw new SettlementInvariantError(`Cancelled quantity mismatch for order ${order.id}`);
        }
        await this.close(
          tx,
          order,
          nextStatus(order.status, 'cancelled'),
          { cancelReason: e.reason },
          event,
        );
        return;
      }
      case 'reduced':
        await this.settleReduce(tx, market, event, e);
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

  private async settleTrade(
    tx: Prisma.TransactionClient,
    market: MarketWithAssets,
    event: EngineEvent,
    e: Extract<EnginePayload, { type: 'trade' }>,
  ): Promise<void> {
    const u = unitsOf(market);
    const maker = await this.order(tx, e.maker_order_id);
    const taker = await this.order(tx, e.taker_order_id);
    const [buyer, seller] = e.taker_side === 'buy' ? [taker, maker] : [maker, taker];
    if (buyer.side !== 'BUY' || seller.side !== 'SELL')
      throw new SettlementInvariantError('Trade sides do not match orders');
    if (buyer.userId === seller.userId)
      throw new SettlementInvariantError('Self-trade reached settlement');

    const priceTicks = BigInt(e.price);
    const lots = BigInt(e.quantity);
    // Maker price must be within the buyer's limit (it is the buyer's hold basis).
    if (buyer.priceTicks !== null && priceTicks > buyer.priceTicks) {
      throw new SettlementInvariantError(`Trade price above buyer limit for order ${buyer.id}`);
    }
    const quote = quoteAmount(priceTicks, lots, u);
    const base = baseAmount(lots, u);
    const buyerBps = buyer.id === maker.id ? market.makerFeeBps : market.takerFeeBps;
    const sellerBps = seller.id === maker.id ? market.makerFeeBps : market.takerFeeBps;
    const buyerFee = feeFor(base, buyerBps); // buyer receives base
    const sellerFee = feeFor(quote, sellerBps); // seller receives quote

    const buyerLocked = toMinorUnits(buyer.lockedRemaining);
    const sellerLocked = toMinorUnits(seller.lockedRemaining);
    if (buyerLocked < quote || sellerLocked < base) {
      throw new SettlementInvariantError(
        `Insufficient held funds for trade ${market.symbol}#${event.seq}`,
      );
    }

    const acc = (assetId: string, type: 'USER_AVAILABLE' | 'USER_LOCKED', userId: string) =>
      this.ledger.ensureAccount(assetId, type, userId, tx);
    const [buyerQuoteLocked, sellerQuoteAvail, sellerBaseLocked, buyerBaseAvail] =
      await Promise.all([
        acc(market.quoteAssetId, 'USER_LOCKED', buyer.userId),
        acc(market.quoteAssetId, 'USER_AVAILABLE', seller.userId),
        acc(market.baseAssetId, 'USER_LOCKED', seller.userId),
        acc(market.baseAssetId, 'USER_AVAILABLE', buyer.userId),
      ]);
    const postings = [
      { accountId: buyerQuoteLocked.id, direction: 'DEBIT' as const, amount: quote },
      { accountId: sellerQuoteAvail.id, direction: 'CREDIT' as const, amount: quote - sellerFee },
      { accountId: sellerBaseLocked.id, direction: 'DEBIT' as const, amount: base },
      { accountId: buyerBaseAvail.id, direction: 'CREDIT' as const, amount: base - buyerFee },
    ];
    if (sellerFee > 0n) {
      const fee = await this.ledger.ensureAccount(market.quoteAssetId, 'FEE_REVENUE', null, tx);
      postings.push({ accountId: fee.id, direction: 'CREDIT', amount: sellerFee });
    }
    if (buyerFee > 0n) {
      const fee = await this.ledger.ensureAccount(market.baseAssetId, 'FEE_REVENUE', null, tx);
      postings.push({ accountId: fee.id, direction: 'CREDIT', amount: buyerFee });
    }
    const { entry } = await this.ledger.postWithin(
      tx,
      {
        type: 'TRADE',
        idempotencyKey: `trade:${market.id}:${event.seq}`,
        description: `Trade ${market.symbol} #${event.seq}`,
        postings,
      },
      SETTLEMENT_ACTOR,
      { metadata: { market: market.symbol, eventSeq: event.seq.toString() } },
    );

    await tx.trade.create({
      data: {
        marketId: market.id,
        eventSeq: event.seq,
        makerOrderId: maker.id,
        takerOrderId: taker.id,
        buyerUserId: buyer.userId,
        sellerUserId: seller.userId,
        takerSide: taker.side,
        priceTicks,
        quantityLots: lots,
        baseAmount: base.toString(),
        quoteAmount: quote.toString(),
        buyerFee: buyerFee.toString(),
        sellerFee: sellerFee.toString(),
        journalEntryId: entry.id,
      },
    });

    for (const [order, consumed] of [
      [buyer, quote],
      [seller, base],
    ] as const) {
      const filled = order.filledLots + lots;
      if (filled > order.quantityLots)
        throw new SettlementInvariantError(`Overfill on order ${order.id}`);
      const remainingInEvent = BigInt(
        order.id === maker.id ? e.maker_remaining : e.taker_remaining,
      );
      if (order.quantityLots - filled !== remainingInEvent) {
        throw new SettlementInvariantError(`Remaining quantity mismatch on order ${order.id}`);
      }
      await tx.order.update({
        where: { id: order.id },
        data: {
          filledLots: filled,
          lockedRemaining: (toMinorUnits(order.lockedRemaining) - consumed).toString(),
          status: nextStatus(order.status, 'trade'),
        },
      });
    }
  }

  private async settleReduce(
    tx: Prisma.TransactionClient,
    market: MarketWithAssets,
    event: EngineEvent,
    e: Extract<EnginePayload, { type: 'reduced' }>,
  ): Promise<void> {
    const order = await this.order(tx, e.order_id);
    const u = unitsOf(market);
    const newRemaining = BigInt(e.remaining);
    const oldRemaining = order.quantityLots - order.filledLots;
    const reducedBy = oldRemaining - newRemaining;
    if (reducedBy <= 0n)
      throw new SettlementInvariantError(`Invalid reduction for order ${order.id}`);
    let release: bigint;
    if (order.side === 'SELL') {
      release = baseAmount(reducedBy, u);
    } else {
      if (order.priceTicks === null)
        throw new SettlementInvariantError('Buy order without price cannot rest');
      release = quoteAmount(order.priceTicks, reducedBy, u);
    }
    const locked = toMinorUnits(order.lockedRemaining);
    if (release > locked)
      throw new SettlementInvariantError(`Reduction releases more than held for ${order.id}`);
    if (release > 0n) {
      await this.releaseFunds(tx, order, release, `order-reduce:${order.id}:${event.seq}`);
    }
    await tx.order.update({
      where: { id: order.id },
      data: {
        quantityLots: order.quantityLots - reducedBy,
        lockedRemaining: (locked - release).toString(),
        status: nextStatus(order.status, 'reduced'),
      },
    });
  }

  /** Terminal transition: releases whatever is still held for the order. */
  private async close(
    tx: Prisma.TransactionClient,
    order: Order,
    status: Order['status'],
    extra: { rejectReason?: string; cancelReason?: string },
    event: EngineEvent,
  ): Promise<void> {
    if (!isTerminal(status))
      throw new SettlementInvariantError(`close() called with non-terminal ${status}`);
    const locked = toMinorUnits(order.lockedRemaining);
    if (locked > 0n)
      await this.releaseFunds(tx, order, locked, `order-release:${order.id}:${event.seq}`);
    await tx.order.update({
      where: { id: order.id },
      data: { status, lockedRemaining: '0', ...extra },
    });
  }

  private async releaseFunds(
    tx: Prisma.TransactionClient,
    order: Order,
    amount: bigint,
    key: string,
  ): Promise<void> {
    const locked = await this.ledger.ensureAccount(
      order.holdAssetId,
      'USER_LOCKED',
      order.userId,
      tx,
    );
    const available = await this.ledger.ensureAccount(
      order.holdAssetId,
      'USER_AVAILABLE',
      order.userId,
      tx,
    );
    await this.ledger.postWithin(
      tx,
      {
        type: 'BALANCE_RELEASE',
        idempotencyKey: key,
        description: `Release for order ${order.id}`,
        postings: [
          { accountId: locked.id, direction: 'DEBIT', amount },
          { accountId: available.id, direction: 'CREDIT', amount },
        ],
      },
      SETTLEMENT_ACTOR,
    );
  }

  private async setStatus(
    tx: Prisma.TransactionClient,
    order: Order,
    status: Order['status'],
  ): Promise<void> {
    await tx.order.update({ where: { id: order.id }, data: { status } });
  }

  private async order(tx: Prisma.TransactionClient, id: string): Promise<Order> {
    const order = await tx.order.findUnique({ where: { id } });
    if (!order) throw new SettlementInvariantError(`Engine referenced unknown order ${id}`);
    return order;
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
