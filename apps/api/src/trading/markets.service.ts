import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type Asset, type Market } from '@prisma/client';
import { formatAmountTrimmed, parseAmount, type MarketDto } from '@platform/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import type { LedgerActor } from '../ledger/ledger.service';
import { toMinorUnits } from '../ledger/ledger-domain';
import { lotsToQuantity, quantityToLots, quotePerTickLot, type MarketUnits } from './order-math';

export type MarketWithAssets = Market & { baseAsset: Asset; quoteAsset: Asset };

export function unitsOf(m: MarketWithAssets): MarketUnits {
  return {
    baseScale: m.baseAsset.scale,
    quoteScale: m.quoteAsset.scale,
    tickSize: toMinorUnits(m.tickSize),
    lotSize: toMinorUnits(m.lotSize),
  };
}

@Injectable()
export class MarketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    input: {
      base: string;
      quote: string;
      tickSize: string;
      lotSize: string;
      minQuantity?: string;
      makerFeeBps: number;
      takerFeeBps: number;
    },
    actor: LedgerActor,
  ): Promise<MarketWithAssets> {
    if (input.base === input.quote) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'Base and quote assets must differ',
      );
    }
    const [base, quote] = await Promise.all([
      this.prisma.asset.findUnique({ where: { code: input.base } }),
      this.prisma.asset.findUnique({ where: { code: input.quote } }),
    ]);
    if (!base || !quote) throw AppError.notFound('Unknown base or quote asset');
    if (base.isPaper !== quote.isPaper) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'A market cannot combine a paper asset with a real asset',
      );
    }
    if (base.status !== 'ACTIVE' || quote.status !== 'ACTIVE') {
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'Both assets must be active');
    }
    let tickSize: bigint;
    let lotSize: bigint;
    try {
      tickSize = parseAmount(input.tickSize, quote.scale);
      lotSize = parseAmount(input.lotSize, base.scale);
    } catch (err) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', (err as Error).message);
    }
    const units: MarketUnits = {
      baseScale: base.scale,
      quoteScale: quote.scale,
      tickSize,
      lotSize,
    };
    quotePerTickLot(units); // throws unless every tick·lot is a whole number of quote minor units
    const minQuantityLots = input.minQuantity
      ? quantityToLots(input.minQuantity, units, 'minQuantity')
      : 1n;
    const symbol = `${base.code}-${quote.code}`;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const market = await tx.market.create({
          data: {
            symbol,
            baseAssetId: base.id,
            quoteAssetId: quote.id,
            tickSize: tickSize.toString(),
            lotSize: lotSize.toString(),
            minQuantityLots,
            makerFeeBps: input.makerFeeBps,
            takerFeeBps: input.takerFeeBps,
            isPaper: base.isPaper,
          },
          include: { baseAsset: true, quoteAsset: true },
        });
        await this.audit.record(
          {
            action: 'trading.market.created',
            outcome: 'SUCCESS',
            actorType: actor.actorType,
            actorUserId: actor.actorUserId ?? null,
            targetType: 'market',
            targetId: symbol,
            context: { requestId: actor.requestId ?? null },
            metadata: { ...input },
          },
          tx,
        );
        return market;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', `Market ${symbol} already exists`);
      }
      throw err;
    }
  }

  async setStatus(
    symbol: string,
    status: 'ACTIVE' | 'HALTED',
    actor: LedgerActor,
  ): Promise<MarketWithAssets> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.market.findUnique({ where: { symbol } });
      if (!existing) throw AppError.notFound('Market not found');
      const market = await tx.market.update({
        where: { symbol },
        data: { status },
        include: { baseAsset: true, quoteAsset: true },
      });
      await this.audit.record(
        {
          action: 'trading.market.status_changed',
          outcome: 'SUCCESS',
          actorType: actor.actorType,
          actorUserId: actor.actorUserId ?? null,
          targetType: 'market',
          targetId: symbol,
          context: { requestId: actor.requestId ?? null },
          metadata: { from: existing.status, to: status },
        },
        tx,
      );
      return market;
    });
  }

  list(): Promise<MarketWithAssets[]> {
    return this.prisma.market.findMany({
      include: { baseAsset: true, quoteAsset: true },
      orderBy: { symbol: 'asc' },
    });
  }

  async require(symbol: string): Promise<MarketWithAssets> {
    const market = await this.prisma.market.findUnique({
      where: { symbol },
      include: { baseAsset: true, quoteAsset: true },
    });
    if (!market) throw AppError.notFound(`Unknown market ${symbol}`);
    return market;
  }

  toDto(m: MarketWithAssets): MarketDto {
    const u = unitsOf(m);
    return {
      symbol: m.symbol,
      base: m.baseAsset.code,
      quote: m.quoteAsset.code,
      tickSize: formatAmountTrimmed(u.tickSize, u.quoteScale),
      lotSize: formatAmountTrimmed(u.lotSize, u.baseScale),
      minQuantity: lotsToQuantity(m.minQuantityLots, u),
      makerFeeBps: m.makerFeeBps,
      takerFeeBps: m.takerFeeBps,
      status: m.status,
      paper: m.isPaper,
    };
  }
}
