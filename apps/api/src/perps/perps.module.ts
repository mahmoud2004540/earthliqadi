import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TradingModule } from '../trading/trading.module';
import { AdminCollateralController } from './collateral.controller';
import { CollateralService } from './collateral.service';
import { PerpRiskScheduler, PerpRiskService } from './perp-risk.service';
import { PerpsController } from './perps.controller';
import { PerpsService } from './perps.service';

@Module({
  imports: [LedgerModule, TradingModule],
  controllers: [PerpsController, AdminCollateralController],
  providers: [PerpsService, PerpRiskService, PerpRiskScheduler, CollateralService],
  exports: [PerpsService, PerpRiskService],
})
export class PerpsModule {}
