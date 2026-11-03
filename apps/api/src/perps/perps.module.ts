import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TradingModule } from '../trading/trading.module';
import { PerpRiskScheduler, PerpRiskService } from './perp-risk.service';
import { AdminPerpsController, PerpsController } from './perps.controller';
import { PerpsService } from './perps.service';

@Module({
  imports: [LedgerModule, TradingModule],
  controllers: [PerpsController, AdminPerpsController],
  providers: [PerpsService, PerpRiskService, PerpRiskScheduler],
  exports: [PerpsService, PerpRiskService],
})
export class PerpsModule {}
