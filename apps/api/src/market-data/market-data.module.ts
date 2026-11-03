import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TradingModule } from '../trading/trading.module';
import { MarketDataController } from './market-data.controller';
import { MarketDataGateway } from './market-data.gateway';
import { MarketDataService } from './market-data.service';

@Module({
  imports: [TradingModule, AuthModule],
  controllers: [MarketDataController],
  providers: [MarketDataService, MarketDataGateway],
  exports: [MarketDataService, MarketDataGateway],
})
export class MarketDataModule {}
