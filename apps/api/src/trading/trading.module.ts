import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { MarketsService } from './markets.service';
import { OrdersService } from './orders.service';
import { SettlementScheduler, SettlementService } from './settlement.service';
import {
  AdminMarketsController,
  MarketsController,
  MyTradesController,
  OrdersController,
} from './trading.controller';

@Module({
  imports: [LedgerModule],
  controllers: [MarketsController, OrdersController, MyTradesController, AdminMarketsController],
  providers: [MarketsService, OrdersService, SettlementService, SettlementScheduler],
  exports: [MarketsService, OrdersService, SettlementService],
})
export class TradingModule {}
