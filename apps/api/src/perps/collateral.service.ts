import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { CollateralAssetDto, MyCollateralDto } from '@platform/shared';
import { randomUUID } from 'node:crypto';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { toMinorUnits } from '../ledger/ledger-domain';
import { LedgerService } from '../ledger/ledger.service';
import { unitsOf, type MarketWithAssets } from '../trading/markets.service';
import { lotsToQuantity, quoteAmount, ticksToPrice } from '../trading/order-math';
import { OrdersService } from '../trading/orders.service';
import { formatAmountTrimmed } from '@platform/shared';
import { conversionFloor, conversionLots, haircutValue } from './collateral-math';

const CONVERSION_PREFIX = 'collat-';
const SYSTEM_CTX: RequestContext = {
  requestId: 'perp-collateral',
  ipAddress: null,
  userAgent: null,
};

/**
 * Multi-collateral by auto-conversion (ADR-0027). Perpetual margin stays in
 * the quote asset (the vault, the ledger and proof of funds are unchanged).
 * Accounts that opt in, in cross mode, let the risk engine sell accepted
 * collateral on its spot market when their free quote balance can no longer
 * defend a position: just enough, never below the best bid minus the
 * asset's haircut.
 */
@Injectable()
export class CollateralService {
  private readonly logger = new Logger(CollateralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  private async rows() {
    const rows = await this.prisma.collateralAsset.findMany({ orderBy: { haircutBps: 'asc' } });
    const markets = await this.prisma.market.findMany({
      where: { id: { in: rows.map((r) => r.spotMarketId) } },
      include: { baseAsset: true, quoteAsset: true },
    });
    const byId = new Map(markets.map((m) => [m.id, m]));
    return rows.map((r) => ({ ...r, market: byId.get(r.spotMarketId)! }));
  }

  private dto(r: Awaited<ReturnType<CollateralService['rows']>>[number]): CollateralAssetDto {
    return {
      asset: r.market.baseAsset.code,
      market: r.market.symbol,
      quoteAsset: r.market.quoteAsset.code,
      haircutBps: r.haircutBps,
      enabled: r.enabled,
    };
  }

  async list(): Promise<CollateralAssetDto[]> {
    return (await this.rows()).map((r) => this.dto(r));
  }

  /** Staff: accept an asset (or change its haircut, or disable it). Audited. */
  async configure(
    staffId: string,
    input: { asset: string; market: string; haircutBps: number; enabled: boolean },
    ctx: RequestContext,
  ): Promise<CollateralAssetDto> {
    const market = await this.prisma.market.findUnique({
      where: { symbol: input.market },
      include: { baseAsset: true, quoteAsset: true },
    });
    if (!market || market.kind !== 'SPOT' || market.baseAsset.code !== input.asset)
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'Name the spot market that sells this asset for the quote asset',
        [{ path: 'market', message: 'Not a spot market for this asset' }],
      );
    await this.prisma.collateralAsset.upsert({
      where: { assetId: market.baseAssetId },
      create: {
        assetId: market.baseAssetId,
        spotMarketId: market.id,
        haircutBps: input.haircutBps,
        enabled: input.enabled,
        updatedBy: staffId,
      },
      update: {
        spotMarketId: market.id,
        haircutBps: input.haircutBps,
        enabled: input.enabled,
        updatedBy: staffId,
        updatedAt: new Date(),
      },
    });
    await this.audit.recordSafe({
      action: 'perp.collateral.configured',
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: staffId,
      targetType: 'asset',
      targetId: input.asset,
      context: ctx,
      metadata: { ...input },
    });
    return (await this.list()).find((a) => a.asset === input.asset)!;
  }

