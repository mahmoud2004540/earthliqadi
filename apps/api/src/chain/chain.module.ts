import { AccessPolicy } from '../access/access.guard';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Module,
  Post,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  withdrawalRequestSchema,
  type VaultConfigDto,
  type VaultProofDto,
  type WithdrawalDto,
} from '@platform/shared';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { Public, RequirePermissions } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { LedgerModule } from '../ledger/ledger.module';
import { metrics } from '../monitoring/metrics';
import { ChainService } from './chain.service';

@ApiTags('vault')
@Controller({ path: 'vault', version: '1' })
export class VaultController {
  constructor(private readonly chain: ChainService) {}

  /** Chain, vault and token addresses (testnet). `enabled: false` when not configured. */
  @Public()
  @Get('config')
  config(): Promise<VaultConfigDto> {
    return this.chain.publicConfig();
  }

  @Get('withdrawals')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  async list(@CurrentAuth() auth: AuthContext): Promise<{ withdrawals: WithdrawalDto[] }> {
    return { withdrawals: await this.chain.withdrawals(auth.user.id) };
  }

  /** Holds the amount and returns an operator-signed withdrawal for the user's wallet to submit. */
  @Post('withdrawals')
  @AccessPolicy('withdraw')
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(withdrawalRequestSchema)
  request(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(withdrawalRequestSchema))
    body: z.infer<typeof withdrawalRequestSchema>,
  ): Promise<WithdrawalDto> {
    return this.chain.requestWithdrawal(auth.user.id, body.asset, body.amount);
  }

  /** Public proof of liabilities: committed root totals vs. tokens held by the contract. */
  @Public()
  @Get('solvency')
  solvency() {
    return this.chain.solvency();
  }

  /** Merkle proof of the user's balances in the latest committed state (for the escape hatch). */
  @Get('proof')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  proof(@CurrentAuth() auth: AuthContext): Promise<VaultProofDto> {
    return this.chain.proof(auth.user.id);
  }

  /** Local chain only: test gas and tokens. */
  @Post('faucet')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  faucet(@CurrentAuth() auth: AuthContext): Promise<{ tokens: string[] }> {
    return this.chain.faucet(auth.user.id);
  }
}

@ApiTags('admin')
@Controller({ path: 'admin/vault', version: '1' })
export class AdminVaultController {
  constructor(private readonly chain: ChainService) {}

  /** Ledger custody vs. on-chain vault balances at the indexed block. */
  @Get('custody')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  async custody() {
    return { assets: await this.chain.custodyCheck() };
  }
}

/** Indexer, withdrawal expiry and state commitments on timers. Errors are logged and retried. */
@Injectable()
export class ChainScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChainScheduler.name);
  private timers: NodeJS.Timeout[] = [];
  private indexing = false;
  private committing = false;

  constructor(
    private readonly chain: ChainService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.chain.enabled) return;
    if (this.config.CHAIN_POLL_MS > 0) {
      this.timers.push(setInterval(() => void this.index(), this.config.CHAIN_POLL_MS));
    }
    if (this.config.VAULT_STATE_INTERVAL_SECONDS > 0) {
      this.timers.push(
        setInterval(() => void this.commit(), this.config.VAULT_STATE_INTERVAL_SECONDS * 1000),
      );
    }
    this.timers.forEach((t) => t.unref());
  }

  onApplicationShutdown(): void {
    this.timers.forEach((t) => clearInterval(t));
  }

  private async index(): Promise<void> {
    if (this.indexing) return;
    this.indexing = true;
    try {
      while ((await this.chain.indexOnce()) > 0);
      await this.chain.expireWithdrawals();
    } catch (err) {
      metrics.chainFailures.inc({ job: 'indexer' });
      this.logger.error({ err }, 'CHAIN_INDEXER_FAILED: retrying');
    } finally {
      this.indexing = false;
    }
  }

  private async commit(): Promise<void> {
    if (this.committing) return;
    this.committing = true;
    try {
      await this.chain.commitState();
    } catch (err) {
      metrics.chainFailures.inc({ job: 'state-commit' });
      this.logger.error({ err }, 'VAULT_STATE_COMMIT_FAILED: retrying');
    } finally {
      this.committing = false;
    }
  }
}

@Module({
  imports: [LedgerModule],
  controllers: [VaultController, AdminVaultController],
  providers: [ChainService, ChainScheduler],
  exports: [ChainService],
})
export class ChainModule {}
