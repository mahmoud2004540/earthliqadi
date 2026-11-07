import { Controller, Get, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AccountOverviewDto } from '@platform/shared';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { ApiKeyScope, RequirePermissions } from '../common/decorators';
import { LedgerModule } from '../ledger/ledger.module';
import { PerpsModule } from '../perps/perps.module';
import { AccountOverviewService } from './overview.service';

@ApiTags('account')
@Controller({ path: 'me', version: '1' })
export class AccountOverviewController {
  constructor(private readonly overview: AccountOverviewService) {}

  /** Balances, where each is held, and an indicative total (ADR-0028). */
  @Get('overview')
  @ApiKeyScope('read')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  get(@CurrentAuth() auth: AuthContext): Promise<AccountOverviewDto> {
    return this.overview.overview(auth.user.id);
  }
}

@Module({
  imports: [LedgerModule, PerpsModule],
  controllers: [AccountOverviewController],
  providers: [AccountOverviewService],
  exports: [AccountOverviewService],
})
export class AccountOverviewModule {}