  async setEnabled(
    userId: string,
    enabled: boolean,
    ctx: RequestContext,
  ): Promise<MyCollateralDto> {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { isVault: true },
    });
    if (u.isVault) throw AppError.forbidden('Vault accounts keep isolated quote margin');
    await this.prisma.user.update({
      where: { id: userId },
      data: { perpCollateralEnabled: enabled },
    });
    await this.audit.recordSafe({
      action: 'perp.collateral.setting',
      outcome: 'SUCCESS',
      actorType: 'USER',
      actorUserId: userId,
      targetType: 'user',
      targetId: userId,
      context: ctx,
      metadata: { enabled },
    });
    return this.mine(userId);
  }

  private async bestBid(marketId: string): Promise<bigint | null> {
    const [r] = await this.prisma.$queryRaw<{ bid: bigint | null }[]>`
      SELECT MAX("price_ticks") AS "bid" FROM "orders"
       WHERE "market_id" = ${marketId}::uuid AND "side" = 'BUY'
         AND "status" IN ('OPEN', 'PARTIALLY_FILLED')
         AND "time_in_force" IN ('GTC', 'POST_ONLY')
         AND NOT "hidden" AND "price_ticks" IS NOT NULL`;
    return r?.bid ?? null;
  }

  private async freeBalance(assetId: string, userId: string): Promise<bigint> {
    const id = await this.ledger.accountId(assetId, 'USER_AVAILABLE', userId);
    const acc = await this.prisma.ledgerAccount.findUnique({ where: { id } });
    return acc ? toMinorUnits(acc.balance) : 0n;
  }

  async mine(userId: string): Promise<MyCollateralDto> {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { perpCollateralEnabled: true, perpMarginMode: true },
    });
    const assets: MyCollateralDto['assets'] = [];
    for (const r of await this.rows()) {
      const m = r.market;
      const units = unitsOf(m);
      const balance = await this.freeBalance(m.baseAssetId, userId);
      const bid = await this.bestBid(m.id);
      const lots = balance / units.lotSize;
      assets.push({
        ...this.dto(r),
        balance: formatAmountTrimmed(balance, m.baseAsset.scale),
        bid: bid === null ? null : ticksToPrice(bid, units),
        value:
          bid === null
            ? null
            : formatAmountTrimmed(
                haircutValue(quoteAmount(bid, lots, units), r.haircutBps),
                m.quoteAsset.scale,
              ),
      });
    }
    return { enabled: u.perpCollateralEnabled, crossMode: u.perpMarginMode === 'cross', assets };
  }

  /**
   * Risk tick: raise `shortfall` (quote minor units) for a cross account by
   * selling pledged collateral. One conversion in flight per account; the
   * proceeds reach the free balance at settlement, and the next cross top-up
   * moves them into the position. Returns whether an order was sent.
   */
  async defend(userId: string, quoteAssetId: string, shortfall: bigint): Promise<boolean> {
    if (shortfall <= 0n) return false;
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        perpCollateralEnabled: true,
        perpMarginMode: true,
        isVault: true,
        walletAddress: true,
        parent: { select: { walletAddress: true } },
      },
    });
    if (!u.perpCollateralEnabled || u.perpMarginMode !== 'cross' || u.isVault) return false;
    // Never trade for a listed wallet (ADR-0022).
    if (await this.access.isSanctioned(u.walletAddress ?? u.parent?.walletAddress ?? null))
      return false;
    const inFlight = await this.prisma.order.count({
      where: {
        userId,
        clientOrderId: { startsWith: CONVERSION_PREFIX },
        status: { in: ['PENDING_NEW', 'OPEN', 'PARTIALLY_FILLED'] },
      },
    });
    if (inFlight > 0) return false;

    for (const r of await this.rows()) {
      const m: MarketWithAssets = r.market;
      if (!r.enabled || m.quoteAssetId !== quoteAssetId || m.status !== 'ACTIVE') continue;
      const units = unitsOf(m);
      const bid = await this.bestBid(m.id);
      if (bid === null) continue;
      const floor = conversionFloor(bid, r.haircutBps);
      // The taker fee comes out of the proceeds: ask for that much more.
      const fee = BigInt(Math.max(0, m.takerFeeBps));
      const target = (shortfall * 10_000n + (10_000n - fee) - 1n) / (10_000n - fee);
      const lots = conversionLots({
        shortfall: target,
        quotePerLotAtFloor: quoteAmount(floor, 1n, units),
        availableLots: (await this.freeBalance(m.baseAssetId, userId)) / units.lotSize,
        minLots: m.minQuantityLots,
      });
      if (lots === null) continue;
      try {
        const { order } = await this.orders.place(
          userId,
          {
            market: m.symbol,
            clientOrderId: `${CONVERSION_PREFIX}${randomUUID()}`,
            side: 'sell',
            type: 'limit',
            timeInForce: 'ioc',
            price: ticksToPrice(floor, units),
            quantity: lotsToQuantity(lots, units),
          },
          SYSTEM_CTX,
          { rateChecked: true },
        );
        await this.audit.recordSafe({
          action: 'perp.collateral.conversion',
          outcome: 'SUCCESS',
          actorType: 'SYSTEM',
          targetType: 'order',
          targetId: order.id,
          metadata: {
            userId,
            market: m.symbol,
            quantity: order.quantity,
            floor: order.price,
            shortfall: shortfall.toString(),
          },
        });
        return true;
      } catch (err) {
        this.logger.warn({ err, userId, market: m.symbol }, 'collateral conversion not placed');
      }
    }
    return false;
  }
}
