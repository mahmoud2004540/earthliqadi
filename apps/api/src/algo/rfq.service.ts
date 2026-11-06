import { HttpStatus, Injectable } from '@nestjs/common';
import type { RfqRequest } from '@prisma/client';
import type { RfqDto } from '@platform/shared';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { parsePerpConfig } from '../perps/perp-config';
import { currentMark } from '../perps/perp-prices';
import { MarketsService, unitsOf, type MarketWithAssets } from '../trading/markets.service';
import { lotsToQuantity, priceToTicks, quantityToLots, ticksToPrice } from '../trading/order-math';
import { OrdersService } from '../trading/orders.service';

const REQUEST_TTL_MS = 60_000;
const QUOTE_TTL_MS = 15_000;
/** Spot block prices must be within this distance of the reference (mid or last). */
const SPOT_BAND_BPS = 500n;

const conflict = (m: string) => new AppError(HttpStatus.CONFLICT, 'CONFLICT', m);
const invalid = (m: string) => new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', m);

/**
 * Request for quote and block trades (ADR-0020). A trader asks registered
 * makers for a price on a size; accepting a quote executes both sides as one
 * engine `block` command: no book impact, no stop triggers, printed to the
 * tape as a normal trade and settled by the normal path. Prices must lie
 * inside a band around the mark (perpetuals) or the book (spot).
 */
