import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { AlgoOrder, Order } from '@prisma/client';
import {
  formatAmountTrimmed,
  parseAmount,
  type AlgoOrderDto,
  type AlgoOrderInput,
  type GridStatsDto,
  type PublicGridDto,
} from '@platform/shared';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { toMinorUnits } from '../ledger/ledger-domain';
import { parsePerpConfig } from '../perps/perp-config';
import { currentMark } from '../perps/perp-prices';
import { MarketsService, unitsOf, type MarketWithAssets } from '../trading/markets.service';
import {
  lotsToQuantity,
  priceToTicks,
  quantityToLots,
  quoteAmount,
  ticksToPrice,
} from '../trading/order-math';
import { isTerminal } from '../trading/order-state';
import { OrdersService } from '../trading/orders.service';
import {
  chaseNeedsReprice,
  chaseTarget,
  gridCounter,
  gridLevels,
  initialGridOrders,
  protectionPrice,
  recurringRun,
  trailingStep,
  type GridDirection,
  type Side,
} from './pro-math';

const MAX_RUNNING = 20;
const MAX_SLICES = 1000;
const SYSTEM_CTX = (id: string): RequestContext => ({
  requestId: `algo:${id}`,
  ipAddress: null,
  userAgent: null,
});

function invalid(message: string, path = 'body'): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', message, [{ path, message }]);
}

/** Kinds that are evaluated on every poll rather than on a schedule. */
const CONTINUOUS = new Set(['TRAILING', 'CHASE', 'GRID']);

/**
 * Algo orders (ADR-0020, ADR-0025). The parent never holds funds itself:
 * each child is an ordinary order with its own hold and risk checks, so a
 * parent can never spend more than the account has.
 *
 * - TWAP: every `interval` seconds an IOC limit child for one slice.
 * - Iceberg: one visible GTC limit child at a time; when it ends, the next.
 * - Trailing stop: follows the reference price; fires one IOC child.
 * - Chase: one post-only child, re-priced to the best price on its side.
 * - Grid: limit children on every level; each fill is answered one level away.
 */
