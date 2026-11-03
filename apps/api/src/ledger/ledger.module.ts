import { Module } from '@nestjs/common';
import { AdminLedgerController, AssetsController, MyLedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { ReconciliationScheduler, ReconciliationService } from './reconciliation.service';

@Module({
  controllers: [AssetsController, MyLedgerController, AdminLedgerController],
  providers: [LedgerService, ReconciliationService, ReconciliationScheduler],
  exports: [LedgerService, ReconciliationService],
})
export class LedgerModule {}
