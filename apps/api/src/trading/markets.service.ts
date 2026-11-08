import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, type Asset, type Market } from '@prisma/client';
import {
  formatAmountTrimmed,
  parseAmount,
  type MarketDto,
  type PerpConfigInput,
} from '@platform/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import type { LedgerActor } from '../ledger/ledger.service';
import { toMinorUnits } from '../ledger/ledger-domain';
import {
  buildPerpConfig,
  parsePerpConfig,
  perpInfoDto,
  withOpenInterestCap,
} from '../perps/perp-config';
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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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
      kind?: 'spot' | 'perpetual';
      perp?: PerpConfigInput;
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
    if (base.isPaper || quote.isPaper) {
      // Also enforced by the database (markets_no_new_paper).
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'Paper trading is retired');
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
    const perpetual = input.kind === 'perpetual';
    if (perpetual !== (input.perp !== undefined)) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'Perpetual markets need a perp configuration; spot markets must not have one',
      );
    }
    const testEnv = this.config.DEPLOY_ENV === 'local' || this.config.DEPLOY_ENV === 'ci';
    for (const src of input.perp?.index.sources ?? []) {
      if (src.type === 'simulated' && !testEnv) {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_FAILED',
          'Simulated index sources are for automated tests only (local/ci)',
        );
      }
      if (src.type === 'oracle' && !this.config.CHAIN_RPC_URL) {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_FAILED',
          'Oracle index sources need CHAIN_RPC_URL',
        );
      }
    }
    if (perpetual && quote.chainTokenAddress === null && !testEnv) {
      // Margin, PnL and funding settle in the quote asset, which must be held in the vault.
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'Perpetual markets need a vault-backed quote asset',
      );
    }
    const perpConfig = perpetual ? buildPerpConfig(input.perp!, quote.scale) : undefined;
    if (perpetual) {
      for (const src of input.perp!.index.sources) {
        if (src.type !== 'spot') continue;
        const ref = await this.prisma.market.findUnique({ where: { symbol: src.market } });
        if (
          !ref ||
          ref.kind !== 'SPOT' ||
          ref.baseAssetId !== base.id ||
          ref.quoteAssetId !== quote.id
        ) {
          throw new AppError(
            HttpStatus.BAD_REQUEST,
            'VALIDATION_FAILED',
            `Index source ${src.market} must be an existing spot market with the same base and quote assets`,
          );
        }
      }
    }
    const symbol = `${base.code}-${quote.code}${perpetual ? '-PERP' : ''}`;

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
            kind: perpetual ? 'PERPETUAL' : 'SPOT',
            ...(perpConfig ? { perpConfig } : {}),
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

  /** Sets or removes a perpetual market's open-interest cap (ADR-0032). Audited. */
  async setOpenInterestCap(
    symbol: string,
    maxOpenInterest: string | null,
    actor: LedgerActor,
  ): Promise<MarketWithAssets> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.market.findUnique({
        where: { symbol },
        include: { quoteAsset: true },
      });
      if (!existing) throw AppError.notFound('Market not found');
      if (existing.kind !== 'PERPETUAL')
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_FAILED',
          'Open-interest caps apply to perpetual markets only',
        );
      const before = parsePerpConfig(existing.perpConfig).maxOpenInterest;
      const market = await tx.market.update({
        where: { symbol },
        data: {
          perpConfig: withOpenInterestCap(
            existing.perpConfig,
            maxOpenInterest,
            existing.quoteAsset.scale,
          ),
        },
        include: { baseAsset: true, quoteAsset: true },
      });
      await this.audit.record(
        {
          action: 'trading.market.open_interest_cap_changed',
          outcome: 'SUCCESS',
          actorType: actor.actorType,
          actorUserId: actor.actorUserId ?? null,
          targetType: 'market',
          targetId: symbol,
          context: { requestId: actor.requestId ?? null },
          metadata: {
            from: before === null ? null : before.toString(),
            to: parsePerpConfig(market.perpConfig).maxOpenInterest?.toString() ?? null,
          },
        },
        tx,
      );
      return market;
    });
  }

  list(): Promise<MarketWithAssets[]> {
    return this.prisma.market.findMany({
      // Retired paper markets are history only.
      where: { isPaper: false },
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
      vaultBacked:
        m.baseAsset.chainTokenAddress !== null && m.quoteAsset.chainTokenAddress !== null,
      kind: m.kind === 'PERPETUAL' ? 'perpetual' : 'spot',
      perp:
        m.kind === 'PERPETUAL'
          ? perpInfoDto(parsePerpConfig(m.perpConfig), m.quoteAsset.scale)
          : null,
    };
  }
}
