import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CANDLE_INTERVAL_SECONDS,
  type BookLevel,
  type CandleDto,
  type CandleInterval,
  type MarketDataStatus,
  type OrderBookDto,
  type PublicTradeDto,
  type TickerDto,
} from '@platform/shared';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { MarketsService, unitsOf, type MarketWithAssets } from '../trading/markets.service';
import { formatAmountTrimmed } from '@platform/shared';
import { lotsToQuantity, ticksToPrice } from '../trading/order-math';
import { toMinorUnits } from '../ledger/ledger-domain';

/** Commands or events older than this without being processed mark the market as delayed. */
export const STALE_AFTER_MS = 2_000;

type Tx = Prisma.TransactionClient;

/**
 * Read models derived ONLY from settled state (ADR-0009). Every snapshot is read
 * in one REPEATABLE READ transaction and tagged with the settlement sequence.
 */
@Injectable()
export class MarketDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly markets: MarketsService,
  ) {}

  /** Settlement sequence per market id (cheap; used by the gateway to detect changes). */
  async sequences(): Promise<Map<string, bigint>> {
    const rows = await this.prisma.settlementState.findMany({
      select: { marketId: true, lastEventSeq: true },
    });
    return new Map(rows.map((r) => [r.marketId, r.lastEventSeq]));
  }

  private snapshot<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  private async seqOf(tx: Tx, marketId: string): Promise<bigint> {
    const s = await tx.settlementState.findUnique({ where: { marketId } });
    return s?.lastEventSeq ?? 0n;
  }

  async status(tx: Tx, market: { id: string; status: string }): Promise<MarketDataStatus> {
    const [row] = await tx.$queryRaw<
      { backlog: bigint; lag: bigint; oldest_command: Date | null; oldest_event: Date | null }[]
    >`
      SELECT m."next_command_seq" - COALESCE(e."last_command_seq", 0) AS "backlog",
             COALESCE(e."last_event_seq", 0) - COALESCE(s."last_event_seq", 0) AS "lag",
             (SELECT min(c."created_at") FROM "engine_commands" c
               WHERE c."market_id" = m."id" AND c."seq" > COALESCE(e."last_command_seq", 0)) AS "oldest_command",
             (SELECT min(ev."created_at") FROM "engine_events" ev
               WHERE ev."market_id" = m."id" AND ev."seq" > COALESCE(s."last_event_seq", 0)) AS "oldest_event"
        FROM "markets" m
        LEFT JOIN "engine_market_state" e ON e."market_id" = m."id"
        LEFT JOIN "settlement_state" s ON s."market_id" = m."id"
       WHERE m."id" = ${market.id}::uuid`;
    const now = Date.now();
    const stale = (d: Date | null) => d !== null && now - d.getTime() > STALE_AFTER_MS;
    const state =
      market.status === 'HALTED'
        ? 'halted'
        : stale(row?.oldest_command ?? null) || stale(row?.oldest_event ?? null)
          ? 'delayed'
          : 'live';
    return {
      state,
      engineBacklog: Number(row?.backlog ?? 0n),
      settlementLag: Number(row?.lag ?? 0n),
    };
  }

  private async levels(
    tx: Tx,
    market: MarketWithAssets,
    depth: number,
  ): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
    const u = unitsOf(market);
    const rows = await tx.$queryRaw<{ side: 'BUY' | 'SELL'; price: bigint; qty: bigint }[]>`
      SELECT "side", "price_ticks" AS "price", SUM("quantity_lots" - "filled_lots")::bigint AS "qty"
        FROM "orders"
       WHERE "market_id" = ${market.id}::uuid
         AND "status" IN ('OPEN', 'PARTIALLY_FILLED')
         AND "time_in_force" IN ('GTC', 'POST_ONLY')
         AND "price_ticks" IS NOT NULL
       GROUP BY "side", "price_ticks"
      HAVING SUM("quantity_lots" - "filled_lots") > 0`;
    const fmt = (r: { price: bigint; qty: bigint }): BookLevel => [
      ticksToPrice(r.price, u),
      lotsToQuantity(r.qty, u),
    ];
    const bids = rows.filter((r) => r.side === 'BUY').sort((a, b) => (a.price > b.price ? -1 : 1));
    const asks = rows.filter((r) => r.side === 'SELL').sort((a, b) => (a.price < b.price ? -1 : 1));
    return { bids: bids.slice(0, depth).map(fmt), asks: asks.slice(0, depth).map(fmt) };
  }

  async book(symbol: string, depth = 50): Promise<OrderBookDto> {
    const market = await this.markets.require(symbol);
    return this.snapshot(async (tx) => {
      const [seq, levels, status] = await Promise.all([
        this.seqOf(tx, market.id),
        this.levels(tx, market, depth),
        this.status(tx, market),
      ]);
      return { market: market.symbol, seq: seq.toString(), ...levels, status };
    });
  }

  async trades(symbol: string, limit = 50, afterSeq?: bigint): Promise<PublicTradeDto[]> {
    const market = await this.markets.require(symbol);
    const u = unitsOf(market);
    const rows = await this.prisma.trade.findMany({
      where: {
        marketId: market.id,
        ...(afterSeq !== undefined ? { eventSeq: { gt: afterSeq } } : {}),
      },
      orderBy: { eventSeq: 'desc' },
      take: limit,
    });
    return rows.map((t) => ({
      seq: t.eventSeq.toString(),
      price: ticksToPrice(t.priceTicks, u),
      quantity: lotsToQuantity(t.quantityLots, u),
      takerSide: t.takerSide === 'BUY' ? 'buy' : 'sell',
      executedAt: t.executedAt.toISOString(),
    }));
  }

  async candles(
    symbol: string,
    interval: CandleInterval,
    limit = 200,
  ): Promise<{ seq: string; data: CandleDto[] }> {
    const market = await this.markets.require(symbol);
    const u = unitsOf(market);
    const seconds = CANDLE_INTERVAL_SECONDS[interval];
    const from = new Date(Date.now() - seconds * 1000 * limit);
    return this.snapshot(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          bucket: Date;
          open: bigint;
          high: bigint;
          low: bigint;
          close: bigint;
          lots: bigint;
          quote: Prisma.Decimal;
          n: number;
        }[]
      >`
        SELECT date_bin(make_interval(secs => ${seconds}), "executed_at", TIMESTAMPTZ '2000-01-01 00:00:00+00') AS "bucket",
               (array_agg("price_ticks" ORDER BY "event_seq"))[1] AS "open",
               max("price_ticks") AS "high",
               min("price_ticks") AS "low",
               (array_agg("price_ticks" ORDER BY "event_seq" DESC))[1] AS "close",
               sum("quantity_lots")::bigint AS "lots",
               sum("quote_amount") AS "quote",
               count(*)::int AS "n"
          FROM "trades"
         WHERE "market_id" = ${market.id}::uuid AND "executed_at" >= ${from}
         GROUP BY 1
         ORDER BY 1 ASC`;
      const seq = await this.seqOf(tx, market.id);
      return {
        seq: seq.toString(),
        data: rows.slice(-limit).map((r) => ({
          time: r.bucket.toISOString(),
          open: ticksToPrice(r.open, u),
          high: ticksToPrice(r.high, u),
          low: ticksToPrice(r.low, u),
          close: ticksToPrice(r.close, u),
          volume: lotsToQuantity(r.lots, u),
          quoteVolume: formatAmountTrimmed(toMinorUnits(r.quote), u.quoteScale),
          trades: r.n,
        })),
      };
    });
  }

  async ticker(symbol: string): Promise<TickerDto> {
    return this.tickerFor(await this.markets.require(symbol));
  }

  async tickers(): Promise<TickerDto[]> {
    const markets = await this.markets.list();
    return Promise.all(markets.map((m) => this.tickerFor(m)));
  }

  private tickerFor(market: MarketWithAssets): Promise<TickerDto> {
    const u = unitsOf(market);
    const since = new Date(Date.now() - 24 * 3600_000);
    return this.snapshot(async (tx) => {
      const [stats] = await tx.$queryRaw<
        {
          open: bigint | null;
          high: bigint | null;
          low: bigint | null;
          lots: bigint | null;
          quote: Prisma.Decimal | null;
        }[]
      >`
        SELECT (array_agg("price_ticks" ORDER BY "event_seq"))[1] AS "open",
               max("price_ticks") AS "high", min("price_ticks") AS "low",
               sum("quantity_lots")::bigint AS "lots", sum("quote_amount") AS "quote"
          FROM "trades" WHERE "market_id" = ${market.id}::uuid AND "executed_at" >= ${since}`;
      const last = await tx.trade.findFirst({
        where: { marketId: market.id },
        orderBy: { eventSeq: 'desc' },
      });
      const [seq, levels, status] = await Promise.all([
        this.seqOf(tx, market.id),
        this.levels(tx, market, 1),
        this.status(tx, market),
      ]);
      const open = stats?.open ?? null;
      const lastTicks = last?.priceTicks ?? null;
      return {
        market: market.symbol,
        paper: market.isPaper,
        seq: seq.toString(),
        last: lastTicks === null ? null : ticksToPrice(lastTicks, u),
        open24h: open === null ? null : ticksToPrice(open, u),
        high24h: stats?.high == null ? null : ticksToPrice(stats.high, u),
        low24h: stats?.low == null ? null : ticksToPrice(stats.low, u),
        change24hPct:
          open !== null && lastTicks !== null && open > 0n ? percentChange(open, lastTicks) : null,
        volume24h: lotsToQuantity(stats?.lots ?? 0n, u),
        quoteVolume24h: formatAmountTrimmed(
          stats?.quote ? toMinorUnits(stats.quote) : 0n,
          u.quoteScale,
        ),
        bestBid: levels.bids[0]?.[0] ?? null,
        bestAsk: levels.asks[0]?.[0] ?? null,
        status,
      };
    });
  }
}

/** Exact percentage with 2 decimals, truncated toward zero (no floats). */
export function percentChange(from: bigint, to: bigint): string {
  const bps = ((to - from) * 10_000n) / from; // hundredths of a percent
  const negative = bps < 0n;
  const abs = negative ? -bps : bps;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