@Injectable()
export class AlgoOrdersService {
  private readonly logger = new Logger(AlgoOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly markets: MarketsService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------ create

  async create(
    userId: string,
    input: AlgoOrderInput,
    ctx: RequestContext,
    opts: { copiedFromId?: string } = {},
  ): Promise<AlgoOrderDto> {
    const market = await this.markets.require(input.market);
    if (market.status !== 'ACTIVE')
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'Market is halted');
    const u = unitsOf(market);
    const perp = market.kind === 'PERPETUAL';
    if (input.reduceOnly && !perp) throw invalid('reduceOnly is for perpetuals', 'reduceOnly');
    const running = await this.prisma.algoOrder.count({ where: { userId, status: 'RUNNING' } });
    if (running >= MAX_RUNNING)
      throw new AppError(
        HttpStatus.CONFLICT,
        'LIMIT_EXCEEDED',
        `At most ${MAX_RUNNING} running algo orders`,
      );

    const base = {
      id: randomUUID(),
      userId,
      marketId: market.id,
      kind: input.kind.toUpperCase(),
      reduceOnly: input.reduceOnly ?? false,
      nextAt: new Date(),
    };
    let data: Parameters<typeof this.prisma.algoOrder.create>[0]['data'];
    switch (input.kind) {
      case 'twap':
      case 'iceberg': {
        const total = quantityToLots(input.quantity, u);
        const slice = quantityToLots(input.sliceQuantity, u, 'sliceQuantity');
        if (slice > total) throw invalid('Slice is larger than the total', 'sliceQuantity');
        if (slice < market.minQuantityLots)
          throw invalid('Slice is below the market minimum', 'sliceQuantity');
        if ((total + slice - 1n) / slice > BigInt(MAX_SLICES))
          throw invalid(`At most ${MAX_SLICES} slices`, 'sliceQuantity');
        data = {
          ...base,
          side: input.side === 'buy' ? 'BUY' : 'SELL',
          totalLots: total,
          sliceLots: slice,
          priceTicks: priceToTicks(input.price, u),
          intervalSeconds: input.kind === 'twap' ? input.intervalSeconds : null,
        };
        break;
      }
      case 'trailing': {
        const total = quantityToLots(input.quantity, u);
        if (total < market.minQuantityLots) throw invalid('Below the market minimum', 'quantity');
        data = {
          ...base,
          side: input.side === 'buy' ? 'BUY' : 'SELL',
          totalLots: total,
          sliceLots: total,
          priceTicks: null,
          callbackBps: input.callbackBps,
          slippageBps: input.slippageBps,
          activationTicks: input.activationPrice
            ? priceToTicks(input.activationPrice, u, 'activationPrice')
            : null,
        };
        break;
      }
      case 'chase': {
        const total = quantityToLots(input.quantity, u);
        if (total < market.minQuantityLots) throw invalid('Below the market minimum', 'quantity');
        data = {
          ...base,
          side: input.side === 'buy' ? 'BUY' : 'SELL',
          totalLots: total,
          sliceLots: total,
          priceTicks: priceToTicks(input.price, u),
        };
        break;
      }
      case 'recurring': {
        // A buy spends a quote amount per run, a sell sells a base amount per run.
        // For buys the lot counts are placeholders (the size is decided per run).
        let runAmount: bigint;
        let slice = 1n;
        if (input.side === 'buy') {
          try {
            runAmount = parseAmount(input.amount, market.quoteAsset.scale);
          } catch {
            throw invalid('Invalid amount', 'amount');
          }
          if (runAmount <= 0n) throw invalid('Amount must be positive', 'amount');
        } else {
          slice = quantityToLots(input.amount, u, 'amount');
          if (slice < market.minQuantityLots) throw invalid('Below the market minimum', 'amount');
          runAmount = slice * toMinorUnits(market.lotSize);
        }
        data = {
          ...base,
          side: input.side === 'buy' ? 'BUY' : 'SELL',
          totalLots: slice * BigInt(input.runs),
          sliceLots: slice,
          priceTicks: input.limitPrice ? priceToTicks(input.limitPrice, u, 'limitPrice') : null,
          intervalSeconds: input.intervalSeconds,
          slippageBps: input.slippageBps,
          runAmount: runAmount.toString(),
          runsTotal: input.runs,
        };
        break;
      }
      case 'grid': {
        const direction = input.direction.toUpperCase() as GridDirection;
        if (!perp && direction !== 'LONG')
          throw invalid('Spot grids are long only (they cannot sell what they do not hold)');
        if (input.reduceOnly) throw invalid('Grids cannot be reduce-only', 'reduceOnly');
        const lower = priceToTicks(input.lowerPrice, u, 'lowerPrice');
        const upper = priceToTicks(input.upperPrice, u, 'upperPrice');
        try {
          gridLevels(lower, upper, input.gridCount);
        } catch (err) {
          throw invalid((err as Error).message, 'gridCount');
        }
        const per = quantityToLots(input.quantityPerGrid, u, 'quantityPerGrid');
        if (per < market.minQuantityLots)
          throw invalid('Grid size is below the market minimum', 'quantityPerGrid');
        data = {
          ...base,
          side: 'BUY',
          totalLots: per * BigInt(input.gridCount + 1),
          sliceLots: per,
          priceTicks: null,
          gridLowerTicks: lower,
          gridUpperTicks: upper,
          gridCount: input.gridCount,
          gridDirection: direction,
          isPublic: input.isPublic,
          copiedFromId: opts.copiedFromId ?? null,
        };
        break;
      }
    }
    const row = await this.prisma.algoOrder.create({ data });
    await this.audit.recordSafe({
      action: 'trading.algo.created',
      outcome: 'SUCCESS',
      actorType: 'USER',
      actorUserId: userId,
      targetType: 'algo_order',
      targetId: row.id,
      context: ctx,
      metadata: { ...input, ...(opts.copiedFromId ? { copiedFromId: opts.copiedFromId } : {}) },
    });
    await this.step(row);
    return this.toDto(await this.prisma.algoOrder.findUniqueOrThrow({ where: { id: row.id } }));
  }

