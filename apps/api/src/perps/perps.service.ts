import { HttpStatus, Injectable } from '@nestjs/common';
import {
  formatAmountTrimmed,
  parseAmount,
  type FundingRoundDto,
  type PerpStatsDto,
  type PositionDto,
} from '@platform/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { toMinorUnits } from '../ledger/ledger-domain';
import { LedgerService, type LedgerActor } from '../ledger/ledger.service';
import { MarketsService, unitsOf, type MarketWithAssets } from '../trading/markets.service';
import { lotsToQuantity, ticksToPrice } from '../trading/order-math';
import { parsePerpConfig, type PerpConfig } from './perp-config';
import {
  absBig,
  bankruptcyTicks,
  fundingRate,
  notionalAt,
  tierFor,
  unrealizedPnl,
} from './perp-math';
import { lockPosition, OPEN_ORDER_STATUSES, positionState } from './perp-orders';
import { markMaxAgeMs } from './perp-prices';

function conflict(message: string): AppError {
  return new AppError(HttpStatus.CONFLICT, 'CONFLICT', message);
}

/** Rate in 1e-8 units → percent string with 4 decimals (e.g. 1_000_000 → "1.0000"). */
export function ratePercent(rate: bigint): string {
  // percent = rate / 1e6; keep 4 decimals → rate / 100 in 1e-4 percent units.
  const v = rate / 100n;
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / 10_000n}.${(a % 10_000n).toString().padStart(4, '0')}`;
}

@Injectable()
export class PerpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly markets: MarketsService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  private async perpMarket(
    symbol: string,
  ): Promise<{ market: MarketWithAssets; config: PerpConfig }> {
    const market = await this.markets.require(symbol);
    if (market.kind !== 'PERPETUAL') throw AppError.notFound(`${symbol} is not a perpetual market`);
    return { market, config: parsePerpConfig(market.perpConfig) };
  }

  private priceFromMinor(minor: bigint, m: MarketWithAssets): string {
    return formatAmountTrimmed(minor, m.quoteAsset.scale);
  }

  async stats(symbol: string, now = new Date()): Promise<PerpStatsDto> {
    const { market, config } = await this.perpMarket(symbol);
    const [latest, state, lastRound] = await Promise.all([
      this.prisma.perpPriceSample.findFirst({
        where: { marketId: market.id },
        orderBy: { sampledAt: 'desc' },
      }),
      this.prisma.perpMarketState.findUnique({ where: { marketId: market.id } }),
      this.prisma.perpFundingRound.findFirst({
        where: { marketId: market.id },
        orderBy: { fundingTime: 'desc' },
      }),
    ]);
    const fresh =
      latest !== null && now.getTime() - latest.sampledAt.getTime() <= markMaxAgeMs(config);
    let predicted: string | null = null;
    if (state?.lastFundingAt) {
      const premiums = await this.prisma.perpPriceSample.findMany({
        where: {
          marketId: market.id,
          sampledAt: { gt: state.lastFundingAt },
          premiumRate: { not: null },
        },
        select: { premiumRate: true },
      });
      predicted = ratePercent(
        fundingRate(
          premiums.map((p) => p.premiumRate!),
          config.fundingClampBps,
        ),
      );
    }
    const intervalMs = config.fundingIntervalSeconds * 1000;
    return {
      market: market.symbol,
      markPrice: latest ? this.priceFromMinor(toMinorUnits(latest.markPrice), market) : null,
      indexPrice: latest ? this.priceFromMinor(toMinorUnits(latest.indexPrice), market) : null,
      predictedFundingRate: predicted,
      lastFundingRate: lastRound ? ratePercent(lastRound.rate) : null,
      nextFundingAt: new Date(
        (Math.floor(now.getTime() / intervalMs) + 1) * intervalMs,
      ).toISOString(),
      sourcesUsed: latest?.sourcesUsed ?? 0,
      indexStale: !fresh,
      sampledAt: latest?.sampledAt.toISOString() ?? null,
    };
  }

  async fundingHistory(symbol: string, limit: number): Promise<FundingRoundDto[]> {
    const { market } = await this.perpMarket(symbol);
    const rounds = await this.prisma.perpFundingRound.findMany({
      where: { marketId: market.id },
      orderBy: { fundingTime: 'desc' },
      take: limit,
    });
    const scale = market.quoteAsset.scale;
    return rounds.map((r) => ({
      market: market.symbol,
      fundingTime: r.fundingTime.toISOString(),
      rate: ratePercent(r.rate),
      markPrice: formatAmountTrimmed(toMinorUnits(r.markPrice), scale),
      collected: formatAmountTrimmed(toMinorUnits(r.collected), scale),
      distributed: formatAmountTrimmed(toMinorUnits(r.distributed), scale),
      positions: r.positions,
    }));
  }

  async positions(userId: string): Promise<PositionDto[]> {
    const rows = await this.prisma.position.findMany({
      where: { userId },
      include: { market: { include: { baseAsset: true, quoteAsset: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const result: PositionDto[] = [];
    for (const row of rows) {
      const m = row.market;
      const config = parsePerpConfig(m.perpConfig);
      const latest = await this.prisma.perpPriceSample.findFirst({
        where: { marketId: m.id },
        orderBy: { sampledAt: 'desc' },
      });
      result.push(
        this.toPositionDto(row, m, config, latest ? toMinorUnits(latest.markPrice) : null),
      );
    }
    return result;
  }

  toPositionDto(
    row: Parameters<typeof positionState>[0] & {
      leverage: number;
      status: 'NORMAL' | 'LIQUIDATING';
      realizedPnl: { toFixed(d?: number): string };
      fundingPnl: { toFixed(d?: number): string };
    },
    m: MarketWithAssets,
    config: PerpConfig,
    mark: bigint | null,
  ): PositionDto {
    const u = unitsOf(m);
    const pos = positionState(row);
    const qs = m.quoteAsset.scale;
    const fmt = (v: bigint): string => formatAmountTrimmed(v, qs);
    const baseUnits = 10n ** BigInt(u.baseScale);
    const flat = pos.size === 0n;
    let liquidationPrice: string | null = null;
    if (!flat && mark !== null) {
      const mmr = BigInt(
        (
          tierFor(config.tiers, notionalAt(mark, pos.size, u, 'up')) ??
          config.tiers[config.tiers.length - 1]!
        ).mmrBps,
      );
      const qty = absBig(pos.size) * u.lotSize;
      // Long: (E − M) / (S·(1 − mmr)); short: (M − E) / (|S|·(1 + mmr)).
      const num =
        (pos.size > 0n ? pos.entry - pos.margin : pos.margin - pos.entry) * baseUnits * 10_000n;
      const den = qty * (pos.size > 0n ? 10_000n - mmr : 10_000n + mmr);
      const p = num / den;
      liquidationPrice = p > 0n ? fmt(p) : null;
    }
    return {
      market: m.symbol,
      side: flat ? 'flat' : pos.size > 0n ? 'long' : 'short',
      size: flat ? '0' : lotsToQuantity(absBig(pos.size), u),
      entryPrice: flat
        ? null
        : fmt((absBig(pos.entry) * baseUnits) / (absBig(pos.size) * u.lotSize)),
      markPrice: mark === null ? null : fmt(mark),
      liquidationPrice,
      bankruptcyPrice: flat ? null : ticksToPrice(bankruptcyTicks(pos, u), u),
      margin: fmt(pos.margin),
      leverage: row.leverage,
      unrealizedPnl: flat || mark === null ? null : fmt(unrealizedPnl(pos, mark, u)),
      realizedPnl: fmt(toMinorUnits(row.realizedPnl)),
      fundingPnl: fmt(toMinorUnits(row.fundingPnl)),
      status: row.status === 'LIQUIDATING' ? 'liquidating' : 'normal',
      asset: m.quoteAsset.code,
    };
  }

  /** Leverage changes only while flat with no open orders (isolated margin, ADR-0011). */
  async setLeverage(
    userId: string,
    symbol: string,
    leverage: number,
    actor: LedgerActor,
  ): Promise<PositionDto> {
    const { market, config } = await this.perpMarket(symbol);
    if (leverage > config.tiers[0]!.maxLeverage)
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        `Maximum leverage on ${symbol} is ${config.tiers[0]!.maxLeverage}x`,
      );
    const row = await this.prisma.$transaction(async (tx) => {
      const pos = await lockPosition(tx, userId, market.id, config.defaultLeverage);
      if (pos.sizeLots !== 0n) throw conflict('Close the position before changing leverage');
      const open = await tx.order.count({
        where: { userId, marketId: market.id, status: { in: [...OPEN_ORDER_STATUSES] } },
      });
      if (open > 0) throw conflict('Cancel open orders on this market before changing leverage');
      const updated = await tx.position.update({ where: { id: pos.id }, data: { leverage } });
      await this.audit.record(
        {
          action: 'perp.leverage.changed',
          outcome: 'SUCCESS',
          actorType: actor.actorType,
          actorUserId: actor.actorUserId ?? null,
          targetType: 'position',
          targetId: pos.id,
          context: { requestId: actor.requestId ?? null },
          metadata: { market: symbol, from: pos.leverage, to: leverage },
        },
        tx,
      );
      return updated;
    });
    return this.toPositionDto(row, market, config, null);
  }

  /** Moves funds from the available balance into an open position's isolated margin. */
  async addMargin(
    userId: string,
    symbol: string,
    amount: string,
    actor: LedgerActor,
  ): Promise<PositionDto> {
    const { market, config } = await this.perpMarket(symbol);
    let value: bigint;
    try {
      value = parseAmount(amount, market.quoteAsset.scale);
    } catch (err) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', (err as Error).message);
    }
    if (value <= 0n)
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Amount must be positive');
    const available = await this.ledger.accountId(market.quoteAssetId, 'USER_AVAILABLE', userId);
    const margin = await this.ledger.accountId(market.quoteAssetId, 'USER_MARGIN', userId);
    const row = await this.prisma.$transaction(async (tx) => {
      const pos = await lockPosition(tx, userId, market.id, config.defaultLeverage);
      if (pos.sizeLots === 0n) throw conflict('There is no open position to add margin to');
      await this.ledger.postWithin(
        tx,
        {
          type: 'MARGIN_TRANSFER',
          idempotencyKey: `margin-add:${pos.id}:${Date.now()}:${value}`,
          description: `Add margin to ${symbol} position`,
          postings: [
            { accountId: available, direction: 'DEBIT', amount: value },
            { accountId: margin, direction: 'CREDIT', amount: value },
          ],
        },
        actor,
      );
      return tx.position.update({
        where: { id: pos.id },
        data: { margin: { increment: value.toString() } },
      });
    });
    return this.toPositionDto(row, market, config, null);
  }

  /** Paper only: funds the insurance fund from the paper faucet account (audited). */
  async seedInsuranceFund(assetCode: string, amount: string, actor: LedgerActor): Promise<string> {
    const asset = await this.ledger.requireAsset(assetCode);
    if (!asset.isPaper) throw conflict('Insurance fund seeding is only available for paper assets');
    let value: bigint;
    try {
      value = parseAmount(amount, asset.scale);
    } catch (err) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', (err as Error).message);
    }
    if (value <= 0n)
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Amount must be positive');
    const faucet = await this.ledger.accountId(asset.id, 'PAPER_FAUCET', null);
    const fund = await this.ledger.accountId(asset.id, 'INSURANCE_FUND', null);
    const result = await this.ledger.post(
      {
        type: 'INSURANCE_FUND_SEED',
        idempotencyKey: `insurance-seed:${asset.id}:${Date.now()}`,
        description: `Paper insurance fund seed ${asset.code} (simulated, no value)`,
        postings: [
          { accountId: faucet, direction: 'DEBIT', amount: value },
          { accountId: fund, direction: 'CREDIT', amount: value },
        ],
      },
      actor,
    );
    await this.audit.record({
      action: 'perp.insurance_fund.seeded',
      outcome: 'SUCCESS',
      actorType: actor.actorType,
      actorUserId: actor.actorUserId ?? null,
      targetType: 'asset',
      targetId: asset.code,
      context: { requestId: actor.requestId ?? null },
      metadata: { amount: value.toString(), entryId: result.entry.id.toString() },
    });
    return formatAmountTrimmed(value, asset.scale);
  }

  /** Insurance fund balance per paper asset (public transparency). */
  async insuranceFunds(): Promise<{ asset: string; balance: string }[]> {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: { type: 'INSURANCE_FUND' },
      include: { asset: true },
    });
    return accounts.map((a) => ({
      asset: a.asset.code,
      balance: formatAmountTrimmed(toMinorUnits(a.balance), a.asset.scale),
    }));
  }
}
