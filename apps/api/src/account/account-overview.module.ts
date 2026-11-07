import { Controller, Get, Header, Module, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  statementQuerySchema,
  type AccountOverviewDto,
  type StatementDto,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { StatementService } from './statement.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { ApiKeyScope, RequirePermissions } from '../common/decorators';
import { LedgerModule } from '../ledger/ledger.module';
import { PerpsModule } from '../perps/perps.module';
import { AccountOverviewService } from './overview.service';

@ApiTags('account')
@Controller({ path: 'me', version: '1' })
export class AccountOverviewController {
  constructor(
    private readonly overview: AccountOverviewService,
    private readonly statements: StatementService,
  ) {}

  /** Monthly ("YYYY-MM") or annual ("YYYY") statement from the ledger (ADR-0028). */
  @Get('statements')
  @ApiKeyScope('read')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  statement(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(statementQuerySchema)) q: z.infer<typeof statementQuerySchema>,
  ): Promise<StatementDto> {
    return this.statements.statement(auth.user.id, q.period);
  }

  /** The same statement as a CSV download. */
  @Get('statements.csv')
  @ApiKeyScope('read')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async statementCsv(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(statementQuerySchema)) q: z.infer<typeof statementQuerySchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    res.setHeader('Content-Disposition', `attachment; filename="statement-${q.period}.csv"`);
    return this.statements.toCsv(await this.statements.statement(auth.user.id, q.period));
  }

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
  providers: [AccountOverviewService, StatementService],
  exports: [AccountOverviewService],
})
export class AccountOverviewModule {}