  async cancel(userId: string, id: string): Promise<AlgoOrderDto> {
    const a = await this.prisma.algoOrder.findFirst({ where: { id, userId } });
    if (!a) throw AppError.notFound('Algo order not found');
    if (a.status === 'RUNNING') {
      await this.prisma.algoOrder.update({
        where: { id },
        data: { status: 'CANCELLED', updatedAt: new Date() },
      });
      await this.cancelChildren(a);
    }
    return this.toDto(await this.prisma.algoOrder.findUniqueOrThrow({ where: { id } }));
  }

  async list(userId: string): Promise<AlgoOrderDto[]> {
    const rows = await this.prisma.algoOrder.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const out: AlgoOrderDto[] = [];
    for (const r of rows) out.push(await this.toDto(r));
    return out;
  }

  // ------------------------------------------------------------ grid marketplace

  async setVisibility(userId: string, id: string, isPublic: boolean): Promise<AlgoOrderDto> {
    const a = await this.prisma.algoOrder.findFirst({ where: { id, userId } });
    if (!a) throw AppError.notFound('Algo order not found');
    if (a.kind !== 'GRID') throw invalid('Only grids can be listed in the marketplace');
    const row = await this.prisma.algoOrder.update({
      where: { id },
      data: { isPublic, updatedAt: new Date() },
    });
    return this.toDto(row);
  }