@Injectable()
export class RfqService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly markets: MarketsService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
  ) {}

  private async engineAccount(userId: string): Promise<string> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return u.parentUserId ?? u.id;
  }

  async registerMaker(staffId: string, userId: string, ctx: RequestContext): Promise<void> {
    await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.prisma.rfqMaker.upsert({
      where: { userId },
      create: { userId, registeredBy: staffId },
      update: { revokedAt: null, registeredBy: staffId },
    });
    await this.audit.record({
      action: 'rfq.maker.registered',
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: staffId,
      targetType: 'user',
      targetId: userId,
      context: ctx,
    });
  }

  private async requireMaker(userId: string) {
    const m = await this.prisma.rfqMaker.findUnique({ where: { userId } });
    if (!m || m.revokedAt) throw AppError.forbidden('Only registered RFQ makers can quote');
  }

  async request(
    userId: string,
    input: { market: string; side: 'buy' | 'sell'; quantity: string },
  ): Promise<RfqDto> {
    const market = await this.markets.require(input.market);
    if (market.status !== 'ACTIVE') throw conflict('Market is halted');
    const lots = quantityToLots(input.quantity, unitsOf(market));
    const row = await this.prisma.rfqRequest.create({
      data: {
        id: randomUUID(),
        userId,
        marketId: market.id,
        side: input.side === 'buy' ? 'BUY' : 'SELL',
        quantityLots: lots,
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
      },
    });
    return this.toDto(row, market);
  }

  /** Open requests a maker may quote (never its own group's). */
  async open(makerId: string): Promise<RfqDto[]> {
    await this.requireMaker(makerId);
    const group = await this.engineAccount(makerId);
    const rows = await this.prisma.rfqRequest.findMany({
      where: { status: 'OPEN', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const out: RfqDto[] = [];
    for (const r of rows) {
      if ((await this.engineAccount(r.userId)) === group) continue;
      out.push(await this.toDto(r, await this.marketOf(r), false));
    }
    return out;
  }

  private marketOf(r: RfqRequest): Promise<MarketWithAssets> {
    return this.prisma.market.findUniqueOrThrow({
      where: { id: r.marketId },
      include: { baseAsset: true, quoteAsset: true },
    });
  }

  /** The price must be inside the band around the mark (perps) or the book (spot). */
  private async checkBand(market: MarketWithAssets, priceTicks: bigint): Promise<void> {
    const u = unitsOf(market);
    const price = priceTicks * u.tickSize;
    let reference: bigint | null;
    let bandBps = SPOT_BAND_BPS;
    if (market.kind === 'PERPETUAL') {
      const cfg = parsePerpConfig(market.perpConfig);
      reference = await currentMark(this.prisma, market.id, cfg);
      bandBps = BigInt(cfg.priceBandBps);
    } else {
      const top = await this.prisma.$queryRaw<{ bid: bigint | null; ask: bigint | null }[]>`
        SELECT max("price_ticks") FILTER (WHERE "side" = 'BUY') AS "bid",
               min("price_ticks") FILTER (WHERE "side" = 'SELL') AS "ask"
          FROM "orders" WHERE "market_id" = ${market.id}::uuid
           AND "status" IN ('OPEN', 'PARTIALLY_FILLED') AND "type" = 'LIMIT'`;
      const { bid, ask } = top[0] ?? { bid: null, ask: null };
      if (bid !== null && ask !== null) reference = ((bid + ask) / 2n) * u.tickSize;
      else {
        const last = await this.prisma.trade.findFirst({
          where: { marketId: market.id },
          orderBy: { eventSeq: 'desc' },
        });
        reference = last ? last.priceTicks * u.tickSize : null;
      }
    }
    if (reference === null) throw conflict('No reference price right now; block trades are paused');
    const band = (reference * bandBps) / 10_000n;
    if (price > reference + band || price < reference - band)
      throw invalid(`Block price must be within ${Number(bandBps) / 100}% of the reference price`);
  }

  async quote(makerId: string, requestId: string, priceText: string) {
    await this.requireMaker(makerId);
    const r = await this.prisma.rfqRequest.findUnique({ where: { id: requestId } });
    if (!r || r.status !== 'OPEN' || r.expiresAt <= new Date())
      throw AppError.notFound('Request not found or no longer open');
    if ((await this.engineAccount(r.userId)) === (await this.engineAccount(makerId)))
      throw AppError.forbidden('You cannot quote your own request');
    const market = await this.marketOf(r);
    const priceTicks = priceToTicks(priceText, unitsOf(market));
    await this.checkBand(market, priceTicks);
    const expiresAt = new Date(Date.now() + QUOTE_TTL_MS);
    const q = await this.prisma.rfqQuote.upsert({
      where: { requestId_makerUserId: { requestId, makerUserId: makerId } },
      create: { id: randomUUID(), requestId, makerUserId: makerId, priceTicks, expiresAt },
      update: { priceTicks, expiresAt },
    });
    return {
      id: q.id,
      price: ticksToPrice(priceTicks, unitsOf(market)),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async get(userId: string, id: string): Promise<RfqDto> {
    const r = await this.prisma.rfqRequest.findFirst({ where: { id, userId } });
    if (!r) throw AppError.notFound('Request not found');
    return this.toDto(r, await this.marketOf(r));
  }

  async cancel(userId: string, id: string): Promise<RfqDto> {
    await this.prisma.rfqRequest.updateMany({
      where: { id, userId, status: 'OPEN' },
      data: { status: 'CANCELLED' },
    });
    return this.get(userId, id);
  }

  /** Executes the quote: both orders are funded and sent as one engine block command. */
  async accept(
    userId: string,
    requestId: string,
    quoteId: string,
    ctx: RequestContext,
  ): Promise<{ buyOrderId: string; sellOrderId: string }> {
    const r = await this.prisma.rfqRequest.findFirst({ where: { id: requestId, userId } });
    if (!r) throw AppError.notFound('Request not found');
    const q = await this.prisma.rfqQuote.findFirst({ where: { id: quoteId, requestId } });
    if (!q) throw AppError.notFound('Quote not found');
    if (q.expiresAt <= new Date()) throw conflict('This quote has expired');
    const market = await this.marketOf(r);
    await this.checkBand(market, q.priceTicks); // the reference may have moved
    const u = unitsOf(market);
    const price = ticksToPrice(q.priceTicks, u);
    const quantity = lotsToQuantity(r.quantityLots, u);
    const requesterBuys = r.side === 'BUY';
    const ids = await this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.rfqRequest.updateMany({
          where: { id: requestId, status: 'OPEN', expiresAt: { gt: new Date() } },
          data: { status: 'FILLED', acceptedQuoteId: quoteId },
        });
        if (claimed.count === 0) throw conflict('This request is no longer open');
        const leg = async (owner: string, side: 'buy' | 'sell', tag: string) => {
          const within: { tx: typeof tx; payload?: Record<string, unknown> } = { tx };
          const { order } = await this.orders.place(
            owner,
            {
              market: market.symbol,
              clientOrderId: `rfq-${requestId}-${tag}`,
              side,
              type: 'limit',
              timeInForce: 'fok',
              price,
              quantity,
            },
            ctx,
            { rateChecked: true, within },
          );
          return { id: order.id, payload: within.payload! };
        };
        const mine = await leg(userId, requesterBuys ? 'buy' : 'sell', 'taker');
        const theirs = await leg(q.makerUserId, requesterBuys ? 'sell' : 'buy', 'maker');
        const [buy, sell] = requesterBuys ? [mine, theirs] : [theirs, mine];
        await this.orders.enqueueSystemCommand(tx, market.id, 'block', {
          type: 'block',
          buy: buy.payload,
          sell: sell.payload,
          maker: requesterBuys ? 'sell' : 'buy',
        });
        return { buyOrderId: buy.id, sellOrderId: sell.id };
      },
      { timeout: 30_000 },
    );
    await this.audit.recordSafe({
      action: 'rfq.block.executed',
      outcome: 'SUCCESS',
      actorType: 'USER',
      actorUserId: userId,
      targetType: 'rfq_request',
      targetId: requestId,
      context: ctx,
      metadata: { quoteId, maker: q.makerUserId, price, quantity },
    });
    return ids;
  }

  private async toDto(r: RfqRequest, market: MarketWithAssets, withQuotes = true): Promise<RfqDto> {
    const u = unitsOf(market);
    const quotes = withQuotes
      ? await this.prisma.rfqQuote.findMany({
          where: { requestId: r.id, expiresAt: { gt: new Date() } },
          orderBy: { priceTicks: r.side === 'BUY' ? 'asc' : 'desc' },
        })
      : [];
    const expired = r.status === 'OPEN' && r.expiresAt <= new Date();
    return {
      id: r.id,
      market: market.symbol,
      side: r.side === 'BUY' ? 'buy' : 'sell',
      quantity: lotsToQuantity(r.quantityLots, u),
      status: expired ? 'expired' : (r.status.toLowerCase() as RfqDto['status']),
      expiresAt: r.expiresAt.toISOString(),
      quotes: quotes.map((q) => ({
        id: q.id,
        price: ticksToPrice(q.priceTicks, u),
        expiresAt: q.expiresAt.toISOString(),
      })),
    };
  }
}
