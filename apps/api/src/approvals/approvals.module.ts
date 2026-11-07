import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChainModule } from '../chain/chain.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PerpsModule } from '../perps/perps.module';
import { TradingModule } from '../trading/trading.module';
import { AdminOperationsController, ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { HealthReportService } from './health-report.service';

@Module({
  imports: [AuthModule, LedgerModule, TradingModule, PerpsModule, ChainModule],
  controllers: [ApprovalsController, AdminOperationsController],
  providers: [ApprovalsService, HealthReportService],
  exports: [ApprovalsService, HealthReportService],
})
export class ApprovalsModule {}
