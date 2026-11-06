import { AccessPolicy } from '../access/access.guard';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  createVaultSchema,
  uuidParamSchema,
  vaultDepositSchema,
  vaultRedeemSchema,
} from '@platform/shared';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { AppError } from '../common/app-error';
import { Public, RequirePermissions } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { LeaderVaultsService } from './leader-vaults.service';

function self(auth: AuthContext): string {
  if (auth.actingAsSubAccount) throw AppError.forbidden('Use your main account for vault shares');
  return auth.user.id;
}

/**
 * Leader vaults (ADR-0019). Public track records; deposits and redemptions by
 * the share holder's own session. The leader trades the vault's account with
 * `X-Sub-Account: <accountId>` (trading routes only).
 */
@ApiTags('vaults')
@Controller({ path: 'leader-vaults', version: '1' })
export class LeaderVaultsController {
  constructor(private readonly vaults: LeaderVaultsService) {}

  @Public()
  @Get()
  async list() {
    return { vaults: await this.vaults.leaderboard() };
  }

  @Public()
  @Get(':id')
  async get(@Param(new ZodValidationPipe(uuidParamSchema)) p: z.infer<typeof uuidParamSchema>) {
    return this.vaults.summary(await this.vaults.require(p.id));
  }

  @Post()
  @AccessPolicy('open')
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(createVaultSchema)
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createVaultSchema)) body: z.infer<typeof createVaultSchema>,
    @ReqContext() ctx: RequestContext,
  ) {
    const v = await this.vaults.create(self(auth), body, ctx);
    return { ...(await this.vaults.summary(v)), accountId: v.accountUserId };
  }

  @Get(':id/me')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  async mine(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: z.infer<typeof uuidParamSchema>,
  ) {
    return this.vaults.position(self(auth), await this.vaults.require(p.id));
  }

  @Post(':id/deposit')
  @AccessPolicy('open')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(vaultDepositSchema)
  deposit(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: z.infer<typeof uuidParamSchema>,
    @Body(new ZodValidationPipe(vaultDepositSchema)) body: z.infer<typeof vaultDepositSchema>,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.vaults.deposit(self(auth), p.id, body.amount, body.idempotencyKey, ctx);
  }

  /** 200 when paid at once; 202 when queued until the leader frees collateral. */
  @Post(':id/redeem')
  @AccessPolicy('withdraw')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(vaultRedeemSchema)
  redeem(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: z.infer<typeof uuidParamSchema>,
    @Body(new ZodValidationPipe(vaultRedeemSchema)) body: z.infer<typeof vaultRedeemSchema>,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.vaults.requestRedemption(self(auth), p.id, body.shares, ctx);
  }
}
