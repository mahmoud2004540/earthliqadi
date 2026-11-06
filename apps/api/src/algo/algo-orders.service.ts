import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { AlgoOrder } from '@prisma/client';
import type { AlgoOrderDto } from '@platform/shared';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { MarketsService, unitsOf } from '../trading/markets.service';
import { lotsToQuantity, priceToTicks, quantityToLots, ticksToPrice } from '../trading/order-math';
import { isTerminal } from '../trading/order-state';
import { OrdersService } from '../trading/orders.service';

const MAX_RUNNING = 20;
const MAX_SLICES = 1000;

/**
 * TWAP and iceberg orders (ADR-0020). The parent never holds funds itself:
 * each slice is an ordinary child order with its own hold and risk checks,
 * so a parent can never spend more than the account has.
 *
 * - TWAP: every `interval` seconds an IOC limit child for one slice at the
 *   parent's limit price, until the total is filled or all slices were sent.
 * - Iceberg: one visible GTC limit child at a time; when it ends, the next.
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

  async create(
    userId: string,
    input: {
      market: string;
      kind: 'twap' | 'iceberg';
      side: 'buy' | 'sell';
      quantity: string;
      sliceQuantity: string;
      price: string;
      intervalSeconds?: number;
      reduceOnly?: boolean;
    },
    ctx: RequestContext,
  ): Promise<AlgoOrderDto> {
    const market = await this.markets.require(input.market);
    if (market.status !== 'ACTIVE')
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'Market is halted');
    const u = unitsOf(market);
    const total = quantityToLots(input.quantity, u);
    const slice = quantityToLots(input.sliceQuantity, u, 'sliceQuantity');
    if (slice > total)
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'Slice is larger than the total',
      );
    if (slice < market.minQuantityLots)
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'Slice is below the market minimum',
      );
    if ((total + slice - 1n) / slice > BigInt(MAX_SLICES))
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        `At most ${MAX_SLICES} slices`,
      );
    if (input.reduceOnly && market.kind !== 'PERPETUAL')
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'reduceOnly is for perpetuals',
      );
    const running = await this.prisma.algoOrder.count({ where: { userId, status: 'RUNNING' } });
    if (running >= MAX_RUNNING)
      throw new AppError(
        HttpStatus.CONFLICT,
        'LIMIT_EXCEEDED',
        `At most ${MAX_RUNNING} running algo orders`,
      );
    const row = await this.prisma.algoOrder.create({
      data: {
        id: randomUUID(),
        userId,
        marketId: market.id,
        kind: input.kind.toUpperCase(),
        side: input.side === 'buy' ? 'BUY' : 'SELL',
        totalLots: total,
        sliceLots: slice,
        priceTicks: priceToTicks(input.price, u),
        intervalSeconds: input.intervalSeconds ?? null,
        reduceOnly: input.reduceOnly ?? false,
        nextAt: new Date(),
      },
    });
    await this.audit.recordSafe({
      action: 'trading.algo.created',
      outcome: 'SUCCESS',
      actorType: 'USER',
      actorUserId: userId,
      targetType: 'algo_order',
      targetId: row.id,
      context: ctx,
      metadata: { ...input },
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
      const open = await this.prisma.order.findMany({
        where: { algoOrderId: id, status: { in: ['PENDING_NEW', 'OPEN', 'PARTIALLY_FILLED'] } },
        select: { id: true },
      });
      await this.orders.cancelOwned(
        userId,
        open.map((o) => o.id),
      );
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

  private async filled(id: string): Promise<{ filled: bigint; activeChild: boolean }> {
    const children = await this.prisma.order.findMany({
      where: { algoOrderId: id },
      select: { filledLots: true, status: true },
    });
    return {
      filled: children.reduce((a, c) => a + c.filledLots, 0n),
      activeChild: children.some((c) => !isTerminal(c.status)),
    };
  }

  /** Advances one parent: sends the next slice when due, or finishes it. */
  async step(a: AlgoOrder, now = new Date()): Promise<void> {
    if (a.status !== 'RUNNING' || a.nextAt > now) return;
    const { filled, activeChild } = await this.filled(a.id);
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
    const market = await this.prisma.market.findUniqueOrThrow({
      where: { id: a.marketId },
      include: { baseAsset: true, quoteAsset: true },
    });
    const u = unitsOf(market);
    const lots = remaining < a.sliceLots ? remaining : a.sliceLots;
    // Claim the slice first so two workers can never send the same one.
    const claimed = await this.prisma.algoOrder.updateMany({
      where: { id: a.id, status: 'RUNNING', slicesSent: a.slicesSent },
      data: {
        slicesSent: { increment: 1 },
        nextAt: twap ? new Date(now.getTime() + a.intervalSeconds! * 1000) : now,
        updatedAt: now,
      },
    });
    if (claimed.count === 0) return;
    try {
      await this.orders.place(
        a.userId,
        {
          market: market.symbol,
          clientOrderId: `algo-${a.id}-${a.slicesSent + 1}`,
          side: a.side === 'BUY' ? 'buy' : 'sell',
          type: 'limit',
          timeInForce: twap ? 'ioc' : 'gtc',
          price: ticksToPrice(a.priceTicks, u),
          quantity: lotsToQuantity(lots, u),
          ...(a.reduceOnly ? { reduceOnly: true } : {}),
        },
        { requestId: `algo:${a.id}`, ipAddress: null, userAgent: null },
        { rateChecked: true, algoOrderId: a.id },
      );
    } catch (err) {
      const message = err instanceof AppError ? err.message : 'Child order failed';
      await this.prisma.algoOrder.update({
        where: { id: a.id },
        data: { status: 'FAILED', lastError: message.slice(0, 256), updatedAt: now },
      });
      if (!(err instanceof AppError)) this.logger.error({ err, algo: a.id }, 'Algo child failed');
    }
  }

  async tick(now = new Date()): Promise<void> {
    const due = await this.prisma.algoOrder.findMany({
      where: { status: 'RUNNING', nextAt: { lte: now } },
      orderBy: { nextAt: 'asc' },
      take: 200,
    });
    for (const a of due) await this.step(a, now);
  }

  async toDto(a: AlgoOrder): Promise<AlgoOrderDto> {
    const market = await this.prisma.market.findUniqueOrThrow({
      where: { id: a.marketId },
      include: { baseAsset: true, quoteAsset: true },
    });
    const u = unitsOf(market);
    const { filled } = await this.filled(a.id);
    return {
      id: a.id,
      market: market.symbol,
      kind: a.kind === 'TWAP' ? 'twap' : 'iceberg',
      side: a.side === 'BUY' ? 'buy' : 'sell',
      quantity: lotsToQuantity(a.totalLots, u),
      sliceQuantity: lotsToQuantity(a.sliceLots, u),
      filledQuantity: filled === 0n ? '0' : lotsToQuantity(filled, u),
      price: ticksToPrice(a.priceTicks, u),
      intervalSeconds: a.intervalSeconds,
      status: a.status.toLowerCase() as AlgoOrderDto['status'],
      slicesSent: a.slicesSent,
      lastError: a.lastError,
      createdAt: a.createdAt.toISOString(),
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
      // logged per order in step()
    } finally {
      this.running = false;
    }
  }
}
