import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { SubAccountsController } from './sub-accounts.controller';
import { SubAccountsService } from './sub-accounts.service';

@Module({
  imports: [LedgerModule],
  controllers: [SubAccountsController],
  providers: [SubAccountsService],
})
export class SubAccountsModule {}
