import { metrics } from '../monitoring/metrics';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Prisma, type Position } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { toMinorUnits, type EntryRequest } from '../ledger/ledger-domain';
import { LedgerService, type LedgerActor } from '../ledger/ledger.service';
import { unitsOf, type MarketWithAssets } from '../trading/markets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../trading/orders.service';
import { parsePerpConfig, type IndexSource, type PerpConfig } from './perp-config';
import {
  allocateFunding,
  bankruptcyTicks,
  computeIndex,
  emaStep,
  fundingRate,
  isLiquidatable,
  markPrice,
  notionalAt,
  premiumRate,
  tierFor,
  type SourceSample,
} from './perp-math';
import { OPEN_ORDER_STATUSES, positionState } from './perp-orders';
import { currentMark } from './perp-prices';

const RISK_ACTOR: LedgerActor = { actorType: 'SYSTEM', requestId: 'perp-risk' };
/** Basis EMA period in samples. */
const BASIS_EMA_PERIOD = 60;

const AGGREGATOR_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/** Converts an oracle answer with `decimals` to quote minor units (rounded down). */
export function oracleToQuote(answer: bigint, decimals: number, quoteScale: number): bigint {
  return decimals >= quoteScale
    ? answer / 10n ** BigInt(decimals - quoteScale)
    : answer * 10n ** BigInt(quoteScale - decimals);
}

type SimulatedState = Record<string, { price: string; second: number }>;