  /** Public grids: parameters and results only, never the owner (ADR-0025). */
  async listPublic(market?: string): Promise<PublicGridDto[]> {
    const marketId = market ? (await this.markets.require(market)).id : undefined;
    const rows = await this.prisma.algoOrder.findMany({
      where: { kind: 'GRID', isPublic: true, ...(marketId ? { marketId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const copies = await this.prisma.algoOrder.groupBy({
      by: ['copiedFromId'],
      where: { copiedFromId: { in: rows.map((r) => r.id) } },
      _count: true,
    });
    const copyCount = new Map(copies.map((c) => [c.copiedFromId, c._count]));
    const now = Date.now();
    const out: PublicGridDto[] = [];
    for (const r of rows) {
      const market = await this.marketOf(r.marketId);
      const end = r.status === 'RUNNING' ? now : r.updatedAt.getTime();
      out.push({
        id: r.id,
        market: market.symbol,
        status: r.status.toLowerCase() as PublicGridDto['status'],
        createdAt: r.createdAt.toISOString(),
        runningSeconds: Math.max(0, Math.floor((end - r.createdAt.getTime()) / 1000)),
        copies: copyCount.get(r.id) ?? 0,
        ...(await this.gridStats(r, market)),
      });
    }
    // Most completed rounds first: the marketplace ranks by results, not by recency.
    return out.sort((a, b) => b.completedRounds - a.completedRounds);
  }

  /** Starts a grid with the parameters of a public one, at the caller's own size. */
  async copy(
    userId: string,
    sourceId: string,
    input: { quantityPerGrid: string; isPublic: boolean },
    ctx: RequestContext,
  ): Promise<AlgoOrderDto> {
    const src = await this.prisma.algoOrder.findFirst({
      where: { id: sourceId, kind: 'GRID', isPublic: true },
    });
    if (!src) throw AppError.notFound('Public grid not found');
    const market = await this.marketOf(src.marketId);
    const u = unitsOf(market);
    return this.create(
      userId,
      {
        kind: 'grid',
        market: market.symbol,
        lowerPrice: ticksToPrice(src.gridLowerTicks!, u),
        upperPrice: ticksToPrice(src.gridUpperTicks!, u),
        gridCount: src.gridCount!,
        direction: src.gridDirection!.toLowerCase() as 'long' | 'short' | 'neutral',
        quantityPerGrid: input.quantityPerGrid,
        isPublic: input.isPublic,
      },
      ctx,
      { copiedFromId: src.id },
    );
  }

  // ------------------------------------------------------------ prices

  private async marketOf(id: string): Promise<MarketWithAssets> {
    return this.prisma.market.findUniqueOrThrow({
      where: { id },
      include: { baseAsset: true, quoteAsset: true },
    });
  }

  /** Best visible bid and ask, in ticks (hidden orders are not part of the visible book). */
  async bestPrices(marketId: string): Promise<{ bid: bigint | null; ask: bigint | null }> {
    const [r] = await this.prisma.$queryRaw<{ bid: bigint | null; ask: bigint | null }[]>`
      SELECT MAX("price_ticks") FILTER (WHERE "side" = 'BUY')  AS "bid",
             MIN("price_ticks") FILTER (WHERE "side" = 'SELL') AS "ask"
        FROM "orders"
       WHERE "market_id" = ${marketId}::uuid
         AND "status" IN ('OPEN', 'PARTIALLY_FILLED')
         AND "time_in_force" IN ('GTC', 'POST_ONLY')
         AND NOT "hidden"
         AND "price_ticks" IS NOT NULL`;
    return { bid: r?.bid ?? null, ask: r?.ask ?? null };
  }

  /** Reference price in ticks: mark for perpetuals, last trade for spot. Null when unknown. */
  async referencePrice(market: MarketWithAssets): Promise<bigint | null> {
    if (market.kind === 'PERPETUAL') {
      const mark = await currentMark(this.prisma, market.id, parsePerpConfig(market.perpConfig));
      return mark === null ? null : mark / toMinorUnits(market.tickSize);
    }
    const last = await this.prisma.trade.findFirst({
      where: { marketId: market.id },
      orderBy: { eventSeq: 'desc' },
      select: { priceTicks: true },
    });
    return last?.priceTicks ?? null;
  }

  // ------------------------------------------------------------ stepping

  private async children(id: string) {
    return this.prisma.order.findMany({
      where: { algoOrderId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async cancelChildren(a: AlgoOrder): Promise<void> {
    const open = await this.prisma.order.findMany({
      where: {
        algoOrderId: a.id,
        status: { in: ['PENDING_NEW', 'OPEN', 'PARTIALLY_FILLED', 'PENDING_TRIGGER'] },
      },
      select: { id: true },
    });
    await this.orders.cancelOwned(
      a.userId,
      open.map((o) => o.id),
    );
  }

  /** Stops a parent with a reason and cancels what it left resting. */
  private async fail(a: AlgoOrder, message: string, now: Date): Promise<void> {
    const r = await this.prisma.algoOrder.updateMany({
      where: { id: a.id, status: 'RUNNING' },
      data: { status: 'FAILED', lastError: message.slice(0, 256), updatedAt: now },
    });
    if (r.count > 0) await this.cancelChildren(a);
  }

  private async placeChild(
    a: AlgoOrder,
    market: MarketWithAssets,
    order: {
      clientOrderId: string;
      side: Side;
      tif: 'gtc' | 'ioc' | 'post_only';
      priceTicks: bigint;
      lots: bigint;
      gridLevel?: number;
    },
    now: Date,
  ): Promise<boolean> {
    const u = unitsOf(market);
    try {
      await this.orders.place(
        a.userId,
        {
          market: market.symbol,
          clientOrderId: order.clientOrderId,
          side: order.side === 'BUY' ? 'buy' : 'sell',
          type: 'limit',
          timeInForce: order.tif,
          price: ticksToPrice(order.priceTicks, u),
          quantity: lotsToQuantity(order.lots, u),
          ...(a.reduceOnly ? { reduceOnly: true } : {}),
        },
        SYSTEM_CTX(a.id),
        {
          rateChecked: true,
          algoOrderId: a.id,
          ...(order.gridLevel !== undefined ? { gridLevel: order.gridLevel } : {}),
        },
      );
      return true;
    } catch (err) {
      const message = err instanceof AppError ? err.message : 'Child order failed';
      if (!(err instanceof AppError)) this.logger.error({ err, algo: a.id }, 'Algo child failed');
      await this.fail(a, message, now);
      return false;
    }
  }

  /** Claims the next child slot so two workers can never send the same one. */
  private async claim(a: AlgoOrder, now: Date, nextAt = now): Promise<boolean> {
    const claimed = await this.prisma.algoOrder.updateMany({
      where: { id: a.id, status: 'RUNNING', slicesSent: a.slicesSent },
      data: { slicesSent: { increment: 1 }, nextAt, updatedAt: now },
    });
    return claimed.count > 0;
  }

  /** Advances one parent. */
  async step(a: AlgoOrder, now = new Date()): Promise<void> {
    if (a.status !== 'RUNNING' || a.nextAt > now) return;
    switch (a.kind) {
      case 'TWAP':
      case 'ICEBERG':
        return this.stepSliced(a, now);
      case 'TRAILING':
        return this.stepTrailing(a, now);
      case 'CHASE':
        return this.stepChase(a, now);
      case 'GRID':
        return this.stepGrid(a, now);
      case 'RECURRING':
        return this.stepRecurring(a, now);
    }
  }

  private async stepSliced(a: AlgoOrder, now: Date): Promise<void> {
    const kids = await this.children(a.id);
    const filled = kids.reduce((s, c) => s + c.filledLots, 0n);
    const activeChild = kids.some((c) => !isTerminal(c.status));
    const remaining = a.totalLots - filled;
    const twap = a.kind === 'TWAP';
    const maxSlices = Number((a.totalLots + a.sliceLots - 1n) / a.sliceLots);
    const exhausted = twap && a.slicesSent >= maxSlices;
    if (remaining <= 0n || exhausted) {
      if (!activeChild)
        await this.prisma.algoOrder.update({
          where: { id: a.id },
          data: { status: 'DONE', updatedAt: now },
        });
      return;
    }
    if (activeChild) return; // iceberg: wait for the visible child; TWAP: wait for the IOC to end
    const market = await this.marketOf(a.marketId);
    const lots = remaining < a.sliceLots ? remaining : a.sliceLots;
    const next = twap ? new Date(now.getTime() + a.intervalSeconds! * 1000) : now;
    if (!(await this.claim(a, now, next))) return;
    await this.placeChild(
      a,
      market,
      {
        clientOrderId: `algo-${a.id}-${a.slicesSent + 1}`,
        side: a.side,
        tif: twap ? 'ioc' : 'gtc',
        priceTicks: a.priceTicks!,
        lots,
      },
      now,
    );
  }

  private async stepTrailing(a: AlgoOrder, now: Date): Promise<void> {
    if (a.slicesSent > 0) {
      // Fired: done once its IOC child has ended.
      const kids = await this.children(a.id);
      if (kids.every((c) => isTerminal(c.status)))
        await this.prisma.algoOrder.updateMany({
          where: { id: a.id, status: 'RUNNING' },
          data: { status: 'DONE', updatedAt: now },
        });
      return;
    }
    const market = await this.marketOf(a.marketId);
    const price = await this.referencePrice(market);
    if (price === null) return; // no fresh reference: keep waiting, never fire blind
    const r = trailingStep(
      { activated: a.activated, extreme: a.extremeTicks },
      { side: a.side, callbackBps: a.callbackBps!, activation: a.activationTicks },
      price,
    );
    if (r.triggered) {
      if (!(await this.claim(a, now))) return;
      await this.prisma.algoOrder.update({
        where: { id: a.id },
        data: { activated: r.activated, extremeTicks: r.extreme },
      });
      await this.placeChild(
        a,
        market,
        {
          clientOrderId: `algo-${a.id}-1`,
          side: a.side,
          tif: 'ioc',
          priceTicks: protectionPrice(a.side, price, a.slippageBps!),
          lots: a.totalLots,
        },
        now,
      );
      return;
    }
    if (r.activated !== a.activated || r.extreme !== a.extremeTicks)
      await this.prisma.algoOrder.updateMany({
        where: { id: a.id, status: 'RUNNING' },
        data: { activated: r.activated, extremeTicks: r.extreme, updatedAt: now },
      });
  }

  private async stepChase(a: AlgoOrder, now: Date): Promise<void> {
    const kids = await this.children(a.id);
    const filled = kids.reduce((s, c) => s + c.filledLots, 0n);
    const active = kids.find((c) => !isTerminal(c.status));
    const remaining = a.totalLots - filled;
    if (remaining <= 0n) {
      if (!active)
        await this.prisma.algoOrder.update({
          where: { id: a.id },
          data: { status: 'DONE', updatedAt: now },
        });
      return;
    }
    const best = await this.bestPrices(a.marketId);
    const target = chaseTarget(a.side, best, a.priceTicks!);
    if (active) {
      // Re-price: cancel first; the replacement goes out once the cancel is confirmed.
      if (
        (active.status === 'OPEN' || active.status === 'PARTIALLY_FILLED') &&
        !active.cancelRequestedAt &&
        chaseNeedsReprice(a.side, active.priceTicks!, target)
      )
        await this.orders.cancelOwned(a.userId, [active.id]);
      return;
    }
    if (a.slicesSent >= MAX_SLICES) return this.fail(a, 'Chase stopped after 1000 re-prices', now);
    const market = await this.marketOf(a.marketId);
    if (!(await this.claim(a, now))) return;
    await this.placeChild(
      a,
      market,
      {
        clientOrderId: `algo-${a.id}-${a.slicesSent + 1}`,
        side: a.side,
        tif: 'post_only',
        priceTicks: target,
        lots: remaining,
      },
      now,
    );
  }

  /** One run per interval (ADR-0029); a run without a usable price is skipped with a reason. */
  private async stepRecurring(a: AlgoOrder, now: Date): Promise<void> {
    const kids = await this.children(a.id);
    const active = kids.some((c) => !isTerminal(c.status));
    if (a.slicesSent >= a.runsTotal!) {
      if (!active)
        await this.prisma.algoOrder.updateMany({
          where: { id: a.id, status: 'RUNNING' },
          data: { status: 'DONE', updatedAt: now },
        });
      return;
    }
    if (active) return;
    const market = await this.marketOf(a.marketId);
    const u = unitsOf(market);
    const next = new Date(now.getTime() + a.intervalSeconds! * 1000);
    if (!(await this.claim(a, now, next))) return;
    const best = await this.bestPrices(a.marketId);
    const run = recurringRun({
      side: a.side,
      bestOpposite: a.side === 'BUY' ? best.ask : best.bid,
      slippageBps: a.slippageBps!,
      limit: a.priceTicks,
      runAmount: BigInt(a.runAmount!.toFixed(0)),
      lotSize: toMinorUnits(market.lotSize),
      minLots: market.minQuantityLots,
      quotePerLot: (p) => quoteAmount(p, 1n, u),
    });
    if (!run.ok) {
      await this.prisma.algoOrder.update({
        where: { id: a.id },
        data: { lastError: `Run ${a.slicesSent + 1} skipped: ${run.reason}`, updatedAt: now },
      });
      return;
    }
    await this.placeChild(
      a,
      market,
      {
        clientOrderId: `algo-${a.id}-${a.slicesSent + 1}`,
        side: a.side,
        tif: 'ioc',
        priceTicks: run.priceTicks,
        lots: run.lots,
      },
      now,
    );
  }

  private async stepGrid(a: AlgoOrder, now: Date): Promise<void> {
    const market = await this.marketOf(a.marketId);
    const levels = gridLevels(a.gridLowerTicks!, a.gridUpperTicks!, a.gridCount!);
    if (a.slicesSent === 0) {
      let ref = await this.referencePrice(market);
      if (ref === null) {
        const best = await this.bestPrices(a.marketId);
        if (best.bid !== null && best.ask !== null) ref = (best.bid + best.ask) / 2n;
      }
      if (ref === null) return this.fail(a, 'No reference price to start the grid', now);
      if (!(await this.claim(a, now))) return;
      for (const o of initialGridOrders(levels, ref, a.gridDirection as GridDirection)) {
        const ok = await this.placeChild(
          a,
          market,
          {
            clientOrderId: `g-${a.id}-${o.level}`,
            side: o.side,
            tif: 'gtc',
            priceTicks: levels[o.level]!,
            lots: a.sliceLots,
            gridLevel: o.level,
          },
          now,
        );
        if (!ok) return;
      }
      return;
    }

    const kids = await this.children(a.id);
    const broken = kids.find((c) => isTerminal(c.status) && c.status !== 'FILLED');
    if (broken)
      return this.fail(
        a,
        `A grid order was ${broken.status.toLowerCase()} outside the grid; the grid stopped`,
        now,
      );
    const ids = new Set(kids.map((c) => c.clientOrderId));
    for (const c of kids) {
      if (c.status !== 'FILLED' || c.gridLevel === null) continue;
      // Initial orders and re-opening answers open a round; their answers close it.
      const counterId = `${c.clientOrderId.startsWith('gx-') ? 'go' : 'gx'}-${c.id}`;
      if (ids.has(counterId)) continue;
      const counter = gridCounter(c.side, c.gridLevel, levels.length);
      if (!counter) continue;
      const lots = await this.counterLots(c, counter.side, a, market);
      if (lots < market.minQuantityLots) continue;
      const ok = await this.placeChild(
        a,
        market,
        {
          clientOrderId: counterId,
          side: counter.side,
          tif: 'gtc',
          priceTicks: levels[counter.level]!,
          lots,
          gridLevel: counter.level,
        },
        now,
      );
      if (!ok) return;
    }
  }

  /**
   * Size of the answer to a filled grid order. Spot buys receive the base
   * asset minus the fee, so the answering sell is the base actually received
   * (rounded down to lots); everything else uses the grid size.
   */
  private async counterLots(
    filled: Order,
    side: Side,
    a: AlgoOrder,
    market: MarketWithAssets,
  ): Promise<bigint> {
    if (market.kind === 'PERPETUAL' || side !== 'SELL') return a.sliceLots;
    const [r] = await this.prisma.$queryRaw<{ fee: string | null }[]>`
      SELECT SUM("buyer_fee")::text AS "fee" FROM "trades"
       WHERE "maker_order_id" = ${filled.id}::uuid OR "taker_order_id" = ${filled.id}::uuid`;
    const lotSize = toMinorUnits(market.lotSize);
    const received = filled.filledLots * lotSize - BigInt(r?.fee ?? '0');
    const lots = received / lotSize;
    return lots < a.sliceLots ? lots : a.sliceLots;
  }

  async tick(now = new Date()): Promise<void> {
    const due = await this.prisma.algoOrder.findMany({
      where: { status: 'RUNNING', nextAt: { lte: now } },
      orderBy: { nextAt: 'asc' },
      take: 200,
    });
    for (const a of due) {
      try {
        await this.step(a, now);
      } catch (err) {
        this.logger.error({ err, algo: a.id }, 'Algo step failed');
      }
      // Continuous kinds go to the back of the queue so scheduled ones are never starved.
      if (CONTINUOUS.has(a.kind))
        await this.prisma.algoOrder.updateMany({
          where: { id: a.id, status: 'RUNNING' },
          data: { nextAt: now },
        });
    }
  }

  // ------------------------------------------------------------ DTOs

  private async gridStats(a: AlgoOrder, market: MarketWithAssets): Promise<GridStatsDto> {
    const u = unitsOf(market);
    const levels = gridLevels(a.gridLowerTicks!, a.gridUpperTicks!, a.gridCount!);
    const closing = await this.prisma.order.findMany({
      where: { algoOrderId: a.id, clientOrderId: { startsWith: 'gx-' }, filledLots: { gt: 0 } },
      select: { side: true, gridLevel: true, filledLots: true, status: true },
    });
    let profit = 0n;
    let rounds = 0;
    for (const c of closing) {
      const i = c.gridLevel!;
      // A closing sell at level i came from a buy at i - 1; a closing buy at i from a sell at i + 1.
      const step = c.side === 'SELL' ? levels[i]! - levels[i - 1]! : levels[i + 1]! - levels[i]!;
      profit += quoteAmount(step, c.filledLots, u);
      if (c.status === 'FILLED') rounds++;
    }
    return {
      lowerPrice: ticksToPrice(a.gridLowerTicks!, u),
      upperPrice: ticksToPrice(a.gridUpperTicks!, u),
      gridCount: a.gridCount!,
      direction: a.gridDirection!.toLowerCase() as GridStatsDto['direction'],
      quantityPerGrid: lotsToQuantity(a.sliceLots, u),
      completedRounds: rounds,
      gridProfit: formatAmountTrimmed(profit, market.quoteAsset.scale),
      isPublic: a.isPublic,
      copiedFromId: a.copiedFromId,
    };
  }

  async toDto(a: AlgoOrder): Promise<AlgoOrderDto> {
    const market = await this.marketOf(a.marketId);
    const u = unitsOf(market);
    const kids = await this.prisma.order.findMany({
      where: { algoOrderId: a.id },
      select: { filledLots: true },
    });
    const filled = kids.reduce((s, c) => s + c.filledLots, 0n);
    let trailing: AlgoOrderDto['trailing'] = null;
    if (a.kind === 'TRAILING') {
      const cb = BigInt(a.callbackBps!);
      const ext = a.extremeTicks;
      const trigger =
        ext === null || !a.activated
          ? null
          : a.side === 'SELL'
            ? (ext * (10_000n - cb)) / 10_000n
            : (ext * (10_000n + cb) + 9_999n) / 10_000n;
      trailing = {
        callbackBps: a.callbackBps!,
        slippageBps: a.slippageBps!,
        activationPrice: a.activationTicks === null ? null : ticksToPrice(a.activationTicks, u),
        activated: a.activated,
        extremePrice: ext === null ? null : ticksToPrice(ext, u),
        triggerPrice: trigger === null || trigger < 1n ? null : ticksToPrice(trigger, u),
      };
    }
    return {
      id: a.id,
      market: market.symbol,
      kind: a.kind.toLowerCase() as AlgoOrderDto['kind'],
      side: a.kind === 'GRID' ? 'both' : a.side === 'BUY' ? 'buy' : 'sell',
      quantity: lotsToQuantity(a.totalLots, u),
      sliceQuantity: lotsToQuantity(a.sliceLots, u),
      filledQuantity: filled === 0n ? '0' : lotsToQuantity(filled, u),
      price: a.priceTicks === null ? null : ticksToPrice(a.priceTicks, u),
      intervalSeconds: a.intervalSeconds,
      status: a.status.toLowerCase() as AlgoOrderDto['status'],
      slicesSent: a.slicesSent,
      lastError: a.lastError,
      createdAt: a.createdAt.toISOString(),
      trailing,
      grid: a.kind === 'GRID' ? await this.gridStats(a, market) : null,
      recurring:
        a.kind === 'RECURRING'
          ? {
              amount: formatAmountTrimmed(
                BigInt(a.runAmount!.toFixed(0)),
                a.side === 'BUY' ? market.quoteAsset.scale : market.baseAsset.scale,
              ),
              amountAsset: a.side === 'BUY' ? market.quoteAsset.code : market.baseAsset.code,
              runs: a.runsTotal!,
              runsDone: a.slicesSent,
              intervalSeconds: a.intervalSeconds!,
              slippageBps: a.slippageBps!,
              limitPrice: a.priceTicks === null ? null : ticksToPrice(a.priceTicks, u),
              nextRunAt:
                a.status === 'RUNNING' && a.slicesSent < a.runsTotal!
                  ? a.nextAt.toISOString()
                  : null,
            }
          : null,
    };
  }
}

@Injectable()
export class AlgoOrdersScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(
    private readonly algos: AlgoOrdersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  onApplicationBootstrap(): void {
    const ms = this.config.ALGO_POLL_MS;
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
      await this.algos.tick();
    } catch {
      // logged per order in tick()
    } finally {
      this.running = false;
    }
  }
}
