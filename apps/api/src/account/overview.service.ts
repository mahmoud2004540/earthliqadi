import { Inject, Injectable } from '@nestjs/common';
import type { AccountOverviewDto } from '@platform/shared';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { PerpsService } from '../perps/perps.service';
import { unitsOf } from '../trading/markets.service';
import { ticksToPrice } from '../trading/order-math';
import { sumDecimals, valueAt } from './overview-math';

/**
 * Account overview (ADR-0028): balances, where each is held, and an
 * indicative value in VALUATION_ASSET at the last traded price. Assets
 * without a market against it are listed as unvalued, never estimated.
 */
@Injectable()
export class AccountOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly perps: PerpsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Last traded price of `assetCode` in the valuation asset, from its spot market. */
  private async price(
    assetCode: string,
    valuation: string,
  ): Promise<{ price: string; market: string } | null> {
    const market = await this.prisma.market.findFirst({
      where: {
        kind: 'SPOT',
        status: 'ACTIVE',
        baseAsset: { code: assetCode },
        quoteAsset: { code: valuation },
      },
      include: { baseAsset: true, quoteAsset: true },
    });
    if (!market) return null;
    const last = await this.prisma.trade.findFirst({
      where: { marketId: market.id },
      orderBy: { eventSeq: 'desc' },
      select: { priceTicks: true },
    });
    if (!last) return null;
    return { price: ticksToPrice(last.priceTicks, unitsOf(market)), market: market.symbol };
  }

  async overview(userId: string): Promise<AccountOverviewDto> {
    const balances = (await this.ledger.balancesForUser(userId)).filter(
      (b) => b.total !== '0' && !/^0(\.0+)?$/.test(b.total),
    );
    const assetRows = await this.prisma.asset.findMany({
      where: { code: { in: balances.map((b) => b.asset) } },
      select: { code: true, chainTokenAddress: true },
    });
    const valuation = await this.prisma.asset.findUnique({
      where: { code: this.config.VALUATION_ASSET },
    });
    const assets: AccountOverviewDto['assets'] = [];
    const unvalued: string[] = [];
    for (const b of balances) {
      const custody = assetRows.find((a) => a.code === b.asset)?.chainTokenAddress
        ? ('vault' as const)
        : ('ledger' as const);
      let price: string | null = null;
      let priceSource: 'reference' | 'last_trade' | null = null;
      let priceMarket: string | null = null;
      let value: string | null = null;
      if (valuation) {
        if (b.asset === valuation.code) {
          price = '1';
          priceSource = 'reference';
          value = b.total;
        } else {
          const p = await this.price(b.asset, valuation.code);
          if (p) {
            price = p.price;
            priceSource = 'last_trade';
            priceMarket = p.market;
            value = valueAt(p.price, b.total, b.scale, valuation.scale);
          }
        }
      }
      if (value === null) unvalued.push(b.asset);
      assets.push({
        asset: b.asset,
        name: b.name,
        available: b.available,
        locked: b.locked,
        margin: b.margin,
        total: b.total,
        custody,
        price,
        priceSource,
        priceMarket,
        value,
      });
    }
    let unrealizedPnl: string | null = null;
    let totalValue: string | null = null;
    if (valuation) {
      const pnl = (await this.perps.positions(userId))
        .filter((p) => p.side !== 'flat' && p.asset === valuation.code && p.unrealizedPnl !== null)
        .map((p) => p.unrealizedPnl!);
      unrealizedPnl = sumDecimals(pnl, valuation.scale);
      totalValue = sumDecimals(
        [...assets.map((a) => a.value).filter((v): v is string => v !== null), unrealizedPnl],
        valuation.scale,
      );
    }
    return {
      valuationAsset: valuation?.code ?? null,
      asOf: new Date().toISOString(),
      totalValue,
      unrealizedPnl,
      assets,
      unvalued,
    };
  }
}