/** Accumulates transfers and nets them per account (an entry lists each account once). */
class Net {
  private readonly net = new Map<string, bigint>();
  move(from: string, to: string, amount: bigint): void {
    if (amount <= 0n || from === to) return;
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

/** Deterministic step of a simulated (clearly labelled) random-walk source. */
export function simulatedStep(price: bigint, seed: string, second: number, volBps: number): bigint {
  const h = createHash('sha256').update(`${seed}:${second}`).digest();
  const r = BigInt((h.readUInt32BE(0) % (2 * volBps + 1)) - volBps);
  const next = (price * (10_000n + r)) / 10_000n;
  return next < 1n ? 1n : next;
}

/**
 * Perpetual risk engine (ADR-0011): samples index and mark prices, settles
 * funding at interval boundaries, and liquidates positions whose equity falls
 * below maintenance margin. Every money movement goes through the ledger.
 * Runs on all API instances; per-market work is serialised by row locks and
 * idempotency keys, so concurrent ticks cannot double-apply anything.
 */
@Injectable()
export class PerpRiskService {
  private readonly logger = new Logger(PerpRiskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private oracleClient: PublicClient | null = null;
  private readonly oracleDecimals = new Map<string, number>();

  /**
   * Chainlink-compatible feed. A failed read, a non-positive answer or an
   * incomplete round yields no price, so the index falls back to the other
   * sources or pauses (never a guessed value).
   */
  private async oracleSample(
    address: string,
    quoteScale: number,
    now: Date,
  ): Promise<SourceSample> {
    if (!this.config.CHAIN_RPC_URL) return { price: null, observedAt: now };
    this.oracleClient ??= createPublicClient({
      transport: http(this.config.CHAIN_RPC_URL),
      cacheTime: 0,
    }) as PublicClient;
    try {
      const feed = address as `0x${string}`;
      let decimals = this.oracleDecimals.get(address);
      if (decimals === undefined) {
        decimals = await this.oracleClient.readContract({
          address: feed,
          abi: AGGREGATOR_ABI,
          functionName: 'decimals',
        });
        this.oracleDecimals.set(address, decimals);
      }
      const [roundId, answer, , updatedAt, answeredInRound] = await this.oracleClient.readContract({
        address: feed,
        abi: AGGREGATOR_ABI,
        functionName: 'latestRoundData',
      });
      if (answer <= 0n || updatedAt === 0n || answeredInRound < roundId)
        return { price: null, observedAt: now };
      const price = oracleToQuote(answer, decimals, quoteScale);
      return { price: price > 0n ? price : null, observedAt: new Date(Number(updatedAt) * 1000) };
    } catch (err) {
      this.logger.warn({ feed: address, err: (err as Error).message }, 'PERP_ORACLE_READ_FAILED');
      return { price: null, observedAt: now };
    }
  }

  async perpMarkets(): Promise<MarketWithAssets[]> {
    return this.prisma.market.findMany({
      where: { kind: 'PERPETUAL' },
      include: { baseAsset: true, quoteAsset: true },
    });
  }

  /** One full risk pass over every perpetual market. */
  async tick(now = new Date()): Promise<void> {
    for (const market of await this.perpMarkets()) {
      const config = parsePerpConfig(market.perpConfig);
      await this.sample(market, config, now);
      await this.settleFunding(market, config, now);
      await this.liquidate(market, config, now);
      await this.cancelOcoSiblings(market);
      await this.cleanReduceOnly(market);
    }
  }

  // ------------------------------------------------------------- index/mark

  /** Best bid/ask of resting orders, in ticks (settled state). */
  private async topOfBook(marketId: string): Promise<{ bid: bigint | null; ask: bigint | null }> {
    const rows = await this.prisma.$queryRaw<{ bid: bigint | null; ask: bigint | null }[]>`
      SELECT max("price_ticks") FILTER (WHERE "side" = 'BUY') AS "bid",
             min("price_ticks") FILTER (WHERE "side" = 'SELL') AS "ask"
        FROM "orders"
       WHERE "market_id" = ${marketId}::uuid AND "status" IN ('OPEN', 'PARTIALLY_FILLED')
         AND "type" IN ('LIMIT', 'STOP_LIMIT')`;
    return rows[0] ?? { bid: null, ask: null };
  }

  private async spotSample(symbol: string, staleMs: number, now: Date): Promise<SourceSample> {
    const market = await this.prisma.market.findUnique({ where: { symbol } });
    if (!market || market.status !== 'ACTIVE') return { price: null, observedAt: now };
    const tick = toMinorUnits(market.tickSize);
    const { bid, ask } = await this.topOfBook(market.id);
    if (bid !== null && ask !== null) return { price: ((bid + ask) * tick) / 2n, observedAt: now };
    const last = await this.prisma.trade.findFirst({
      where: { marketId: market.id, executedAt: { gte: new Date(now.getTime() - staleMs) } },
      orderBy: { eventSeq: 'desc' },
    });
    return last
      ? { price: last.priceTicks * tick, observedAt: last.executedAt }
      : { price: null, observedAt: now };
  }

  async sample(market: MarketWithAssets, config: PerpConfig, now = new Date()): Promise<void> {
    const state = await this.prisma.perpMarketState.upsert({
      where: { marketId: market.id },
      create: { marketId: market.id },
      update: {},
    });
    const simulated = { ...(state.simulatedPrices as SimulatedState) };
    const second = Math.floor(now.getTime() / 1000);
    const staleMs = config.index.staleSeconds * 1000;
    const samples: SourceSample[] = [];
    for (const src of config.index.sources)
      samples.push(
        src.type === 'oracle'
          ? await this.oracleSample(src.address, market.quoteAsset.scale, now)
          : await this.sourceSample(src, simulated, second, staleMs, now),
      );

    const index = computeIndex(samples, now, {
      staleMs,
      outlierBps: config.index.outlierBps,
      minSources: config.index.minSources,
    });
    if (index.price === null) {
      // No reliable index: no sample is written, so the mark ages out and
      // funding, liquidations and new risk-increasing orders pause.
      this.logger.warn({ market: market.symbol, ...index, price: null }, 'PERP_INDEX_UNAVAILABLE');
      await this.prisma.perpMarketState.update({
        where: { marketId: market.id },
        data: { simulatedPrices: simulated },
      });
      return;
    }
    const u = unitsOf(market);
    const { bid, ask } = await this.topOfBook(market.id);
    const mid = bid !== null && ask !== null ? ((bid + ask) * u.tickSize) / 2n : null;
    const basisEma = emaStep(
      toMinorUnits(state.basisEma),
      mid === null ? 0n : mid - index.price,
      BASIS_EMA_PERIOD,
    );
    const mark = markPrice(index.price, basisEma, config.maxBasisBps);
    await this.prisma.$transaction([
      this.prisma.perpPriceSample.createMany({
        data: [
          {
            marketId: market.id,
            sampledAt: now,
            indexPrice: index.price.toString(),
            markPrice: mark.toString(),
            midPrice: mid?.toString() ?? null,
            premiumRate: mid === null ? null : premiumRate(mid, index.price),
            sourcesUsed: index.used,
          },
        ],
        skipDuplicates: true,
      }),
      this.prisma.perpMarketState.update({
        where: { marketId: market.id },
        data: { basisEma: basisEma.toString(), simulatedPrices: simulated },
      }),
    ]);
  }

  private async sourceSample(
    src: Exclude<IndexSource, { type: 'oracle' }>,
    simulated: SimulatedState,
    second: number,
    staleMs: number,
    now: Date,
  ): Promise<SourceSample> {
    if (src.type === 'spot') return this.spotSample(src.market, staleMs, now);
    const prev = simulated[src.seed];
    let price = prev ? BigInt(prev.price) : src.start;
    if (!prev || prev.second < second) {
      price = prev ? simulatedStep(price, src.seed, second, src.volatilityBps) : price;
      simulated[src.seed] = { price: price.toString(), second };
    }
    return { price, observedAt: now };
  }

  // ---------------------------------------------------------------- funding

  /** Settles funding once per interval boundary (idempotent per market and time). */
  async settleFunding(
    market: MarketWithAssets,
    config: PerpConfig,
    now = new Date(),
  ): Promise<boolean> {
    const intervalMs = config.fundingIntervalSeconds * 1000;
    const fundingTime = new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
    const state = await this.prisma.perpMarketState.findUnique({ where: { marketId: market.id } });
    if (!state) return false;
    if (state.lastFundingAt === null) {
      // First interval starts now; nobody is charged for time before the market was sampled.
      await this.prisma.perpMarketState.update({
        where: { marketId: market.id },
        data: { lastFundingAt: fundingTime },
      });
      return false;
    }
    if (fundingTime <= state.lastFundingAt) return false;
    const mark = await currentMark(this.prisma, market.id, config, now);
    if (mark === null) return false; // paused without a reliable mark

    const samples = await this.prisma.perpPriceSample.findMany({
      where: {
        marketId: market.id,
        sampledAt: { gt: state.lastFundingAt, lte: fundingTime },
        premiumRate: { not: null },
      },
      select: { premiumRate: true },
    });
    const rate = fundingRate(
      samples.map((s) => s.premiumRate!),
      config.fundingClampBps,
    );
    const u = unitsOf(market);
    let accounts: ReturnType<LedgerService['transactionalAccounts']> | null = null;
    let committed = false;
    await this.prisma.$transaction(
      async (tx) => {
        const st = await tx.$queryRaw<{ last_funding_at: Date | null }[]>`
          SELECT "last_funding_at" FROM "perp_market_state" WHERE "market_id" = ${market.id}::uuid FOR UPDATE`;
        if (st[0]?.last_funding_at && st[0].last_funding_at >= fundingTime) return; // another instance did it
        await tx.$queryRaw`
          SELECT "id" FROM "positions" WHERE "market_id" = ${market.id}::uuid AND "size_lots" <> 0
           ORDER BY "id" FOR UPDATE`;
        const positions = await tx.position.findMany({
          where: { marketId: market.id, sizeLots: { not: 0n } },
        });
        const alloc = allocateFunding(
          positions.map((p) => ({ id: p.id, size: p.sizeLots, margin: toMinorUnits(p.margin) })),
          mark,
          rate,
          u,
        );
        const acc = this.ledger.transactionalAccounts(tx);
        accounts = acc;
        const pool = await acc.id(market.quoteAssetId, 'PERP_FUNDING_POOL', null);
        const net = new Net();
        const byId = new Map(positions.map((p) => [p.id, p]));
        for (const t of alloc.transfers) {
          const p = byId.get(t.id)!;
          const margin = await acc.id(market.quoteAssetId, 'USER_MARGIN', p.userId);
          if (t.amount < 0n) net.move(margin, pool, -t.amount);
          else net.move(pool, margin, t.amount);
        }
        const key = `funding:${market.id}:${fundingTime.getTime()}`;
        const postings = net.postings();
        let entryId: bigint | null = null;
        if (postings.length >= 2) {
          const posted = await this.ledger.postBatchWithin(
            tx,
            [
              {
                type: 'FUNDING',
                idempotencyKey: key,
                description: `Funding ${market.symbol} ${fundingTime.toISOString()}`,
                postings,
              },
            ],
            RISK_ACTOR,
          );
          entryId = posted.get(key)!.id;
        }
        if (alloc.transfers.length > 0) {
          await tx.$executeRaw`
            UPDATE "positions" AS p
               SET "margin" = p."margin" + v."delta", "funding_pnl" = p."funding_pnl" + v."delta",
                   "updated_at" = now()
              FROM (SELECT unnest(${alloc.transfers.map((t) => t.id)}::uuid[]) AS "id",
                           unnest(${alloc.transfers.map((t) => t.amount.toString())}::numeric[]) AS "delta") AS v
             WHERE p."id" = v."id"`;
        }
        await tx.perpFundingRound.create({
          data: {
            id: randomUUID(),
            marketId: market.id,
            fundingTime,
            rate,
            markPrice: mark.toString(),
            collected: alloc.collected.toString(),
            distributed: alloc.distributed.toString(),
            positions: positions.length,
            journalEntryId: entryId,
          },
        });
        await tx.perpMarketState.update({
          where: { marketId: market.id },
          data: { lastFundingAt: fundingTime },
        });
        committed = true;
      },
      { timeout: 60_000 },
    );
    (accounts as ReturnType<LedgerService['transactionalAccounts']> | null)?.commit();
    return committed;
  }

  // ------------------------------------------------------------ liquidation

  private mmrFor(config: PerpConfig, notional: bigint): number {
    return (tierFor(config.tiers, notional) ?? config.tiers[config.tiers.length - 1]!).mmrBps;
  }

  /**
   * Two-step liquidation of each position below maintenance margin:
   * 1. flag it LIQUIDATING (new orders blocked) and cancel its open orders;
   * 2. once no order remains, submit an IOC reduce-only order for the whole
   *    position, protected at the bankruptcy price, so the fill can never
   *    realise more than the margin. Unfilled remainders retry next tick.
   * Positions that recover above maintenance before step 2 are released.
   */
  async liquidate(market: MarketWithAssets, config: PerpConfig, now = new Date()): Promise<number> {
    if (market.status !== 'ACTIVE') return 0;
    const mark = await currentMark(this.prisma, market.id, config, now);
    if (mark === null) return 0;
    const u = unitsOf(market);
    const positions = await this.prisma.position.findMany({
      where: { marketId: market.id, sizeLots: { not: 0n } },
    });
    let actions = 0;
    for (const p of positions) {
      const pos = positionState(p);
      const mmr = this.mmrFor(config, notionalAt(mark, pos.size, u, 'up'));
      const below = isLiquidatable(pos, mark, u, mmr);
      if (p.status === 'NORMAL' && !below) continue;
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "positions" WHERE "id" = ${p.id}::uuid FOR UPDATE`;
          const cur = await tx.position.findUniqueOrThrow({ where: { id: p.id } });
          if (cur.sizeLots === 0n) return;
          const st = positionState(cur);
          const stillBelow = isLiquidatable(st, mark, u, mmr);
          const open = await tx.order.findMany({
            where: {
              userId: cur.userId,
              marketId: market.id,
              status: { in: [...OPEN_ORDER_STATUSES] },
            },
          });
          if (cur.status === 'NORMAL') {
            if (!stillBelow) return;
            await tx.position.update({ where: { id: cur.id }, data: { status: 'LIQUIDATING' } });
            await this.audit.record(
              {
                action: 'perp.liquidation.started',
                outcome: 'SUCCESS',
                actorType: 'SYSTEM',
                targetType: 'position',
                targetId: cur.id,
                metadata: {
                  market: market.symbol,
                  userId: cur.userId,
                  size: cur.sizeLots.toString(),
                  margin: cur.margin.toString(),
                  mark: mark.toString(),
                  mmrBps: mmr,
                },
              },
              tx,
            );
            await this.cancelAll(tx, market.id, cur.userId, open);
            await this.notifications.notify(
              {
                userId: cur.userId,
                kind: 'perp.liquidation',
                title: `Your ${market.symbol} position is being liquidated`,
                body: 'Equity fell below the maintenance margin. Open orders on this market were cancelled and the position is being closed.',
                data: { market: market.symbol },
              },
              tx,
            );
            actions++;
            return;
          }
          // LIQUIDATING
          if (open.some((o) => o.isLiquidation)) return; // in flight
          if (open.length > 0) {
            await this.cancelAll(
              tx,
              market.id,
              cur.userId,
              open.filter((o) => !o.cancelRequestedAt),
            );
            return;
          }
          if (!stillBelow) {
            await tx.position.update({ where: { id: cur.id }, data: { status: 'NORMAL' } });
            actions++;
            return;
          }
          const orderId = randomUUID();
          const side = st.size > 0n ? 'SELL' : 'BUY';
          const protection = bankruptcyTicks(st, u);
          const lots = st.size > 0n ? st.size : -st.size;
          await tx.order.create({
            data: {
              id: orderId,
              userId: cur.userId,
              marketId: market.id,
              clientOrderId: `liq-${orderId}`,
              side,
              type: 'MARKET',
              timeInForce: 'IOC',
              priceTicks: protection,
              quantityLots: lots,
              holdAssetId: market.quoteAssetId,
              holdAmount: '0',
              lockedRemaining: '0',
              reduceOnly: true,
              isLiquidation: true,
              leverage: cur.leverage,
            },
          });
          await this.orders.enqueueSystemCommand(tx, market.id, 'place', {
            type: 'place',
            order_id: orderId,
            account: cur.userId,
            side: side === 'SELL' ? 'sell' : 'buy',
            kind: 'market',
            tif: 'ioc',
            price: Number(protection),
            stop_price: null,
            quantity: Number(lots),
          });
          await this.audit.record(
            {
              action: 'perp.liquidation.order_placed',
              outcome: 'SUCCESS',
              actorType: 'SYSTEM',
              targetType: 'position',
              targetId: cur.id,
              metadata: {
                market: market.symbol,
                orderId,
                quantityLots: lots.toString(),
                protectionTicks: protection.toString(),
                mark: mark.toString(),
              },
            },
            tx,
          );
          actions++;
        },
        { timeout: 30_000 },
      );
    }
    return actions;
  }

  private async cancelAll(
    tx: Prisma.TransactionClient,
    marketId: string,
    userId: string,
    orders: { id: string; cancelRequestedAt: Date | null }[],
  ): Promise<void> {
    for (const o of orders) {
      if (o.cancelRequestedAt) continue;
      await this.orders.enqueueSystemCommand(tx, marketId, 'cancel', {
        type: 'cancel',
        order_id: o.id,
        account: userId,
      });
      await tx.order.update({ where: { id: o.id }, data: { cancelRequestedAt: new Date() } });
    }
  }

  /**
   * One-cancels-the-other: once a member of a take-profit / stop-loss pair has
   * triggered (or ended), the members still waiting for their trigger are
   * cancelled.
   */
  async cancelOcoSiblings(market: MarketWithAssets): Promise<number> {
    const rows = await this.prisma.$queryRaw<
      { id: string; user_id: string; cancel_requested_at: Date | null }[]
    >`
      SELECT w."id", w."user_id", w."cancel_requested_at" FROM "orders" w
       WHERE w."market_id" = ${market.id}::uuid AND w."oco_group_id" IS NOT NULL
         AND w."status" = 'PENDING_TRIGGER' AND w."cancel_requested_at" IS NULL
         AND EXISTS (SELECT 1 FROM "orders" o
                      WHERE o."oco_group_id" = w."oco_group_id" AND o."id" <> w."id"
                        AND o."status" NOT IN ('PENDING_NEW', 'PENDING_TRIGGER'))`;
    for (const r of rows) {
      await this.prisma.$transaction(async (tx) => {
        await this.cancelAll(tx, market.id, r.user_id, [
          { id: r.id, cancelRequestedAt: r.cancel_requested_at },
        ]);
      });
    }
    return rows.length;
  }

  /**
   * Reduce-only orders that no longer fit the position (it shrank or flipped
   * through other fills) are cancelled, so they cannot open a position.
   */
  async cleanReduceOnly(market: MarketWithAssets): Promise<number> {
    const open = await this.prisma.order.findMany({
      where: {
        marketId: market.id,
        reduceOnly: true,
        isLiquidation: false,
        cancelRequestedAt: null,
        status: { in: [...OPEN_ORDER_STATUSES] },
      },
    });
    if (open.length === 0) return 0;
    const positions = new Map<string, Position>(
      (
        await this.prisma.position.findMany({
          where: { marketId: market.id, userId: { in: [...new Set(open.map((o) => o.userId))] } },
        })
      ).map((p) => [p.userId, p]),
    );
    let cancelled = 0;
    const byUser = new Map<string, typeof open>();
    for (const o of open) byUser.set(o.userId, [...(byUser.get(o.userId) ?? []), o]);
    for (const [userId, orders] of byUser) {
      const size = positions.get(userId)?.sizeLots ?? 0n;
      const closingSide = size > 0n ? 'SELL' : size < 0n ? 'BUY' : null;
      // A take-profit / stop-loss pair can only ever execute once: count it once.
      const groups = new Map<string, bigint>();
      let remaining = 0n;
      for (const o of orders.filter((x) => x.side === closingSide)) {
        const left = o.quantityLots - o.filledLots;
        if (o.ocoGroupId) {
          const prev = groups.get(o.ocoGroupId) ?? 0n;
          groups.set(o.ocoGroupId, left > prev ? left : prev);
        } else remaining += left;
      }
      for (const v of groups.values()) remaining += v;
      const abs = size < 0n ? -size : size;
      const invalid = orders.filter((o) => o.side !== closingSide || remaining > abs);
      if (invalid.length === 0) continue;
      await this.prisma.$transaction(async (tx) => {
        await this.cancelAll(tx, market.id, userId, invalid);
      });
      cancelled += invalid.length;
    }
    return cancelled;
  }
}

/** Runs the risk engine on a fixed interval; errors are logged and retried. */
@Injectable()
export class PerpRiskScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PerpRiskScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly risk: PerpRiskService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const ms = this.config.PERP_RISK_POLL_MS;
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
      await this.risk.tick();
    } catch (err) {
      metrics.riskTickFailures.inc();
      this.logger.error(
        { err: err instanceof Prisma.PrismaClientKnownRequestError ? err.code : err },
        'PERP_RISK_TICK_FAILED: retrying next tick',
      );
    } finally {
      this.running = false;
    }
  }
}
