import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  assetCodeSchema,
  assetStatusSchema,
  createAssetSchema,
  faucetRequestSchema,
  ledgerHistoryQuerySchema,
  type AssetDto,
  type BalanceDto,
  type LedgerHistoryItemDto,
} from '@platform/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { Public, RequirePermissions } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { LedgerService } from './ledger.service';
import { ReconciliationService } from './reconciliation.service';

const entryIdParam = z.object({ id: z.string().regex(/^\d{1,19}$/) });
const assetCodeParam = z.object({ code: assetCodeSchema });
const accountsQuery = z.object({ ownerUserId: z.uuid().optional() });
const runsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

/** Public reference data: configured assets (no prices, no volumes). */
@ApiTags('ledger')
@Controller({ path: 'assets', version: '1' })
export class AssetsController {
  constructor(private readonly ledger: LedgerService) {}

  @Public()
  @Get()
  async list(): Promise<{ assets: AssetDto[] }> {
    return { assets: (await this.ledger.listAssets(true)).map((a) => this.ledger.toAssetDto(a)) };
  }
}

/** Paper trading faucet (simulated funds for paper assets only, ADR-0010). */
@ApiTags('ledger')
@Controller({ path: 'paper', version: '1' })
export class PaperController {
  constructor(private readonly ledger: LedgerService) {}

  @Post('faucet')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(faucetRequestSchema)
  async faucet(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(faucetRequestSchema)) body: z.infer<typeof faucetRequestSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<{ asset: string; amount: string; entryId: string }> {
    const asset = await this.ledger.requireAsset(body.asset);
    const { entry } = await this.ledger.paperFaucet(auth.user.id, body.asset, {
      actorType: 'USER',
      actorUserId: auth.user.id,
      requestId: ctx.requestId,
    });
    return {
      asset: asset.code,
      amount: this.ledger.toAssetDto(asset).faucetAmount ?? '0',
      entryId: entry.id.toString(),
    };
  }
}

/** The authenticated user's own balances and ledger history. */
@ApiTags('ledger')
@Controller({ path: 'me', version: '1' })
export class MyLedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('balances')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  async balances(@CurrentAuth() auth: AuthContext): Promise<{ balances: BalanceDto[] }> {
    return { balances: await this.ledger.balancesForUser(auth.user.id) };
  }

  @Get('ledger-entries')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  history(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(ledgerHistoryQuerySchema))
    query: z.infer<typeof ledgerHistoryQuerySchema>,
  ): Promise<{ items: LedgerHistoryItemDto[]; nextBefore: string | null }> {
    return this.ledger.historyForUser(auth.user.id, query);
  }
}

/**
 * Staff ledger endpoints. There is deliberately no endpoint to post arbitrary
 * entries or adjust balances: staff adjustments require maker-checker
 * approval and arrive with the admin app (Phase 7).
 */
@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminLedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly reconciliation: ReconciliationService,
    private readonly audit: AuditService,
  ) {}

  @Get('assets')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  async listAssets(): Promise<{ assets: AssetDto[] }> {
    return { assets: (await this.ledger.listAssets(false)).map((a) => this.ledger.toAssetDto(a)) };
  }

  @Post('assets')
  @RequirePermissions(PERMISSIONS.ASSETS_CONFIGURE)
  @ApiZodBody(createAssetSchema)
  async createAsset(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createAssetSchema)) body: z.infer<typeof createAssetSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<AssetDto> {
    const asset = await this.ledger.createAsset(body, {
      actorType: 'STAFF',
      actorUserId: auth.user.id,
      requestId: ctx.requestId,
    });
    return this.ledger.toAssetDto(asset);
  }

  @Patch('assets/:code/status')
  @RequirePermissions(PERMISSIONS.ASSETS_CONFIGURE)
  @ApiZodBody(assetStatusSchema)
  async setAssetStatus(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(assetCodeParam)) params: z.infer<typeof assetCodeParam>,
    @Body(new ZodValidationPipe(assetStatusSchema)) body: z.infer<typeof assetStatusSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<AssetDto> {
    const asset = await this.ledger.setAssetStatus(params.code, body.status, {
      actorType: 'STAFF',
      actorUserId: auth.user.id,
      requestId: ctx.requestId,
    });
    return this.ledger.toAssetDto(asset);
  }

  @Get('ledger/accounts')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  async accounts(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(accountsQuery)) query: z.infer<typeof accountsQuery>,
    @ReqContext() ctx: RequestContext,
  ) {
    await this.auditRead(auth, ctx, 'admin.ledger.accounts.read', query.ownerUserId ?? 'system');
    return { accounts: await this.ledger.accountsFor(query.ownerUserId) };
  }

  @Get('ledger/entries/:id')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  async entry(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(entryIdParam)) params: z.infer<typeof entryIdParam>,
    @ReqContext() ctx: RequestContext,
  ) {
    await this.auditRead(auth, ctx, 'admin.ledger.entry.read', params.id);
    return this.ledger.entryWithPostings(BigInt(params.id));
  }

  @Post('ledger/reconciliations')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.LEDGER_RECONCILE)
  async reconcile(@CurrentAuth() auth: AuthContext) {
    return this.reconciliation.run('MANUAL', auth.user.id);
  }

  @Get('ledger/reconciliations')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  async runs(@Query(new ZodValidationPipe(runsQuery)) query: z.infer<typeof runsQuery>) {
    return { runs: await this.reconciliation.latest(query.limit) };
  }

  private auditRead(auth: AuthContext, ctx: RequestContext, action: string, targetId: string) {
    return this.audit.record({
      action,
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: auth.user.id,
      targetType: 'ledger',
      targetId,
      context: ctx,
    });
  }
}
